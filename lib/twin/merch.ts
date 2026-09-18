/**
 * The planogram: which SKU is merchandised in which facing, how deep that
 * facing is filled, and what a plan is worth.
 *
 * This is the store's answer to the distribution center's slotting, and it is
 * where the two models differ most. In a warehouse the best slot is the one the
 * picker walks least to reach, and height is a labor penalty — a bend or a
 * stretch. In a shop the best facing is the one the customer sees, and height
 * is a sales lift: eye level is buy level. The cost function flips sign. The
 * shelf a stocker would pick (low, near the stockroom door at the back) is
 * roughly the opposite of the shelf that sells (waist to eye, on an endcap,
 * inside the front door), and an optimized plan spends restock walking to buy
 * exposure. `facingValue` is the sales side and `restockCost` the labor side;
 * the plan is built on the first and reports the second.
 *
 * The other difference is that a SKU is not slottable anywhere. A bulk-bin SKU
 * cannot live on a gondola shelf and a tray of ganache cannot live on a
 * seasonal table, so `sku.fixture` has to match `facing.kind`. The one
 * exception is feature space: an endcap or a seasonal table is filled with
 * whatever is selling, and that product also lives in the aisle. So a gondola
 * or wall SKU may be promoted onto a spare endcap or seasonal facing, which is
 * exactly what a real feature is. Impulse racks at the register are not feature
 * space in that sense — they take small, single-hand, low-price items chosen
 * for the lane, and a gondola carton neither fits the rack nor clears the
 * queue — so nothing is promoted there.
 *
 * Merchandising moves the mix, not the total: `appealOf` is normalised so the
 * average dollar of the assortment sees an appeal of 1, and the store's dollars
 * stay candystore's. A better plan pays in lost sales avoided and in trips to
 * the stockroom saved, not in invented revenue.
 *
 * The plan is the year-round one. A holiday SKU holds its facing all year here;
 * it is demand, not merchandising, that knows when it sells.
 */

import { LimitError } from "../layout/limits";
import { FIXTURE_KINDS, type FixtureKind } from "../layout/spec";
import { expectedDailyUnits, expectedDayTotal, isOperating, lineProbability, type DemandModel } from "./demand";
import { FIXTURE_APPEAL, isGoldenShelf, shelfAppeal, stockDistance, walkDistance, type Facing, type Layout } from "./layout";
import type { Catalog, LaborStandards, Site, Sku } from "./types";

export type MerchPolicy = "current" | "optimized";

/** Which facing each SKU is merchandised in. */
export type Planogram = Map<string, Facing>;

/** Selling units a full facing of this SKU holds. */
export type FacingUnits = Map<string, number>;

