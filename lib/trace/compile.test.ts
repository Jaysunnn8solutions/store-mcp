/**
 * The compiler's contract with the page, pinned as invariants rather than as
 * numbers: the same events compile to byte-identical arrays, every track's time
 * strictly increases, a job's animation occupies exactly the minutes the engine
 * charged it, the dirty list is in the order the cursor's half-open range
 * needs, and the projection at the horizon is the MCP tools' own `kpis`.
 *
 * That last one is the point of the whole subsystem. If it ever fails, the 3D
 * page and the tools are telling two different stories about the same day.
 */

import { describe, expect, it } from "vitest";
import { storeIds } from "../data/store";
import { runOperations, type OperationsResult } from "../twin/operations";
import type { Layout } from "../twin/layout";
import { kpis, KPI_KEYS, type Kpis } from "../twin/replicate";
import { buildTwin, operationsOptions } from "../twin/twin";
import { collectBuffers, compilePlayback, CsrBuilder, PalletBuilder, rowInsertIndex, type CompileInput } from "./compile";
import { finalize, kpiContext, projectKpis, type KpiState } from "./kpis";
import { ActorState, PalletAt, RecordingTracer, type CsrTimeline, type Playback, type SkuInfo, type SupplierInfo, type TraceEvent, type TraceInit, type World } from "./types";
import { buildWorld } from "./world";

const DAYS = 3;
const SEED = 1;
/** Week 44 is the Halloween peak: full queues, walk-outs and a busy lot. */
const START_WEEK = 44;

interface Fixture {
  input: CompileInput;
  events: TraceEvent[];
  init: TraceInit;
  layout: Layout;
  world: World;
  result: OperationsResult;
  playback: Playback;
}

const cached = new Map<string, Fixture>();

/**
 * The default fixture is the one the 3D page plays: the first shop on seed 1.
 * The projection test also compiles a second shop on a second seed, because the
 * numbers only mean something if they hold on a floor plan and an order book
 * the compiler was not written in front of.
 */
