/**
 * One run is a sample, not an answer. `replicate` runs the floor on
 * consecutive seeds and reduces the results to a mean, a p90 and a per-metric
 * worst, plus a vote on which process was the bottleneck.
 *
 * `Kpis` is deliberately a flat record of numbers: every tool, the 3D page's
 * HUD, the report writer and the optimizer's cost function read it, and the
 * aggregation below is generic over its keys.
 */

import { quantile } from "../util/random";
import type { OperationsResult } from "./operations";
import { runOperations } from "./operations";
import type { TwinContext } from "./twin";
import { operationsOptions } from "./twin";

export interface Kpis {
  // What the shop sold
  customers: number;
  transactions: number;
  unitsSold: number;
  salesDollars: number;
  averageBasket: number;
  conversionRate: number;

  // What it did not sell
  lostShelfDollars: number;
  lostQueueDollars: number;
  lostSalesShare: number;

  // Whether the candy was in front of the customer
  onShelfShare: number;
  shortAtShelf: number;
  emptyFacingHours: number;
  restocks: number;
  hotRestocks: number;

  // Whether anyone had to wait
  counterWaitAvgMin: number;
  counterWaitP90Min: number;
  registerWaitAvgMin: number;
  registerWaitP90Min: number;
  worstWaitMin: number;
  abandoned: number;
  abandonRate: number;
  giftWraps: number;

  // Orders that left the store
  ordersPlaced: number;
  ordersLate: number;
  orderLateMinTotal: number;
  orderCutDollars: number;
  vanRounds: number;
  vanLateRounds: number;

  // Goods coming in
  inboundTrucks: number;
  inboundCases: number;
  dockToStockAvgMin: number;
  dockToStockP90Min: number;
  palletsNotPutAway: number;

  // People
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  utilization: number;
  absences: number;
  laborCost: number;
  laborShareOfSales: number;
  salesPerPaidHour: number;

  // The two things a shop runs out of first
  registerUtilization: number;
  counterUtilization: number;
}

export const KPI_KEYS = [
  "customers",
  "transactions",
  "unitsSold",
  "salesDollars",
  "averageBasket",
  "conversionRate",
  "lostShelfDollars",
  "lostQueueDollars",
  "lostSalesShare",
  "onShelfShare",
  "shortAtShelf",
  "emptyFacingHours",
  "restocks",
  "hotRestocks",
  "counterWaitAvgMin",
  "counterWaitP90Min",
  "registerWaitAvgMin",
  "registerWaitP90Min",
  "worstWaitMin",
  "abandoned",
  "abandonRate",
  "giftWraps",
  "ordersPlaced",
  "ordersLate",
  "orderLateMinTotal",
  "orderCutDollars",
  "vanRounds",
  "vanLateRounds",
  "inboundTrucks",
  "inboundCases",
  "dockToStockAvgMin",
  "dockToStockP90Min",
  "palletsNotPutAway",
  "paidHours",
  "overtimeHours",
  "busyHours",
  "utilization",
  "absences",
  "laborCost",
  "laborShareOfSales",
  "salesPerPaidHour",
  "registerUtilization",
  "counterUtilization",
] as const satisfies ReadonlyArray<keyof Kpis>;

