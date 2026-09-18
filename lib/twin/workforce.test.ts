/**
 * Workforce planner tests. The building, the hours and the shop's dollars are
 * the committed ones; the assortment and the roster are synthetic, so these
 * assert structure — conservation, direction, and rules the schedule must never
 * break — rather than numbers that move whenever the mock catalog is retuned.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_KINDS } from "../layout/spec";
import { buildDemandModel, DAY_OF_WEEK } from "./demand";
import { buildLayout, isGoldenShelf, siteToSpec, stockDistance, type Facing, type Layout } from "./layout";
import { facingUnitsFor, planogramFor, skuRates, type Planogram } from "./merch";
import { DEFAULT_COSTS, DEFAULT_STANDARDS } from "./standards";
import { PROCESSES, SKILLS, type Catalog, type Network, type Site, type Sku, type Worker } from "./types";
import { buildWeekSchedule, expectedWorkload, planSeason, singlePointsOfFailure, type WorkloadContext } from "./workforce";

const DATA = path.resolve(import.meta.dirname, "../../data");

function sites(): Site[] {
  return JSON.parse(readFileSync(path.join(DATA, "sites.json"), "utf8")) as Site[];
}

function siteById(id: string): Site {
  const found = sites().find((s) => s.id === id);
  if (!found) throw new Error(`no site ${id}`);
  return found;
}

function network(): Network {
  return JSON.parse(readFileSync(path.join(DATA, "network.json"), "utf8")) as Network;
}

/**
 * A synthetic assortment: three SKUs on each fixture family in every category
 * the shop sells, mostly on the overnight trailer with one importer calling in
 * its own truck. Bulk bins and showcase trays sell by the pound, everything
 * else by the piece.
 */
function makeCatalog(categories: string[]): Catalog {
  const skus: Sku[] = [];
  for (const category of categories) {
    const n = FIXTURE_KINDS.length * 2;
    for (let i = 0; i < n; i++) {
      const fixture = FIXTURE_KINDS[i % FIXTURE_KINDS.length];
      const weight = fixture === "bulk" || fixture === "showcase";
      // Every eighth SKU comes from the importer, which calls in its own truck.
      const supplier = i % 8 === 7 ? "sup-import" : i % 2 === 0 ? "sup-dc-1" : "sup-dc-2";
      skus.push({
        id: `${category.replace(/[^a-z]/g, "")}-${String(i + 1).padStart(2, "0")}`,
        name: `${category} ${fixture} ${i + 1}`,
        category,
        supplier,
        unitRetail: weight ? 14 + (i % 4) : 3.5 + (i % 5),
        sellBy: weight ? "weight" : "each",
        unitsPerInner: weight ? 5 : 12,
        innersPerCase: 6,
        casesPerPallet: 40,
        innerCubeFt: 0.35,
        velocityShare: 1 / n,
        fixture,
      });
    }
  }
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    seed: 1,
    suppliers: [
      { id: "sup-dc-1", name: "Domestic One", kind: "domestic", leadDays: 2, leadSdDays: 0.5, orderDay: 1, channel: "dc" },
      { id: "sup-dc-2", name: "Domestic Two", kind: "domestic", leadDays: 3, leadSdDays: 0.5, orderDay: 4, channel: "dc" },
      { id: "sup-import", name: "Importer", kind: "importer", leadDays: 3, leadSdDays: 2, orderDay: 2, channel: "direct" },
    ],
    skus,
  };
}

/**
 * A shop's planning context, assembled the way twin.ts assembles one: the
 * committed building and dollars, a synthetic assortment, and a real planogram
 * from merch.ts. `startWeek` 20 is a seasonally ordinary week.
 */
function makeContext(siteId: string, scale = 1, startWeek = 20): WorkloadContext {
  const site = siteById(siteId);
  const net = network();
  const store = net.stores.find((s) => s.id === site.store);
  if (!store) throw new Error(`no store ${site.store}`);
  const catalog = makeCatalog(Object.keys(store.revenueBy));
  const model = buildDemandModel(net, catalog.skus, site, scale);
  const layout = buildLayout(siteToSpec(site), site);
  const rates = skuRates(model);
  const plan = planogramFor("current", layout, catalog, model, rates);
  return {
    site,
    layout,
    model,
    catalog,
    std: DEFAULT_STANDARDS,
    startWeek,
    plan,
    facingUnits: facingUnitsFor("current", layout, plan, rates, DEFAULT_STANDARDS, site),
    rates,
  };
}

