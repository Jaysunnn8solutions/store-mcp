/**
 * Demand: candystore's annual retail dollars for this shop, turned into
 * customers walking through the door minute by minute, and into the special
 * orders the store picks before it opens.
 *
 * The chain is candystore's, with a retail middle:
 *
 *   annual $ by category
 *     ÷ 52                                  → an ordinary week
 *     × seasonFactor(calendar week)         → the candy calendar
 *     × day-of-week share                   → Saturday is not Tuesday
 *     × demandScale × shock                 → the scenario
 *     × hour-of-day share                   → the lunch and commute peaks
 *     ÷ mean basket                          → customers per quarter hour
 *     → Poisson draw per bin, then a basket per customer
 *
 * The two ends — candystore's `revenueBy` and a Poisson draw — are the same as
 * digitaltwin_mcp's, which is what keeps the three projects' dollars
 * reconcilable. `demand.test.ts` pins that.
 *
 * Merchandising moves the mix, not the total. Where a SKU sits changes its
 * share of the store's dollars (an endcap steals from the shelf behind it),
 * but the store's dollars are candystore's. The value of a better planogram
 * shows up as fewer lost sales, not as invented revenue.
 */

import { poisson, seededRandom, type Rng } from "../util/random";
import type { FixtureKind } from "../layout/spec";
import { calendarWeekOfDay, seasonFactor } from "./season";
import { hhmm } from "./standards";
import type { Category, Network, NetworkStore, OpeningHours, Site, Sku } from "./types";

// ---------------------------------------------------------------------------
// Who walks in
// ---------------------------------------------------------------------------

export type BasketKind = "quick" | "browse" | "counter" | "bulk" | "gift";
export const BASKET_KINDS: BasketKind[] = ["quick", "browse", "counter", "bulk", "gift"];

export interface BasketKindSpec {
  kind: BasketKind;
  /** Share of the shop's customers. */
  share: number;
  /** Expected spend, dollars. */
  meanDollars: number;
  /** Which fixtures this shopper goes to, by relative weight. */
  fixtures: Partial<Record<FixtureKind, number>>;
  /** Chance the order is gift-wrapped at the counter. */
  wrapRate: number;
  /** Minutes on the floor before they are ready to pay. */
  dwellMin: number;
  /** Minutes they will stand in a queue before walking out. */
  patienceMin: number;
}

/**
 * Five kinds of candy shopper. The counter and gift baskets are what make a
 * confectioner's different from a convenience store: they are a fifth of the
 * customers and nearly half the dollars, and they need a person behind glass.
 */
export const BASKET_SPECS: BasketKindSpec[] = [
  { kind: "quick", share: 0.34, meanDollars: 9, fixtures: { impulse: 3, gondola: 2, endcap: 2, seasonal: 1 }, wrapRate: 0, dwellMin: 3, patienceMin: 4 },
  { kind: "browse", share: 0.3, meanDollars: 22, fixtures: { gondola: 4, wall: 2, endcap: 2, bulk: 2, seasonal: 2, impulse: 1 }, wrapRate: 0.05, dwellMin: 9, patienceMin: 7 },
  { kind: "counter", share: 0.16, meanDollars: 31, fixtures: { showcase: 6, gondola: 1, endcap: 1 }, wrapRate: 0.35, dwellMin: 5, patienceMin: 9 },
  { kind: "bulk", share: 0.12, meanDollars: 17, fixtures: { bulk: 6, gondola: 1, impulse: 1 }, wrapRate: 0.02, dwellMin: 7, patienceMin: 6 },
  { kind: "gift", share: 0.08, meanDollars: 58, fixtures: { showcase: 4, seasonal: 2, gondola: 1, endcap: 1, wall: 1 }, wrapRate: 0.8, dwellMin: 11, patienceMin: 12 },
];

/** Relative pull of each weekday, 1 = Monday. A sweet shop's week ends heavy. */
export const DAY_OF_WEEK = [0.75, 0.75, 0.85, 0.95, 1.3, 1.8, 1.15];