/** Metrics where a bigger number is a worse week. */
const HIGHER_IS_WORSE = new Set<keyof Kpis>([
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

export function kpis(r: OperationsResult): Kpis {
  const lost = r.sales.lostShelfDollars + r.sales.lostQueueDollars;
  const potential = r.sales.salesDollars + lost;
  return {
    customers: r.sales.customers,
    transactions: r.sales.transactions,
    unitsSold: r.sales.unitsSold,
    salesDollars: r.sales.salesDollars,
    averageBasket: r.sales.averageBasket,
    conversionRate: r.sales.customers > 0 ? r.sales.transactions / r.sales.customers : 0,

    lostShelfDollars: r.sales.lostShelfDollars,
    lostQueueDollars: r.sales.lostQueueDollars,
    lostSalesShare: potential > 0 ? lost / potential : 0,

    onShelfShare: r.availability.onShelfShare,
    shortAtShelf: r.availability.shortAtShelf,
    emptyFacingHours: r.availability.emptyFacingMinutes / 60,
    restocks: r.availability.restocks,
    hotRestocks: r.availability.hotRestocks,

    counterWaitAvgMin: r.service.counterWaitAvgMin,
    counterWaitP90Min: r.service.counterWaitP90Min,
    registerWaitAvgMin: r.service.registerWaitAvgMin,
    registerWaitP90Min: r.service.registerWaitP90Min,
    worstWaitMin: r.service.worstWaitMin,
    abandoned: r.service.abandonedCounter + r.service.abandonedRegister,
    abandonRate: r.service.abandonRate,
    giftWraps: r.sales.giftWraps,

    ordersPlaced: r.orders.placed,
    ordersLate: r.orders.late,
    orderLateMinTotal: r.orders.lateMinTotal,
    orderCutDollars: r.orders.cutDollars,
    vanRounds: r.orders.vanRounds,
    vanLateRounds: r.orders.vanLateRounds,

    inboundTrucks: r.inbound.trucks,
    inboundCases: r.inbound.cases,
    dockToStockAvgMin: r.inbound.dockToStockAvgMin,
    dockToStockP90Min: r.inbound.dockToStockP90Min,
    palletsNotPutAway: r.inbound.palletsNotPutAway,

    paidHours: r.labor.paidHours,
    overtimeHours: r.labor.overtimeHours,
    busyHours: r.labor.busyHours,
    utilization: r.labor.utilization,
    absences: r.labor.absences,
    laborCost: r.labor.regularCost + r.labor.overtimeCost,
    laborShareOfSales: r.labor.laborShareOfSales,
    salesPerPaidHour: r.labor.salesPerPaidHour,

    registerUtilization: r.resources.registers.utilization,
    counterUtilization: r.resources.counters.utilization,
  };
}

export interface Replications {
  runs: OperationsResult[];
  mean: Kpis;
  p90: Kpis;
  /** Per metric, in the direction that hurts. */
  worst: Kpis;
  bottleneck: OperationsResult["bottleneck"];
}

function aggregate(list: Kpis[], f: (xs: number[], key: keyof Kpis) => number): Kpis {
  const out = {} as Kpis;
  for (const k of KPI_KEYS) out[k] = f(list.map((x) => x[k]), k);
  return out;
}

export function replicate(ctx: TwinContext, days: number, runs: number, seed = 1): Replications {
  const results: OperationsResult[] = [];
  for (let i = 0; i < runs; i++) results.push(runOperations(ctx, operationsOptions(ctx, days, seed + i)));
  const list = results.map(kpis);

  const votes = new Map<string, { count: number; waitHours: number; process: OperationsResult["bottleneck"]["process"] }>();
  for (const r of results) {
    const key = `${r.bottleneck.process ?? "none"}|${r.bottleneck.constraint}`;
    const v = votes.get(key) ?? { count: 0, waitHours: 0, process: r.bottleneck.process };
    v.count++;
    v.waitHours += r.bottleneck.waitHours;
    votes.set(key, v);
  }
  let best: { key: string; count: number; waitHours: number; process: OperationsResult["bottleneck"]["process"] } | null = null;
  for (const [key, v] of [...votes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!best || v.count > best.count || (v.count === best.count && v.waitHours > best.waitHours)) best = { key, ...v };
  }
  const bottleneck: OperationsResult["bottleneck"] = best
    ? { process: best.process, constraint: best.key.split("|").slice(1).join("|"), waitHours: best.waitHours / runs }
    : { process: null, constraint: "none", waitHours: 0 };

  return {
    runs: results,
    mean: aggregate(list, (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)),
    p90: aggregate(list, (xs) => quantile(xs, 0.9)),
    worst: aggregate(list, (xs, k) => (HIGHER_IS_WORSE.has(k) ? Math.max(...xs) : Math.min(...xs))),
    bottleneck,
  };
}