/** What it costs to keep one facing filled, in the terms the planner charges. */
function fillCost(layout: Layout, f: Facing): number {
  const shelves = layout.spec.fixtures.find((x) => x.id === f.run)?.shelves ?? f.shelf;
  return (2 * stockDistance(layout, f)) / DEFAULT_STANDARDS.walkFtPerMin + (isGoldenShelf(f.shelf, shelves) ? 0 : DEFAULT_STANDARDS.restockBendReachSec / 60);
}

function worker(id: string, role: string, type: Worker["type"], homeShift: string, skills: Worker["skills"], rate: number, maxWeeklyHours: number, productivity = 1): Worker {
  return { id, store: "", role, type, homeShift, skills, productivity, hourlyRate: rate, maxWeeklyHours };
}

/**
 * Buford's crew, as a shop that size really is staffed: one confectioner with a
 * food handler's card, one driver on the insurance, and everyone else on the
 * floor and the registers.
 */
function bufordRoster(): Worker[] {
  return [
    worker("buf-01", "Store manager", "full-time", "open", ["receive", "stock", "register", "pick"], 30, 40),
    worker("buf-02", "Counter confectioner", "full-time", "mid", ["counter", "register", "stock"], 19.5, 40, 1.05),
    worker("buf-03", "Cashier", "part-time", "close", ["register", "stock"], 16.5, 16, 0.95),
    worker("buf-04", "Stocker", "full-time", "open", ["stock", "receive"], 17.5, 40),
    worker("buf-05", "Delivery driver", "full-time", "open", ["drive", "pick", "stock"], 21, 40),
    worker("buf-06", "Cashier", "part-time", "mid", ["register", "stock"], 16.5, 24, 0.9),
  ];
}

/** Midtown trades seven days and needs a crew on every one of them. */
function midtownRoster(): Worker[] {
  return [
    worker("mid-01", "Store manager", "full-time", "open", ["receive", "stock", "register", "counter", "pick", "drive"], 30, 40),
    worker("mid-02", "Shift lead", "full-time", "mid", ["receive", "stock", "register", "counter", "pick"], 23, 40),
    worker("mid-03", "Counter confectioner", "full-time", "mid", ["counter", "register", "stock"], 19.5, 40, 1.05),
    worker("mid-04", "Counter confectioner", "full-time", "close", ["counter", "register", "stock"], 19.5, 40),
    worker("mid-05", "Cashier", "full-time", "close", ["register", "stock"], 16.5, 40),
    worker("mid-06", "Stocker", "full-time", "open", ["stock", "receive"], 17.5, 40),
    worker("mid-07", "Receiver", "full-time", "open", ["receive", "stock", "pick"], 18.5, 40),
    worker("mid-08", "Delivery driver", "full-time", "open", ["drive", "pick", "stock"], 21, 40),
    worker("mid-09", "Cashier", "part-time", "close", ["register", "stock"], 16.5, 24, 0.95),
  ];
}