export interface SkuRate {
  sku: Sku;
  /** Selling units a week: pieces for an "each" SKU, pounds for a "weight" one. */
  unitsPerWeek: number;
  /** Baskets a week that contain the SKU — the store's version of pick lines. */
  basketsPerWeek: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Week 20 has a seasonal index of 1 — an ordinary trading week, no holiday
 * anywhere near it — which is the week the DC twin pins its slotting to. Note
 * that an ordinary week is a little under the annual average, because the candy
 * year is top-heavy and `seasonFactor` divides by its own mean.
 */
const ORDINARY_WEEK = 20;

/**
 * How fast shopper traffic falls off with walking distance from the entrance.
 * At 220 ft a facing sees about a third of the front-of-store exposure, which
 * over a 60-to-90-foot shop works out to roughly a 30% spread between the
 * storefront and the back wall — about what traffic counts in small-format
 * stores show.
 */
const DOOR_DECAY_FT = 220;

/** Cube of a typical candy display box, for sharing a cart trip between the boxes on it. */
const CART_CASE_CUBE_FT = 0.3;

/**
 * Expected selling units on one basket line, matching how `demand.ts` draws
 * them: packaged candy goes in ones and twos, bulk and showcase candy in
 * fractions of a pound. Only used to turn expected units back into the number
 * of shoppers who reached for the facing.
 */
const PIECE_UNITS_PER_LINE = 1.53;
const WEIGHT_UNITS_PER_LINE = 0.68;

/** Fixtures a store manager counts as feature space when reporting a plan. */
const FEATURE_FIXTURES: ReadonlySet<FixtureKind> = new Set<FixtureKind>(["endcap", "seasonal", "impulse"]);

/** Feature families a SKU from another family may be promoted into, in pass order. */
const PROMOTE_TO: FixtureKind[] = ["endcap", "seasonal"];

/** Families whose SKUs are shelf-stable cartons, so they can be featured. */
const PROMOTE_FROM: ReadonlySet<FixtureKind> = new Set<FixtureKind>(["gondola", "wall"]);

/**
 * Most feature space a plan will take out of the aisle. A promoted SKU vacates
 * its shelf facing here, and a shop that featured a quarter of its range would
 * have gaps down every aisle to show for it. A building with more endcap than
 * its range can fill leaves the rest empty, which `evaluateMerch` reports as
 * facings the plan does not use.
 */
const MAX_FEATURE_SHARE = 0.2;

function cmpId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// How fast a SKU sells
// ---------------------------------------------------------------------------

function unitsPerLine(sku: Sku): number {
  return sku.sellBy === "weight" ? WEIGHT_UNITS_PER_LINE : PIECE_UNITS_PER_LINE;
}

/**
 * Expected units and baskets a week for every SKU the shop sells, over an
 * ordinary (unseasoned) week. Units rank the planogram and size the facings;
 * baskets are the retail analogue of pick lines — how many shoppers a week
 * reach for that facing — and say how visible a SKU has to be.
 */
export function skuRates(model: DemandModel, startWeek = ORDINARY_WEEK): SkuRate[] {
  const units = new Map<string, number>();
  const baskets = new Map<string, number>();
  for (let d = 0; d < 7; d++) {
    if (!isOperating(model.site, d)) continue;
    const daily = expectedDailyUnits(model, d, 1, startWeek);
    const customers = (expectedDayTotal(model, d, startWeek) * (1 - model.specialShare)) / model.meanBasket;
    // model.skus is an array in catalog order, so this sum is the same every run.
    for (const sku of model.skus) {
      const u = daily.get(sku.id) ?? 0;
      if (u <= 0) continue;
      units.set(sku.id, (units.get(sku.id) ?? 0) + u);
      if (customers <= 0) continue;
      const linesPerBasket = u / unitsPerLine(sku) / customers;
      baskets.set(sku.id, (baskets.get(sku.id) ?? 0) + customers * lineProbability(linesPerBasket));
    }
  }
  return model.skus.map((sku) => ({ sku, unitsPerWeek: units.get(sku.id) ?? 0, basketsPerWeek: baskets.get(sku.id) ?? 0 }));
}

// ---------------------------------------------------------------------------
// What a facing is worth, and what it costs
// ---------------------------------------------------------------------------

/**
 * Shelves on a run, which is what `shelfAppeal` measures a shelf against. The
 * count is a property of the layout and never changes, so it is cached per
 * layout; the cache cannot change an answer, only how long it takes.
 */
const shelfCounts = new WeakMap<Layout, Map<string, number>>();

function shelvesOnRun(layout: Layout, run: string): number {
  let counts = shelfCounts.get(layout);
  if (!counts) {
    counts = new Map<string, number>();
    for (const f of layout.spec.fixtures) counts.set(f.id, f.shelves);
    // An imported spec may disagree with the facings that were built from it;
    // the facings are what we are scoring, so they win.
    for (const f of layout.facings) counts.set(f.run, Math.max(counts.get(f.run) ?? 0, f.shelf));
    shelfCounts.set(layout, counts);
  }
  return counts.get(run) ?? 1;
}

/** Share of the store's traffic that passes a facing, by how far it is from the door. */
function doorExposure(layout: Layout, f: Facing): number {
  return Math.exp(-walkDistance(layout, layout.entry, f) / DOOR_DECAY_FT);
}

/** How much a facing is worth to a SKU: fixture pull x shelf height x nearness to the door. */
export function facingValue(layout: Layout, f: Facing): number {
  return FIXTURE_APPEAL[f.kind] * shelfAppeal(f.shelf, shelvesOnRun(layout, f.run)) * doorExposure(layout, f);
}

/** Display boxes a stock cart carries to the floor in one trip. */
function casesPerCart(std: LaborStandards): number {
  return Math.max(1, std.cartCubeFt / CART_CASE_CUBE_FT);
}

/**
 * Minutes it costs to keep a facing filled, per case worked: opening the box
 * and facing the shelf, the bend or stretch an ungolden shelf adds, and this
 * facing's share of the trip out from the stockroom, which the other boxes on
 * the cart share. A bulk bin and a showcase tray are decanted rather than
 * shelved and carry the tray standard instead.
 *
 * Travel is a few percent of the total in a seventy-foot shop, where it is the
 * dominant term in a three-hundred-foot warehouse. That is the whole reason a
 * store's best facing is the one the customer sees rather than the one the
 * stocker reaches first.
 */
export function restockCost(layout: Layout, f: Facing, std: LaborStandards): number {
  const handling = f.served || f.kind === "bulk" ? std.restockPerTray : std.restockPerCase;
  const bend = isGoldenShelf(f.shelf, shelvesOnRun(layout, f.run)) ? 0 : std.restockBendReachSec / 60;
  const trip = (std.restockPerTrip + (2 * stockDistance(layout, f)) / std.walkFtPerMin) / casesPerCart(std);
  return handling + bend + trip;
}

// ---------------------------------------------------------------------------
// Families: a SKU may only sit on the fixture it belongs to
// ---------------------------------------------------------------------------

/**
 * The SKUs this shop merchandises: the catalog, cropped to the categories
 * candystore says the store sells, in id order. A specialty shop does not put
 * the traditional assortment on its shelves.
 */
function assortment(catalog: Catalog, model: DemandModel): Sku[] {
  const live = new Set(model.skus.map((s) => s.id));
  return catalog.skus.filter((s) => live.has(s.id)).sort(cmpId);
}

/** Facings by fixture family, in the order the building laid them out. */
function facingsByKind(layout: Layout): Map<FixtureKind, Facing[]> {
  const out = new Map<FixtureKind, Facing[]>();
  for (const f of layout.facings) {
    const list = out.get(f.kind);
    if (list) list.push(f);
    else out.set(f.kind, [f]);
  }
  return out;
}

function shortOfFacings(kind: FixtureKind, want: number, have: number): LimitError {
  if (have === 0) {
    return new LimitError(
      `The assortment has ${want} ${kind} SKUs and the layout has no ${kind} fixtures at all. ` +
        `Add a ${kind} run to the store, or give those SKUs a fixture family this building has.`
    );
  }
  return new LimitError(
    `The assortment has ${want} ${kind} SKUs and the layout only ${have} ${kind} facings. ` +
      `Widen the ${kind} run, add a shelf or another facing per bay to it, or move SKUs to another fixture family.`
  );
}

/**
 * Every family has to fit its own facings. Unlike the warehouse, where any SKU
 * fits any slot, this is a hard constraint on the building.
 */
function checkFamilies(skus: Sku[], facings: Map<FixtureKind, Facing[]>): void {
  const want = new Map<FixtureKind, number>();
  for (const s of skus) want.set(s.fixture, (want.get(s.fixture) ?? 0) + 1);
  // FIXTURE_KINDS is a fixed array, so a store short on two families always
  // complains about the same one first.
  for (const kind of FIXTURE_KINDS) {
    const n = want.get(kind) ?? 0;
    const have = facings.get(kind)?.length ?? 0;
    if (n > have) throw shortOfFacings(kind, n, have);
  }
}

// ---------------------------------------------------------------------------
// The plans
// ---------------------------------------------------------------------------

/**
 * The shop as it is: SKUs in catalog id order onto the facings of their own
 * family in index order, front of the run first, every facing the same size.
 * It is what a store ends up with when the assortment grew one delivery at a
 * time and nobody ever walked the floor with a velocity report.
 */
export function currentPlanogram(layout: Layout, catalog: Catalog, model: DemandModel): Planogram {
  const skus = assortment(catalog, model);
  const facings = facingsByKind(layout);
  checkFamilies(skus, facings);
  const next = new Map<FixtureKind, number>();
  const plan: Planogram = new Map();
  for (const sku of skus) {
    const list = facings.get(sku.fixture) ?? [];
    const i = next.get(sku.fixture) ?? 0;
    next.set(sku.fixture, i + 1);
    const f = list[i];
    if (!f) throw shortOfFacings(sku.fixture, i + 1, list.length);
    plan.set(sku.id, f);
  }
  return plan;
}

function assign(plan: Planogram, skus: Sku[], facings: Facing[], kind: FixtureKind): void {
  for (let i = 0; i < skus.length; i++) {
    const f = facings[i];
    if (!f) throw shortOfFacings(kind, skus.length, facings.length);
    plan.set(skus[i].id, f);
  }
}

/**
 * The plan a merchandiser would draw: within each family the SKUs that sell
 * most units take the highest-value facings, and then a feature pass gives the
 * fastest movers in the store the endcap and seasonal facings those families do
 * not need for themselves. A promoted SKU vacates its shelf facing, so the next
 * one down slides up into it — which is why the feature pass runs before the
 * within-family assignment rather than after it.
 */
export function optimizedPlanogram(layout: Layout, catalog: Catalog, model: DemandModel, rates: SkuRate[]): Planogram {
  const skus = assortment(catalog, model);
  const facings = facingsByKind(layout);
  checkFamilies(skus, facings);

  const rate = new Map(rates.map((r) => [r.sku.id, r.unitsPerWeek]));
  const byUnits = (a: Sku, b: Sku) => (rate.get(b.id) ?? 0) - (rate.get(a.id) ?? 0) || cmpId(a, b);

  // Feature pass. A feature family's own SKUs are guaranteed their facings —
  // they have nowhere else to go — and the spare ones are filled with the
  // fastest movers in the store, endcaps first because they pull hardest.
  const promotedTo = new Map<string, FixtureKind>();
  const familyOf = (s: Sku) => promotedTo.get(s.id) ?? s.fixture;
  const promotable = skus.filter((s) => PROMOTE_FROM.has(s.fixture));
  let budget = Math.ceil(promotable.length * MAX_FEATURE_SHARE);
  for (const kind of PROMOTE_TO) {
    if (budget <= 0) break;
    const have = facings.get(kind)?.length ?? 0;
    const spare = Math.min(budget, have - skus.filter((s) => familyOf(s) === kind).length);
    if (spare <= 0) continue;
    const candidates = promotable.filter((s) => !promotedTo.has(s.id)).sort(byUnits);
    for (const s of candidates.slice(0, spare)) promotedTo.set(s.id, kind);
    budget -= Math.min(spare, candidates.length);
  }

  // Facing value never changes within a call, so score once and sort on that.
  const value = new Map(layout.facings.map((f) => [f.id, facingValue(layout, f)]));
  const plan: Planogram = new Map();
  for (const kind of FIXTURE_KINDS) {
    const list = [...(facings.get(kind) ?? [])].sort((a, b) => (value.get(b.id) ?? 0) - (value.get(a.id) ?? 0) || cmpId(a, b));
    assign(plan, skus.filter((s) => familyOf(s) === kind).sort(byUnits), list, kind);
  }
  return plan;
}

/** Whether a SKU is allowed in a facing: its own family, or feature space it may be promoted into. */
function canSit(fixture: FixtureKind, f: Facing): boolean {
  return f.kind === fixture || (PROMOTE_FROM.has(fixture) && PROMOTE_TO.includes(f.kind));
}

/**
 * Move only the `n` SKUs that gain most, each swapping with whatever sits in
 * its optimal facing — the resets a store can actually do between two Sunday
 * nights. A swap moves two SKUs, so this is at most 2n moves, and a swap is
 * kept only if the pair together sells more afterwards.
 *
 * The warehouse version of this keeps a swap when the pair costs less; here it
 * is kept when the pair is worth more, which is the same arithmetic with the
 * sign flipped. A swap is skipped when the SKU being displaced could not
 * legally stand in the vacated facing.
 */
export function partialPlanogram(layout: Layout, current: Planogram, optimal: Planogram, rates: SkuRate[], n: number): Planogram {
  const result = new Map(current);
  const value = new Map(layout.facings.map((f) => [f.id, facingValue(layout, f)]));
  const v = (f: Facing) => value.get(f.id) ?? facingValue(layout, f);
  const dollars = new Map(rates.map((r) => [r.sku.id, r.unitsPerWeek * r.sku.unitRetail]));
  const fixture = new Map(rates.map((r) => [r.sku.id, r.sku.fixture]));

  // Built from `rates`, an array, rather than by iterating the planogram Map.
  const occupant = new Map<string, string>();
  for (const r of rates) {
    const f = current.get(r.sku.id);
    if (f) occupant.set(f.id, r.sku.id);
  }

  const gains = rates
    .map((r) => {
      const from = current.get(r.sku.id);
      const to = optimal.get(r.sku.id);
      if (!from || !to) return { sku: r.sku.id, gain: 0 };
      return { sku: r.sku.id, gain: (dollars.get(r.sku.id) ?? 0) * (v(to) - v(from)) };
    })
    .filter((g) => g.gain > 0)
    .sort((a, b) => b.gain - a.gain || (a.sku < b.sku ? -1 : 1));

  let moves = 0;
  for (const g of gains) {
    if (moves >= n) break;
    const from = result.get(g.sku);
    const target = optimal.get(g.sku);
    if (!from || !target || from.id === target.id) continue;
    const mine = fixture.get(g.sku);
    if (!mine || !canSit(mine, target)) continue;
    const other = occupant.get(target.id);
    const theirs = other ? fixture.get(other) : undefined;
    if (other && (!theirs || !canSit(theirs, from))) continue;
    const my = dollars.get(g.sku) ?? 0;
    const their = other ? dollars.get(other) ?? 0 : 0;
    const before = my * v(from) + their * v(target);
    const after = my * v(target) + their * v(from);
    if (after <= before) continue;
    result.set(g.sku, target);
    occupant.set(target.id, g.sku);
    if (other) {
      result.set(other, from);
      occupant.set(from.id, other);
    } else {
      occupant.delete(from.id);
    }
    moves++;
  }
  return result;
}

export function planogramFor(policy: MerchPolicy, layout: Layout, catalog: Catalog, model: DemandModel, rates: SkuRate[]): Planogram {
  return policy === "optimized" ? optimizedPlanogram(layout, catalog, model, rates) : currentPlanogram(layout, catalog, model);
}

// ---------------------------------------------------------------------------
// What the plan does to demand
// ---------------------------------------------------------------------------

/**
 * The merchandising multiplier each SKU earns from where it sits, normalised to
 * mean 1 across the assortment so the store's total dollars stay candystore's.
 *
 * Deliberate: merchandising moves the mix, not the total. An endcap steals its
 * lift from the shelf behind it, and a shop that faces everything beautifully
 * still sells what its catchment will buy. The real value of a better plan is
 * that the fast movers are the ones in front of the customer, so fewer sales
 * are lost to an empty or invisible facing.
 *
 * With `rates` the mean is weighted by `velocityShare`, so it is the average
 * dollar of the assortment that sees 1 rather than the average SKU; without
 * them it is the plain mean over the plan, which is all a caller bootstrapping
 * a demand model before it has rates can have.
 */
export function appealOf(layout: Layout, plan: Planogram, rates: SkuRate[] = []): Map<string, number> {
  // Sorted, because two planograms built different ways insert their keys in
  // different orders and must still produce identical numbers.
  const ids = [...plan.keys()].sort();
  const raw = new Map<string, number>();
  for (const id of ids) {
    const f = plan.get(id);
    if (f) raw.set(id, facingValue(layout, f));
  }
  const share = new Map(rates.map((r) => [r.sku.id, r.sku.velocityShare]));
  let num = 0;
  let den = 0;
  for (const id of ids) {
    const w = rates.length > 0 ? share.get(id) ?? 0 : 1;
    num += w * (raw.get(id) ?? 0);
    den += w;
  }
  if (den <= 0) {
    // No usable weights: fall back to the plain mean so the map is still mean 1.
    num = 0;
    den = 0;
    for (const id of ids) {
      num += raw.get(id) ?? 0;
      den += 1;
    }
  }
  const mean = den > 0 ? num / den : 1;
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, mean > 0 ? (raw.get(id) ?? 0) / mean : 1);
  return out;
}

