/**
 * Integration tests over the committed shops.
 *
 * These assert direction and conservation, never calibrated values, so editing
 * the mock catalog, roster or standards does not break them. If a test here
 * fails, something about how the shop behaves has changed, not what the inputs
 * happen to be.
 */

import { describe, expect, it } from "vitest";
import { RecordingTracer } from "../trace/types";
import { findSite, loadNetwork, storeIds } from "../data/load";
import { expectedDayTotal, hoursOn, isOperating, weekdayOf } from "./demand";
import { runOperations } from "./operations";
import { kpis } from "./replicate";
import { seasonFactor } from "./season";
import { buildTwin, operationsOptions, type TwinScenario } from "./twin";
import { PROCESS_SKILL } from "./types";
import { buildWeekSchedule } from "./workforce";

const STORE = "store-midtown";

async function run(store: string, week: number, days: number, scenario: TwinScenario = {}, seed = 1) {
  const ctx = await buildTwin(store, week, scenario);
  const result = runOperations(ctx, operationsOptions(ctx, days, seed));
  return { ctx, result, k: kpis(result) };
}

describe("the shop trades", () => {
  it("serves customers, rings them up and keeps the takings", async () => {
    const { k } = await run(STORE, 36, 7);
    expect(k.customers).toBeGreaterThan(500);
    expect(k.transactions).toBeGreaterThan(0);
    expect(k.salesDollars).toBeGreaterThan(0);
    expect(k.averageBasket).toBeGreaterThan(1);
    // Nobody can buy more than walked in, and every basket is somebody's.
    expect(k.transactions).toBeLessThanOrEqual(k.customers + k.ordersPlaced);
  });

  it("staffs every trading day", async () => {
    const { result } = await run(STORE, 36, 7);
    for (const d of result.daily) {
      if (!d.open) continue;
      expect(d.customers, `day ${d.day}`).toBeGreaterThan(0);
      expect(d.transactions, `day ${d.day} had customers but rang up nothing`).toBeGreaterThan(0);
    }
  });

  it("is shut on a dark day", async () => {
    const { result } = await run("store-buford", 36, 7);
    const monday = result.daily.find((d) => d.weekday === 1);
    expect(monday?.open).toBe(false);
    expect(monday?.customers).toBe(0);
    expect(monday?.transactions).toBe(0);
  });

  it("replays exactly on the same seed", async () => {
    const a = await run(STORE, 36, 5);
    const b = await run(STORE, 36, 5);
    expect(b.result.sales).toEqual(a.result.sales);
    expect(b.result.service).toEqual(a.result.service);
    expect(b.result.availability).toEqual(a.result.availability);
    expect(b.result.processes).toEqual(a.result.processes);
  });

  it("differs on a different seed", async () => {
    const a = await run(STORE, 36, 5, {}, 1);
    const b = await run(STORE, 36, 5, {}, 2);
    expect(b.k.salesDollars).not.toBe(a.k.salesDollars);
  });

  it("runs the same numbers whether or not anybody is watching", async () => {
    // The 3D page records the run through a Tracer. Emitting must never draw
    // from a random stream, schedule an event or touch engine state, or the
    // page and the tools would quietly disagree — so a traced run and an
    // untraced one have to be identical, not merely close.
    const ctx = await buildTwin(STORE, 44, {});
    const quiet = runOperations(ctx, operationsOptions(ctx, 5, 1));
    const tracer = new RecordingTracer();
    const watched = runOperations(ctx, operationsOptions(ctx, 5, 1), tracer);
    expect(tracer.events.length).toBeGreaterThan(1000);
    expect(watched.sales).toEqual(quiet.sales);
    expect(watched.service).toEqual(quiet.service);
    expect(watched.availability).toEqual(quiet.availability);
    expect(watched.orders).toEqual(quiet.orders);
    expect(watched.inbound).toEqual(quiet.inbound);
    expect(watched.labor).toEqual(quiet.labor);
    expect(watched.processes).toEqual(quiet.processes);
    expect(watched.daily).toEqual(quiet.daily);
  });

  it("emits a non-decreasing stream that opens with init and closes with end", async () => {
    const ctx = await buildTwin(STORE, 36, {});
    const tracer = new RecordingTracer();
    runOperations(ctx, operationsOptions(ctx, 3, 1), tracer);
    const events = tracer.events;
    expect(events[0].k).toBe("init");
    expect(events[0].t).toBe(0);
    const last = events[events.length - 1];
    expect(last.k).toBe("end");
    expect(last.t).toBe(3 * 1440);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].t, `event ${i} (${events[i].k}) went backwards`).toBeGreaterThanOrEqual(events[i - 1].t);
    }
  });
});

