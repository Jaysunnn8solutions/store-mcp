/**
 * The browser side of a run.
 *
 * This is written against a `post` callback rather than the Web Worker globals,
 * so the whole pipeline — validate, build the context, simulate, compile,
 * transfer — runs unchanged under vitest on Node with no Worker anywhere. The
 * worker shell is a dozen lines that wire `self.onmessage` to `runInWorker` and
 * `self.postMessage` to `post`.
 *
 * One `run` request answers with progress messages (`building`, then one
 * `simulating` per horizon day as the engine starts it, then `compiling`) and
 * exactly one `done` or `error`. Validation happens before anything is posted,
 * so a bad request produces one `error` and no progress at all.
 *
 * Every typed array of the playback is handed to postMessage as a transferable,
 * so a few megabytes of keyframes move instead of being copied. After that post
 * the worker's own arrays are detached: nothing may touch the playback again.
 * Only the playback owns buffers — the world payload and the KPIs are plain
 * structured-clone-safe data, which is exactly why payload.ts exists.
 */

import { ZodError } from "zod";
import { DataNotLoadedError, hasData, UnknownIdError } from "../data/store";
import { installBundledData } from "../data/bundle";
import { LimitError } from "../layout/limits";
import { MAX_DAYS } from "../store-ui/hash";
import { collectBuffers, compilePlayback } from "../trace/compile";
import { RecordingTracer, type RunSpec, type TraceEvent, type TwinRequest, type TwinResponse } from "../trace/types";
import { buildWorld } from "../trace/world";
import { runOperations } from "../twin/operations";
import { kpis } from "../twin/replicate";
import { buildTwin, FIXTURES_IGNORED, operationsOptions, scenarioSchema, setContextCacheLimit, type TwinContext, type TwinScenario } from "../twin/twin";
import { buildWorldPayload, workerInfos } from "./payload";

/** Posted as an error: candystore's market model is fetched server-side and allows no cross-origin request, so a live-network scenario stays on the MCP tools. */
export const CANDYSTORE_UNSUPPORTED = "Scenarios that open or close shops in the candystore network run through the MCP tools; the 3D page uses the committed snapshot.";

/** A request the page should never send. Rejected before any work starts. */
export class UnsupportedError extends Error {}

export type PostMessageFn = (msg: TwinResponse, transfer?: Transferable[]) => void;

/** Issues named in one banner before it stops being readable. */
export const BANNER_ISSUES = 5;

/**
 * Records the events and reports each day as the engine reaches it. The `day`
 * event is emitted at the top of every horizon day, so `day + 1` is the day now
 * being simulated and `day / days` is the share finished.
 */
export class ProgressTracer extends RecordingTracer {
  constructor(
    private readonly post: PostMessageFn,
    private readonly id: number
  ) {
    super();
  }

  override emit(e: TraceEvent): void {
    super.emit(e);
    if (e.k === "day") this.post({ type: "progress", id: this.id, phase: "simulating", day: e.day + 1 });
  }
}

/**
 * Runs the page has been told to abandon. A worker is single-threaded, so a
 * cancel that arrives mid-simulation cannot interrupt it; what it can do is
 * stop the answer being posted and stop the compile — the expensive half — from
 * running at all. The page gets silence for a run it no longer wants.
 */
const cancelled = new Set<number>();

let prepared = false;

/**
 * Registers the bundled data and shrinks the context cache, once.
 *
 * `setData` bumps the data version that buildTwin keys its cache on, so calling
 * it per run would throw away every cached context; and two contexts is the
 * right depth in a browser, where a user edits one field and runs again but
 * each context carries a layout and a demand model. Under vitest the Node
 * provider is already registered, so this leaves it alone.
 */
function prepare(): void {
  if (prepared) return;
  prepared = true;
  if (!hasData()) installBundledData();
  setContextCacheLimit(2);
}

