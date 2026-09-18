/**
 * Everything a tool's answer is made of except the model itself: the
 * annotation constants, the error wrapper every handler runs inside, the
 * number formatters, the KPI table and the deep link into the 3D page.
 *
 * Handlers never see the request URL — mcp-handler hides it and stdio has none
 * — so the site's own origin comes from the environment instead. That, and the
 * import of the Node data loader, make this module server-only: it is never in
 * a browser bundle.
 *
 * The one rule the formatters follow is that a number in a tool's answer is
 * written for a person to read out loud. $3.2k, 94%, 6 min. Raw floats are for
 * the JSON blocks, of which there are none here.
 */

import { deflateSync, strToU8 } from "fflate";
import { z, ZodError } from "zod";
import { UnknownIdError } from "../data/load";
import { LimitError } from "../layout/limits";
import type { Kpis } from "../twin/replicate";
import { WEEKDAYS } from "../twin/standards";
import { describeDisruptions, type TwinContext, type TwinScenario } from "../twin/twin";

/**
 * The site's own origin, for links in tool output. Vercel sets the production
 * domain at build time; locally it is the dev server.
 */
export const SITE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000";

/** The 3D page plays at most four weeks; the simulation tools allow eight. */
export const HASH_MAX_DAYS = 28;

/** Cap on the encoded scenario, in base64url characters, so a link stays inside every browser's URL limit. */
const HASH_MAX_SCENARIO_CHARS = 6 * 1024;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The /store page's URL hash for one run.
 *
 * Temporary: lib/store-ui/hash.ts owns this codec and exports `encodeHash`;
 * when it lands, the body of this function becomes a call to it and the format
 * below goes away. The format is deliberately the one that module documents —
 * the keys in this order, absent ones omitted, the scenario deflated and
 * base64url'd — so a link written today decodes there unchanged.
 */
export function encodeRunHash(state: { store: string; week: number; days: number; seed: number; scenario: TwinScenario }): string | null {
  const parts = [`store=${encodeURIComponent(state.store)}`, `week=${state.week}`, `days=${state.days}`, `seed=${state.seed}`];
  if (Object.keys(state.scenario).length > 0) {
    const s = base64url(deflateSync(strToU8(JSON.stringify(state.scenario)), { level: 9 }));
    if (s.length > HASH_MAX_SCENARIO_CHARS) return null;
    parts.push(`s=${s}`);
  }
  return `#${parts.join("&")}`;
}

/**
 * The page URL that replays a tool's first replication: `replicate` runs seeds
 * 1..runs, so seed 1 on the page is `rep.runs[0]`. Days are capped at the
 * page's horizon; draws happen in event order, so the first 28 days of a
 * longer run are the same days. Null when the scenario carries a layout (an
 * imported shop is up to 1 MB and is handed to the page in-browser, never in a
 * URL) or is simply too large to link.
 */
export function storeUrl(store: string, startWeek: number, days: number, scenario: TwinScenario): string | null {
  if (scenario.layout) return null;
  const hash = encodeRunHash({ store, week: startWeek, days: Math.min(days, HASH_MAX_DAYS), seed: 1, scenario });
  return hash === null ? null : `${SITE_URL}/store${hash}`;
}

/**
 * The closing line of simulate_day and what_if: how to watch the run in 3D. A
 * candystore scenario is fetched live on the server and the browser cannot
 * (candystore-mcp sends no CORS headers), so that case says so rather than
 * linking to a page that would refuse it.
 */
export function storeLink(store: string, startWeek: number, days: number, scenario: TwinScenario): string {
  if (scenario.layout) return `For an imported shop, open ${SITE_URL}/import, import the drawing and use Open in 3D.`;
  if (scenario.candystore) return `The 3D page (${SITE_URL}/store) plays the committed market snapshot only; a candystore store scenario is not replayed there.`;
  const url = storeUrl(store, startWeek, days, scenario);
  if (!url) return `This scenario is too large for a link; enter it on ${SITE_URL}/store to watch it in 3D.`;
  if (days > HASH_MAX_DAYS) return `Watch the first ${HASH_MAX_DAYS} days of this run in 3D (seed 1, same draws): ${url}`;
  return `Watch this run in 3D (seed 1 replays exactly): ${url}`;
}