/**
 * Share of a trading day's customers by hour of the clock, before the shop's
 * own hours crop it: slow at open, a lunch bump, the after-school hour, and
 * the commute peak that is the busiest of the day.
 */
export const HOUR_SHAPE_WEEKDAY = [0, 0, 0, 0, 0, 0, 0, 0.2, 0.3, 0.4, 0.55, 0.85, 1.3, 1.15, 0.95, 1.1, 1.3, 1.5, 1.35, 1.0, 0.55, 0.25, 0.1, 0];
/** Saturdays and Sundays fill in the middle of the day instead. */
export const HOUR_SHAPE_WEEKEND = [0, 0, 0, 0, 0, 0, 0, 0.15, 0.25, 0.5, 0.8, 1.1, 1.35, 1.45, 1.4, 1.3, 1.2, 1.1, 0.95, 0.7, 0.4, 0.2, 0.1, 0];

/** Quarter-hour bins: fine enough for a queue, coarse enough to stay cheap. */
export const BIN_MIN = 15;

export interface BasketLine {
  sku: string;
  /** Pieces for an "each" SKU, pounds for a "weight" one. */
  units: number;
}

export interface Basket {
  id: string;
  kind: BasketKind;
  /** Minute of the horizon the shopper walks in. */
  arriveMin: number;
  lines: BasketLine[];
  /** Lines that come from behind the showcase glass, so a clerk serves them. */
  servedLines: BasketLine[];
  wrap: boolean;
  dwellMin: number;
  patienceMin: number;
  /** What the basket is worth if every line is on the shelf. */
  dollars: number;
}

export interface DemandShock {
  fromDay: number;
  toDay: number;
  factor: number;
  category?: string;
}

// ---------------------------------------------------------------------------
// Orders that leave the store
// ---------------------------------------------------------------------------