async function fixture(store = 0, seed = SEED): Promise<Fixture> {
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
  const suppliers: SupplierInfo[] = ctx.catalog.suppliers.map((s) => ({ id: s.id, name: s.name, channel: s.channel }));
  const world = buildWorld(
    ctx.layout,
    ctx.workers.map((w) => ({ id: w.id, role: w.role, type: w.type, skills: w.skills, productivity: w.productivity, hourlyRate: w.hourlyRate, overtimeMultiplier: 1.5 }))
  );
  const input: CompileInput = {
    events,
    layout: ctx.layout,
    world,
    skus,
    planogram: [...ctx.plan.entries()].map(([sku, f]) => [sku, f.id] as [string, string]),
    suppliers,
  };
  const f: Fixture = { input, events, init, layout: ctx.layout, world, result, playback: compilePlayback(input) };
  cached.set(key, f);
  return f;
}

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>, what: string): void {
  expect(`${what}.length=${a.length}`).toBe(`${what}.length=${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) expect(`${what}[${i}]=${a[i]}`).toBe(`${what}[${i}]=${b[i]}`);
  }
}

function csrArrays(c: CsrTimeline<Uint8Array | Uint16Array | Int32Array | Uint32Array>): Array<ArrayLike<number>> {
  return [c.offsets, c.t, c.v, c.ev];
}

function everyArray(pb: Playback): Array<[string, ArrayLike<number>]> {
  const out: Array<[string, ArrayLike<number>]> = [];
  pb.tracks.forEach((tr, i) => {
    if (!tr) return;
    out.push([`track${i}.t`, tr.t], [`track${i}.x`, tr.x], [`track${i}.y`, tr.y], [`track${i}.z`, tr.z], [`track${i}.h`, tr.h], [`track${i}.s`, tr.s], [`track${i}.seg`, tr.seg], [`track${i}.job`, tr.job], [`track${i}.carry`, tr.carry]);
  });
  const csrs: Array<[string, CsrTimeline<Uint8Array | Uint16Array | Int32Array | Uint32Array>]> = [
    ["facings", pb.facings],
    ["facingHot", pb.facingHot],
    ["storage", pb.storage],
    ["storageSku", pb.storageSku],
    ["doors", pb.doors],
    ["laneSlots", pb.laneSlots],
    ["posts", pb.posts],
    ["queueLen", pb.queueLen],
    ["stalls", pb.stalls],
  ];
  for (const [name, c] of csrs) csrArrays(c).forEach((a, j) => out.push([`${name}[${j}]`, a]));
  out.push(["facingSku", pb.facingSku]);
  out.push(["pallets.offsets", pb.pallets.offsets], ["pallets.t", pb.pallets.t], ["pallets.at", pb.pallets.at], ["pallets.ref", pb.pallets.ref], ["pallets.slot", pb.pallets.slot], ["pallets.ev", pb.pallets.ev]);
  out.push(["dirty.t", pb.dirty.t], ["dirty.kind", pb.dirty.kind], ["dirty.idx", pb.dirty.idx], ["dirty.row", pb.dirty.row]);
  out.push(["queueBins.queues", pb.queueBins.queues], ["kpiBins.series", pb.kpiBins.series]);
  out.push(["samples.dockToStock", pb.samples.dockToStock], ["samples.counterWait", pb.samples.counterWait], ["samples.registerWait", pb.samples.registerWait], ["samples.orderCycle", pb.samples.orderCycle]);
  out.push(["quiet.t0", pb.quiet.t0], ["quiet.t1", pb.quiet.t1]);
  return out;
}

/**
 * The only figures allowed to differ from the tools', and why. The labor
 * figures are summed per worker and then across workers by the engine, and in
 * clock-in order by the reducer, and floating-point addition is not
 * associative. The four sampled figures are read back out of the Float32
 * buffers the samples cross to the page as. Everything else — every count,
 * every dollar, every minute — is compared bit for bit. Observed worst case
 * across four shop-and-seed runs: 4e-8 relative on the samples, 3e-15 on the
 * labor figures.
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

describe("rowInsertIndex", () => {
  it("places a row by time, not by call order", () => {
    const rows = [{ t: 0 }, { t: 5 }, { t: 9 }];
    expect(rowInsertIndex(rows, -1)).toBe(0);
    expect(rowInsertIndex(rows, 0)).toBe(1);
    expect(rowInsertIndex(rows, 5)).toBe(2);
    expect(rowInsertIndex(rows, 7)).toBe(2);
    expect(rowInsertIndex(rows, 100)).toBe(3);
  });
});

describe("CsrBuilder", () => {
  it("keeps rows in time order however they are written, and drops repeats", () => {
    const b = new CsrBuilder(1, () => 0);
    b.set(0, 10, 5, 1);
    b.set(0, 4, 3, 2); // written later, belongs earlier
    b.set(0, 20, 5, 3); // no change from the row in force
    const dirty: Array<{ t: number; kind: number; idx: number; row: number }> = [];
    const out = b.build((n) => new Int32Array(n), 0, dirty);
    expect([...out.t]).toEqual([0, 4, 10]);
    expect([...out.v]).toEqual([0, 3, 5]);
    // Row 0 is the initial value and is never dirty.
    expect(dirty.map((d) => d.row)).toEqual([1, 2]);
  });

  it("replaces a row written at the same minute", () => {
    const b = new CsrBuilder(1, () => -1);
    b.set(0, 7, 2, 0);
    b.set(0, 7, 3, 1);
    const out = b.build((n) => new Int32Array(n), 0, []);
    expect([...out.t]).toEqual([0, 7]);
    expect([...out.v]).toEqual([-1, 3]);
  });
});

describe("PalletBuilder", () => {
  it("starts unborn and records each move once", () => {
    const b = new PalletBuilder();
    const i = b.add();
    b.set(i, 3, PalletAt.Trailer, 9, -1, 0);
    b.set(i, 8, PalletAt.Trailer, 9, -1, 1);
    b.set(i, 12, PalletAt.Gone, -1, -1, 2);
    expect(b.current(i).at).toBe(PalletAt.Gone);
    const out = b.build([]);
    expect([...out.at]).toEqual([PalletAt.Unborn, PalletAt.Trailer, PalletAt.Gone]);
    expect([...out.t]).toEqual([0, 3, 12]);
  });
});

describe("compilePlayback", () => {
  it("compiles the same events to byte-identical arrays", async () => {
    const f = await fixture();
    const again = compilePlayback(f.input);
    const a = everyArray(f.playback);
    const b = everyArray(again);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) sameArray(a[i][1], b[i][1], a[i][0]);
    expect(again.entities).toEqual(f.playback.entities);
    expect(again.ticker).toEqual(f.playback.ticker);
    expect(again.jobs.length).toBe(f.playback.jobs.length);
  });

  it("names every entity and gives every worker a track", async () => {
    const f = await fixture();
    const pb = f.playback;
    expect(pb.entities.length).toBe(pb.tracks.length);
    for (const e of pb.entities) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.colorIdx).toBeGreaterThanOrEqual(0);
    }
    for (const w of f.init.workers) {
      const i = pb.entities.findIndex((e) => e.kind === "worker" && e.id === w.id);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(pb.tracks[i]).not.toBeNull();
    }
    // A pallet lives in the pallet timeline instead of a track.
    pb.entities.forEach((e, i) => {
      if (e.kind === "pallet") expect(pb.tracks[i]).toBeNull();
      else expect(pb.tracks[i]).not.toBeNull();
    });
    const arrivals = f.events.filter((e) => e.k === "customerArrive").length;
    expect(pb.entities.filter((e) => e.kind === "customer").length).toBe(arrivals);
    expect(pb.entities.filter((e) => e.kind === "car").length).toBe(arrivals);
  });

  it("keeps every track's time strictly increasing and inside the horizon", async () => {
    const f = await fixture();
    for (const tr of f.playback.tracks) {
      if (!tr) continue;
      expect(tr.t.length).toBeGreaterThan(0);
      expect(tr.t[0]).toBeGreaterThanOrEqual(0);
      for (let i = 1; i < tr.t.length; i++) {
        if (!(tr.t[i] > tr.t[i - 1])) expect(`track ${tr.entity} frame ${i}: ${tr.t[i]} after ${tr.t[i - 1]}`).toBe("strictly increasing");
      }
      expect(tr.t[tr.t.length - 1]).toBeLessThanOrEqual(f.init.horizonEnd + 1e-9);
      expect(tr.x.length).toBe(tr.t.length);
      expect(tr.carry.length).toBe(tr.t.length);
    }
  });

  it("gives a job exactly the minutes the engine charged it", async () => {
    const f = await fixture();
    const pb = f.playback;
    const started = pb.jobs.filter((j) => j.startAt >= 0);
    expect(started.length).toBeGreaterThan(0);
    for (const j of started) {
      expect(j.endAt - j.startAt).toBeCloseTo(j.dur, 9);
      expect(j.truncated).toBe(j.endAt > f.init.horizonEnd);
      expect(j.stopMin + j.moveMin).toBeLessThanOrEqual(j.dur + 1e-6);
    }
    // No frame belonging to a job falls outside that job's window.
    const byId = new Map(pb.jobs.map((j) => [j.id, j]));
    for (const tr of pb.tracks) {
      if (!tr) continue;
      for (let i = 0; i < tr.t.length; i++) {
        const j = byId.get(tr.job[i]);
        if (!j || j.startAt < 0) continue;
        expect(tr.t[i]).toBeGreaterThanOrEqual(j.startAt - 1e-6);
        expect(tr.t[i]).toBeLessThanOrEqual(Math.min(j.endAt, f.init.horizonEnd) + 1e-6);
      }
    }
  });

  it("reports a fit for every job it drew", async () => {
    const f = await fixture();
    const fits = new Set(f.playback.jobs.filter((j) => j.startAt >= 0).map((j) => j.fit));
    for (const fit of fits) expect(["stationary", "exact", "borrowed", "fadeIn", "fast"]).toContain(fit);
    for (const j of f.playback.jobs) {
      if (j.startAt < 0) continue;
      expect(j.speedRatio).toBeGreaterThan(0);
      expect(j.visualFeet).toBeGreaterThanOrEqual(0);
    }
  });

  it("builds sound CSR timelines and a sorted dirty list", async () => {
    const f = await fixture();
    const pb = f.playback;
    const csrs: Array<[string, CsrTimeline<Uint8Array | Uint16Array | Int32Array | Uint32Array>]> = [
      ["facings", pb.facings],
      ["facingHot", pb.facingHot],
      ["storage", pb.storage],
      ["storageSku", pb.storageSku],
      ["doors", pb.doors],
      ["laneSlots", pb.laneSlots],
      ["posts", pb.posts],
      ["queueLen", pb.queueLen],
      ["stalls", pb.stalls],
    ];
    for (const [name, c] of csrs) {
      expect(c.offsets[0]).toBe(0);
      for (let i = 0; i + 1 < c.offsets.length; i++) {
        const lo = c.offsets[i];
        const hi = c.offsets[i + 1];
        expect(`${name}[${i}] rows`).toBe(hi >= lo ? `${name}[${i}] rows` : "non-negative");
        expect(c.t[lo]).toBe(0);
        for (let r = lo + 1; r < hi; r++) expect(c.t[r]).toBeGreaterThan(c.t[r - 1]);
      }
      expect(c.offsets[c.offsets.length - 1]).toBe(c.t.length);
    }
    for (let i = 1; i < pb.dirty.t.length; i++) {
      const before = [pb.dirty.t[i - 1], pb.dirty.kind[i - 1], pb.dirty.idx[i - 1], pb.dirty.row[i - 1]];
      const after = [pb.dirty.t[i], pb.dirty.kind[i], pb.dirty.idx[i], pb.dirty.row[i]];
      const cmp = before.findIndex((v, k) => v !== after[k]);
      if (cmp >= 0) expect(before[cmp]).toBeLessThan(after[cmp]);
    }
    // Every dirty row points at a real row of its timeline.
    const lengths = [pb.facings.t.length, pb.facingHot.t.length, pb.storage.t.length, pb.storageSku.t.length, pb.doors.t.length, pb.laneSlots.t.length, pb.posts.t.length, pb.pallets.t.length, pb.stalls.t.length, pb.queueLen.t.length];
    for (let i = 0; i < pb.dirty.t.length; i++) {
      const n = lengths[pb.dirty.kind[i]];
      expect(pb.dirty.row[i]).toBeGreaterThanOrEqual(0);
      expect(pb.dirty.row[i]).toBeLessThan(n);
    }
  });

  it("keeps the queues, posts and stalls physically possible", async () => {
    const f = await fixture();
    const pb = f.playback;
    for (let i = 0; i < pb.queueLen.v.length; i++) expect(pb.queueLen.v[i]).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < pb.posts.v.length; i++) {
      const v = pb.posts.v[i];
      expect(v).toBeGreaterThanOrEqual(-2);
      if (v >= 0) expect(pb.entities[v]).toBeDefined();
    }
    for (let i = 0; i < pb.stalls.v.length; i++) {
      const v = pb.stalls.v[i];
      if (v >= 0) expect(pb.entities[v]?.kind).toBe("car");
    }
    // A stall is never occupied by two cars at once.
    for (let s = 0; s + 1 < pb.stalls.offsets.length; s++) {
      let occupied = false;
      for (let r = pb.stalls.offsets[s]; r < pb.stalls.offsets[s + 1]; r++) {
        const v = pb.stalls.v[r];
        if (v >= 0) {
          expect(occupied).toBe(false);
          occupied = true;
        } else occupied = false;
      }
    }
  });

  it("draws the queues, because they are the point of the page", async () => {
    const f = await fixture();
    const pb = f.playback;
    // Somebody waited at a register, and a clerk served somebody at one.
    let longest = 0;
    for (let i = 0; i < pb.queueLen.v.length; i++) longest = Math.max(longest, pb.queueLen.v[i]);
    expect(longest).toBeGreaterThan(0);
    expect([...pb.posts.v].some((v) => v >= 0)).toBe(true);
    // Every customer stands in a line at some point, and goes Off at the end.
    const customers = pb.entities.map((e, i) => (e.kind === "customer" ? i : -1)).filter((i) => i >= 0);
    expect(customers.length).toBeGreaterThan(0);
    const queued = customers.filter((i) => {
      const tr = pb.tracks[i];
      return tr ? [...tr.s].includes(ActorState.Queue) : false;
    });
    expect(queued.length).toBeGreaterThan(customers.length / 2);
    for (const i of customers.slice(0, 50)) {
      const tr = pb.tracks[i]!;
      expect(tr.s[0]).toBe(ActorState.Off);
    }
    // The shelves and the stockroom both move.
    expect(pb.facings.t.length).toBeGreaterThan(pb.facings.offsets.length);
    expect(pb.storage.t.length).toBeGreaterThan(pb.storage.offsets.length);
  });

  it("moves every pallet through places that exist", async () => {
    const f = await fixture();
    const pb = f.playback;
    const known = new Set(Object.values(PalletAt) as number[]);
    for (let p = 0; p + 1 < pb.pallets.offsets.length; p++) {
      const lo = pb.pallets.offsets[p];
      expect(pb.pallets.at[lo]).toBe(PalletAt.Unborn);
      for (let r = lo; r < pb.pallets.offsets[p + 1]; r++) {
        expect(known.has(pb.pallets.at[r])).toBe(true);
        if (pb.pallets.at[r] === PalletAt.Storage) expect(pb.pallets.ref[r]).toBeLessThan(f.layout.storage.length);
      }
    }
  });

  it("bins the queues and the KPI series across the whole horizon", async () => {
    const f = await fixture();
    const pb = f.playback;
    expect(pb.queueBins.binMin).toBe(1);
    expect(pb.kpiBins.binMin).toBe(5);
    expect(pb.queueBins.count).toBe(Math.ceil(f.init.horizonEnd));
    expect(pb.kpiBins.count).toBe(Math.ceil(f.init.horizonEnd / 5));
    expect(pb.kpiBins.series.length).toBe(pb.kpiBins.count * 18);
    // Sales only ever go up, bin to bin.
    let last = 0;
    for (let b = 0; b < pb.kpiBins.count; b++) {
      const v = pb.kpiBins.series[b * 18];
      expect(v).toBeGreaterThanOrEqual(last - 1e-6);
      last = v;
    }
    expect(pb.checkpoints.length).toBeGreaterThan(0);
    expect(pb.checkpoints[0].t).toBe(0);
    for (let i = 1; i < pb.checkpoints.length; i++) expect(pb.checkpoints[i].t).toBeGreaterThan(pb.checkpoints[i - 1].t);
  });

  it("lists quiet intervals in order and inside the horizon", async () => {
    const f = await fixture();
    const q = f.playback.quiet;
    for (let i = 0; i < q.t0.length; i++) {
      expect(q.t1[i]).toBeGreaterThan(q.t0[i]);
      expect(q.t0[i]).toBeGreaterThanOrEqual(0);
      expect(q.t1[i]).toBeLessThanOrEqual(f.init.horizonEnd);
      if (i > 0) expect(q.t0[i]).toBeGreaterThanOrEqual(q.t1[i - 1]);
    }
  });

  it("writes a ticker the shop would recognise", async () => {
    const f = await fixture();
    const t = f.playback.ticker;
    expect(t.length).toBeGreaterThan(0);
    for (let i = 1; i < t.length; i++) expect(t[i].t).toBeGreaterThanOrEqual(t[i - 1].t - 1e-9);
    for (const line of t) {
      expect(line.text.length).toBeGreaterThan(0);
      expect([0, 1, 2]).toContain(line.severity);
      expect(f.playback.events[line.ev]?.k).toBe(line.kind);
    }
    // A walked-out customer is always a problem, never a note.
    for (const line of t) if (line.kind === "abandon") expect(line.severity).toBe(2);
    // Every order that left the shop says so exactly once, and says it from the
    // event that carries the money: `orderOut`, not the three events around it.
    expect(t.filter((l) => l.kind === "orderOut").length).toBe(f.events.filter((e) => e.k === "orderOut").length);
    expect(t.some((l) => l.kind === "orderCollected")).toBe(false);
    // A restock is a trip, so its line counts facings rather than naming a SKU.
    const trips = t.filter((l) => l.kind === "jobQueued" && l.text.startsWith("Restock cart"));
    expect(trips.length).toBeGreaterThan(0);
    for (const l of trips) expect(l.text).toMatch(/\d+ facings? to fill/);
  });

  it("hands postMessage every buffer exactly once", async () => {
    const f = await fixture();
    const bufs = collectBuffers(f.playback);
    expect(new Set(bufs).size).toBe(bufs.length);
    const have = new Set(bufs);
    for (const [name, a] of everyArray(f.playback)) {
      const view = a as unknown as ArrayBufferView;
      expect(`${name} transferred`).toBe(have.has(view.buffer as ArrayBuffer) ? `${name} transferred` : `${name} missing`);
    }
  });

  it("drops the events when the page does not want them", async () => {
    const f = await fixture();
    const lean = compilePlayback({ ...f.input, opts: { keepEvents: false } });
    expect(lean.events).toEqual([]);
    expect(lean.jobs.length).toBe(f.playback.jobs.length);
    expect(lean.meta.compiler).toBe(f.playback.meta.compiler);
  });

  // Marietta on seed 2 is the second opinion: one counter station instead of
  // two, one van round instead of two and shorter trading hours, so the order
  // book, the queues and the utilization denominators are all different numbers.
  for (const c of [
    { store: 0, seed: SEED },
    { store: 2, seed: SEED + 1 },
  ]) {
    it(`projects the tools' kpis(result) exactly at the horizon: shop ${c.store}, seed ${c.seed}`, async () => {
      const f = await fixture(c.store, c.seed);
      const pb = f.playback;
      const last = pb.checkpoints[pb.checkpoints.length - 1];
      expect(last.t).toBe(f.init.horizonEnd);
      const got = projectKpis(last.kpis as KpiState, f.init.horizonEnd, f.init, pb.samples, true);
      const want = kpis(f.result);
      for (const k of KPI_KEYS) {
        const tol = NEAR[k];
        if (tol === undefined) expect(`${k}=${got[k]}`).toBe(`${k}=${want[k]}`);
        else expect(Math.abs(got[k] - want[k]) / Math.max(1, Math.abs(want[k])), `${k}: ${got[k]} vs ${want[k]}`).toBeLessThan(tol);
      }
    });
  }

  it("finalizes the same way from a checkpoint replay", async () => {
    const f = await fixture();
    const ctx = kpiContext(f.init, f.events, f.input.skus);
    const mid = f.playback.checkpoints[Math.floor(f.playback.checkpoints.length / 2)];
    expect(mid.kpis.lastT).toBeLessThanOrEqual(mid.t + 1e-9);
    // Finalizing twice from the same state gives the same numbers, so the
    // checkpoint the HUD reads is not order-dependent.
    const a = { ...mid.kpis, queues: [...mid.kpis.queues] } as KpiState;
    const b = { ...mid.kpis, queues: [...mid.kpis.queues] } as KpiState;
    finalize(a, f.init.horizonEnd, ctx);
    finalize(b, f.init.horizonEnd, ctx);
    expect(a).toEqual(b);
  });
});
