/**
 * Every number the page, the inspector and the report show a reader.
 *
 * Deterministic on purpose: the separators, the decimal point and the rounding
 * are done here rather than handed to `Intl`, whose output depends on the ICU
 * build the browser or the Node process happens to carry. A screenshot taken on
 * one machine has to match the one taken on another, and a report copied out of
 * the page has to match the one an MCP tool prints.
 *
 * Units, throughout: feet, minutes, dollars. Selling units are pieces for a
 * SKU that sells by the each and POUNDS for one that sells by weight, which is
 * why `units` takes the SKU's `sellBy` rather than guessing.
 *
 * This module also holds the KPI table — label, formatter, and whether a rise
 * is bad — that the HUD, the compare panel and the report all read, so a metric
 * is worded and coloured the same everywhere.
 */

import type { Kpis } from "../twin/replicate";
import { WEEKDAYS } from "../twin/standards";
import type { SellBy } from "../twin/types";

/** What a formatter prints when it is handed a NaN or an infinity. */
const NONE = "–";

/** Thousands separators and fixed decimals, hand-rolled so the output never depends on the host's ICU data. */
function group(n: number, digits: number): string {
  const sign = n < 0 ? "-" : "";
  const fixed = Math.abs(n).toFixed(digits);
  const dot = fixed.indexOf(".");
  const whole = dot < 0 ? fixed : fixed.slice(0, dot);
  const frac = dot < 0 ? "" : fixed.slice(dot);
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + frac;
}

/** A plain count: "4,812". */
export function count(n: number, digits = 0): string {
  return Number.isFinite(n) ? group(n, digits) : NONE;
}

/** Dollars in full: "$118,240", or "$21.40" with cents. */
export function money(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return NONE;
  return `${n < 0 ? "-" : ""}$${group(Math.abs(n), digits)}`;
}