export const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Tools that accept a `candystore` scenario may call its live API. */
export const readOnlyOpenWorld = { ...readOnly, openWorldHint: true };

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function error(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

/**
 * Run a handler and turn the failures a caller can fix — an unknown shop or
 * worker, a shift that closes before it opens, an argument out of range,
 * candystore rejecting a scenario — into an isError result carrying the reason,
 * rather than a protocol error the caller cannot read.
 */
export async function guarded(fn: () => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnknownIdError || err instanceof LimitError) return error(err.message);
    if (err instanceof ZodError) return error(`Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (err instanceof Error && /candystore|fetch|abort|timeout/i.test(`${err.name} ${err.message}`)) return error(`Could not get the candystore scenario: ${err.message}`);
    throw err;
  }
}

/**
 * The minus goes in front of the dollar sign, not after it: "−$728" reads as
 * money owed, "$-728" reads as a typo.
 */
export function money(d: number): string {
  const abs = Math.abs(d);
  const sign = d < 0 ? "−" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${sign}$${Math.round(abs / 1e3)}k`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export function dollars2(d: number): string {
  return `${d < 0 ? "−" : ""}$${Math.abs(d).toFixed(2)}`;
}

export function fmtInt(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}

export function fmt1(x: number): string {
  return (Math.round(x * 10) / 10).toLocaleString("en-US");
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(Math.abs(x) < 0.1 && x !== 0 ? 1 : 0)}%`;
}

/** For shares that live in the last percent or two, where a whole point is the whole story. */
export function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function hours(min: number): string {
  if (min < 90) return `${Math.round(min)} min`;
  return `${fmt1(min / 60)} h`;
}

/** A queue wait, which is short enough that the tenths matter. */
export function waitMin(min: number): string {
  return `${fmt1(min)} min`;
}

export function signed(x: number, f: (v: number) => string): string {
  if (Math.abs(x) < 1e-9) return "±0";
  return `${x > 0 ? "+" : "−"}${f(Math.abs(x))}`;
}

export function dayLabel(day: number): string {
  return `day ${day} (${WEEKDAYS[((day % 7) + 7) % 7]})`;
}

/** Minutes after midnight as a clock time, for a peak half hour. */
export function clockOf(minuteOfDay: number): string {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** What the scenario actually did, echoed back so a caller can see it landed. */
export function scenarioLine(ctx: TwinContext): string {
  const parts = [...ctx.changes, ...describeDisruptions(ctx.scenario)];
  return parts.length ? `Scenario: ${parts.join("; ")}.` : "Scenario: baseline.";
}

/** The shop, named the way a person would name it. */
export function storeName(ctx: TwinContext): string {
  return `${ctx.site.name} (${ctx.site.id})`;
}

/**
 * A markdown table of KPIs, one column per labelled set.
 *
 * A row is a label, the number the delta column subtracts, the formatter, and
 * optionally a cell renderer for the rows that carry a second figure in
 * brackets — restocks and the hot ones among them, walk-outs and the rate they
 * are, the p90 beside the average wait. The bracketed figure is context for
 * the number in front of it, so the delta stays on the first.
 */
export function kpiTable(columns: Array<[string, Kpis]>, delta = false): string {
  const pair = (a: string, b: string) => `${a} (${b})`;
  const rows: Array<[string, (k: Kpis) => number, (v: number) => string, ((k: Kpis) => string)?]> = [
    ["Customers in", (k) => k.customers, fmtInt],
    ["Transactions (conversion)", (k) => k.transactions, fmtInt, (k) => pair(fmtInt(k.transactions), pct(k.conversionRate))],
    ["Units sold", (k) => k.unitsSold, fmtInt],
    ["Sales", (k) => k.salesDollars, money],
    ["Average basket", (k) => k.averageBasket, dollars2],
    ["Lost sales, empty shelf", (k) => k.lostShelfDollars, money],
    ["Lost sales, walked out", (k) => k.lostQueueDollars, money],
    ["Lost sales share", (k) => k.lostSalesShare, pct1],
    ["On-shelf availability", (k) => k.onShelfShare, pct1],
    ["Empty-facing hours", (k) => k.emptyFacingHours, fmt1],
    ["Restocks (hot)", (k) => k.restocks, fmt1, (k) => pair(fmt1(k.restocks), fmt1(k.hotRestocks))],
    ["Counter wait, avg (p90)", (k) => k.counterWaitAvgMin, waitMin, (k) => pair(waitMin(k.counterWaitAvgMin), waitMin(k.counterWaitP90Min))],
    ["Register wait, avg (p90)", (k) => k.registerWaitAvgMin, waitMin, (k) => pair(waitMin(k.registerWaitAvgMin), waitMin(k.registerWaitP90Min))],
    ["Worst wait", (k) => k.worstWaitMin, waitMin],
    ["Walk-outs (rate)", (k) => k.abandoned, fmt1, (k) => pair(fmt1(k.abandoned), pct1(k.abandonRate))],
    ["Gift wraps", (k) => k.giftWraps, fmt1],
    ["Special orders (late)", (k) => k.ordersPlaced, fmt1, (k) => pair(fmt1(k.ordersPlaced), fmt1(k.ordersLate))],
    ["Order $ cut, no stock", (k) => k.orderCutDollars, money],
    ["Van rounds (late)", (k) => k.vanRounds, fmt1, (k) => pair(fmt1(k.vanRounds), fmt1(k.vanLateRounds))],
    ["Dock-to-stock avg", (k) => k.dockToStockAvgMin, hours],
    ["Paid hours (overtime)", (k) => k.paidHours, fmt1, (k) => pair(fmt1(k.paidHours), fmt1(k.overtimeHours))],
    ["Labor utilization", (k) => k.utilization, pct],
    ["Labor cost", (k) => k.laborCost, money],
    ["Labor per $100 of sales", (k) => k.laborShareOfSales, (v) => dollars2(v * 100)],
    ["Sales per paid hour", (k) => k.salesPerPaidHour, money],
    ["Registers busy (counter)", (k) => k.registerUtilization, pct, (k) => pair(pct(k.registerUtilization), pct(k.counterUtilization))],
    ["Absences", (k) => k.absences, fmt1],
  ];
  const showDelta = delta && columns.length === 2;
  const head = `| KPI | ${columns.map((c) => c[0]).join(" | ")} |${showDelta ? " change |" : ""}`;
  const sep = `|---|${columns.map(() => "---:").join("|")}|${showDelta ? "---:|" : ""}`;
  const body = rows.map(([label, get, f, cell]) => {
    const cells = columns.map((c) => (cell ? cell(c[1]) : f(get(c[1]))));
    const d = showDelta ? ` ${signed(get(columns[1][1]) - get(columns[0][1]), f)} |` : "";
    return `| ${label} | ${cells.join(" | ")} |${d}`;
  });
  return [head, sep, ...body].join("\n");
}

export const daysSchema = z.number().int().min(1).max(56).describe("Days to simulate from the Monday of startWeek.");
export const runsSchema = z.number().int().min(1).max(20).describe("Replications with different random draws; the table reports the mean.");

export type ScenarioArgs = TwinScenario;
export { z };
