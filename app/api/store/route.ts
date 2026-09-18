import { z, ZodError } from "zod";
import { UnknownIdError } from "@/lib/data/load";
import { LIMITS, LimitError, formatBytes } from "@/lib/layout/limits";
import { layoutSpecSchema } from "@/lib/layout/spec";
import { storeFloorSvg } from "@/lib/render/store-floor";
import { replicate } from "@/lib/twin/replicate";
import { buildTwin, storeSchema } from "@/lib/twin/twin";

/** A few short runs on a small building; well inside Vercel Hobby's limit. */
export const maxDuration = 30;

/**
 * Headroom over the spec itself for the rest of the body and JSON escaping.
 * Checked twice — once on the declared length, once on what actually arrived —
 * because a client may send neither honestly.
 */
const BODY_SLACK = 16_000;

const schema = z
  .object({
    layout: layoutSpecSchema,
    store: storeSchema.default("store-midtown"),
    startWeek: z.number().int().min(1).max(52).default(36),
    days: z.number().int().min(1).max(28).default(10),
    runs: z.number().int().min(1).max(5).default(2),
    merchandising: z.enum(["current", "optimized"]).default("current"),
  })
  .strict();

/**
 * Simulate an imported shop. Stateless by design: the spec arrives in the
 * request, the answer goes back, and nothing is kept — no database, no session,
 * no file on disk. The import page holds the drawing in the browser and sends
 * only the compact spec.
 */
export async function POST(request: Request) {
  const tooBig = { error: `The request is over the ${formatBytes(LIMITS.specJson)} limit for a layout spec.` };
  if (Number(request.headers.get("content-length") ?? 0) > LIMITS.specJson + BODY_SLACK) {
    return Response.json(tooBig, { status: 413 });
  }
  try {
    const raw = await request.text();
    if (raw.length > LIMITS.specJson + BODY_SLACK) return Response.json(tooBig, { status: 413 });
    const body = schema.parse(JSON.parse(raw));
    const ctx = await buildTwin(body.store, body.startWeek, { layout: body.layout, merchandising: body.merchandising });
    const rep = replicate(ctx, body.days, body.runs);
    return Response.json(
      {
        kpis: rep.mean,
        worst: rep.worst,
        bottleneck: rep.bottleneck,
        svg: storeFloorSvg({ layout: ctx.layout, title: body.layout.name }, { shadeBy: "appeal", width: 900 }),
        layout: {
          facings: ctx.layout.facings.length,
          salesAisles: ctx.layout.salesAisles.length,
          storagePositions: ctx.layout.storage.length,
          sellingSqFt: ctx.layout.sellingSqFt,
          backroomSqFt: ctx.layout.backroomSqFt,
          registers: ctx.layout.service.filter((s) => s.kind === "register").length,
          counters: ctx.layout.service.filter((s) => s.kind === "counter").length,
          eyeLevelShare: ctx.merchEval.eyeLevelShare,
          featureShare: ctx.merchEval.featureShare,
          restocksPerWeek: ctx.merchEval.restocksPerWeek,
        },
        crew: ctx.workers.length,
        changes: ctx.changes,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof ZodError) return Response.json({ error: "Invalid request", issues: err.issues.slice(0, 10) }, { status: 400 });
    if (err instanceof SyntaxError) return Response.json({ error: "Body must be JSON" }, { status: 400 });
    if (err instanceof LimitError || err instanceof UnknownIdError) return Response.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