export interface SpecialOrder {
  id: string;
  /** "delivery" rides the van; "pickup" waits on the curbside shelf. */
  kind: "delivery" | "pickup";
  customer: string;
  /** Horizon day the order was taken, the evening before it is due. */
  placedDay: number;
  dueDay: number;
  /** Minute of `dueDay` the van leaves, or the customer is told to collect. */
  dueMin: number;
  lines: BasketLine[];
  wrap: boolean;
  dollars: number;
  /** Road miles from the shop, for the delivery round. */
  miles: number;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface DemandModel {
  site: Site;
  store: NetworkStore;
  skus: Sku[];
  skuById: Map<string, Sku>;
  scale: number;
  shocks: DemandShock[];
  /** Retail dollars a SKU sells in an ordinary week, before season and shocks. */
  weeklyDollars: Map<string, number>;
  /** Weekly dollars by category, straight from candystore. */
  weeklyByCategory: Map<Category, number>;
  /** Merchandising multiplier per SKU, mean-1 across the assortment. */
  appeal: Map<string, number>;
  /** Per-fixture correction that makes the basket draw reproduce `weeklyDollars`. */
  fixtureBoost: Record<string, number>;
  /**
   * The average basket a customer actually leaves with, dollars. Measured, not
   * assumed: see `calibrateBasket`.
   */
  meanBasket: number;
  /** Draw pools per basket kind, built once. */
  pools: Map<BasketKind, { pool: SkuWeight[]; total: number }>;
  /** Share of the shop's dollars taken as delivery and pickup orders. */
  specialShare: number;
  /** Share of special orders that ride the van rather than being collected. */
  deliveryShare: number;
}

/** Horizon day 0 is the Monday of `startWeek`; negative days work for warm-up. */
export function weekdayOf(d: number): number {
  return (((d % 7) + 7) % 7) + 1;
}

/** Trading hours for a horizon day, or null when the shop is dark. */
export function hoursOn(site: Site, d: number): OpeningHours | null {
  const wd = weekdayOf(d);
  if (!site.operatingDays.includes(wd)) return null;
  return site.hours.find((h) => h.day === wd) ?? null;
}

export function isOperating(site: Site, d: number): boolean {
  return hoursOn(site, d) !== null;
}

function shockFactor(model: DemandModel, day: number, category: Category): number {
  let f = 1;
  for (const s of model.shocks) {
    if (day < s.fromDay || day > s.toDay) continue;
    if (s.category && s.category !== category) continue;
    f *= s.factor;
  }
  return f;
}

/** Share of the week's dollars that fall on a given horizon day. */
export function dayShare(site: Site, d: number): number {
  const hrs = hoursOn(site, d);
  if (!hrs) return 0;
  let total = 0;
  for (const wd of site.operatingDays) total += DAY_OF_WEEK[wd - 1];
  return total > 0 ? DAY_OF_WEEK[weekdayOf(d) - 1] / total : 0;
}

/**
 * Expected retail dollars a category takes on a horizon day. This is the
 * authoritative number: everything below it only decides who buys what.
 */
export function expectedDailyDollars(model: DemandModel, category: Category, day: number, startWeek: number): number {
  const weekly = model.weeklyByCategory.get(category) ?? 0;
  if (weekly <= 0) return 0;
  const season = seasonFactor(calendarWeekOfDay(startWeek, day));
  return weekly * season * dayShare(model.site, day) * model.scale * shockFactor(model, day, category);
}

/** Expected dollars across every category on a horizon day. */
export function expectedDayTotal(model: DemandModel, day: number, startWeek: number): number {
  let t = 0;
  for (const cat of model.weeklyByCategory.keys()) t += expectedDailyDollars(model, cat, day, startWeek);
  return t;
}

/**
 * Expected units of each SKU sold on a horizon day, for the stock model. Uses
 * the authoritative category dollars and the merchandised within-category mix,
 * so it never depends on how the baskets happened to fall.
 */
export function expectedDailyUnits(model: DemandModel, fromDay: number, days: number, startWeek: number): Map<string, number> {
  const out = new Map<string, number>();
  if (days <= 0) return out;
  const byCat = new Map<Category, Sku[]>();
  for (const sku of model.skus) {
    const list = byCat.get(sku.category);
    if (list) list.push(sku);
    else byCat.set(sku.category, [sku]);
  }
  for (let d = fromDay; d < fromDay + days; d++) {
    for (const [cat, list] of byCat) {
      const dollars = expectedDailyDollars(model, cat, d, startWeek);
      if (dollars <= 0) continue;
      let wsum = 0;
      for (const s of list) wsum += s.velocityShare * (model.appeal.get(s.id) ?? 1);
      if (wsum <= 0) continue;
      for (const s of list) {
        const w = (s.velocityShare * (model.appeal.get(s.id) ?? 1)) / wsum;
        out.set(s.id, (out.get(s.id) ?? 0) + (dollars * w) / s.unitRetail / days);
      }
    }
  }
  return out;
}

/** The chance a SKU shows up on any one basket, which is what ranks a facing. */
export function lineProbability(mean: number): number {
  return 1 - Math.exp(-mean);
}

// ---------------------------------------------------------------------------
// Building the model
// ---------------------------------------------------------------------------

function blendedBasket(): number {
  return BASKET_SPECS.reduce((a, s) => a + s.share * s.meanDollars, 0);
}

/**
 * The basket kinds shop by fixture, so left alone they would not reproduce the
 * assortment's own dollar mix. One multiplier per fixture family closes the
 * gap; the fixed point is reached in a few dozen cheap passes and is
 * deterministic, so every caller sees the same numbers.
 */
function calibrateFixtures(target: Record<string, number>): Record<string, number> {
  const kinds = Object.keys(target);
  const boost: Record<string, number> = {};
  for (const k of kinds) boost[k] = 1;
  for (let iter = 0; iter < 60; iter++) {
    const got: Record<string, number> = {};
    for (const k of kinds) got[k] = 0;
    for (const spec of BASKET_SPECS) {
      let z = 0;
      for (const k of kinds) z += (spec.fixtures[k as FixtureKind] ?? 0) * boost[k];
      if (z <= 0) continue;
      for (const k of kinds) got[k] += (spec.share * spec.meanDollars * (spec.fixtures[k as FixtureKind] ?? 0) * boost[k]) / z;
    }
    const total = kinds.reduce((a, k) => a + got[k], 0);
    let moved = 0;
    for (const k of kinds) {
      if (target[k] <= 0) {
        boost[k] = 0;
        continue;
      }
      const share = total > 0 ? got[k] / total : 0;
      if (share <= 0) continue;
      const ratio = target[k] / share;
      const next = boost[k] * Math.pow(ratio, 0.6);
      moved = Math.max(moved, Math.abs(next - boost[k]));
      boost[k] = next;
    }
    if (moved < 1e-9) break;
  }
  return boost;
}

/** Seed for the calibration draw; fixed, so every caller measures the same thing. */
const CALIBRATION_SEED = 90210;
const CALIBRATION_BASKETS = 500;

/**
 * What a basket is really worth.
 *
 * A basket is aimed at a target spend, but it is filled with whole units, so
 * it overshoots the target by part of a line — and for a $9 grab-and-go basket
 * part of a line is a quarter of the basket. The lognormal spread adds another
 * few points on top. Left uncorrected, the shop would sell a third more than
 * candystore says it does, and the stock model would chase a number the market
 * model never set.
 *
 * Rather than derive the correction, measure it: draw a few hundred baskets of
 * each kind on a fixed stream and take the mean. It is deterministic, it costs
 * a few milliseconds once, and it stays right if the way a basket is filled
 * ever changes.
 */
function calibrateBasket(model: DemandModel): number {
  const rng = seededRandom(CALIBRATION_SEED);
  let blended = 0;
  for (const spec of BASKET_SPECS) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < CALIBRATION_BASKETS; i++) {
      const b = makeBasket(model, spec, "cal", 0, rng);
      if (!b) continue;
      sum += b.dollars;
      n++;
    }
    blended += spec.share * (n > 0 ? sum / n : spec.meanDollars);
  }
  return blended > 0 ? blended : blendedBasket();
}

