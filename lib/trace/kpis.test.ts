/**
 * The reducer has one job: reproduce the engine's own arithmetic from the
 * events alone. So the tests here are not golden numbers — they are the two
 * properties that make the reducer usable at all. First, that replaying from a
 * checkpoint gives the same state as replaying from the start, which is what
 * lets the page scrub. Second, that the projection at the horizon is the MCP
 * tools' `kpis(result)`, field for field.
 *
 * That second one runs over two shops and two seeds. One shop proves nothing:
 * a reducer can match a single run by accident and still be adding the wrong
 * events up, and the accounting the engine changed most recently — order
 * revenue, order lateness, demand-weighted availability — only bites where the
 * order book and the queues are shaped differently.
 */

import { describe, expect, it } from "vitest";
import { storeIds } from "../data/store";
import { runOperations, type OperationsResult } from "../twin/operations";
import { kpis, KPI_KEYS, type Kpis } from "../twin/replicate";
import { buildTwin, operationsOptions } from "../twin/twin";
import { applyEvent, cloneState, createState, finalize, kpiContext, openMinutes, projectKpis, type KpiSamples, type KpiState } from "./kpis";
import { RecordingTracer, type SkuInfo, type TraceEvent, type TraceInit } from "./types";

const DAYS = 3;
/** Week 44 is the Halloween peak: full queues, walk-outs and a busy lot. */
const START_WEEK = 44;

/**
 * Midtown keeps two counter stations and sends the van out twice a day;
 * Marietta has one of each, opens an hour later and closes earlier, so its
 * orders miss the round more often and its trading minutes are a different
 * number. Seeds 1 and 2 are runs 1 and 2 of the tools' own replication table,
 * so a failure here is a failure a `store_replicate` caller would see.
 */
const CASES: Array<{ store: number; seed: number }> = [
  { store: 0, seed: 1 },
  { store: 0, seed: 2 },
  { store: 2, seed: 1 },
  { store: 2, seed: 2 },
];

interface Run {
  events: TraceEvent[];
  init: TraceInit;
  result: OperationsResult;
  skus: SkuInfo[];
  samples: KpiSamples;
}

const cached = new Map<string, Run>();

async function run(store = CASES[0].store, seed = CASES[0].seed): Promise<Run> {
  const key = `${store}|${seed}`;
  const hit = cached.get(key);
  if (hit) return hit;
  const ctx = await buildTwin(storeIds()[store], START_WEEK, {});
  const tracer = new RecordingTracer();
  const result = runOperations(ctx, operationsOptions(ctx, DAYS, seed), tracer);
  const events = tracer.events;
  const init = events.find((e): e is TraceInit => e.k === "init");
  if (!init) throw new Error("no init event");
  const skus: SkuInfo[] = ctx.catalog.skus.map((s, i) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    supplier: s.supplier,
    unitRetail: s.unitRetail,
    sellBy: s.sellBy,
    unitsPerInner: s.unitsPerInner,
    innersPerCase: s.innersPerCase,
    fixture: s.fixture,
    colorIdx: i % 8,
  }));
  // The same three sample streams the compiler collects, in event order.
  const dockToStock: number[] = [];
  const counterWait: number[] = [];
  const registerWait: number[] = [];
  const orderCycle: number[] = [];
  for (const e of events) {
    if (e.k === "putaway") dockToStock.push(e.dockToStockMin);
    else if (e.k === "counterDone") counterWait.push(e.waitMin);
    else if (e.k === "sale") registerWait.push(e.waitMin);
  }
  const r: Run = {
    events,
    init,
    result,
    skus,
    samples: {
      dockToStock: Float32Array.from(dockToStock),
      counterWait: Float32Array.from(counterWait),
      registerWait: Float32Array.from(registerWait),
      orderCycle: Float32Array.from(orderCycle),
    },
  };
  cached.set(key, r);
  return r;
}