describe("expectedWorkload", () => {
  const ctx = makeContext("store-midtown");

  it("reconciles half hours, processes and skills", () => {
    const week = expectedWorkload(ctx, 0);
    let cells = 0;
    for (const day of week.days) {
      const fromCells = day.halfHours.reduce((a, c) => a + c.total, 0);
      const fromProcess = PROCESSES.reduce((a, p) => a + day.byProcess[p], 0);
      const fromSkill = SKILLS.reduce((a, s) => a + day.bySkill[s], 0);
      expect(fromCells).toBeCloseTo(day.total, 6);
      expect(fromProcess).toBeCloseTo(day.total, 6);
      expect(fromSkill).toBeCloseTo(day.total, 6);
      cells += fromCells;
    }
    expect(cells).toBeCloseTo(week.total, 6);
    // Every minute is charged to exactly one shift, even the ones nobody covers.
    const byShift = Object.values(week.byShift).reduce((a, b) => a + b, 0);
    expect(byShift).toBeCloseTo(week.total, 6);
  });

  it("puts every process on the floor and the pre-open work before the doors", () => {
    const week = expectedWorkload(ctx, 0);
    for (const p of PROCESSES) expect(week.byProcess[p]).toBeGreaterThan(0);
    const friday = week.days[4];
    const opens = friday.open;
    const preOpen = (process: "pick" | "pack") =>
      friday.halfHours.filter((c) => c.minuteOfDay < opens).reduce((a, c) => a + (c.minutes[process] ?? 0), 0);
    expect(preOpen("pick")).toBeCloseTo(friday.byProcess.pick, 6);
    expect(preOpen("pack")).toBeCloseTo(friday.byProcess.pack, 6);
  });

  it("peaks at the counter in the evening on a weekday", () => {
    const friday = expectedWorkload(ctx, 0).days[4];
    expect(friday.weekday).toBe(5);
    expect(friday.peakHalfHour.minutes).toBeGreaterThan(0);
    expect(friday.peakHalfHour.minuteOfDay).toBeGreaterThanOrEqual(16 * 60);
    expect(friday.peakHalfHour.minuteOfDay).toBeLessThan(friday.close);
    // The peak is the counter, not the day: it is a slice of serve + checkout.
    const peak = friday.halfHours.find((c) => c.minuteOfDay === friday.peakHalfHour.minuteOfDay);
    expect(peak).toBeDefined();
    expect(friday.peakHalfHour.minutes).toBeCloseTo((peak?.minutes.serve ?? 0) + (peak?.minutes.checkout ?? 0), 6);
  });

  it("is flat where the shop is dark and follows the day of the week where it is not", () => {
    const buford = expectedWorkload(makeContext("store-buford"), 0);
    const monday = buford.days[0];
    expect(monday.weekday).toBe(1);
    expect(monday.total).toBe(0);
    expect(monday.halfHours).toHaveLength(0);
    // Saturday pulls hardest of the trading days, and the workload follows.
    const saturday = buford.days[5];
    const tuesday = buford.days[1];
    expect(DAY_OF_WEEK[5]).toBeGreaterThan(DAY_OF_WEEK[1]);
    expect(saturday.byProcess.checkout).toBeGreaterThan(tuesday.byProcess.checkout);
  });

  it("charges restocking for where the planogram put the SKU", () => {
    const cheap = [...ctx.layout.facings].sort((a, b) => fillCost(ctx.layout, a) - fillCost(ctx.layout, b) || (a.id < b.id ? -1 : 1));
    const near: Planogram = new Map();
    const far: Planogram = new Map();
    ctx.model.skus.forEach((sku, i) => {
      near.set(sku.id, cheap[i]);
      far.set(sku.id, cheap[cheap.length - 1 - i]);
    });
    const restock = (plan: Planogram) => expectedWorkload({ ...ctx, plan }, 0).byProcess.restock;
    expect(restock(near)).toBeLessThan(restock(far));
    // And a shop whose plan places nothing falls back to the building average,
    // which lands between the two.
    const blind = restock(new Map());
    expect(blind).toBeGreaterThan(restock(near));
    expect(blind).toBeLessThan(restock(far));
  });

  it("rises with the scenario's demand scale and with the season", () => {
    const base = expectedWorkload(ctx, 0);
    const busier = expectedWorkload(makeContext("store-midtown", 1.4), 0);
    expect(busier.total).toBeGreaterThan(base.total);
    expect(busier.byProcess.checkout).toBeGreaterThan(base.byProcess.checkout * 1.3);
    // Horizon week 24 of a horizon starting in week 20 is calendar week 44.
    const halloween = expectedWorkload(ctx, 24);
    expect(halloween.calendarWeek).toBe(44);
    expect(halloween.total).toBeGreaterThan(base.total * 1.5);
  });
});

