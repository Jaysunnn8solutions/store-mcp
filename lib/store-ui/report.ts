/**
 * The run write-up: what the shop did, where it jammed, and what to change.
 *
 * Everything here is the engine's own accounting — the same numbers the MCP
 * tools print — reduced into a headline, a handful of findings, a day-by-day
 * table and a ranked list of things to try.
 *
 * The recommendations are a **rule engine, not an optimizer**. Each rule is a
 * threshold somebody who has run a shop would recognise, it fires on evidence
 * it names, and it points at the one scenario field to change and the tab that
 * field lives on. Nothing here searches: it cannot tell you the best number of
 * registers, only that the queue is costing you money and which knob moves it.
 * Change one input, run again, compare. That honesty is the point — a reader
 * who can see the rule can disagree with it.
 *
 * Pure: KPIs and an OperationsResult in, strings out. No DOM, no fetch, no
 * playback (so a tool can write the same report server-side).
 */

import type { OperationsResult } from "../twin/operations";
import type { Kpis } from "../twin/replicate";
import { PROCESS_SKILL, PROCESSES, type Process } from "../twin/types";
import { count, delta, KPI_META, minutes, money, percent, weekday } from "./format";

/** The five input tabs on the 3D page, plus the deliveries tab the van and the pick window live on. */
export const REPORT_TABS = ["Labor", "Demand", "Supply", "Store", "Deliveries", "Disruptions"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export interface Recommendation {
  /** What to do, in a few words. */
  title: string;
  /** Why, with the numbers it fired on. */
  detail: string;
  /** The scenario field to change, e.g. "registers" or "times.pickStart". */
  field: string;
  /** The tab that field lives on. */
  tab: ReportTab;
  /** What is at stake, as one figure. */
  impact: string;
}

export interface ReportInput {
  kpis: Kpis;
  result: OperationsResult;
  ctx: { storeName: string; startWeek: number; days: number; seed: number; changes: string[] };
  /** The run before this one, when there was one: buildReport uses it for a "since last run" finding. */
  previous?: Kpis;
}

export interface Report {
  /** One sentence a reader can stop after. */
  headline: string;
  findings: string[];
  recommendations: Recommendation[];
  /** One row per horizon day, raw numbers, keyed by DAY_COLUMNS. */
  days: Array<Record<string, string | number>>;
}

/** Severity is used to rank and then dropped: the published shape is the same for every rule. */
type Severity = "high" | "medium" | "low";
interface Rule extends Recommendation {
  severity: Severity;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** A ratio, or null when the denominator is zero — the report prints "—" rather than a NaN. */
function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// The day table
// ---------------------------------------------------------------------------

/** The day columns, once: the record keys, the CSV headers and how Markdown renders each. */
export const DAY_COLUMNS: ReadonlyArray<{ key: string; header: string; fmt: (v: string | number) => string }> = [
  { key: "day", header: "day", fmt: (v) => String(v) },
  { key: "weekday", header: "weekday", fmt: (v) => String(v) },
  { key: "week", header: "calendar_week", fmt: (v) => String(v) },
  { key: "open", header: "open", fmt: (v) => String(v) },
  { key: "customers", header: "customers", fmt: (v) => count(Number(v)) },
  { key: "transactions", header: "transactions", fmt: (v) => count(Number(v)) },
  { key: "unitsSold", header: "units_sold", fmt: (v) => count(Number(v)) },
  { key: "salesDollars", header: "sales_dollars", fmt: (v) => money(Number(v)) },
  { key: "lostShelfDollars", header: "lost_shelf_dollars", fmt: (v) => money(Number(v)) },
  { key: "lostQueueDollars", header: "lost_queue_dollars", fmt: (v) => money(Number(v)) },
  { key: "walkedOut", header: "walked_out", fmt: (v) => count(Number(v)) },
  { key: "counterWaitMin", header: "counter_wait_min", fmt: (v) => minutes(Number(v)) },
  { key: "registerWaitMin", header: "register_wait_min", fmt: (v) => minutes(Number(v)) },
  { key: "worstWaitMin", header: "worst_wait_min", fmt: (v) => minutes(Number(v)) },
  { key: "restocks", header: "restocks", fmt: (v) => count(Number(v)) },
  { key: "hotRestocks", header: "hot_restocks", fmt: (v) => count(Number(v)) },
  { key: "shelfShorts", header: "short_at_shelf", fmt: (v) => count(Number(v)) },
  { key: "ordersDue", header: "orders_due", fmt: (v) => count(Number(v)) },
  { key: "ordersLate", header: "orders_late", fmt: (v) => count(Number(v)) },
  { key: "inboundTrucks", header: "inbound_trucks", fmt: (v) => count(Number(v)) },
  { key: "inboundCases", header: "inbound_cases", fmt: (v) => count(Number(v)) },
  { key: "overtimeHours", header: "overtime_hours", fmt: (v) => count(Number(v), 1) },
  { key: "absences", header: "absences", fmt: (v) => count(Number(v)) },
];

function buildDays(result: OperationsResult): Array<Record<string, string | number>> {
  return result.daily.map((d) => ({
    day: d.day + 1,
    weekday: weekday(d.weekday),
    week: d.calendarWeek,
    open: d.open ? "yes" : "dark",
    customers: d.customers,
    transactions: d.transactions,
    unitsSold: r2(d.unitsSold),
    salesDollars: r2(d.salesDollars),
    lostShelfDollars: r2(d.lostShelfDollars),
    lostQueueDollars: r2(d.lostQueueDollars),
    walkedOut: d.abandoned,
    counterWaitMin: r2(d.counterWaitAvgMin),
    registerWaitMin: r2(d.registerWaitAvgMin),
    worstWaitMin: r2(d.worstWaitMin),
    restocks: d.restocks,
    hotRestocks: d.hotRestocks,
    shelfShorts: d.shortAtShelf,
    ordersDue: d.ordersDue,
    ordersLate: d.ordersLate,
    inboundTrucks: d.inboundTrucks,
    inboundCases: d.inboundCases,
    overtimeHours: r2(d.overtimeHours),
    absences: d.absences,
  }));
}

/** The trading day the shop struggled most on, by lost dollars then by the worst wait. Named in the recommendations so a fix has a shift to go on. */
function worstDay(result: OperationsResult): OperationsResult["daily"][number] | null {
  let best: OperationsResult["daily"][number] | null = null;
  for (const d of result.daily) {
    if (!d.open) continue;
    const lost = d.lostQueueDollars + d.lostShelfDollars;
    const bestLost = best ? best.lostQueueDollars + best.lostShelfDollars : -1;
    if (!best || lost > bestLost || (lost === bestLost && d.worstWaitMin > best.worstWaitMin)) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Each rule states the evidence it fired on and names one field on one tab.
 * The order below is the order they are evaluated in; the returned list is
 * sorted by severity, so the thing costing the most money is first.
 */
export function recommend(input: ReportInput): Recommendation[] {
  const { kpis: k, result } = input;
  const out: Rule[] = [];
  const bad = worstDay(result);
  const onBad = bad ? ` Worst on ${weekday(bad.weekday)} of week ${bad.calendarWeek}.` : "";
  const res = result.resources;
  const b = result.bottleneck;

  // 1. The till queue. A shopper who walks out of the line is this model's
  //    version of a truck leaving late: the basket is already in their hand.
  if (result.service.abandonedRegister > 0 || k.registerWaitP90Min > 5) {
    const tillHot = res.registers.utilization > 0.7;
    out.push({
      severity: k.lostQueueDollars > 0.01 * k.salesDollars ? "high" : "medium",
      title: tillHot ? "Open another register" : "Put a cashier on the afternoon peak",
      detail: `The till queue ran ${minutes(k.registerWaitAvgMin)} on average and ${minutes(k.registerWaitP90Min)} at the ninetieth percentile, with ${res.registers.count} register(s) at ${percent(res.registers.utilization)} utilization. ${count(result.service.abandonedRegister)} shopper(s) put the basket down and left.${onBad}`,
      field: tillHot ? "registers" : "addWorkers",
      tab: tillHot ? "Store" : "Labor",
      impact: `${money(k.lostQueueDollars)} of baskets abandoned in the line`,
    });
  }

  // 2. The showcase. Counter work needs a food handler's card, so the cheap
  //    fix is a trained body, not another station.
  if (result.service.abandonedCounter > 0 || k.counterWaitP90Min > 8) {
    const glassHot = res.counters.count > 0 && res.counters.utilization > 0.75;
    out.push({
      severity: result.service.abandonedCounter > 0 ? "high" : "medium",
      title: glassHot ? "Add a serving position behind the glass" : "Add a second counter clerk on the peak",
      detail: `Waits at the showcase averaged ${minutes(k.counterWaitAvgMin)}, ${minutes(k.counterWaitP90Min)} at p90, across ${res.counters.count} station(s) at ${percent(res.counters.utilization)}. ${count(result.sales.counterServed)} of ${count(result.sales.counterCustomers)} shoppers who wanted the counter were served; ${count(result.service.abandonedCounter)} gave up.${onBad}`,
      field: glassHot ? "counters" : "addWorkers",
      tab: glassHot ? "Store" : "Labor",
      impact: `${count(result.service.abandonedCounter)} shopper(s) lost at the glass`,
    });
  }

  // 3. The shelf is the pick face. An empty facing is a lost sale even with a
  //    full stockroom, which is the difference between this and a warehouse.
  if (k.lostShelfDollars > 0 || k.onShelfShare < 0.985) {
    out.push({
      severity: k.lostShelfDollars > 0.01 * k.salesDollars ? "high" : "medium",
      title: "Bigger facings on the top movers",
      detail: `The candy a shopper reached for was on the shelf ${percent(k.onShelfShare, 1)} of the time; ${count(k.shortAtShelf)} reaches came up empty and ${count(k.emptyFacingHours, 1)} facing-hours were dry. Sizing a facing to more days of demand is the cheapest fix: it does not add stockroom cases, it just stops the shelf running dry between fills.`,
      field: "facingDays",
      tab: "Store",
      impact: `${money(k.lostShelfDollars)} off an empty shelf`,
    });
  }

  // 4. Hot restocks are interruptions: somebody stops what they are doing and
  //    goes and fetches, usually in the middle of trading.
  const hotShare = ratio(k.hotRestocks, k.restocks);
  if (hotShare !== null && hotShare > 0.15 && k.hotRestocks >= 5) {
    out.push({
      severity: "medium",
      title: "Fill the shelves before the doors open",
      detail: `${count(k.hotRestocks)} of ${count(k.restocks)} restocks were hot (${percent(hotShare)}): the shelf was already empty when somebody went for it. A longer pre-open stocking window, or re-merchandising so the fast movers sit where they are easy to fill, turns these into planned work.`,
      field: "merchandising",
      tab: "Store",
      impact: `${count(k.hotRestocks)} interruptions during trading`,
    });
  }

  // 5. Special orders. The van leaving late is the one deadline the shop has.
  if (k.ordersLate > 0 || k.vanLateRounds > 0) {
    const pickBound = b.process === "pick" || b.process === "pack";
    out.push({
      severity: "high",
      title: pickBound ? "Start the pre-open pick earlier" : "Let the van leave a little later",
      detail: `${count(k.ordersLate)} of ${count(k.ordersPlaced)} special orders missed their time, ${minutes(k.orderLateMinTotal)} late in total, and ${count(k.vanLateRounds)} of ${count(k.vanRounds)} van rounds left late. The bottleneck was ${b.process ?? "unclear"} (${count(b.waitHours, 1)} job-hours of waiting; ${b.constraint}), so ${pickBound ? "the picking and packing window before the doors open is what binds" : "the round itself is what binds"}.`,
      field: pickBound ? "times.pickStart" : "times.vanDeparture",
      tab: "Deliveries",
      impact: `${count(k.ordersLate)} late order(s), ${minutes(k.orderLateMinTotal)} in total`,
    });
  }

  // 6. Cut lines are stock that was never there to sell.
  if (k.orderCutDollars > 0) {
    out.push({
      severity: k.orderCutDollars > 0.01 * k.salesDollars ? "high" : "medium",
      title: "Hold more safety stock",
      detail: `${money(k.orderCutDollars)} of special-order lines were cut for want of stock (${count(result.orders.cutLines)} lines). A higher service level holds more cover against a late trailer and a busy week; it costs carrying, so check what it does to the stockroom before keeping it.`,
      field: "serviceLevel",
      tab: "Supply",
      impact: `${money(k.orderCutDollars)} of orders cut`,
    });
  }

  // 7. Goods sitting on the apron are not on the shelf, and they are in the way.
  if (k.palletsNotPutAway > 0 || k.dockToStockP90Min > 180) {
    out.push({
      severity: k.palletsNotPutAway > 0 ? "medium" : "low",
      title: "More hands, or another jack, on the overnight delivery",
      detail: `Dock to stockroom took ${minutes(k.dockToStockAvgMin)} on average and ${minutes(k.dockToStockP90Min)} at p90, and ${count(k.palletsNotPutAway)} pallet(s) were still on the apron at the end. ${res.palletJacks.count} pallet jack(s) ran at ${percent(res.palletJacks.utilization)}; trucks waited ${minutes(result.inbound.doorWaitAvgMin)} for a goods door.`,
      field: res.palletJacks.utilization > 0.6 ? "palletJacks" : "addWorkers",
      tab: res.palletJacks.utilization > 0.6 ? "Store" : "Labor",
      impact: `${count(k.palletsNotPutAway)} pallet(s) not away, p90 ${minutes(k.dockToStockP90Min)}`,
    });
  }

  // 8. Overtime buys the same hours at one and a half times the price.
  const otShare = ratio(k.overtimeHours, k.paidHours);
  if (otShare !== null && otShare > 0.05) {
    out.push({
      severity: otShare > 0.15 ? "high" : "medium",
      title: "Swap the overtime for a part-timer",
      detail: `${count(k.overtimeHours, 1)} overtime hours, ${percent(otShare)} of paid hours, costing ${money(result.labor.overtimeCost)} — ${result.daily.filter((d) => d.overtimeHours > 0).length} day(s) ran past the shift. A part-timer on the heavy days buys the same cover at straight time.`,
      field: "addWorkers",
      tab: "Labor",
      impact: `${money(result.labor.overtimeCost)} of overtime premium`,
    });
  }

  // 9. A counter queue with an idle floor is a training problem, not a staffing
  //    one: `counter` needs a food handler's card, so nobody can cover it.
  const serve = result.processes.serve;
  if (serve.jobs > 0 && serve.waitTotalMin / serve.jobs > 3 && k.utilization < 0.8) {
    out.push({
      severity: "medium",
      title: "Cross-train somebody on the counter",
      detail: `Counter jobs waited ${minutes(serve.waitTotalMin / serve.jobs)} on average, up to ${minutes(serve.waitMaxMin)}, while the crew as a whole ran at ${percent(k.utilization)}. The counter needs a food handler's card, so nobody else can step in until somebody has one — a fortnight of training, then the peak covers itself.`,
      field: "crossTrain",
      tab: "Labor",
      impact: `${minutes(serve.waitTotalMin / serve.jobs)} average wait at the glass`,
    });
  }

  // 10. Slack with nothing going wrong is the one finding worth acting on in
  //     the other direction.
  if (k.utilization < 0.55 && k.abandoned === 0 && k.ordersLate === 0 && k.paidHours > 0) {
    out.push({
      severity: "low",
      title: "Trim the roster, or find out where this crew breaks",
      detail: `The crew ran at ${percent(k.utilization)}: ${count(k.paidHours - k.busyHours, 0)} of ${count(k.paidHours, 0)} paid hours were idle, with nobody walking out and every order on time. Either take the hours out, or push demand up until the first shopper leaves and see how much more this shop can sell as it stands.`,
      field: "demandScale",
      tab: "Demand",
      impact: `${count(k.paidHours - k.busyHours, 0)} idle paid hours`,
    });
  }

  // 11. Absences.
  const shifts = result.workers.reduce((a, w) => a + w.shiftsWorked + w.absences, 0);
  const absentShare = ratio(result.labor.absences, shifts);
  if (absentShare !== null && absentShare > 0.1) {
    out.push({
      severity: "low",
      title: "Cover the sick days",
      detail: `${count(result.labor.absences)} absences over ${count(shifts)} scheduled shifts (${percent(absentShare)}). The rate is itself a scenario input; cross-training is what makes a missing counter clerk or driver survivable.`,
      field: "absenteeism",
      tab: "Disruptions",
      impact: `${percent(absentShare)} of shifts uncovered`,
    });
  }

  // 12. Work queuing somewhere that is not the bottleneck is usually flexing,
  //     not hiring.
  const idle: Process[] = PROCESSES.filter((p) => {
    const s = result.processes[p];
    return s.jobs > 0 && s.waitTotalMin / s.jobs > 45 && p !== b.process;
  });
  for (const p of idle.slice(0, 2)) {
    const s = result.processes[p];
    out.push({
      severity: "low",
      title: `Let idle people pick up ${p}`,
      detail: `${p} jobs waited ${minutes(s.waitTotalMin / s.jobs)} on average (max ${minutes(s.waitMaxMin)}, queue up to ${s.maxQueue}), ${percent(ratio(s.equipmentWaitMin, s.waitTotalMin) ?? 0)} of it held by a till, a counter or a cart rather than by a person. It takes the ${PROCESS_SKILL[p]} skill.`,
      field: "flex",
      tab: "Labor",
      impact: `${minutes(s.waitTotalMin / s.jobs)} average wait on ${p}`,
    });
  }

  if (out.length === 0) {
    out.push({
      severity: "low",
      title: "Nothing to fix in this week",
      detail: `Nobody walked out, the shelf held at ${percent(k.onShelfShare, 1)}, every special order left on time, and the crew ran at ${percent(k.utilization)} with ${count(k.overtimeHours, 1)} overtime hours. This is a rule engine, not a search: it only fires on trouble.`,
      field: "demandScale",
      tab: "Demand",
      impact: "no rule fired",
    });
  }

  return out
    .sort((a, b2) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b2.severity])
    .map(({ title, detail, field, tab, impact }) => ({ title, detail, field, tab, impact }));
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function buildFindings(input: ReportInput): string[] {
  const { kpis: k, result, previous } = input;
  const out: string[] = [];
  const lost = k.lostShelfDollars + k.lostQueueDollars;
  out.push(`${count(k.customers)} shoppers came in and ${count(k.transactions)} bought something (${percent(k.conversionRate, 1)}), for ${money(k.salesDollars)} at ${money(k.averageBasket, 2)} a basket.`);
  out.push(`${money(lost)} did not ring up: ${money(k.lostShelfDollars)} because the shelf was empty and ${money(k.lostQueueDollars)} because somebody would not stand in the line — ${percent(k.lostSalesShare, 1)} of everything the shop could have sold.`);
  out.push(`Waits: ${minutes(k.registerWaitAvgMin)} at the till (p90 ${minutes(k.registerWaitP90Min)}), ${minutes(k.counterWaitAvgMin)} at the showcase (p90 ${minutes(k.counterWaitP90Min)}); the worst single wait was ${minutes(k.worstWaitMin)} and ${count(k.abandoned)} shoppers walked out.`);
  out.push(`The candy was in front of the customer ${percent(k.onShelfShare, 1)} of the time, off ${count(k.restocks)} restocks of which ${count(k.hotRestocks)} were hot.`);
  out.push(`${count(k.ordersPlaced)} special orders, ${count(k.ordersLate)} late, ${money(k.orderCutDollars)} cut; ${count(k.vanRounds)} van rounds with ${count(k.vanLateRounds)} leaving late.`);
  out.push(`${count(k.inboundTrucks)} deliveries brought ${count(k.inboundCases)} cases; dock to stockroom ${minutes(k.dockToStockAvgMin)} (p90 ${minutes(k.dockToStockP90Min)}), ${count(k.palletsNotPutAway)} pallets never put away.`);
  out.push(`${count(k.paidHours, 1)} paid hours (${count(k.overtimeHours, 1)} overtime) at ${percent(k.utilization)} utilization cost ${money(k.laborCost)}, ${percent(k.laborShareOfSales, 1)} of sales, ${money(k.salesPerPaidHour, 2)} sold per paid hour.`);
  out.push(`Bottleneck: ${result.bottleneck.process ? `${result.bottleneck.process}, about ${count(result.bottleneck.waitHours, 1)} job-hours of waiting — ${result.bottleneck.constraint}.` : result.bottleneck.constraint}`);
  out.push(`Registers ran at ${percent(result.resources.registers.utilization)} across ${result.resources.registers.count}; counters at ${percent(result.resources.counters.utilization)} across ${result.resources.counters.count}.`);
  if (previous) {
    const moved = KPI_META.map((m) => ({ m, d: delta(m.key, previous[m.key], k[m.key]) }))
      .filter((x) => x.d.cls !== "")
      .sort((a, b) => (a.d.cls === b.d.cls ? 0 : a.d.cls === "bad" ? -1 : 1))
      .slice(0, 4);
    if (moved.length) out.push(`Against the previous run: ${moved.map((x) => `${x.m.label} ${x.d.text}`).join(", ")}.`);
  }
  return out;
}

export function buildReport(input: ReportInput): Report {
  const { kpis: k, result, ctx } = input;
  const lost = k.lostShelfDollars + k.lostQueueDollars;
  const headline =
    `${ctx.storeName} took ${money(k.salesDollars)} from ${count(k.customers)} shoppers over ${ctx.days} day${ctx.days === 1 ? "" : "s"} from week ${ctx.startWeek} (seed ${ctx.seed}), ` +
    `left ${money(lost)} on the table — ${count(k.abandoned)} walked out of a queue, ${percent(k.onShelfShare, 1)} of reaches found stock — ` +
    `and paid ${money(k.laborCost)} in wages at ${percent(k.utilization)} utilization` +
    `${result.bottleneck.process ? `, with ${result.bottleneck.process} the bottleneck.` : "."}`;
  return {
    headline,
    findings: buildFindings(input),
    recommendations: recommend(input),
    days: buildDays(result),
  };
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** The write-up as Markdown. Pass both runs' KPIs to get the change table. */
export function reportMarkdown(r: Report, previous?: Kpis, current?: Kpis): string {
  const lines: string[] = [
    `# ${r.headline}`,
    ``,
    `## What happened`,
    ``,
    ...r.findings.map((f) => `- ${f}`),
    ``,
    `## What to change`,
    ``,
  ];
  if (r.recommendations.length === 0) lines.push(`Nothing fired.`);
  for (const rec of r.recommendations) {
    lines.push(`### ${rec.title}`, ``, `**${rec.tab} › \`${rec.field}\`** — at stake: ${rec.impact}.`, ``, rec.detail, ``);
  }
  lines.push(`## Day by day`, ``, `| ${DAY_COLUMNS.map((c) => c.header).join(" | ")} |`, `|${DAY_COLUMNS.map((_, i) => (i < 4 ? "---" : "---:")).join("|")}|`);
  for (const row of r.days) lines.push(`| ${DAY_COLUMNS.map((c) => c.fmt(row[c.key] ?? "")).join(" | ")} |`);
  lines.push(``);

  if (previous && current) {
    const rows = KPI_META.map((m) => ({ m, a: previous[m.key], b: current[m.key], d: delta(m.key, previous[m.key], current[m.key]) })).filter((x) => x.d.cls !== "");
    if (rows.length) {
      lines.push(`## Against the previous run`, ``, `| KPI | before | after | change |`, `|---|---:|---:|---:|`);
      for (const x of rows) lines.push(`| ${x.m.label} | ${x.m.fmt(x.a)} | ${x.m.fmt(x.b)} | ${x.d.text}${x.d.cls === "good" ? " ✓" : " ✗"} |`);
      lines.push(``);
    }
  }
  lines.push(
    `Dollars are candystore retail value. Waits are the time a person actually stood there. ` +
      `The recommendations above are a rule engine over these numbers, not an optimizer: each one is a threshold with the evidence it fired on. ` +
      `Change one field, run the same seed again, and compare.`,
    ``
  );
  return lines.join("\n");
}

function csvCell(v: string | number): string {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The day table, one row per horizon day, numbers unformatted so a spreadsheet can chart them. */
export function reportCsv(r: Report): string {
  const head = DAY_COLUMNS.map((c) => c.header).join(",");
  const rows = r.days.map((row) => DAY_COLUMNS.map((c) => csvCell(row[c.key] ?? "")).join(","));
  return [head, ...rows].join("\n") + "\n";
}

export function reportJson(r: Report): string {
  return JSON.stringify(r, null, 2);
}

/** A file-name stem such as "store-report-store-midtown-wk44-7d-seed1". */
export function reportFileStem(store: string, startWeek: number, days: number, seed: number): string {
  return `store-report-${store}-wk${startWeek}-${days}d-seed${seed}`;
}
