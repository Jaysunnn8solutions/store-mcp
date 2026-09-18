/**
 * Inventory tests. The assertions are structural — stock is conserved, a
 * facing never holds more than it can, a higher service level buys more — so
 * they survive a change of standards or catalog. The catalog here is a small
 * synthetic one rather than the generated file, so the numbers under test come
 * from the policy and not from whatever the generator last produced.
 */

import { describe, expect, it } from "vitest";
import networkJson from "../../data/network.json";
import sitesJson from "../../data/sites.json";
import { buildDemandModel, expectedDailyUnits, type DemandModel } from "./demand";
import { buildPallets, DEFAULT_POLICY, InventoryBook, runInventory, type InventoryPolicy } from "./inventory";
import { DEFAULT_STANDARDS } from "./standards";
import type { Catalog, Network, Site, Sku } from "./types";

const network = networkJson as unknown as Network;
const site = (sitesJson as unknown as Site[])[0];
/** Week 20: no holiday, so the seasonal forecast and the demand agree closely. */
const START_WEEK = 20;

function makeCatalog(): Catalog {
  const n = 24;
  const skus: Sku[] = [];
  for (let i = 0; i < n; i++) {
    const weight = i % 4 === 3;
    skus.push({
      id: `T-${String(i + 1).padStart(4, "0")}`,
      name: `Test candy ${i + 1}`,
      category: "traditional",
      supplier: ["SUP-A", "SUP-B", "SUP-C"][i % 3],
      unitRetail: weight ? 11.5 : 2.5 + (i % 5) * 0.75,
      sellBy: weight ? "weight" : "each",
      unitsPerInner: weight ? 5 : 24,
      innersPerCase: weight ? 2 : 6,
      casesPerPallet: 30,
      innerCubeFt: 0.22,
      velocityShare: 1 / n,
      fixture: weight ? "bulk" : "gondola",
    });
  }
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    seed: 7,
    suppliers: [
      { id: "SUP-A", name: "Domestic chocolate", kind: "domestic", leadDays: 5, leadSdDays: 1, orderDay: 1, channel: "dc" },
      { id: "SUP-B", name: "Local baker", kind: "domestic", leadDays: 2, leadSdDays: 0.5, orderDay: 3, channel: "direct" },
      { id: "SUP-C", name: "Importer", kind: "importer", leadDays: 21, leadSdDays: 4, orderDay: 2, channel: "dc" },
    ],
    skus,
  };
}

const catalog = makeCatalog();

function model(): DemandModel {
  return buildDemandModel(network, catalog.skus, site);
}

/** A facing that holds `inners` display boxes of the SKU, in selling units. */
function caps(inners: number): Map<string, number> {
  return new Map(catalog.skus.map((s) => [s.id, s.unitsPerInner * inners]));
}

function stockUnits(book: InventoryBook): number {
  return book.skus.reduce((a, s) => a + s.onFacing + s.onHandBack, 0);
}

describe("pallets", () => {
  it("conserve cases and keep full pallets single-SKU", () => {
    const skus = new Map(catalog.skus.map((s) => [s.id, s]));
    const lines = catalog.skus.slice(0, 8).map((s, i) => ({ sku: s.id, cases: 7 + i * 11 }));
    const pallets = buildPallets(lines, skus, DEFAULT_STANDARDS.palletCubeFt);
    const on = pallets.reduce((a, p) => a + p.items.reduce((b, it) => b + it.cases, 0), 0);
    expect(on).toBe(lines.reduce((a, l) => a + l.cases, 0));
    for (const p of pallets) expect(p.mixed).toBe(p.items.length > 1);
    // No pallet carries more of a SKU than a pallet of it holds.
    for (const p of pallets) {
      for (const it of p.items) expect(it.cases).toBeLessThanOrEqual(skus.get(it.sku)?.casesPerPallet ?? 0);
    }
  });
});