export function buildDemandModel(
  network: Network,
  skus: Sku[],
  site: Site,
  scale = 1,
  shocks: DemandShock[] = [],
  appeal: Map<string, number> = new Map(),
  specialShare = 0.12,
  deliveryShare = 0.6
): DemandModel {
  const store = network.stores.find((s) => s.id === site.store);
  if (!store) throw new Error(`Store "${site.store}" is not in the candystore network. Known: ${network.stores.map((s) => s.id).join(", ")}.`);

  const weeklyByCategory = new Map<Category, number>();
  for (const [cat, annual] of Object.entries(store.revenueBy)) {
    if (annual > 0) weeklyByCategory.set(cat, annual / 52);
  }

  // Only the categories this store actually sells, and only SKUs in them.
  const live = skus.filter((s) => weeklyByCategory.has(s.category));
  const weeklyDollars = new Map<string, number>();
  const byCat = new Map<Category, Sku[]>();
  for (const s of live) {
    const list = byCat.get(s.category);
    if (list) list.push(s);
    else byCat.set(s.category, [s]);
  }
  for (const [cat, list] of byCat) {
    const weekly = weeklyByCategory.get(cat) ?? 0;
    let wsum = 0;
    for (const s of list) wsum += s.velocityShare * (appeal.get(s.id) ?? 1);
    for (const s of list) {
      const w = wsum > 0 ? (s.velocityShare * (appeal.get(s.id) ?? 1)) / wsum : 0;
      weeklyDollars.set(s.id, weekly * w);
    }
  }

  const fixtureTarget: Record<string, number> = {};
  let grand = 0;
  for (const s of live) {
    const d = weeklyDollars.get(s.id) ?? 0;
    fixtureTarget[s.fixture] = (fixtureTarget[s.fixture] ?? 0) + d;
    grand += d;
  }
  for (const k of Object.keys(fixtureTarget)) fixtureTarget[k] = grand > 0 ? fixtureTarget[k] / grand : 0;

  const model: DemandModel = {
    site,
    store,
    skus: live,
    skuById: new Map(live.map((s) => [s.id, s])),
    scale,
    shocks,
    weeklyDollars,
    weeklyByCategory,
    appeal,
    fixtureBoost: calibrateFixtures(fixtureTarget),
    meanBasket: blendedBasket(),
    pools: new Map(),
    specialShare,
    deliveryShare,
  };
  model.meanBasket = calibrateBasket(model);
  return model;
}

