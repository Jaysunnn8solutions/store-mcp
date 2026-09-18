/**
 * Planogram tests. They assert the structural claims the model makes — every
 * SKU on a fixture it belongs to, a mean-1 appeal map, facings between the
 * uniform one and what the shelf holds — and the direction of the two
 * comparisons the tools sell: an optimized plan puts more of the store's
 * dollars where the customer sees them, and refills fewer times a week.
 *
 * The catalog is a fixture rather than the committed one, because the catalog
 * generator is a sibling module: it is sized from the layout so every store's
 * families fit, and its velocity shares are a Zipf curve, which is how a candy
 * range really falls.
 */

import { describe, expect, it } from "vitest";
import networkJson from "../../data/network.json";
import sitesJson from "../../data/sites.json";
import { LimitError } from "../layout/limits";
import { FIXTURE_KINDS, type FixtureKind } from "../layout/spec";
import { buildDemandModel } from "./demand";
import { buildLayout, siteToSpec, type Layout } from "./layout";
import {
  appealOf,
  currentPlanogram,
  evaluateMerch,
  facingCapacity,
  facingUnitsFor,
  facingValue,
  optimizedPlanogram,
  partialPlanogram,
  planogramFor,
  restockCost,
  restocksPerWeek,
  skuRates,
  type SkuRate,
} from "./merch";
import { DEFAULT_STANDARDS } from "./standards";
import type { Catalog, Network, Site, Sku } from "./types";

const network = networkJson as unknown as Network;
const sites = sitesJson as unknown as Site[];
const std = DEFAULT_STANDARDS;

/** Roughly the shape of a small candy range: mostly gondola, a little of everything else. */
const DESIRED: Record<FixtureKind, number> = { gondola: 60, wall: 12, bulk: 10, showcase: 14, endcap: 6, seasonal: 4, impulse: 4 };

function siteById(id: string): Site {
  const site = sites.find((s) => s.id === id);
  if (!site) throw new Error(`${id} is not in data/sites.json`);
  return site;
}

function makeCatalog(layout: Layout, categories: string[], counts: Partial<Record<FixtureKind, number>> = {}): Catalog {
  const room = new Map<FixtureKind, number>();
  for (const f of layout.facings) room.set(f.kind, (room.get(f.kind) ?? 0) + 1);
  const skus: Sku[] = [];
  for (const category of categories) {
    const start = skus.length;
    for (const kind of FIXTURE_KINDS) {
      const want = counts[kind] ?? Math.min(DESIRED[kind], Math.floor((room.get(kind) ?? 0) / categories.length));
      for (let k = 0; k < want; k++) {
        const n = skus.length + 1;
        const weight = kind === "bulk" || kind === "showcase";
        skus.push({
          id: `S-${String(n).padStart(4, "0")}`,
          name: `${kind} candy ${n}`,
          category,
          supplier: "SUP-1",
          unitRetail: weight ? 11 + (n % 5) : 3 + (n % 7),
          sellBy: weight ? "weight" : "each",
          unitsPerInner: weight ? 5 : 24,
          innersPerCase: 6,
          casesPerPallet: 40,
          innerCubeFt: 0.25,
          velocityShare: 0,
          fixture: kind,
        });
      }
    }
    const mine = skus.slice(start);
    const raw = mine.map((_, i) => 1 / (i + 3));
    const total = raw.reduce((a, b) => a + b, 0);
    mine.forEach((s, i) => {
      s.velocityShare = raw[i] / total;
    });
  }
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    seed: 1,
    suppliers: [{ id: "SUP-1", name: "Test supplier", kind: "domestic", leadDays: 4, leadSdDays: 1, orderDay: 1, channel: "dc" }],
    skus,
  };
}

interface Fixture {
  site: Site;
  layout: Layout;
  catalog: Catalog;
  rates: SkuRate[];
}

function setup(siteId: string, counts?: Partial<Record<FixtureKind, number>>): Fixture {
  const site = siteById(siteId);
  const layout = buildLayout(siteToSpec(site), site);
  const store = network.stores.find((s) => s.id === site.store);
  if (!store) throw new Error(`${site.store} is not in data/network.json`);
  const categories = Object.keys(store.revenueBy).filter((c) => store.revenueBy[c] > 0);
  const catalog = makeCatalog(layout, categories, counts);
  // The bootstrap a caller does: a model with no appeal yet gives the rates the
  // planogram is ranked on, and the planogram gives the appeal for the next one.
  const model = buildDemandModel(network, catalog.skus, site);
  return { site, layout, catalog, rates: skuRates(model) };
}