describe("order-up-to", () => {
  it("rises with the service level", () => {
    const m = model();
    const build = (serviceLevel: number) => new InventoryBook(m, catalog, { forecast: "seasonal", serviceLevel }, START_WEEK, [], 3, caps(4));
    const low = build(0.8);
    const high = build(0.995);
    let compared = 0;
    for (let i = 0; i < low.skus.length; i++) {
      const a = low.orderUpTo(low.skus[i], 0);
      const b = high.orderUpTo(high.skus[i], 0);
      if (a <= 0) continue;
      expect(b).toBeGreaterThan(a);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("falls back to the seasonal forecast until a trailing history exists", () => {
    const m = model();
    const trailing: InventoryPolicy = { forecast: "trailing", serviceLevel: 0.97 };
    const book = new InventoryBook(m, catalog, trailing, START_WEEK, [], 3, caps(4));
    const state = book.skus[0];
    const seasonal = book.orderUpTo(state, 0);
    expect(seasonal).toBeGreaterThan(0);
    // Six days is not a week, so the seasonal answer still stands.
    state.history = [0, 0, 0, 0, 0, 0];
    expect(book.orderUpTo(state, 0)).toBeCloseTo(seasonal, 6);
    // With a week of nothing sold, the trailing buyer stops buying.
    state.history = [0, 0, 0, 0, 0, 0, 0];
    expect(book.orderUpTo(state, 0)).toBe(0);
  });
});

describe("the book", () => {
  it("conserves units: opening plus received equals sold plus on hand", () => {
    const m = model();
    const book = new InventoryBook(m, catalog, DEFAULT_POLICY, START_WEEK, [], 5, caps(2));
    book.initialize(0);
    const opening = stockUnits(book);
    let received = 0;
    for (let d = 0; d < 42; d++) {
      book.review(d);
      for (const po of book.arrivals(d)) {
        for (const l of po.lines) {
          book.receive(l.sku, l.units);
          received += l.units;
        }
      }
      for (const s of book.skus) book.restock(s.sku.id, book.restockNeed(s.sku.id));
      const units = expectedDailyUnits(m, d, 1, START_WEEK);
      for (const s of book.skus) {
        const q = units.get(s.sku.id) ?? 0;
        if (q > 0) book.sell(s.sku.id, q);
      }
      book.endDay();
    }
    expect(received).toBeGreaterThan(0);
    expect(book.totals.soldUnits).toBeGreaterThan(0);
    const inflow = opening + received;
    const outflow = book.totals.soldUnits + stockUnits(book);
    // A lost sale takes nothing off the shelf, so it is not part of the balance.
    expect(Math.abs(inflow - outflow) / inflow).toBeLessThan(1e-9);
  });

  it("never puts more on a facing than it holds, and restocks from the back", () => {
    const m = model();
    const cap = caps(3);
    const book = new InventoryBook(m, catalog, DEFAULT_POLICY, START_WEEK, [], 5, cap);
    const s = book.skus[0];
    const per = s.sku.innersPerCase * s.sku.unitsPerInner;
    book.receive(s.sku.id, 20 * per);
    expect(s.onFacing).toBe(0);
    expect(s.onHandBack).toBe(20 * per);

    const need = book.restockNeed(s.sku.id);
    expect(need).toBe(cap.get(s.sku.id));
    const moved = book.restock(s.sku.id, 10 * per);
    expect(moved).toBe(need);
    expect(s.onFacing).toBe(cap.get(s.sku.id));
    expect(s.onHandBack).toBe(20 * per - moved);
    // Full already: nothing moves, however much is asked for.
    expect(book.restock(s.sku.id, 10 * per)).toBe(0);
  });

  it("loses the sale a customer cannot reach, and fills the pick from the back", () => {
    const m = model();
    const book = new InventoryBook(m, catalog, DEFAULT_POLICY, START_WEEK, [], 5, caps(1));
    const s = book.skus[0];
    const cap = s.sku.unitsPerInner;
    book.receive(s.sku.id, 40 * cap);
    book.restock(s.sku.id, book.restockNeed(s.sku.id));

    // Plenty on the facing: nothing is lost.
    const easy = book.sell(s.sku.id, cap / 2);
    expect(easy.sold).toBe(cap / 2);
    expect(easy.lost).toBe(0);

    // Emptying it costs the rest of the demand, even with a full stockroom.
    const hard = book.sell(s.sku.id, cap);
    expect(hard.sold).toBe(cap / 2);
    expect(hard.lost).toBe(cap / 2);
    expect(s.onFacing).toBe(0);
    expect(book.totals.lostLines).toBe(0);
    expect(book.sell(s.sku.id, 5).lost).toBe(5);
    expect(book.totals.lostLines).toBe(1);
    expect(book.lostBySku.get(s.sku.id)).toBe(cap / 2 + 5);

    // A picker walks to the back, so the same bare shelf cuts nothing.
    const back = s.onHandBack;
    const picked = book.pick(s.sku.id, 3 * cap);
    expect(picked.picked).toBe(3 * cap);
    expect(picked.cut).toBe(0);
    expect(s.onHandBack).toBe(back - 3 * cap);

    // Until the back is empty too.
    const all = book.pick(s.sku.id, s.onHandBack + 10);
    expect(all.cut).toBe(10);
    expect(s.onHandBack).toBe(0);
  });

  it("unwinds an abandoned basket instead of calling it a lost sale", () => {
    const m = model();
    const book = new InventoryBook(m, catalog, DEFAULT_POLICY, START_WEEK, [], 5, caps(1));
    const s = book.skus[0];
    const cap = s.sku.unitsPerInner;
    book.receive(s.sku.id, 4 * cap);
    book.restock(s.sku.id, book.restockNeed(s.sku.id));
    book.sell(s.sku.id, cap);
    expect(book.totals.soldUnits).toBe(cap);
    expect(s.onFacing).toBe(0);

    book.returnToShelf(s.sku.id, cap);
    expect(book.totals.soldUnits).toBe(0);
    expect(book.totals.soldDollars).toBe(0);
    expect(book.totals.lostUnits).toBe(0);
    expect(s.onFacing).toBe(cap);

    // What the facing has no room for goes back to the stockroom.
    const back = s.onHandBack;
    book.sell(s.sku.id, 2);
    book.restock(s.sku.id, book.restockNeed(s.sku.id));
    book.returnToShelf(s.sku.id, 2);
    expect(s.onFacing).toBe(cap);
    expect(s.onHandBack).toBe(back);
  });

  it("reports availability as the share of facings holding stock", () => {
    const m = model();
    const book = new InventoryBook(m, catalog, DEFAULT_POLICY, START_WEEK, [], 5, caps(1));
    expect(book.shelfShare()).toBe(0);
    book.initialize(0);
    expect(book.shelfShare()).toBe(1);
    for (const s of book.skus) book.sell(s.sku.id, s.onFacing);
    expect(book.shelfShare()).toBe(0);
  });
});

describe("runInventory", () => {
  const days = 28;

  it("runs both forecasts and reports a row a day", () => {
    const m = model();
    for (const forecast of ["seasonal", "trailing"] as const) {
      const run = runInventory(m, catalog, {
        startWeek: START_WEEK,
        days,
        warmupWeeks: 4,
        policy: { forecast, serviceLevel: 0.97 },
        seed: 9,
        facingCap: caps(6),
      });
      expect(run.daily).toHaveLength(days);
      expect(run.daily[0].day).toBe(0);
      expect(run.book.totals.soldUnits).toBeGreaterThan(0);
      expect(run.book.totals.receivedCases).toBeGreaterThan(0);
      // Totals are re-baselined at day 0, so they match the rows exactly.
      const rows = run.daily.reduce((a, r) => a + r.soldUnits, 0);
      expect(rows).toBeCloseTo(run.book.totals.soldUnits, 6);
      for (const r of run.daily) {
        expect(r.shelfShare).toBeGreaterThanOrEqual(0);
        expect(r.shelfShare).toBeLessThanOrEqual(1);
        expect(r.onHandRetail).toBeGreaterThanOrEqual(0);
        expect(r.backroomCases).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps every facing inside its cap", () => {
    const m = model();
    const cap = caps(5);
    const run = runInventory(m, catalog, { startWeek: START_WEEK, days, warmupWeeks: 4, seed: 4, facingCap: cap });
    for (const s of run.book.skus) {
      expect(s.onFacing).toBeLessThanOrEqual((cap.get(s.sku.id) ?? 0) + 1e-9);
      expect(s.onFacing).toBeGreaterThanOrEqual(0);
      expect(s.onHandBack).toBeGreaterThanOrEqual(0);
    }
  });

  it("loses almost nothing when the facings are deep and the stock is there", () => {
    const m = model();
    const run = runInventory(m, catalog, { startWeek: START_WEEK, days, warmupWeeks: 6, seed: 4, facingCap: caps(10) });
    expect(run.book.totals.soldUnits).toBeGreaterThan(0);
    // Not zero, and it should not be: the forecast is a flat daily mean while
    // the week is weekend-heavy, and a truck due on a Saturday waits for the
    // store's next delivery day, so the thin moment is a Sunday at the end of a
    // review cycle. What is being pinned here is that a deep facing over a
    // stocked backroom loses a few percent and not a fifth.
    expect(run.book.totals.lostUnits / run.book.totals.soldUnits).toBeLessThan(0.05);
    const share = run.daily.reduce((a, r) => a + r.shelfShare, 0) / run.daily.length;
    expect(share).toBeGreaterThan(0.9);
  });

  it("loses sales when the facings are too shallow to hold a day", () => {
    const m = model();
    const shallow = runInventory(m, catalog, { startWeek: START_WEEK, days, warmupWeeks: 6, seed: 4, facingCap: caps(0.25) });
    const deep = runInventory(m, catalog, { startWeek: START_WEEK, days, warmupWeeks: 6, seed: 4, facingCap: caps(10) });
    expect(shallow.book.totals.lostUnits).toBeGreaterThan(deep.book.totals.lostUnits);
    expect(shallow.book.totals.lostDollars).toBeGreaterThan(0);
  });

  it("replays exactly on the same seed", () => {
    const m = model();
    const opts = { startWeek: START_WEEK, days, warmupWeeks: 4, seed: 12, facingCap: caps(6) };
    const a = runInventory(m, catalog, opts);
    const b = runInventory(m, catalog, opts);
    expect(JSON.stringify(b.daily)).toBe(JSON.stringify(a.daily));
  });
});