// ---------------------------------------------------------------------------
// How deep a facing is filled
// ---------------------------------------------------------------------------

/**
 * Selling units of a SKU one facing holds, by cube. The layout's facing cube is
 * measured at the spec's shelf height, so it is rescaled to the standards'
 * before the SKU's cube per selling unit divides into it. Never less than 1:
 * a facing that cannot hold one of something is a facing nobody would give it.
 */
export function facingCapacity(layout: Layout, sku: Sku, f: Facing, std: LaborStandards): number {
  const cube = (f.cubeFt / layout.spec.shelfHeightFt) * std.shelfHeightFt;
  const perUnit = sku.innerCubeFt / sku.unitsPerInner;
  if (!(perUnit > 0) || !(cube > 0)) return 1;
  return Math.max(1, Math.floor(cube / perUnit));
}

/**
 * The facing a shop merchandises without thinking about it: one display box —
 * the box the stocker opens — set out on the shelf. A bulk bin and a showcase
 * tray are filled as they stand, because a bin is a bin: you cannot give a fast
 * bulk SKU a deeper facing without rebuilding the wall.
 */
function uniformUnits(sku: Sku, f: Facing, capacity: number): number {
  if (f.kind === "bulk" || f.served) return capacity;
  return Math.max(1, Math.min(capacity, Math.round(sku.unitsPerInner)));
}