function plans(f: Fixture) {
  const model = buildDemandModel(network, f.catalog.skus, f.site);
  const current = currentPlanogram(f.layout, f.catalog, model);
  const optimal = optimizedPlanogram(f.layout, f.catalog, model, f.rates);
  return { model, current, optimal };
}

const midtown = setup("store-midtown");

describe("skuRates", () => {
  it("gives every SKU the shop sells a rate, and ranks by velocity", () => {
    expect(midtown.rates.length).toBe(midtown.catalog.skus.length);
    for (const r of midtown.rates) {
      expect(r.unitsPerWeek).toBeGreaterThan(0);
      expect(r.basketsPerWeek).toBeGreaterThan(0);
      // A shopper takes at least one piece of a packaged SKU, so it can never
      // be on more baskets than it sells pieces. A weighed one sells by the
      // fraction of a pound, so its baskets can and do outrun its pounds.
      if (r.sku.sellBy === "each") expect(r.basketsPerWeek).toBeLessThanOrEqual(r.unitsPerWeek + 1e-9);
    }
    const first = midtown.rates[0];
    const last = midtown.rates[midtown.rates.length - 1];
    expect(first.unitsPerWeek).toBeGreaterThan(last.unitsPerWeek);
  });

  it("is deterministic", () => {
    const again = setup("store-midtown").rates;
    expect(again.map((r) => [r.sku.id, r.unitsPerWeek])).toEqual(midtown.rates.map((r) => [r.sku.id, r.unitsPerWeek]));
  });
});

describe("facingValue and restockCost", () => {
  it("prefers the fixture the customer sees, not the shelf the stocker reaches", () => {
    const endcaps = midtown.layout.facings.filter((f) => f.kind === "endcap");
    const gondolas = midtown.layout.facings.filter((f) => f.kind === "gondola");
    const bestEndcap = Math.max(...endcaps.map((f) => facingValue(midtown.layout, f)));
    const bestGondola = Math.max(...gondolas.map((f) => facingValue(midtown.layout, f)));
    expect(bestEndcap).toBeGreaterThan(bestGondola);

    // Within one run, the middle shelves beat the floor and the top one.
    const run = gondolas.filter((f) => f.run === gondolas[0].run && f.bay === gondolas[0].bay && f.slot === 0).sort((a, b) => a.shelf - b.shelf);
    const values = run.map((f) => facingValue(midtown.layout, f));
    expect(Math.max(...values)).toBeGreaterThan(values[0]);
    expect(Math.max(...values)).toBeGreaterThan(values[values.length - 1]);
  });

  it("charges a bend or a stretch, and charges a bin as a tray", () => {
    const gondolas = midtown.layout.facings.filter((f) => f.kind === "gondola" && f.slot === 0 && f.bay === 0 && f.run === "G1");
    const costs = gondolas.map((f) => restockCost(midtown.layout, f, std));
    expect(Math.max(...costs)).toBeGreaterThan(Math.min(...costs));
    const bin = midtown.layout.facings.find((f) => f.kind === "bulk");
    const shelf = gondolas[0];
    if (!bin) throw new Error("the midtown store has a bulk wall");
    expect(restockCost(midtown.layout, bin, std)).toBeGreaterThan(restockCost(midtown.layout, shelf, std));
  });
});