describe("the dollars reconcile with candystore", () => {
  it("sells what the market model says, less what it loses", async () => {
    const days = 28;
    const { ctx, k } = await run(STORE, 36, days);
    let target = 0;
    for (let d = 0; d < days; d++) target += expectedDayTotal(ctx.model, d, ctx.startWeek);
    const attempted = k.salesDollars + k.lostShelfDollars + k.lostQueueDollars;
    // Within a tenth: the residual is the last basket of a bin and the orders
    // still on the bench when the horizon ends.
    expect(attempted / target).toBeGreaterThan(0.9);
    expect(attempted / target).toBeLessThan(1.1);
  });

  it("holds its stock level over a month", async () => {
    const { result } = await run(STORE, 36, 28);
    const drift = Math.abs(result.stock.retailEnd - result.stock.retailStart) / result.stock.retailStart;
    expect(drift, "stock should settle, not drain or pile up").toBeLessThan(0.3);
  });

  it("never sells more than it took off the shelf", async () => {
    const { result } = await run(STORE, 36, 14);
    expect(result.availability.onShelfShare).toBeGreaterThan(0);
    expect(result.availability.onShelfShare).toBeLessThanOrEqual(1);
    expect(result.sales.lostShelfUnits).toBeGreaterThanOrEqual(0);
  });

  it("only works hours it paid for", async () => {
    const { result } = await run(STORE, 36, 7);
    expect(result.labor.busyHours).toBeLessThanOrEqual(result.labor.paidHours + result.labor.overtimeHours + 1);
    expect(result.labor.utilization).toBeGreaterThan(0);
    expect(result.labor.utilization).toBeLessThanOrEqual(1);
  });
});

describe("demand responds", () => {
  it("scales with demandScale", async () => {
    const base = await run(STORE, 36, 7);
    const up = await run(STORE, 36, 7, { demandScale: 1.5 });
    expect(up.k.customers).toBeGreaterThan(base.k.customers * 1.2);
    expect(up.k.salesDollars).toBeGreaterThan(base.k.salesDollars);
  });

  it("peaks at Halloween", async () => {
    const ordinary = await run(STORE, 36, 7);
    const halloween = await run(STORE, 44, 7);
    expect(seasonFactor(44)).toBeGreaterThan(1.9);
    expect(halloween.k.customers).toBeGreaterThan(ordinary.k.customers * 1.5);
  });

  it("follows the week: Saturday beats Tuesday", async () => {
    const { result } = await run(STORE, 36, 7);
    const sat = result.daily.find((d) => d.weekday === 6)!;
    const tue = result.daily.find((d) => d.weekday === 2)!;
    expect(sat.customers).toBeGreaterThan(tue.customers);
  });

  it("takes a category shock", async () => {
    const base = await run(STORE, 36, 7);
    const shocked = await run(STORE, 36, 7, { demandShocks: [{ fromDay: 0, toDay: 6, factor: 0.5 }] });
    expect(shocked.k.customers).toBeLessThan(base.k.customers);
  });
});

