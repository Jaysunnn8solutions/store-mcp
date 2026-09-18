/**
 * The catalog is generated, so what is worth asserting is not a price but the
 * structure every other module reads it through: unique ids, velocity shares
 * that still sum to a category, a fixture and a sellable price on every line,
 * and a floor whose dollar mix is the one the shop was planned to. The last
 * test pins the committed data/catalog.json to the seed, so a change to the
 * generator that nobody regenerated for is caught here rather than in a run.
 */

import { describe, expect, it } from "vitest";
import { FIXTURE_KINDS } from "../lib/layout/spec";
import { loadCatalog, loadNetwork } from "../lib/data/store";
import type { Category, Sku } from "../lib/twin/types";
import { buildCatalog, fixtureMix, FIXTURE_TARGET } from "./catalog";

const network = loadNetwork();
const catalog = buildCatalog(network);

/** Annual retail dollars by category across the whole network. */
function networkDollars(): Map<Category, number> {
  const out = new Map<Category, number>();
  for (const store of network.stores) {
    for (const [cat, annual] of Object.entries(store.revenueBy)) out.set(cat, (out.get(cat) ?? 0) + annual);
  }
  return out;
}

function byCategory(skus: Sku[]): Map<Category, Sku[]> {
  const out = new Map<Category, Sku[]>();
  for (const s of skus) {
    const list = out.get(s.category);
    if (list) list.push(s);
    else out.set(s.category, [s]);
  }
  return out;
}

describe("catalog", () => {
  it("gives every SKU a unique id and a known supplier", () => {
    const ids = new Set(catalog.skus.map((s) => s.id));
    expect(ids.size).toBe(catalog.skus.length);
    const suppliers = new Set(catalog.suppliers.map((s) => s.id));
    expect(new Set(catalog.suppliers.map((s) => s.id)).size).toBe(catalog.suppliers.length);
    for (const sku of catalog.skus) expect(suppliers.has(sku.supplier), `${sku.id} → ${sku.supplier}`).toBe(true);
  });

  it("uses both inbound channels, so a store sees trailers and box trucks", () => {
    const channels = new Set(catalog.suppliers.map((s) => s.channel));
    expect(channels).toEqual(new Set(["dc", "direct"]));
    // Every domestic family flows through the distribution center: that is the
    // link to digitaltwin_mcp, and it has to stay true.
    for (const s of catalog.suppliers.filter((x) => x.kind === "domestic")) expect(s.channel).toBe("dc");
  });

  it("keeps velocity shares a within-category distribution", () => {
    for (const [category, skus] of byCategory(catalog.skus)) {
      const total = skus.reduce((a, s) => a + s.velocityShare, 0);
      expect(total, category).toBeCloseTo(1, 9);
      for (const s of skus) expect(s.velocityShare, s.id).toBeGreaterThan(0);
    }
  });

  it("gives every SKU a fixture, a selling unit and a price someone could pay", () => {
    for (const sku of catalog.skus) {
      expect(FIXTURE_KINDS, sku.id).toContain(sku.fixture);
      expect(sku.unitRetail, sku.id).toBeGreaterThan(0);
      expect(sku.unitsPerInner, sku.id).toBeGreaterThan(0);
      expect(Number.isInteger(sku.unitsPerInner), sku.id).toBe(true);
      expect(sku.innersPerCase, sku.id).toBeGreaterThan(0);
      expect(sku.casesPerPallet, sku.id).toBeGreaterThan(0);
      expect(sku.innerCubeFt, sku.id).toBeGreaterThan(0);
      if (sku.sellBy === "each") {
        expect(sku.unitRetail, sku.id).toBeLessThanOrEqual(14.99);
      } else {
        // Dollars a pound, off the scale at the counter or the bulk wall.
        expect(sku.unitRetail, sku.id).toBeGreaterThanOrEqual(12);
        expect(sku.unitRetail, sku.id).toBeLessThanOrEqual(46);
      }
    }
  });

  it("sells by the pound only from the glass and the bins", () => {
    const weight = catalog.skus.filter((s) => s.sellBy === "weight");
    expect(weight.length).toBeGreaterThan(0);
    for (const sku of weight) expect(["showcase", "bulk"], sku.id).toContain(sku.fixture);
    // And the converse: nothing on a scoop fixture is sold by the piece.
    for (const sku of catalog.skus) {
      if (sku.fixture === "showcase" || sku.fixture === "bulk") expect(sku.sellBy, sku.id).toBe("weight");
    }
  });

  it("only puts seasonal candy on the seasonal tables", () => {
    const seasonal = catalog.skus.filter((s) => s.fixture === "seasonal");
    expect(seasonal.length).toBeGreaterThan(0);
    for (const sku of seasonal) expect(sku.season, sku.id).toBeTruthy();
    // A holiday SKU that did not fit the tables still knows its holiday, so the
    // set with a season is larger than the set on the fixture.
    const dated = catalog.skus.filter((s) => s.season);
    expect(dated.length).toBeGreaterThanOrEqual(seasonal.length);
    expect(dated.length).toBeLessThan(catalog.skus.length / 4);
  });

  it("merchandises the floor to the planned dollar mix", () => {
    // What the network actually sells: traditional is 96% of it, so this is
    // mostly the general stores' floor.
    const dollars = networkDollars();
    const mix = fixtureMix(catalog.skus, (cat) => dollars.get(cat) ?? 0);
    for (const kind of FIXTURE_KINDS) {
      expect(Math.abs(mix[kind] - FIXTURE_TARGET[kind]), `${kind} ${(mix[kind] * 100).toFixed(1)}% vs ${(FIXTURE_TARGET[kind] * 100).toFixed(0)}%`).toBeLessThan(0.03);
    }
    expect(FIXTURE_KINDS.reduce((a, k) => a + mix[k], 0)).toBeCloseTo(1, 9);
  });

  it("shapes every category's floor the same way, so the specialty shop is not a bare case", () => {
    for (const [category, skus] of byCategory(catalog.skus)) {
      const mix = fixtureMix(skus);
      for (const kind of FIXTURE_KINDS) {
        expect(Math.abs(mix[kind] - FIXTURE_TARGET[kind]), `${category} ${kind} ${(mix[kind] * 100).toFixed(1)}%`).toBeLessThan(0.05);
      }
    }
  });

  it("is deterministic, and the committed catalog.json is what the seed produces", () => {
    const again = buildCatalog(network);
    expect(again.skus).toEqual(catalog.skus);
    expect(again.suppliers).toEqual(catalog.suppliers);

    const committed = loadCatalog();
    expect(committed.seed).toBe(catalog.seed);
    expect(committed.suppliers).toEqual(catalog.suppliers);
    expect(committed.skus).toEqual(catalog.skus);
  });
});