function validate(spec: RunSpec): TwinScenario {
  const scenario = scenarioSchema.parse(spec.scenario);
  if (scenario.candystore) throw new UnsupportedError(CANDYSTORE_UNSUPPORTED);
  if (!Number.isInteger(spec.days) || spec.days < 1 || spec.days > MAX_DAYS) throw new RangeError(`days must be a whole number from 1 to ${MAX_DAYS} on the 3D page (got ${spec.days}).`);
  if (!Number.isInteger(spec.seed) || spec.seed < 1) throw new RangeError(`seed must be a whole number of at least 1 (got ${spec.seed}).`);
  if (!Number.isInteger(spec.startWeek) || spec.startWeek < 1 || spec.startWeek > 52) throw new RangeError(`startWeek must be a whole number from 1 to 52 (got ${spec.startWeek}).`);
  return scenario;
}

/**
 * Non-fatal notes about the run as it was actually configured: things the
 * caller asked for that the building cannot do, and things the scenario quietly
 * dropped. They ride along with the answer rather than replacing it.
 */
export function runIssues(ctx: TwinContext): string[] {
  const out: string[] = [];
  const s = ctx.scenario;
  if (ctx.changes.includes(FIXTURES_IGNORED)) out.push(FIXTURES_IGNORED);
  if (s.counters !== undefined && ctx.site.showcase === null) out.push(`This shop has no showcase, so "counters" was ignored: there is no glass to serve from.`);
  if (ctx.site.equipment.vans === 0 && (s.deliveryShare ?? 1) > 0) out.push("The shop has no van, so every special order has to be collected; delivery orders will read as pickups.");
  if (ctx.site.doors.docks + ctx.site.doors.ground === 0) out.push("The shop has no goods door: deliveries have nowhere to land, and receiving will queue behind itself.");
  if (ctx.layout.facings.length === 0) out.push("The layout has no selling facings, so there is nothing for a shopper to take off a shelf.");
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message));
    const shown = issues.slice(0, BANNER_ISSUES);
    const more = issues.length - shown.length;
    return `Invalid scenario — ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
  }
  // Error subclasses do not survive postMessage and a minifier renames
  // constructors, so the names the page branches on are pinned here by
  // instanceof and written into the message itself.
  if (err instanceof UnsupportedError) return `Unsupported: ${err.message}`;
  if (err instanceof UnknownIdError) return `Unknown id: ${err.message}`;
  if (err instanceof LimitError) return `Too big: ${err.message}`;
  if (err instanceof DataNotLoadedError) return `No data: ${err.message}`;
  if (err instanceof RangeError) return `Out of range: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Answer one request through `post`. Never throws: every failure comes back as an `error` message. */
export async function runInWorker(req: TwinRequest, post: PostMessageFn): Promise<void> {
  if (req.type === "cancel") {
    cancelled.add(req.id);
    return;
  }
  const { id, spec } = req;
  cancelled.delete(id);
  try {
    const scenario = validate(spec);
    prepare();
    post({ type: "progress", id, phase: "building" });
    const ctx = await buildTwin(spec.store, spec.startWeek, scenario);
    if (cancelled.has(id)) return;
    // operationsOptions reads the run-time half of the scenario (patience,
    // outages, inbound lateness) and stays inside the same try, so a future
    // rejection there is reported like any other.
    const opts = operationsOptions(ctx, spec.days, spec.seed);

    const tracer = new ProgressTracer(post, id);
    const result = runOperations(ctx, opts, tracer);
    if (cancelled.has(id)) return;

    post({ type: "progress", id, phase: "compiling", day: spec.days, days: spec.days });
    const world = buildWorld(ctx.layout, workerInfos(ctx.workers, ctx.costs));
    const payload = buildWorldPayload(ctx);
    // The compiler needs the planogram to know which facing each SKU's stock
    // sits in, so a `facing` event can be drawn on the right shelf.
    const planogram = [...ctx.plan.entries()].map(([sku, facing]) => [sku, facing.id] as [string, string]);
    const playback = compilePlayback({ events: tracer.events, layout: ctx.layout, world, skus: payload.skus, planogram, suppliers: payload.suppliers });
    if (cancelled.has(id)) return;

    post({ type: "done", id, playback, world: payload, kpis: kpis(result), issues: runIssues(ctx) }, collectBuffers(playback));
  } catch (err) {
    if (cancelled.has(id)) return;
    post({ type: "error", id, message: errorMessage(err) });
  } finally {
    cancelled.delete(id);
  }
}