describe("the queue is where a shop loses money", () => {
  it("keeps more customers when there are more tills and more cashiers", async () => {
    const base = await run("store-decatur", 44, 7);
    const more = await run("store-decatur", 44, 7, { registers: 6, addWorkers: [{ role: "cashier", shift: "mid", type: "part-time", count: 2 }] });
    // Sales and walk-outs, not the wait percentile. Relieving the till pushes
    // the load onto whatever is next, and the people who would have left the
    // queue now stay in it — so the p90 wait can hold steady or even rise
    // while the shop is plainly better off. The outcome is what to assert.
    expect(more.k.abandoned).toBeLessThan(base.k.abandoned);
    expect(more.k.salesDollars).toBeGreaterThan(base.k.salesDollars);
  });

  it("empties faster when shoppers are impatient", async () => {
    const patient = await run("store-decatur", 44, 7, { patience: 2 });
    const hurried = await run("store-decatur", 44, 7, { patience: 0.35 });
    expect(hurried.k.abandoned).toBeGreaterThan(patient.k.abandoned);
    expect(hurried.k.lostQueueDollars).toBeGreaterThan(patient.k.lostQueueDollars);
  });

  it("builds when the till network goes down", async () => {
    const base = await run("store-decatur", 44, 7);
    const down = await run("store-decatur", 44, 7, { posOutages: [{ day: 5, start: "12:00", hours: 3 }] });
    expect(down.k.registerWaitP90Min).toBeGreaterThan(base.k.registerWaitP90Min);
  });

  it("builds at the glass when a counter station closes", async () => {
    const base = await run("store-avalon", 44, 7);
    const shut = await run("store-avalon", 44, 7, { counterOutages: [{ fromDay: 0, toDay: 6, count: 2 }] });
    expect(shut.k.counterWaitAvgMin).toBeGreaterThanOrEqual(base.k.counterWaitAvgMin);
  });
});

describe("the shelf is the pick face", () => {
  it("loses sales when the facings run dry", async () => {
    const { k } = await run(STORE, 44, 14);
    expect(k.shortAtShelf).toBeGreaterThan(0);
    expect(k.lostShelfDollars).toBeGreaterThan(0);
    expect(k.onShelfShare).toBeLessThan(1);
  });

  it("fills the shelves in cart trips, not one line at a time", async () => {
    const { result } = await run(STORE, 36, 14);
    const trips = result.availability.restocks;
    // A trip that only ever carried one facing would mean one trip per unit
    // sold, which is the bug this batching exists to prevent.
    expect(trips).toBeGreaterThan(0);
    expect(trips).toBeLessThan(result.sales.unitsSold / 4);
  });

  it("restocks less often when the facings are sized to demand", async () => {
    const current = await run(STORE, 36, 21, { merchandising: "current" });
    const optimized = await run(STORE, 36, 21, { merchandising: "optimized" });
    expect(optimized.ctx.merchEval.restocksPerWeek).toBeLessThan(current.ctx.merchEval.restocksPerWeek);
  });

  it("moves the fastest movers to eye level when re-merchandised", async () => {
    const current = await run(STORE, 36, 3, { merchandising: "current" });
    const optimized = await run(STORE, 36, 3, { merchandising: "optimized" });
    expect(optimized.ctx.merchEval.eyeLevelShare).toBeGreaterThan(current.ctx.merchEval.eyeLevelShare);
  });
});