// ---------------------------------------------------------------------------
// Drawing a day
// ---------------------------------------------------------------------------

/**
 * Expected customers in each quarter hour of a trading day, indexed from
 * midnight. Bins outside the shop's hours are zero.
 */
export function arrivalBins(model: DemandModel, day: number, startWeek: number): Float64Array {
  const bins = new Float64Array(Math.ceil(1440 / BIN_MIN));
  const hrs = hoursOn(model.site, day);
  if (!hrs) return bins;
  const dollars = expectedDayTotal(model, day, startWeek) * (1 - model.specialShare);
  if (dollars <= 0) return bins;
  const open = hhmm(hrs.open);
  const close = hhmm(hrs.close);
  const wd = weekdayOf(day);
  const shape = wd >= 6 ? HOUR_SHAPE_WEEKEND : HOUR_SHAPE_WEEKDAY;

  let total = 0;
  for (let b = 0; b < bins.length; b++) {
    const min = b * BIN_MIN;
    if (min < open || min >= close) continue;
    const w = shape[Math.floor(min / 60)];
    bins[b] = w;
    total += w;
  }
  if (total <= 0) return bins;
  const customers = dollars / model.meanBasket;
  for (let b = 0; b < bins.length; b++) bins[b] = (bins[b] / total) * customers;
  return bins;
}

interface SkuWeight {
  sku: Sku;
  /** Weight for drawing a line, already fixture-corrected. */
  w: number;
}

function buildPool(model: DemandModel, spec: BasketKindSpec): { pool: SkuWeight[]; total: number } {
  const pool: SkuWeight[] = [];
  let total = 0;
  // Catalog id order, not Map order, so the cumulative draw below lines up run
  // to run whatever the assortment is.
  for (const s of [...model.skus].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const f = spec.fixtures[s.fixture] ?? 0;
    if (f <= 0) continue;
    const w = (model.weeklyDollars.get(s.id) ?? 0) * f * (model.fixtureBoost[s.fixture] ?? 1);
    if (w <= 0) continue;
    pool.push({ sku: s, w });
    total += w;
  }
  return { pool, total };
}

function poolFor(model: DemandModel, spec: BasketKindSpec): { pool: SkuWeight[]; total: number } {
  let p = model.pools.get(spec.kind);
  if (!p) {
    p = buildPool(model, spec);
    model.pools.set(spec.kind, p);
  }
  return p;
}

function drawSku(pool: SkuWeight[], total: number, rng: Rng): Sku {
  let r = rng() * total;
  for (const p of pool) {
    r -= p.w;
    if (r <= 0) return p.sku;
  }
  return pool[pool.length - 1].sku;
}

/**
 * How many selling units of a SKU one shopper takes. Packaged candy goes in
 * ones and twos; bulk and showcase candy is bought by the fraction of a pound.
 */
function unitsFor(sku: Sku, rng: Rng): number {
  if (sku.sellBy === "weight") return Math.round((0.25 + rng() * 0.85) * 4) / 4;
  const r = rng();
  return r < 0.62 ? 1 : r < 0.88 ? 2 : r < 0.97 ? 3 : 4;
}

function makeBasket(model: DemandModel, spec: BasketKindSpec, id: string, arriveMin: number, rng: Rng): Basket | null {
  const { pool, total } = poolFor(model, spec);
  if (pool.length === 0) return null;
  // Spend is lognormal-ish around the kind's mean: a long right tail, because
  // the customer who comes in for a gift box is the one who spends.
  const target = spec.meanDollars * Math.exp(0.55 * (rng() + rng() + rng() - 1.5) * 1.6) * (0.6 + 0.8 * rng());
  const lines: BasketLine[] = [];
  const served: BasketLine[] = [];
  const seen = new Map<string, BasketLine>();
  let dollars = 0;
  for (let i = 0; i < 14 && dollars < target; i++) {
    const sku = drawSku(pool, total, rng);
    const units = unitsFor(sku, rng);
    const existing = seen.get(sku.id);
    if (existing) existing.units += units;
    else {
      const line: BasketLine = { sku: sku.id, units };
      seen.set(sku.id, line);
      lines.push(line);
      if (sku.fixture === "showcase") served.push(line);
    }
    dollars += units * sku.unitRetail;
  }
  if (lines.length === 0) return null;
  const jitter = 0.7 + 0.6 * rng();
  return {
    id,
    kind: spec.kind,
    arriveMin,
    lines,
    servedLines: served,
    wrap: rng() < spec.wrapRate,
    dwellMin: Math.max(0.5, spec.dwellMin * jitter),
    patienceMin: Math.max(1, spec.patienceMin * jitter),
    dollars,
  };
}