describe("planograms", () => {
  const { model, current, optimal } = plans(midtown);

  it("places every SKU the shop sells", () => {
    expect(current.size).toBe(midtown.catalog.skus.length);
    expect(optimal.size).toBe(midtown.catalog.skus.length);
    expect(new Set([...current.values()].map((f) => f.id)).size).toBe(current.size);
    expect(new Set([...optimal.values()].map((f) => f.id)).size).toBe(optimal.size);
  });

  it("keeps every SKU on a fixture family it belongs to", () => {
    for (const sku of midtown.catalog.skus) {
      const c = current.get(sku.id);
      expect(c?.kind).toBe(sku.fixture);
      const o = optimal.get(sku.id);
      if (!o) throw new Error(`${sku.id} has no optimized facing`);
      const promoted = (sku.fixture === "gondola" || sku.fixture === "wall") && (o.kind === "endcap" || o.kind === "seasonal");
      expect(o.kind === sku.fixture || promoted).toBe(true);
    }
  });

  it("features only a handful of the aisle's SKUs", () => {
    const promotable = midtown.catalog.skus.filter((s) => s.fixture === "gondola" || s.fixture === "wall");
    const promoted = promotable.filter((s) => optimal.get(s.id)?.kind !== s.fixture);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.length).toBeLessThanOrEqual(Math.ceil(promotable.length * 0.2));
    // The feature space goes to the fastest movers, not to whoever asked first.
    const rate = new Map(midtown.rates.map((r) => [r.sku.id, r.unitsPerWeek]));
    const slowestPromoted = Math.min(...promoted.map((s) => rate.get(s.id) ?? 0));
    const fastestLeft = Math.max(...promotable.filter((s) => optimal.get(s.id)?.kind === s.fixture).map((s) => rate.get(s.id) ?? 0));
    expect(slowestPromoted).toBeGreaterThanOrEqual(fastestLeft);
  });

  it("throws a LimitError naming the family that does not fit", () => {
    const over = setup("store-midtown", { seasonal: 500, gondola: 4, wall: 0, bulk: 0, showcase: 0, endcap: 0, impulse: 0 });
    const m = buildDemandModel(network, over.catalog.skus, over.site);
    expect(() => currentPlanogram(over.layout, over.catalog, m)).toThrow(LimitError);
    expect(() => currentPlanogram(over.layout, over.catalog, m)).toThrow(/seasonal/);
  });

  it("is the same plan every time, and planogramFor picks it", () => {
    const again = optimizedPlanogram(midtown.layout, midtown.catalog, model, midtown.rates);
    expect([...again].map(([s, f]) => [s, f.id])).toEqual([...optimal].map(([s, f]) => [s, f.id]));
    const viaPolicy = planogramFor("optimized", midtown.layout, midtown.catalog, model, midtown.rates);
    expect([...viaPolicy].map(([s, f]) => [s, f.id])).toEqual([...optimal].map(([s, f]) => [s, f.id]));
    const viaCurrent = planogramFor("current", midtown.layout, midtown.catalog, model, midtown.rates);
    expect([...viaCurrent].map(([s, f]) => [s, f.id])).toEqual([...current].map(([s, f]) => [s, f.id]));
  });
});

describe("appealOf", () => {
  const { current, optimal } = plans(midtown);

  it("normalises to a mean of 1 over the assortment's dollars", () => {
    for (const plan of [current, optimal]) {
      const appeal = appealOf(midtown.layout, plan, midtown.rates);
      let num = 0;
      let den = 0;
      for (const r of midtown.rates) {
        num += r.sku.velocityShare * (appeal.get(r.sku.id) ?? 0);
        den += r.sku.velocityShare;
      }
      expect(num / den).toBeCloseTo(1, 10);
      for (const v of appeal.values()) expect(v).toBeGreaterThan(0);
    }
  });

  it("normalises to a plain mean of 1 when there are no rates yet", () => {
    const appeal = appealOf(midtown.layout, current);
    const values = [...appeal.values()];
    expect(values.reduce((a, b) => a + b, 0) / values.length).toBeCloseTo(1, 10);
  });

  it("lifts the fast movers, which is the whole point", () => {
    const before = appealOf(midtown.layout, current, midtown.rates);
    const after = appealOf(midtown.layout, optimal, midtown.rates);
    const fastest = [...midtown.rates].sort((a, b) => b.unitsPerWeek - a.unitsPerWeek)[0];
    expect(after.get(fastest.sku.id) ?? 0).toBeGreaterThan(before.get(fastest.sku.id) ?? 0);
  });
});

describe("facing units", () => {
  const { current, optimal } = plans(midtown);
  const uniform = facingUnitsFor("current", midtown.layout, current, midtown.rates, std, midtown.site);
  const sized = facingUnitsFor("optimized", midtown.layout, optimal, midtown.rates, std, midtown.site);

  it("never exceeds what the facing holds and never falls below the uniform facing", () => {
    for (const r of midtown.rates) {
      const f = optimal.get(r.sku.id);
      const u = sized.get(r.sku.id) ?? 0;
      if (!f) throw new Error(`${r.sku.id} has no facing`);
      const cap = facingCapacity(midtown.layout, r.sku, f, std);
      expect(u).toBeGreaterThanOrEqual(1);
      expect(u).toBeLessThanOrEqual(cap);
      const c = current.get(r.sku.id);
      if (!c) throw new Error(`${r.sku.id} has no current facing`);
      const uniformHere = Math.min(facingCapacity(midtown.layout, r.sku, c, std), c.kind === "bulk" || c.served ? Number.POSITIVE_INFINITY : Math.round(r.sku.unitsPerInner));
      expect(uniform.get(r.sku.id) ?? 0).toBe(Math.max(1, uniformHere));
    }
  });

  it("gives a fast mover more room than a slow one", () => {
    const shelf = midtown.rates.filter((r) => r.sku.fixture === "gondola").sort((a, b) => b.unitsPerWeek - a.unitsPerWeek);
    expect(sized.get(shelf[0].sku.id) ?? 0).toBeGreaterThan(sized.get(shelf[shelf.length - 1].sku.id) ?? 0);
  });

  it("refills the floor fewer times a week", () => {
    expect(restocksPerWeek(midtown.rates, sized)).toBeLessThan(restocksPerWeek(midtown.rates, uniform));
  });
});