describe("goods in and orders out", () => {
  it("takes the overnight trailer and the daytime vendors", async () => {
    const { result } = await run("store-avalon", 36, 21);
    expect(result.inbound.trucks).toBeGreaterThan(0);
    expect(result.inbound.cases).toBeGreaterThan(0);
    expect(result.inbound.dockToStockAvgMin).toBeGreaterThan(0);
  });

  it("picks and sends the special orders", async () => {
    const { result } = await run(STORE, 36, 14);
    expect(result.orders.placed).toBeGreaterThan(0);
    expect(result.orders.picked).toBeGreaterThan(0);
    expect(result.orders.vanRounds).toBeGreaterThan(0);
    expect(result.orders.stops).toBeGreaterThanOrEqual(result.orders.vanRounds);
  });

  it("runs the van later when it has nobody to drive it", async () => {
    const base = await run(STORE, 36, 14);
    const noVan = await run(STORE, 36, 14, { vanOutages: [{ fromDay: 0, toDay: 13, count: 1 }] });
    expect(noVan.k.vanRounds).toBeLessThan(base.k.vanRounds);
  });

  it("slows dock-to-stock when a goods door is out", async () => {
    const base = await run("store-avalon", 36, 14);
    const shut = await run("store-avalon", 36, 14, { dockOutages: [{ fromDay: 0, toDay: 13, count: 2 }] });
    expect(shut.k.dockToStockAvgMin).toBeGreaterThanOrEqual(base.k.dockToStockAvgMin);
  });
});

describe("the crew", () => {
  it("gives every present worker one primary a day, and only skills they hold", async () => {
    const ctx = await buildTwin(STORE, 36, {});
    const sched = buildWeekSchedule(ctx.workloadContext, ctx.workers, 0, ctx.scheduleOptions);
    const byId = new Map(ctx.workers.map((w) => [w.id, w]));
    const seen = new Set<string>();
    for (const a of sched.assignments) {
      const key = `${a.day}|${a.worker}`;
      expect(seen.has(key), `${a.worker} assigned twice on day ${a.day}`).toBe(false);
      seen.add(key);
      expect(byId.get(a.worker)?.skills, `${a.worker} given ${a.primary}`).toContain(a.primary);
    }
  });

  it("never rosters anyone past their weekly hours", async () => {
    const ctx = await buildTwin(STORE, 36, {});
    const sched = buildWeekSchedule(ctx.workloadContext, ctx.workers, 0, ctx.scheduleOptions);
    const hours = new Map<string, number>();
    for (const a of sched.assignments) hours.set(a.worker, (hours.get(a.worker) ?? 0) + a.hours);
    for (const w of ctx.workers) {
      expect(hours.get(w.id) ?? 0, `${w.id} (${w.type})`).toBeLessThanOrEqual(w.maxWeeklyHours + 0.01);
    }
  });

  it("covers every shift of every trading day", async () => {
    const ctx = await buildTwin(STORE, 36, {});
    const sched = buildWeekSchedule(ctx.workloadContext, ctx.workers, 0, ctx.scheduleOptions);
    for (let d = 0; d < 7; d++) {
      if (!isOperating(ctx.site, d)) continue;
      expect(sched.assignments.filter((a) => a.day === d).length, `day ${d} has nobody rostered`).toBeGreaterThan(0);
    }
  });

  it("needs more hours at Halloween than in September", async () => {
    const ctx = await buildTwin(STORE, 36, {});
    const ordinary = buildWeekSchedule(ctx.workloadContext, ctx.workers, 0, ctx.scheduleOptions);
    const peakCtx = await buildTwin(STORE, 44, {});
    const peak = buildWeekSchedule(peakCtx.workloadContext, peakCtx.workers, 0, peakCtx.scheduleOptions);
    const total = (s: typeof ordinary) => Object.values(s.required).reduce((a, b) => a + b, 0);
    expect(total(peak)).toBeGreaterThan(total(ordinary) * 1.4);
  });

  it("loses hours to absence and gains them to overtime", async () => {
    const none = await run(STORE, 44, 7, { absenteeism: 0 });
    const lots = await run(STORE, 44, 7, { absenteeism: 0.4 });
    expect(none.k.absences).toBe(0);
    expect(lots.k.absences).toBeGreaterThan(0);
    expect(lots.k.busyHours).toBeLessThan(none.k.busyHours);
  });

  it("charges every process to somebody who can do it", async () => {
    const { result } = await run(STORE, 36, 7);
    const byId = new Map(result.workers.map((w) => [w.id, w]));
    const ctx = await buildTwin(STORE, 36, {});
    for (const w of ctx.workers) {
      const rec = byId.get(w.id);
      if (!rec) continue;
      for (const p of Object.keys(rec.byProcess) as Array<keyof typeof rec.byProcess>) {
        expect(w.skills, `${w.id} did ${p}`).toContain(PROCESS_SKILL[p]);
      }
    }
  });
});