function replay(r: Run, from: number, state: KpiState): KpiState {
  const ctx = kpiContext(r.init, r.events, r.skus);
  for (let i = from; i < r.events.length; i++) applyEvent(state, r.events[i], ctx);
  return state;
}

/** The finalized state at the horizon: what the HUD reads and the tools print. */
function closedBooks(r: Run): KpiState {
  const ctx = kpiContext(r.init, r.events, r.skus);
  const state = createState(r.init);
  for (const e of r.events) applyEvent(state, e, ctx);
  finalize(state, r.init.horizonEnd, ctx);
  return state;
}

/**
 * The whole epsilon list, field by field, and why each one is on it. Everything
 * not named here — every count, every dollar, every minute, the sales, the
 * losses, the empty-facing hours, the availability share — is compared bit for
 * bit, because the reducer adds exactly the terms the engine adds, at exactly
 * the events the engine adds them at.
 *
 * Two things break that, and only two:
 *
 * - **A sum taken in a different order.** The engine totals hours and wages per
 *   worker and then across the roster; the reducer totals them in clock-in and
 *   clock-out order. `busyHours` is per job either way but reaches the total by
 *   a different route, and the two resource utilizations are worse still: the
 *   engine integrates a running count of busy tills minute by minute while the
 *   reducer adds each job's minutes as it starts. Floating-point addition is
 *   not associative, so the last bit or two of these differs. Everything
 *   derived from them (`utilization`, `laborCost`, `laborShareOfSales`,
 *   `salesPerPaidHour`) inherits it.
 * - **A number that has been through Float32.** The sampled averages and
 *   percentiles are read back out of the buffers the samples cross to the page
 *   as, so they carry seven significant digits rather than sixteen, and a p90
 *   interpolates between two already-rounded values.
 *
 * The bounds are the smallest round numbers with real headroom over what four
 * shop-and-seed runs actually show: 3e-15 relative on the re-summed figures
 * (1e-12 here) and 4e-8 on the sampled ones (1e-6 here).
 */
const NEAR: Partial<Record<keyof Kpis, number>> = {
  paidHours: 1e-12,
  overtimeHours: 1e-12,
  busyHours: 1e-12,
  utilization: 1e-12,
  laborCost: 1e-12,
  laborShareOfSales: 1e-12,
  salesPerPaidHour: 1e-12,
  registerUtilization: 1e-12,
  counterUtilization: 1e-12,
  dockToStockAvgMin: 1e-6,
  dockToStockP90Min: 1e-6,
  counterWaitP90Min: 1e-6,
  registerWaitP90Min: 1e-6,
};

export function compareKpis(got: Kpis, want: Kpis): void {
  for (const k of KPI_KEYS) {
    const tol = NEAR[k];
    if (tol === undefined) {
      expect(`${k}=${got[k]}`).toBe(`${k}=${want[k]}`);
    } else {
      const scale = Math.max(1, Math.abs(want[k]));
      expect(Math.abs(got[k] - want[k]) / scale, `${k}: ${got[k]} vs ${want[k]}`).toBeLessThan(tol);
    }
  }
}