describe("evaluateMerch", () => {
  const { current, optimal } = plans(midtown);
  const uniform = facingUnitsFor("current", midtown.layout, current, midtown.rates, std, midtown.site);
  const sized = facingUnitsFor("optimized", midtown.layout, optimal, midtown.rates, std, midtown.site);
  const before = evaluateMerch(midtown.layout, current, uniform, midtown.rates, std);
  const after = evaluateMerch(midtown.layout, optimal, sized, midtown.rates, std);

  it("counts what is on the floor", () => {
    for (const e of [before, after]) {
      expect(e.skus).toBe(midtown.catalog.skus.length);
      expect(e.facings).toBe(midtown.layout.facings.length);
      expect(e.used).toBe(e.skus);
      expect(e.used).toBeLessThanOrEqual(e.facings);
      expect(e.eyeLevelShare).toBeGreaterThanOrEqual(0);
      expect(e.eyeLevelShare).toBeLessThanOrEqual(1);
      expect(e.featureShare).toBeGreaterThanOrEqual(0);
      expect(e.featureShare).toBeLessThanOrEqual(1);
      expect(e.restockMinutesPerWeek).toBeGreaterThan(0);
      expect(e.feetPerRestock).toBeGreaterThan(0);
      expect(e.daysOfSupply).toBeGreaterThan(0);
    }
  });

  it("optimized wins on appeal, eye level, feature space and trips to the stockroom", () => {
    expect(after.weightedAppeal).toBeGreaterThan(before.weightedAppeal);
    expect(after.eyeLevelShare).toBeGreaterThan(before.eyeLevelShare);
    expect(after.featureShare).toBeGreaterThan(before.featureShare);
    expect(after.restocksPerWeek).toBeLessThan(before.restocksPerWeek);
    expect(after.daysOfSupply).toBeGreaterThan(before.daysOfSupply);
  });

  it("puts a partial reset between the two", () => {
    const partial = partialPlanogram(midtown.layout, current, optimal, midtown.rates, 12);
    expect(partial.size).toBe(current.size);
    expect(new Set([...partial.values()].map((f) => f.id)).size).toBe(partial.size);
    for (const sku of midtown.catalog.skus) {
      const f = partial.get(sku.id);
      if (!f) throw new Error(`${sku.id} lost its facing in the partial reset`);
      const promoted = (sku.fixture === "gondola" || sku.fixture === "wall") && (f.kind === "endcap" || f.kind === "seasonal");
      expect(f.kind === sku.fixture || promoted).toBe(true);
    }
    const units = facingUnitsFor("optimized", midtown.layout, partial, midtown.rates, std, midtown.site);
    const mid = evaluateMerch(midtown.layout, partial, units, midtown.rates, std);
    expect(mid.weightedAppeal).toBeGreaterThan(before.weightedAppeal);
    expect(mid.weightedAppeal).toBeLessThan(after.weightedAppeal);
  });

  it("does nothing when no moves are allowed", () => {
    const none = partialPlanogram(midtown.layout, current, optimal, midtown.rates, 0);
    expect([...none].map(([s, f]) => [s, f.id])).toEqual([...current].map(([s, f]) => [s, f.id]));
  });
});

describe("every store", () => {
  it("plans, sizes and evaluates", () => {
    for (const site of sites) {
      const f = setup(site.id);
      const model = buildDemandModel(network, f.catalog.skus, f.site);
      const optimal = optimizedPlanogram(f.layout, f.catalog, model, f.rates);
      const units = facingUnitsFor("optimized", f.layout, optimal, f.rates, std, f.site);
      const ev = evaluateMerch(f.layout, optimal, units, f.rates, std);
      expect(ev.skus).toBe(f.catalog.skus.length);
      expect(ev.used).toBeLessThanOrEqual(ev.facings);
      expect(ev.weightedAppeal).toBeGreaterThan(0);
      expect(Number.isFinite(ev.restockMinutesPerWeek)).toBe(true);
      const appeal = appealOf(f.layout, optimal, f.rates);
      let num = 0;
      let den = 0;
      for (const r of f.rates) {
        num += r.sku.velocityShare * (appeal.get(r.sku.id) ?? 0);
        den += r.sku.velocityShare;
      }
      expect(num / den).toBeCloseTo(1, 8);
    }
  });
});