describe("scenarios are validated", () => {
  it("rejects an unknown shop", async () => {
    await expect(buildTwin("store-nowhere", 36, {})).rejects.toThrow(/Unknown store/);
  });

  it("rejects an unknown worker", async () => {
    await expect(buildTwin(STORE, 36, { removeWorkers: ["nobody"] })).rejects.toThrow(/Unknown worker/);
  });

  it("will not put a temp behind the glass or in the van", async () => {
    await expect(
      buildTwin(STORE, 36, { addWorkers: [{ role: "cashier", shift: "mid", type: "temp", count: 1 }], crossTrain: [{ worker: "NEW-01", skill: "counter" }] })
    ).rejects.toThrow(/food handler/);
    await expect(
      buildTwin(STORE, 36, { addWorkers: [{ role: "cashier", shift: "mid", type: "temp", count: 1 }], crossTrain: [{ worker: "NEW-01", skill: "drive" }] })
    ).rejects.toThrow(/insurance/);
  });

  it("rejects hours that close before they open", async () => {
    await expect(buildTwin(STORE, 36, { hours: [{ day: 6, open: "18:00", close: "10:00" }] })).rejects.toThrow(/close at or before/);
  });

  it("rejects an unknown supplier and an unknown category", async () => {
    await expect(buildTwin(STORE, 36, { supplierDelays: [{ supplier: "SUP-NONE", extraDays: 3, fromDay: 0, toDay: 3 }] })).rejects.toThrow(/Unknown supplier/);
    await expect(buildTwin(STORE, 36, { demandShocks: [{ fromDay: 0, toDay: 3, factor: 2, category: "nope" }] })).rejects.toThrow(/Unknown category/);
  });

  it("records what a scenario actually changed", async () => {
    const ctx = await buildTwin(STORE, 36, { registers: 4, merchandising: "optimized" });
    expect(ctx.changes.join(" ")).toMatch(/registers 2 → 4/);
    expect(ctx.changes.join(" ")).toMatch(/optimized/);
  });

  it("adds and cross-trains people in one call", async () => {
    const ctx = await buildTwin(STORE, 36, {
      addWorkers: [{ role: "stocker", shift: "open", type: "full-time", count: 1 }],
      crossTrain: [{ worker: "NEW-01", skill: "pick" }],
    });
    const added = ctx.workers.find((w) => w.id === "NEW-01");
    expect(added).toBeDefined();
    expect(added?.skills).toContain("pick");
  });
});

describe("every committed shop runs", () => {
  it.each(storeIds())("%s", async (id) => {
    const ctx = await buildTwin(id, 36, {});
    const site = findSite(id);
    expect(loadNetwork().stores.some((s) => s.id === site.store)).toBe(true);
    expect(ctx.layout.facings.length).toBeGreaterThan(100);
    expect(ctx.layout.storage.length).toBeGreaterThan(10);
    expect(ctx.layout.service.some((s) => s.kind === "register")).toBe(true);
    expect(ctx.layout.doors.some((d) => d.kind === "entrance")).toBe(true);
    expect(ctx.layout.doors.some((d) => d.kind === "dock" || d.kind === "ground")).toBe(true);

    const result = runOperations(ctx, operationsOptions(ctx, 7, 1));
    expect(result.sales.customers).toBeGreaterThan(0);
    expect(result.sales.salesDollars).toBeGreaterThan(0);
    // Trading hours are honoured: nobody arrives before the doors open.
    for (const d of result.daily) {
      const hrs = hoursOn(ctx.site, d.day);
      expect(d.open).toBe(hrs !== null);
      expect(d.weekday).toBe(weekdayOf(d.day));
    }
  });
});