function drawKind(rng: Rng): BasketKindSpec {
  let r = rng();
  for (const s of BASKET_SPECS) {
    r -= s.share;
    if (r <= 0) return s;
  }
  return BASKET_SPECS[BASKET_SPECS.length - 1];
}

/**
 * Every customer who walks in on a horizon day, in arrival order. Draws are
 * per quarter-hour bin so the shape of the day survives, and each customer's
 * exact minute is uniform inside their bin.
 */
export function customersOn(model: DemandModel, day: number, startWeek: number, rng: Rng): Basket[] {
  const bins = arrivalBins(model, day, startWeek);
  const out: Basket[] = [];
  let n = 0;
  for (let b = 0; b < bins.length; b++) {
    if (bins[b] <= 0) continue;
    const count = poisson(rng, bins[b]);
    const times: number[] = [];
    for (let i = 0; i < count; i++) times.push(b * BIN_MIN + rng() * BIN_MIN);
    times.sort((x, y) => x - y);
    for (const min of times) {
      const spec = drawKind(rng);
      const basket = makeBasket(model, spec, `C${day}-${String(++n).padStart(4, "0")}`, day * 1440 + min, rng);
      if (basket) out.push(basket);
    }
  }
  return out;
}

/**
 * Delivery and pickup orders taken on `placedDay` for the next trading day.
 * These are the "special picks": they are picked and packed before the doors
 * open, and the delivery ones go out on the van's morning round.
 */
export function ordersPlacedOn(model: DemandModel, placedDay: number, startWeek: number, rng: Rng): SpecialOrder[] {
  let dueDay = placedDay + 1;
  for (let i = 0; i < 7 && !isOperating(model.site, dueDay); i++) dueDay++;
  if (!isOperating(model.site, dueDay)) return [];

  const dollars = expectedDayTotal(model, dueDay, startWeek) * model.specialShare;
  if (dollars <= 0) return [];
  // Special orders are big: a party tray, an office gift, a wedding favour.
  const mean = model.meanBasket * 3.2;
  const count = poisson(rng, dollars / mean);
  if (count <= 0) return [];

  const spec = BASKET_SPECS.find((s) => s.kind === "gift")!;
  const vanMin = hhmm(model.site.times.vanDeparture);
  const second = model.site.times.vanSecondDeparture ? hhmm(model.site.times.vanSecondDeparture) : null;
  const hrs = hoursOn(model.site, dueDay)!;
  const out: SpecialOrder[] = [];
  for (let i = 0; i < count; i++) {
    const basket = makeBasket(model, { ...spec, meanDollars: mean }, `O${dueDay}-${String(i + 1).padStart(3, "0")}`, 0, rng);
    if (!basket) continue;
    const delivery = rng() < model.deliveryShare;
    // Most rounds go out before the doors open; the rest ride the afternoon van.
    const afternoon = second !== null && rng() < 0.3;
    out.push({
      id: basket.id,
      kind: delivery ? "delivery" : "pickup",
      customer: `Order ${basket.id}`,
      placedDay,
      dueDay,
      dueMin: delivery ? (afternoon ? second! : vanMin) : hhmm(hrs.open),
      lines: basket.lines,
      wrap: rng() < 0.55,
      dollars: basket.dollars,
      miles: Math.round((1.5 + rng() * 9) * 10) / 10,
    });
  }
  return out;
}