/** Dollars in a column that has to stay narrow: "$3.2k", "$1.18M". Under a thousand it is just the number. */
export function compactMoney(n: number): string {
  if (!Number.isFinite(n)) return NONE;
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}k`;
  return `${sign}$${group(a, 0)}`;
}

/** A fraction as a percentage: percent(0.973, 1) is "97.3%". */
export function percent(f: number, digits = 0): string {
  return Number.isFinite(f) ? `${group(f * 100, digits)}%` : NONE;
}

/**
 * A duration. Under an hour it keeps one decimal, because the difference
 * between a 4.2-minute and a 6.1-minute queue is the whole question; past an
 * hour the decimal stops meaning anything, so it becomes "1 h 12 min".
 */
export function minutes(m: number): string {
  if (!Number.isFinite(m)) return NONE;
  const v = Math.max(0, m);
  if (v < 60) return `${group(v, v < 10 ? 1 : v < 60 ? 1 : 0)} min`;
  const total = Math.round(v);
  const h = Math.floor(total / 60);
  const rest = total % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

/** Pounds, to a tenth while it is small enough for the tenth to matter. */
export function weight(lb: number): string {
  return Number.isFinite(lb) ? `${group(lb, lb < 100 ? 1 : 0)} lb` : NONE;
}

/**
 * Selling units in the shop's own vocabulary: pieces for an "each" SKU, pounds
 * for one sold by weight. Getting this wrong makes a bulk bin read as if it
 * held forty thousand gummy bears.
 */
export function units(n: number, sellBy: SellBy = "each"): string {
  if (!Number.isFinite(n)) return NONE;
  return sellBy === "weight" ? weight(n) : `${group(n, 0)} pc`;
}

export function feet(ft: number): string {
  return Number.isFinite(ft) ? `${group(Math.round(ft), 0)} ft` : NONE;
}

/** 1 = Monday … 7 = Sunday, as the site's hours and delivery days number them. */
export function weekday(d: number): string {
  return WEEKDAYS[d - 1] ?? String(d);
}

// ---------------------------------------------------------------------------
// The KPI table
// ---------------------------------------------------------------------------

export interface KpiMeta {
  key: keyof Kpis;
  label: string;
  fmt: (v: number) => string;
  /** replicate.ts ranks the worst run by these: a rise is a worse week. */
  higherIsWorse: boolean;
}

/**
 * replicate.ts keeps this set private, so it is restated here and pinned by a
 * test. It has to agree, or a delta on the page would be coloured green for a
 * change the tools call the worst run of the batch.
 */
export const HIGHER_IS_WORSE: ReadonlySet<keyof Kpis> = new Set<keyof Kpis>([
  "lostShelfDollars",
  "lostQueueDollars",
  "lostSalesShare",
  "shortAtShelf",
  "emptyFacingHours",
  "hotRestocks",
  "counterWaitAvgMin",
  "counterWaitP90Min",
  "registerWaitAvgMin",
  "registerWaitP90Min",
  "worstWaitMin",
  "abandoned",
  "abandonRate",
  "ordersLate",
  "orderLateMinTotal",
  "orderCutDollars",
  "vanLateRounds",
  "dockToStockAvgMin",
  "dockToStockP90Min",
  "palletsNotPutAway",
  "overtimeHours",
  "absences",
  "laborCost",
  "laborShareOfSales",
]);

const meta = (key: keyof Kpis, label: string, fmt: (v: number) => string): KpiMeta => ({ key, label, fmt, higherIsWorse: HIGHER_IS_WORSE.has(key) });

/** Every KPI in the order a reader wants them: what sold, what did not, whether the candy was in front of anyone, who waited, what left, what arrived, what it cost. */
export const KPI_META: readonly KpiMeta[] = [
  meta("customers", "Customers", (v) => count(v)),
  meta("transactions", "Transactions", (v) => count(v)),
  meta("unitsSold", "Units sold", (v) => count(v)),
  meta("salesDollars", "Sales", (v) => money(v)),
  meta("averageBasket", "Average basket", (v) => money(v, 2)),
  meta("conversionRate", "Conversion", (v) => percent(v, 1)),

  meta("lostShelfDollars", "Lost to an empty shelf", (v) => money(v)),
  meta("lostQueueDollars", "Lost to the queue", (v) => money(v)),
  meta("lostSalesShare", "Lost share of demand", (v) => percent(v, 1)),

  meta("onShelfShare", "On the shelf", (v) => percent(v, 1)),
  meta("shortAtShelf", "Shelf came up short", (v) => count(v)),
  meta("emptyFacingHours", "Empty facing hours", (v) => count(v, 1)),
  meta("restocks", "Restocks", (v) => count(v)),
  meta("hotRestocks", "Hot restocks", (v) => count(v)),

  meta("counterWaitAvgMin", "Counter wait", (v) => minutes(v)),
  meta("counterWaitP90Min", "Counter wait p90", (v) => minutes(v)),
  meta("registerWaitAvgMin", "Register wait", (v) => minutes(v)),
  meta("registerWaitP90Min", "Register wait p90", (v) => minutes(v)),
  meta("worstWaitMin", "Worst wait", (v) => minutes(v)),
  meta("abandoned", "Walked out", (v) => count(v)),
  meta("abandonRate", "Walk-out rate", (v) => percent(v, 1)),
  meta("giftWraps", "Gifts wrapped", (v) => count(v)),

  meta("ordersPlaced", "Special orders", (v) => count(v)),
  meta("ordersLate", "Orders late", (v) => count(v)),
  meta("orderLateMinTotal", "Order late minutes", (v) => count(v)),
  meta("orderCutDollars", "Order lines cut", (v) => money(v)),
  meta("vanRounds", "Van rounds", (v) => count(v)),
  meta("vanLateRounds", "Van rounds late", (v) => count(v)),

  meta("inboundTrucks", "Inbound trucks", (v) => count(v)),
  meta("inboundCases", "Inbound cases", (v) => count(v)),
  meta("dockToStockAvgMin", "Dock to shelf", (v) => minutes(v)),
  meta("dockToStockP90Min", "Dock to shelf p90", (v) => minutes(v)),
  meta("palletsNotPutAway", "Pallets left on the dock", (v) => count(v)),

  meta("paidHours", "Paid hours", (v) => count(v, 1)),
  meta("overtimeHours", "Overtime hours", (v) => count(v, 1)),
  meta("busyHours", "Busy hours", (v) => count(v, 1)),
  meta("utilization", "Utilization", (v) => percent(v)),
  meta("absences", "Absences", (v) => count(v)),
  meta("laborCost", "Labor cost", (v) => money(v)),
  meta("laborShareOfSales", "Labor share of sales", (v) => percent(v, 1)),
  meta("salesPerPaidHour", "Sales per paid hour", (v) => money(v, 2)),

  meta("registerUtilization", "Register utilization", (v) => percent(v)),
  meta("counterUtilization", "Counter utilization", (v) => percent(v)),
];

export const KPI_BY_KEY: ReadonlyMap<keyof Kpis, KpiMeta> = new Map(KPI_META.map((m) => [m.key, m]));

/** A change from run a to run b: the text with its sign, and the class that colours it. */
export interface Delta {
  /** "+$1.2k", "−6.1 min", "±0". */
  text: string;
  sign: "+" | "−" | "";
  /** "good" when the run improved, "bad" when it got worse, "" when it did not move. */
  cls: "good" | "bad" | "";
}

/**
 * The signed change in a metric, formatted with that metric's own formatter and
 * coloured by whether a rise is bad for it. Changes under 1e-9 read as "±0"
 * rather than as a stray rounding artefact.
 */
export function delta(key: keyof Kpis, a: number, b: number): Delta {
  const m = KPI_BY_KEY.get(key);
  const d = b - a;
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return { text: "±0", sign: "", cls: "" };
  const sign = d > 0 ? "+" : "−";
  const worse = HIGHER_IS_WORSE.has(key) ? d > 0 : d < 0;
  const body = m ? m.fmt(Math.abs(d)) : count(Math.abs(d), 2);
  return { text: `${sign}${body}`, sign, cls: worse ? "bad" : "good" };
}