/**
 * Facing sizes. "current" gives every SKU the uniform facing its fixture holds.
 * "optimized" sizes each facing to `std.facingDaysOfSupply` days of that SKU's
 * demand, capped by what the facing physically holds and never below the
 * uniform facing — a facing is topped up when it runs down, so a smaller than
 * standard facing only buys more trips to the stockroom. That rule is the
 * warehouse's, unchanged: it is exactly as true for a shelf as for a pick face.
 */
export function facingUnitsFor(policy: MerchPolicy, layout: Layout, plan: Planogram, rates: SkuRate[], std: LaborStandards, site: Site): FacingUnits {
  const days = site.operatingDays.length || 7;
  const out: FacingUnits = new Map();
  for (const r of rates) {
    const f = plan.get(r.sku.id);
    if (!f) continue;
    const capacity = facingCapacity(layout, r.sku, f, std);
    const uniform = uniformUnits(r.sku, f, capacity);
    if (policy === "current") {
      out.set(r.sku.id, uniform);
      continue;
    }
    const need = Math.ceil((r.unitsPerWeek / days) * std.facingDaysOfSupply);
    out.set(r.sku.id, Math.min(capacity, Math.max(uniform, need)));
  }
  return out;
}

/** Facing refills a week the plan implies: each SKU's weekly units over what its facing holds. */
export function restocksPerWeek(rates: SkuRate[], units: FacingUnits): number {
  let n = 0;
  for (const r of rates) {
    const u = units.get(r.sku.id) ?? 0;
    if (u <= 0) continue;
    n += r.unitsPerWeek / u;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** The shelf band with the best pull on a run of this many shelves. */
function isEyeLevel(shelf: number, shelves: number): boolean {
  let best = 0;
  for (let s = 1; s <= shelves; s++) best = Math.max(best, shelfAppeal(s, shelves));
  return shelfAppeal(shelf, shelves) >= best - 1e-9;
}

export interface MerchEvaluation {
  /** SKUs the plan places. */
  skus: number;
  /** Facings the building has. */
  facings: number;
  /** Facings the plan occupies; the rest are empty shelf. */
  used: number;
  /** Share of the week's dollars merchandised at eye level. */
  eyeLevelShare: number;
  /** Share of the week's dollars on feature fixtures: endcaps, tables and the register racks. */
  featureShare: number;
  /** Dollar-weighted mean facing value — the one number that says whether the plan is working. */
  weightedAppeal: number;
  /** Facing refills a week. */
  restocksPerWeek: number;
  /**
   * Stocker minutes a week to keep the plan filled. It barely moves with facing
   * size — the same boxes still have to be opened and faced — so the gain from
   * sizing facings shows up in `restocksPerWeek`, in how often somebody has to
   * stop what they are doing and go and fetch.
   */
  restockMinutesPerWeek: number;
  /** Feet walked per refill, out from the stockroom door and back. */
  feetPerRestock: number;
  /** Days of demand standing on the sales floor when every facing is full. */
  daysOfSupply: number;
}

/**
 * What a store manager would ask of a plan: how much of the shelf is working,
 * where the dollars sit, and what it costs to keep it filled.
 */
export function evaluateMerch(layout: Layout, plan: Planogram, units: FacingUnits, rates: SkuRate[], std: LaborStandards): MerchEvaluation {
  const days = layout.site.operatingDays.length || 7;
  let dollars = 0;
  let eye = 0;
  let feature = 0;
  let value = 0;
  let minutes = 0;
  let feet = 0;
  let visits = 0;
  let shelfUnits = 0;
  let dailyUnits = 0;
  for (const r of rates) {
    const f = plan.get(r.sku.id);
    if (!f) continue;
    const d = r.unitsPerWeek * r.sku.unitRetail;
    dollars += d;
    if (isEyeLevel(f.shelf, shelvesOnRun(layout, f.run))) eye += d;
    if (FEATURE_FIXTURES.has(f.kind)) feature += d;
    value += d * facingValue(layout, f);
    // A store works the display box the distribution center picks, not the
    // supplier's master case: that is the carton a stocker opens on the floor.
    minutes += (r.unitsPerWeek / Math.max(1, r.sku.unitsPerInner)) * restockCost(layout, f, std);
    const held = units.get(r.sku.id) ?? 0;
    const refills = held > 0 ? r.unitsPerWeek / held : 0;
    visits += refills;
    feet += refills * 2 * stockDistance(layout, f);
    shelfUnits += held;
    dailyUnits += r.unitsPerWeek / days;
  }
  const occupied = new Set<string>();
  for (const f of plan.values()) occupied.add(f.id);
  return {
    skus: plan.size,
    facings: layout.facings.length,
    used: occupied.size,
    eyeLevelShare: dollars > 0 ? eye / dollars : 0,
    featureShare: dollars > 0 ? feature / dollars : 0,
    weightedAppeal: dollars > 0 ? value / dollars : 0,
    restocksPerWeek: visits,
    restockMinutesPerWeek: minutes,
    feetPerRestock: visits > 0 ? feet / visits : 0,
    daysOfSupply: dailyUnits > 0 ? shelfUnits / dailyUnits : 0,
  };
}