describe("buildWeekSchedule", () => {
  const ctx = makeContext("store-midtown");
  const roster = midtownRoster();

  it("never puts anyone on a skill they do not hold, or past their hours", () => {
    const sched = buildWeekSchedule(ctx, roster, 0);
    const byId = new Map(roster.map((w) => [w.id, w]));
    const hours = new Map<string, number>();
    const seen = new Set<string>();
    for (const a of sched.assignments) {
      const w = byId.get(a.worker);
      expect(w).toBeDefined();
      expect(w?.skills).toContain(a.primary);
      expect(a.shift).toBe(w?.homeShift);
      // One primary per person per day.
      const key = `${a.day}/${a.worker}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      hours.set(a.worker, (hours.get(a.worker) ?? 0) + a.hours);
    }
    for (const [id, h] of hours) expect(h).toBeLessThanOrEqual((byId.get(id)?.maxWeeklyHours ?? 0) + 1e-9);
  });

  it("covers every trading day before it chases the busy ones", () => {
    const sched = buildWeekSchedule(ctx, roster, 0);
    const daysOf = (id: string) => sched.assignments.filter((a) => a.worker === id).map((a) => a.weekday).sort((x, y) => x - y);

    // Coverage first: no trading day is left with nobody on it, whatever the
    // volume says. A shop that opens on Monday with an empty floor is not a
    // staffing plan, and the scheduler puts one person on every shift of every
    // trading day before anyone gets their pick of the busy end of the week.
    for (let d = 0; d < 7; d++) {
      expect(sched.assignments.filter((a) => a.day === d).length, `day ${d}`).toBeGreaterThan(0);
    }

    // Then volume: what hours are left go where the load is. mid-09 works 24 h
    // against an 8.5 h paid shift, so three days at most, and they lean late.
    const pt = daysOf("mid-09");
    expect(pt.length).toBeGreaterThan(0);
    expect(pt.length).toBeLessThanOrEqual(3);
    expect(pt.some((weekday) => weekday >= 5)).toBe(true);

    // A 40 h full-timer on an 8 h paid shift covers five of the seven days.
    expect(daysOf("mid-01")).toHaveLength(5);
  });

  it("needs fewer hours as the target utilization rises", () => {
    const total = (u: number) => SKILLS.reduce((a, s) => a + buildWeekSchedule(ctx, roster, 0, { targetUtilization: u, absenteeism: 0.05 }).required[s], 0);
    const slack = total(0.75);
    const tight = total(0.95);
    expect(tight).toBeLessThan(slack);
    expect(tight).toBeCloseTo((slack * 0.75) / 0.95, 6);
  });

  it("covers what it can and reports the rest as a gap", () => {
    const sched = buildWeekSchedule(ctx, roster, 0);
    for (const skill of SKILLS) {
      expect(sched.covered[skill]).toBeLessThanOrEqual(sched.required[skill] + 1e-6);
    }
    for (const gap of sched.gaps) {
      expect(gap.gapHours).toBeGreaterThan(0);
      expect(gap.gapHours).toBeCloseTo(gap.requiredHours - gap.coveredHours, 6);
    }
    expect(sched.spareHours).toBeGreaterThanOrEqual(0);
  });

  it("flags the day a skill rests on one person", () => {
    const sched = buildWeekSchedule(makeContext("store-buford"), bufordRoster(), 0);
    const driver = sched.risks.filter((r) => r.skill === "drive");
    expect(driver.length).toBeGreaterThan(0);
    for (const r of driver) expect(r.worker).toBe("buf-05");
  });
});

describe("planSeason", () => {
  it("closes an ordinary week without overtime and names the gated skills when it cannot", () => {
    const quiet = planSeason(makeContext("store-midtown"), midtownRoster(), DEFAULT_COSTS, 0, 2);
    expect(quiet).toHaveLength(2);
    for (const row of quiet) {
      expect(row.requiredHours).toBeGreaterThan(0);
      expect(row.rosterHours).toBeGreaterThan(0);
      expect(row.laborCost).toBeGreaterThan(0);
      expect(row.notes.length).toBeGreaterThan(0);
    }

    // Three times the dollars on the Halloween week, with one confectioner and
    // one driver on the payroll: overtime cannot close it and a temp may not.
    const stretched = planSeason(makeContext("store-buford", 3), bufordRoster(), DEFAULT_COSTS, 24, 1);
    const row = stretched[0];
    expect(row.calendarWeek).toBe(44);
    expect(row.overtimeHours).toBeGreaterThan(0);
    expect(row.gapHours).toBeGreaterThan(0);
    expect(row.notes.join(" ")).toMatch(/food handler's card|licence and the store's insurance/);
  });

  it("grows the requirement through the candy calendar", () => {
    const ctx = makeContext("store-midtown");
    const rows = planSeason(ctx, midtownRoster(), DEFAULT_COSTS, 0, 25);
    const ordinary = rows[0];
    const halloween = rows[24];
    expect(halloween.calendarWeek).toBe(44);
    expect(halloween.requiredHours).toBeGreaterThan(ordinary.requiredHours * 1.5);
    // The standing roster cannot grow, so the extra has to show up as overtime,
    // temps or an uncovered gap.
    expect(halloween.overtimeHours + halloween.tempHours + halloween.gapHours).toBeGreaterThan(0);
  });
});

describe("singlePointsOfFailure", () => {
  it("finds the one counter clerk and the one driver", () => {
    const points = singlePointsOfFailure(bufordRoster());
    expect(points.map((p) => p.skill).sort()).toEqual(["counter", "drive"]);
    expect(points.find((p) => p.skill === "counter")?.workers).toEqual(["buf-02"]);
    expect(points.find((p) => p.skill === "drive")?.workers).toEqual(["buf-05"]);
    for (const p of points) expect(p.note).toContain(p.workers[0]);
  });

  it("does not count temps, and says so when nobody holds a skill", () => {
    const roster = bufordRoster().filter((w) => w.id !== "buf-05");
    roster.push(worker("buf-90", "Seasonal driver", "temp", "open", ["drive", "stock"], 24, 32));
    const drive = singlePointsOfFailure(roster).find((p) => p.skill === "drive");
    expect(drive?.workers).toEqual([]);
    expect(drive?.note).toMatch(/Nobody/);
  });
});