describe("kpiContext", () => {
  it("is immutable, so a replay from a checkpoint equals a replay from init", async () => {
    const r = await run();
    const mid = Math.floor(r.events.length / 2);
    const ctx = kpiContext(r.init, r.events, r.skus);

    const full = createState(r.init);
    let snapshot: KpiState | null = null;
    for (let i = 0; i < r.events.length; i++) {
      if (i === mid) snapshot = cloneState(full);
      applyEvent(full, r.events[i], ctx);
    }
    expect(snapshot).not.toBeNull();

    const resumed = replay(r, mid, cloneState(snapshot!));
    expect(resumed).toEqual(full);
  });

  it("finds the counter short-falls the engine never emits an event for", async () => {
    const r = await run();
    const ctx = kpiContext(r.init, r.events, r.skus);
    // Every step is attached to an event in the stream, never to an index.
    for (const [e] of ctx.steps) expect(r.events.includes(e)).toBe(true);
    expect(ctx.ratedFacings).toBeGreaterThan(0);
    // The glass running out mid-order is the one short the engine counts in
    // its own books without emitting anything, so the prepass has to find it:
    // what the serve job asked for, less what came out of the case.
    const shorts = [...ctx.steps.values()].reduce((a, s) => a + s.shorts.length, 0);
    const traced = r.events.filter((e) => e.k === "short" && e.customer !== null).length;
    expect(shorts + traced).toBe(r.result.availability.shortAtShelf);
  });

  it("has every order either out or still open, never both and never neither", async () => {
    const r = await run();
    const ctx = kpiContext(r.init, r.events, r.skus);
    const placed = r.events.filter((e) => e.k === "orderPlaced").length;
    const out = r.events.filter((e) => e.k === "orderOut").length;
    // `orderOut` is the one statement that an order left the shop, so its count
    // is the engine's fulfilled count and nothing else needs deriving.
    expect(out).toBe(r.result.orders.fulfilled);
    expect(out + ctx.openOrders.length).toBe(placed);
    for (const o of ctx.openOrders) expect(o.dueAt).toBeGreaterThan(0);
  });
});

describe("openMinutes", () => {
  it("counts the trading minutes of the horizon, and no more", async () => {
    const r = await run();
    const full = openMinutes(r.init, r.init.horizonEnd, true);
    expect(full).toBeGreaterThan(0);
    expect(full).toBeLessThanOrEqual(r.init.days * 1440);
    // Part way through day 0 it can only have counted part of day 0.
    const early = openMinutes(r.init, 12 * 60, false);
    expect(early).toBeLessThan(full);
    expect(openMinutes(r.init, r.init.horizonEnd, false)).toBe(full);
  });
});

describe("projectKpis", () => {
  for (const c of CASES) {
    it(`equals the tools' kpis(result) at the horizon: shop ${c.store}, seed ${c.seed}`, async () => {
      const r = await run(c.store, c.seed);
      compareKpis(projectKpis(closedBooks(r), r.init.horizonEnd, r.init, r.samples, true), kpis(r.result));
    });
  }

  it("splits the takings the way the engine does", async () => {
    const r = await run();
    const state = closedBooks(r);
    // The till and the order book are counted apart, so a delivery is never a
    // transaction and the average basket is a basket, not a basket plus a van.
    expect(state.tillDollars).toBeCloseTo(r.result.sales.tillDollars, 6);
    expect(state.orderDollars).toBeCloseTo(r.result.sales.orderDollars, 6);
    expect(state.transactions).toBe(r.result.sales.transactions);
    expect(state.transactions + state.abandonedRegister).toBeLessThanOrEqual(state.customers);
  });

  it("is a running figure: nothing has happened at t = 0", async () => {
    const r = await run();
    const zero = projectKpis(createState(r.init), 0, r.init, r.samples, false);
    expect(zero.customers).toBe(0);
    expect(zero.salesDollars).toBe(0);
    expect(zero.transactions).toBe(0);
    // The shelf starts however the warm-up left it, which is not nothing.
    expect(zero.onShelfShare).toBeGreaterThan(0);
  });

  it("never counts a walked-out basket as a transaction", async () => {
    const r = await run();
    const ctx = kpiContext(r.init, r.events, r.skus);
    const state = createState(r.init);
    for (const e of r.events) applyEvent(state, e, ctx);
    const k = projectKpis(state, r.init.horizonEnd, r.init, r.samples, false);
    // A customer who gives up at the glass still pays for what is in their
    // basket, so only a register walk-out rules a transaction out.
    expect(state.abandonedRegister + k.transactions).toBeLessThanOrEqual(k.customers);
    expect(k.transactions).toBeLessThanOrEqual(k.customers);
    expect(k.abandonRate).toBeCloseTo(k.customers > 0 ? k.abandoned / k.customers : 0, 12);
    expect(k.lostQueueDollars).toBeGreaterThan(0);
  });
});
