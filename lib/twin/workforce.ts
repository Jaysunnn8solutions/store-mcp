/**
 * Workforce planning for a shop: how much work there is, when in the day it
 * lands, who is rostered against it, and what to do about the gap.
 *
 * The arithmetic is the distribution center's — workload is expected volume
 * times an engineered standard, and requirement is workload ÷ productivity ÷
 * target utilization ÷ (1 − absenteeism) — but a store's work is shaped by the
 * clock in a way a DC's is not. Much of it is customer-facing: a shopper is
 * standing there while it happens, so an hour of counter work at 17:30 cannot
 * be done at 11:00 instead. A shop can be comfortably under-utilised across the
 * week and still have a ten-minute queue at 17:30 on the Saturday before
 * Halloween. That is why every day is reported half hour by half hour as well
 * as in weekly totals, and why `peakHalfHour` measures the counter rather than
 * the whole floor: restocking, receiving and picking can wait an hour, and a
 * queue cannot.
 *
 * The other half of the shape is that the work which cannot wait for the
 * customers is stacked before the doors open. Special orders are picked,
 * packed and loaded between `pickStart` and `vanDeparture`, and the overnight
 * trailer is unloaded before that, which is what makes the opening shift the
 * constrained one even in a week whose totals look comfortable.
 *
 * Nothing here draws a random number. These are expectations; the simulation is
 * what turns them into a day with variance in it. The two have to agree in the
 * mean, so every standard charged here is the one the engine charges, and every
 * volume comes from the same demand model.
 */

import {
  BASKET_SPECS,
  BIN_MIN,
  arrivalBins,
  expectedDailyUnits,
  expectedDayTotal,
  hoursOn,
  lineProbability,
  weekdayOf,
  type BasketKindSpec,
  type DemandModel,
} from "./demand";
import { doorToStorage, isGoldenShelf, sShapeDistance, stockDistance, type Facing, type Layout } from "./layout";
import type { FacingUnits, Planogram, SkuRate } from "./merch";
import { calendarWeekOfDay } from "./season";
import { hhmm, shiftPaidHours } from "./standards";
import { PROCESSES, PROCESS_SKILL, SKILLS, type Catalog, type CostRates, type LaborStandards, type Process, type Site, type Skill, type Sku, type Supplier, type Worker } from "./types";

/** The reporting grid. Half an hour is short enough to see a queue build. */
const HALF_HOUR = 30;

/**
 * Expected selling units in one pull off the shelf, from `unitsFor` in
 * demand.ts: 1.53 pieces of a packaged SKU, or two thirds of a pound of
 * something scooped or trayed.
 */
const UNITS_PER_DRAW_EACH = 1.53;
const UNITS_PER_DRAW_WEIGHT = 0.675;

/** A special order is this many ordinary baskets, as `ordersPlacedOn` draws it. */
const SPECIAL_ORDER_MULTIPLE = 3.2;
/** Share of special orders that are gift-wrapped, also from `ordersPlacedOn`. */
const ORDER_WRAP_RATE = 0.55;
/** Share of a day's delivery orders that ride the afternoon van when there is one. */
const AFTERNOON_ROUND_SHARE = 0.3;

/**
 * Mean road miles between a special-order customer and the shop — the mean of
 * the 1.5–10.5 draw in `ordersPlacedOn` — and the share of that a stop adds to
 * a round. Stops are clustered, so a van driving to four customers does not
 * drive four round trips; a third of each radial distance is the usual planning
 * rule for a dense urban round.
 */
const MEAN_STOP_MILES = 6;
const ROUND_LEG_SHARE = 0.35;

/** Overtime a shop will ask of one person in a week before it books a temp. */
const MAX_OVERTIME_PER_WORKER = 8;

/**
 * Skills a temp cannot be booked into. A food handler's card and the store's
 * driver insurance both take longer than a season, so a shortfall behind the
 * glass or on the van can only be closed by cross-training or hiring. This is
 * the store's version of the distribution center's forklift certification.
 */
const TEMP_BLOCKED: Skill[] = ["counter", "drive"];

/** Hours below this are rounding, not a gap. */
const GAP_EPSILON = 0.25;

/**
 * Facings a stocker works before the cart is empty and they walk back. It is
 * what stops a shop full of tiny facings from looking as cheap to fill as a
 * shop full of deep ones: the cases are the same either way, the trips are not.
 */
const FACINGS_PER_TRIP = 12;

/** What each skill lets a person do, for the notes the planner writes. */
const SKILL_WORK: Record<Skill, string> = {
  receive: "take a delivery in",
  stock: "fill the shelves",
  counter: "work behind the glass",
  register: "open a register",
  pick: "pick a special order",
  drive: "take the van out",
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface WorkloadContext {
  site: Site;
  layout: Layout;
  model: DemandModel;
  catalog: Catalog;
  std: LaborStandards;
  /** Calendar week horizon day 0 falls in. */
  startWeek: number;
  /** Which facing merch put each SKU in; it is what restocking costs. */
  plan: Planogram;
  /** Selling units a full facing holds, which is what sets how often it is refilled. */
  facingUnits: FacingUnits;
  /**
   * Per-SKU rates over an ordinary week, as merch ranked and sized the facings
   * with. The planner does not read them: it plans a named week, and the
   * seasoned units for that week come from the demand model, which is also
   * what the simulation sells. They travel in the context so a caller holding
   * one has everything merch produced in one place.
   */
  rates: SkuRate[];
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

export interface HalfHourLoad {
  /** Minutes after midnight the half hour starts. */
  minuteOfDay: number;
  /** Standard minutes of work landing in it, by process; absent means none. */
  minutes: Partial<Record<Process, number>>;
  total: number;
}

export interface DayWorkload {
  /** Horizon day; day 0 is the Monday of the context's `startWeek`. */
  day: number;
  weekday: number;
  /** Trading hours as minutes after midnight; both 0 on a day the shop is dark. */
  open: number;
  close: number;
  byProcess: Record<Process, number>;
  bySkill: Record<Skill, number>;
  /** The whole working day, opening crew to close-down, in half hours. */
  halfHours: HalfHourLoad[];
  /**
   * The busiest half hour *at the counter* — serve plus checkout. Deferrable
   * work is deliberately not in it: a queue is made of customers, not cases,
   * and this number is what decides how many people have to be on the floor at
   * that moment rather than merely that day.
   */
  peakHalfHour: { minuteOfDay: number; minutes: number };
  total: number;
}

export interface WeeklyWorkload {
  /** Horizon week; week 0 is days 0–6. */
  week: number;
  calendarWeek: number;
  days: DayWorkload[];
  byProcess: Record<Process, number>;
  bySkill: Record<Skill, number>;
  /** Standard minutes attributed to each shift by the half hours it covers. */
  byShift: Record<string, number>;
  total: number;
}

function zeroByProcess(): Record<Process, number> {
  return { unload: 0, receive: 0, putaway: 0, restock: 0, serve: 0, checkout: 0, pick: 0, pack: 0, load: 0, deliver: 0 };
}

function zeroBySkill(): Record<Skill, number> {
  return { receive: 0, stock: 0, counter: 0, register: 0, pick: 0, drive: 0 };
}

// ---------------------------------------------------------------------------
// Things that depend on the building and the assortment, not on the day
// ---------------------------------------------------------------------------

/** What one pull off the shelf looks like for a basket kind, in expectation. */
interface DrawProfile {
  /** Chance of drawing each SKU, parallel to `model.skus`. */
  p: number[];
  /** Pieces of packaged candy in a draw. */
  pieces: number;
  /** Chance the draw is something weighed — a bulk scoop or a showcase tray. */
  weighs: number;
  /** Chance it comes from behind the glass, so a clerk has to fetch it. */
  showcase: number;
  /** Selling units, dollars and cube a draw adds to the basket. */
  units: number;
  dollars: number;
  cubeFt: number;
}

interface Profile {
  /** Blended standard minutes one walk-in customer costs, by process. */
  perCustomer: { serve: number; checkout: number };
  /** One special order, in expectation. */
  order: { lines: number; units: number; cubeFt: number };
  /** Feet walked on the pick tour one special order takes. */
  tourFeet: number;
  /** Share of facings outside the golden shelves, which cost a bend or a stretch. */
  bendShare: number;
  /** Round trip in feet from the receiving apron to an average stockroom position. */
  putawayWalkFt: number;
  /** Round trip in feet from the stockroom door to an average facing. */
  restockWalkFt: number;
  /**
   * What the plan costs to keep filled, per SKU: the round trip out to its
   * facing and the bend or stretch its shelf costs. This is where a better
   * planogram shows up in the labor plan — a fast mover near the stockroom door
   * at waist height is cheaper to fill than the same SKU on the top shelf of the
   * far aisle, and the difference is real minutes.
   */
  facingCost: Map<string, { walkFt: number; bendMin: number }>;
}

/**
 * Cached per context. Every field is a pure function of the building, the
 * assortment and the standards, and a week of planning asks for them a few
 * hundred times.
 */
const PROFILES = new WeakMap<WorkloadContext, Profile>();

/**
 * Mirrors `poolFor`, `drawSku` and `unitsFor` in demand.ts in expectation
 * rather than by drawing, so the planner's basket and the simulation's basket
 * are the same basket.
 */
function drawProfile(model: DemandModel, spec: BasketKindSpec): DrawProfile {
  const w: number[] = [];
  let total = 0;
  for (const sku of model.skus) {
    const f = spec.fixtures[sku.fixture] ?? 0;
    const x = f > 0 ? (model.weeklyDollars.get(sku.id) ?? 0) * f * (model.fixtureBoost[sku.fixture] ?? 1) : 0;
    w.push(x);
    total += x;
  }
  const out: DrawProfile = { p: w.map(() => 0), pieces: 0, weighs: 0, showcase: 0, units: 0, dollars: 0, cubeFt: 0 };
  if (total <= 0) return out;
  model.skus.forEach((sku, i) => {
    const p = w[i] / total;
    out.p[i] = p;
    const units = sku.sellBy === "weight" ? UNITS_PER_DRAW_WEIGHT : UNITS_PER_DRAW_EACH;
    if (sku.sellBy === "weight") out.weighs += p;
    else out.pieces += p * units;
    if (sku.fixture === "showcase") out.showcase += p;
    out.units += p * units;
    out.dollars += p * units * sku.unitRetail;
    out.cubeFt += (p * units * sku.innerCubeFt) / Math.max(1e-9, sku.unitsPerInner);
  });
  return out;
}

/**
 * Distinct lines after `draws` pulls from the same pool. A shopper who takes
 * two of the same bar has one line, not two, and `packPerLine` is charged per
 * line.
 */
function distinctLines(p: number[], draws: number): number {
  let n = 0;
  for (const q of p) {
    if (q > 0) n += 1 - Math.pow(1 - q, draws);
  }
  return n;
}

/** Draws needed to reach a target spend, capped as `makeBasket` caps its loop. */
function drawsFor(profile: DrawProfile, dollars: number): number {
  if (profile.dollars <= 0) return 0;
  return Math.min(14, dollars / profile.dollars);
}

function customerStandards(model: DemandModel, std: LaborStandards): { serve: number; checkout: number } {
  let serve = 0;
  let checkout = 0;
  for (const spec of BASKET_SPECS) {
    const draw = drawProfile(model, spec);
    const n = drawsFor(draw, spec.meanDollars);
    if (n <= 0) continue;
    // Everything in the basket is rung up, whether it came off a shelf or out
    // of the glass; a weighed box is one item on the scale however much it
    // weighs, a packaged SKU is one item per piece.
    const items = n * (draw.pieces + draw.weighs);
    const weighed = n * draw.weighs;
    const served = n * draw.showcase;
    // The chance this shopper goes to the counter at all, which is what the
    // greeting and the box are charged against.
    serve += spec.share * (lineProbability(served) * std.servePerCustomer + served * std.servePerItem);
    checkout +=
      spec.share *
      (std.checkoutPerCustomer + items * std.checkoutPerItem + (weighed * std.checkoutWeighSec) / 60 + spec.wrapRate * std.giftWrapPerOrder);
  }
  return { serve, checkout };
}

/** Shelves on each run, which is what `isGoldenShelf` measures a shelf against. */
function shelvesByRun(layout: Layout): Map<string, number> {
  const shelves = new Map<string, number>();
  for (const f of layout.facings) shelves.set(f.run, Math.max(shelves.get(f.run) ?? 0, f.shelf));
  return shelves;
}

/**
 * One facing in each aisle: the route a picker walks when the plan has not
 * placed the SKUs an order is made of, which a small shop's order touches most
 * of the aisles for anyway.
 */
function aisleTourFeet(layout: Layout): number {
  const seen = new Set<number>();
  const reps: Facing[] = [];
  for (const f of layout.facings) {
    if (seen.has(f.aisle)) continue;
    seen.add(f.aisle);
    reps.push(f);
  }
  reps.sort((a, b) => a.aisle - b.aisle || (a.id < b.id ? -1 : 1));
  return sShapeDistance(layout, reps);
}

/**
 * The route a special order really walks: the SKUs most likely to be on one, in
 * the facings the plan put them in, in S-shape sequence.
 */
function orderTourFeet(ctx: WorkloadContext, draw: DrawProfile, lines: number): number {
  const ranked = ctx.model.skus
    .map((sku, i) => ({ sku, p: draw.p[i] }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p || (a.sku.id < b.sku.id ? -1 : 1))
    .slice(0, Math.max(1, Math.round(lines)));
  const facings: Facing[] = [];
  for (const x of ranked) {
    const f = ctx.plan.get(x.sku.id);
    if (f) facings.push(f);
  }
  return facings.length > 0 ? sShapeDistance(ctx.layout, facings) : aisleTourFeet(ctx.layout);
}

function bendShare(layout: Layout): number {
  const shelves = shelvesByRun(layout);
  let bends = 0;
  for (const f of layout.facings) {
    if (!isGoldenShelf(f.shelf, shelves.get(f.run) ?? f.shelf)) bends++;
  }
  return layout.facings.length ? bends / layout.facings.length : 0;
}

/** Where the plan put each SKU, priced as the walk and the stretch it costs. */
function facingCosts(ctx: WorkloadContext): Map<string, { walkFt: number; bendMin: number }> {
  const shelves = shelvesByRun(ctx.layout);
  const out = new Map<string, { walkFt: number; bendMin: number }>();
  // model.skus is an array in catalog order, so this loop is the same every run.
  for (const sku of ctx.model.skus) {
    const f = ctx.plan.get(sku.id);
    if (!f) continue;
    out.set(sku.id, {
      walkFt: 2 * stockDistance(ctx.layout, f),
      bendMin: isGoldenShelf(f.shelf, shelves.get(f.run) ?? f.shelf) ? 0 : ctx.std.restockBendReachSec / 60,
    });
  }
  return out;
}

function profileOf(ctx: WorkloadContext): Profile {
  const cached = PROFILES.get(ctx);
  if (cached) return cached;
  const { layout, model, std } = ctx;
  const gift = BASKET_SPECS.find((s) => s.kind === "gift") ?? BASKET_SPECS[BASKET_SPECS.length - 1];
  const orderDraw = drawProfile(model, gift);
  const orderDollars = model.meanBasket * SPECIAL_ORDER_MULTIPLE;
  const draws = drawsFor(orderDraw, orderDollars);
  let putaway = 0;
  for (const pos of layout.storage) putaway += doorToStorage(layout.staging, pos);
  let restock = 0;
  for (const f of layout.facings) restock += stockDistance(layout, f);
  const lines = distinctLines(orderDraw.p, draws);
  const p: Profile = {
    perCustomer: customerStandards(model, std),
    order: { lines, units: draws * orderDraw.units, cubeFt: draws * orderDraw.cubeFt },
    tourFeet: orderTourFeet(ctx, orderDraw, lines),
    bendShare: bendShare(layout),
    putawayWalkFt: layout.storage.length ? (2 * putaway) / layout.storage.length : 0,
    restockWalkFt: layout.facings.length ? (2 * restock) / layout.facings.length : 0,
    facingCost: facingCosts(ctx),
  };
  PROFILES.set(ctx, p);
  return p;
}

// ---------------------------------------------------------------------------
// The half-hour grid
// ---------------------------------------------------------------------------

/** A block of work and the window of the day it has to happen in. */
interface Segment {
  process: Process;
  from: number;
  to: number;
  minutes: number;
}

interface Grid {
  cells: HalfHourLoad[];
  add(process: Process, minuteOfDay: number, minutes: number): void;
  spread(segment: Segment): void;
}

function makeGrid(from: number, to: number): Grid {
  const cells: HalfHourLoad[] = [];
  for (let m = from; m < to; m += HALF_HOUR) cells.push({ minuteOfDay: m, minutes: {}, total: 0 });
  if (cells.length === 0) cells.push({ minuteOfDay: from, minutes: {}, total: 0 });
  const end = cells[cells.length - 1].minuteOfDay + HALF_HOUR;
  const put = (cell: HalfHourLoad, process: Process, minutes: number) => {
    if (minutes <= 0) return;
    cell.minutes[process] = (cell.minutes[process] ?? 0) + minutes;
    cell.total += minutes;
  };
  const add = (process: Process, minuteOfDay: number, minutes: number) => {
    const i = Math.min(cells.length - 1, Math.max(0, Math.floor((minuteOfDay - from) / HALF_HOUR)));
    put(cells[i], process, minutes);
  };
  const spread = (segment: Segment) => {
    if (segment.minutes <= 0) return;
    // A window that falls outside the working day is pinned to its nearest
    // edge rather than dropped: the work still has to be done by someone.
    const lo = Math.max(from, Math.min(segment.from, end - HALF_HOUR));
    const hi = Math.min(end, Math.max(segment.to, lo + 1));
    const span = hi - lo;
    for (const cell of cells) {
      const o = Math.min(cell.minuteOfDay + HALF_HOUR, hi) - Math.max(cell.minuteOfDay, lo);
      if (o > 0) put(cell, segment.process, (segment.minutes * o) / span);
    }
  };
  return { cells, add, spread };
}

/** Expected customers arriving inside [a, b), from the quarter-hour arrival bins. */
function customersIn(bins: Float64Array, a: number, b: number): number {
  let n = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] <= 0) continue;
    const lo = i * BIN_MIN;
    const o = Math.min(lo + BIN_MIN, b) - Math.max(lo, a);
    if (o > 0) n += (bins[i] * o) / BIN_MIN;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Where the work comes from
// ---------------------------------------------------------------------------

/**
 * The weekday a vendor's own truck calls: its order day plus its lead time,
 * rolled forward to a day the shop is open, exactly as the inventory book
 * schedules it.
 */
function arrivalWeekday(site: Site, supplier: Supplier): number {
  let d = supplier.orderDay - 1 + Math.round(supplier.leadDays);
  for (let i = 0; i < 14 && !site.operatingDays.includes(weekdayOf(d)); i++) d++;
  return weekdayOf(d);
}

/** Days a distribution-center delivery has to cover: until the next one calls. */
function coverDays(days: number[], weekday: number): number {
  if (days.length === 0) return 7;
  const sorted = [...days].sort((a, b) => a - b);
  const next = sorted.find((d) => d > weekday);
  return next === undefined ? sorted[0] + 7 - weekday : next - weekday;
}

/**
 * Restocking the sales floor. A facing is refilled when it runs down, so the
 * refills are the week's units over what a facing holds — the planogram's own
 * arithmetic, run day by day so the season is in it. Shelf SKUs are worked out
 * of the display box they arrived in; bulk bins and showcase trays are
 * decanted instead, which is what `restockPerTray` pays for.
 */
function restockLoad(ctx: WorkloadContext, day: number): Segment[] {
  const { std, model } = ctx;
  const hrs = hoursOn(ctx.site, day);
  if (!hrs) return [];
  const p = profileOf(ctx);
  const units = expectedDailyUnits(model, day, 1, ctx.startWeek);
  const fallback = { walkFt: p.restockWalkFt, bendMin: (p.bendShare * std.restockBendReachSec) / 60 };
  let cases = 0;
  let cube = 0;
  let trays = 0;
  let refills = 0;
  let walkFt = 0;
  let bendMin = 0;
  for (const sku of model.skus) {
    const u = units.get(sku.id) ?? 0;
    if (u <= 0) continue;
    // A SKU merch has not sized or placed is assumed to show one display box,
    // in an average spot.
    const holds = Math.max(1e-6, ctx.facingUnits.get(sku.id) ?? sku.unitsPerInner);
    const cost = p.facingCost.get(sku.id) ?? fallback;
    const inners = u / Math.max(1e-9, sku.unitsPerInner);
    const refill = u / holds;
    cube += inners * sku.innerCubeFt;
    refills += refill;
    walkFt += refill * cost.walkFt;
    if (sku.fixture === "bulk" || sku.fixture === "showcase") trays += refill;
    else {
      cases += inners;
      bendMin += inners * cost.bendMin;
    }
  }
  // A trip carries a cart's worth of cube, and covers only so many facings
  // however little each of them needs. What it walks is the average of the
  // facings it is going out to, which is where the plan shows up.
  const trips = Math.max(cube / Math.max(1e-9, std.cartCubeFt), refills / FACINGS_PER_TRIP);
  const perTripWalk = refills > 0 ? walkFt / refills : p.restockWalkFt;
  const minutes = trips * (std.restockPerTrip + perTripWalk / std.walkFtPerMin) + cases * std.restockPerCase + bendMin + trays * std.restockPerTray;
  if (minutes <= 0) return [];
  // Shelves are filled before the doors open and topped up all day.
  return [{ process: "restock", from: hhmm(hrs.open) - 120, to: hhmm(hrs.close), minutes }];
}

/**
 * Master cases and cube for a set of SKUs, from the mean daily units over the
 * days the delivery covers.
 */
function inboundVolume(skus: Sku[], perDay: Map<string, number>, days: number): { cases: number; cube: number } {
  let cases = 0;
  let cube = 0;
  for (const sku of skus) {
    const units = (perDay.get(sku.id) ?? 0) * days;
    if (units <= 0) continue;
    const inners = units / Math.max(1e-9, sku.unitsPerInner);
    cases += inners / Math.max(1e-9, sku.innersPerCase);
    cube += inners * sku.innerCubeFt;
  }
  return { cases, cube };
}

/**
 * Goods through the back door. The overnight trailer from the distribution
 * center comes in on pallets before the shop opens; vendors' own box trucks are
 * hand-stacked through the trading day, which is why they cost per case rather
 * than per pallet and land in the middle of the busiest part of the shift.
 *
 * Both are sized from the week's unit sales, so a week of arrivals is a week of
 * sales however the delivery days fall.
 */
function inboundLoad(ctx: WorkloadContext, day: number): Segment[] {
  const { site, std, model, catalog } = ctx;
  const p = profileOf(ctx);
  const weekday = weekdayOf(day);
  const suppliers = new Map(catalog.suppliers.map((s) => [s.id, s]));
  const out: Segment[] = [];
  const putawayPerMove = std.putawayHandling + p.putawayWalkFt / std.walkFtPerMin;

  if (site.dcDeliveryDays.includes(weekday)) {
    const days = coverDays(site.dcDeliveryDays, weekday);
    const perDay = expectedDailyUnits(model, day, days, ctx.startWeek);
    const dcSkus = model.skus.filter((s) => suppliers.get(s.supplier)?.channel === "dc");
    const importSkus = dcSkus.filter((s) => suppliers.get(s.supplier)?.kind === "importer");
    const v = inboundVolume(dcSkus, perDay, days);
    const imported = inboundVolume(importSkus, perDay, days);
    if (v.cases > 0) {
      const pallets = Math.ceil(v.cube / Math.max(1e-9, std.palletCubeFt));
      const [a, b] = site.times.overnightWindow;
      const from = hhmm(a);
      const to = hhmm(b);
      out.push({ process: "unload", from, to, minutes: std.unloadPerTruck + pallets * std.unloadPerPallet });
      out.push({ process: "receive", from, to, minutes: v.cases * std.receivePerCase + imported.cases * std.labelPerImportCase });
      out.push({ process: "putaway", from, to, minutes: pallets * putawayPerMove });
    }
  }

  // One entry per vendor calling today. Suppliers are aggregated through a Map
  // and read back in sorted id order: a Map's iteration order must never decide
  // a number in this project.
  const direct = new Map<string, Sku[]>();
  for (const sku of model.skus) {
    const sup = suppliers.get(sku.supplier);
    if (!sup || sup.channel !== "direct" || arrivalWeekday(site, sup) !== weekday) continue;
    const list = direct.get(sup.id);
    if (list) list.push(sku);
    else direct.set(sup.id, [sku]);
  }
  if (direct.size > 0) {
    // A vendor calls once a week, so its truck carries a week of its SKUs.
    const perWeek = expectedDailyUnits(model, day, 7, ctx.startWeek);
    const [a, b] = site.times.directWindow;
    const from = hhmm(a);
    const to = hhmm(b);
    for (const id of [...direct.keys()].sort()) {
      const sup = suppliers.get(id);
      const skus = direct.get(id);
      if (!sup || !skus) continue;
      const v = inboundVolume(skus, perWeek, 7);
      if (v.cases <= 0) continue;
      const moves = Math.ceil(v.cube / Math.max(1e-9, std.cartCubeFt));
      const importCases = sup.kind === "importer" ? v.cases : 0;
      out.push({ process: "unload", from, to, minutes: std.unloadPerTruck + v.cases * std.unloadPerCase });
      out.push({ process: "receive", from, to, minutes: v.cases * std.receivePerCase + importCases * std.labelPerImportCase });
      out.push({ process: "putaway", from, to, minutes: moves * putawayPerMove });
    }
  }
  return out;
}

/**
 * The orders that leave the shop. Everything is picked and packed between
 * `pickStart` and the van's departure, before the doors open, because the
 * people who would do it are on the registers afterwards. The van's round is on
 * the road through the morning, which is labor the store is paying for while
 * nobody is on the floor.
 */
function orderLoad(ctx: WorkloadContext, day: number): Segment[] {
  const { site, std, model } = ctx;
  const p = profileOf(ctx);
  const hrs = hoursOn(site, day);
  if (!hrs) return [];
  const dollars = expectedDayTotal(model, day, ctx.startWeek) * model.specialShare;
  const orders = dollars / Math.max(1e-9, model.meanBasket * SPECIAL_ORDER_MULTIPLE);
  if (orders <= 0) return [];

  const out: Segment[] = [];
  const pickFrom = hhmm(site.times.pickStart);
  const vanMin = hhmm(site.times.vanDeparture);
  const tours = orders * Math.max(1, p.order.cubeFt / Math.max(1e-9, std.cartCubeFt));
  out.push({
    process: "pick",
    from: pickFrom,
    to: vanMin,
    minutes: tours * (std.pickPerTour + p.tourFeet / std.walkFtPerMin) + orders * (p.order.lines * std.pickPerLine + p.order.units * std.pickPerUnit),
  });
  out.push({
    process: "pack",
    from: pickFrom,
    to: vanMin,
    minutes: orders * (std.packPerOrder + p.order.lines * std.packPerLine + ORDER_WRAP_RATE * std.giftWrapPerOrder),
  });

  const second = site.times.vanSecondDeparture ? hhmm(site.times.vanSecondDeparture) : null;
  const deliveries = orders * model.deliveryShare;
  const rounds: Array<{ depart: number; stops: number }> = [
    { depart: vanMin, stops: deliveries * (second === null ? 1 : 1 - AFTERNOON_ROUND_SHARE) },
  ];
  if (second !== null) rounds.push({ depart: second, stops: deliveries * AFTERNOON_ROUND_SHARE });
  for (const round of rounds) {
    if (round.stops <= 0) continue;
    // A part of a van is a van: the expected round is a fraction of a departure
    // on a quiet day, and a whole one as soon as there is more than a stop.
    const vans = Math.min(1, round.stops);
    const miles = std.routeBaseMiles + round.stops * MEAN_STOP_MILES * ROUND_LEG_SHARE;
    const drive = round.stops * std.deliverPerStop + miles * std.deliverPerMile;
    out.push({ process: "load", from: round.depart - HALF_HOUR, to: round.depart, minutes: round.stops * std.loadPerOrder + vans * std.loadPerVan });
    out.push({ process: "deliver", from: round.depart, to: round.depart + Math.max(HALF_HOUR, drive), minutes: drive });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A day, and a week
// ---------------------------------------------------------------------------

/** The window the crew is in the building, which is wider than the trading day. */
function workingWindow(ctx: WorkloadContext, open: number, close: number, segments: Segment[]): { from: number; to: number } {
  const { site } = ctx;
  let lo = Math.min(open, hhmm(site.times.pickStart));
  let hi = close;
  for (const s of site.shifts) {
    const start = hhmm(s.start);
    lo = Math.min(lo, start);
    hi = Math.max(hi, start + shiftPaidHours(s.start, s.end) * 60);
  }
  for (const seg of segments) {
    lo = Math.min(lo, seg.from);
    hi = Math.max(hi, seg.to);
  }
  return { from: Math.floor(lo / HALF_HOUR) * HALF_HOUR, to: Math.ceil(hi / HALF_HOUR) * HALF_HOUR };
}

function dayWorkload(ctx: WorkloadContext, day: number): DayWorkload {
  const weekday = weekdayOf(day);
  const hrs = hoursOn(ctx.site, day);
  if (!hrs) {
    return { day, weekday, open: 0, close: 0, byProcess: zeroByProcess(), bySkill: zeroBySkill(), halfHours: [], peakHalfHour: { minuteOfDay: 0, minutes: 0 }, total: 0 };
  }
  const open = hhmm(hrs.open);
  const close = hhmm(hrs.close);
  const segments = [...restockLoad(ctx, day), ...inboundLoad(ctx, day), ...orderLoad(ctx, day)];
  const { from, to } = workingWindow(ctx, open, close, segments);
  const grid = makeGrid(from, to);
  for (const seg of segments) grid.spread(seg);

  // The customers, half hour by half hour. This is the only part of the day
  // that cannot be moved to a quieter hour.
  const p = profileOf(ctx);
  const bins = arrivalBins(ctx.model, day, ctx.startWeek);
  let peak = { minuteOfDay: open, minutes: 0 };
  for (const cell of grid.cells) {
    const customers = customersIn(bins, cell.minuteOfDay, cell.minuteOfDay + HALF_HOUR);
    if (customers <= 0) continue;
    const serve = customers * p.perCustomer.serve;
    const checkout = customers * p.perCustomer.checkout;
    grid.add("serve", cell.minuteOfDay, serve);
    grid.add("checkout", cell.minuteOfDay, checkout);
    if (serve + checkout > peak.minutes) peak = { minuteOfDay: cell.minuteOfDay, minutes: serve + checkout };
  }

  const byProcess = zeroByProcess();
  const bySkill = zeroBySkill();
  let total = 0;
  for (const cell of grid.cells) {
    for (const process of PROCESSES) {
      const m = cell.minutes[process] ?? 0;
      if (m <= 0) continue;
      byProcess[process] += m;
      bySkill[PROCESS_SKILL[process]] += m;
      total += m;
    }
  }
  return { day, weekday, open, close, byProcess, bySkill, halfHours: grid.cells, peakHalfHour: peak, total };
}

/** Standard minutes for one horizon week, by day, process, skill and shift. */
export function expectedWorkload(ctx: WorkloadContext, week: number): WeeklyWorkload {
  const days: DayWorkload[] = [];
  for (let i = 0; i < 7; i++) days.push(dayWorkload(ctx, week * 7 + i));
  const byProcess = zeroByProcess();
  const bySkill = zeroBySkill();
  const byShift: Record<string, number> = {};
  for (const s of ctx.site.shifts) byShift[s.id] = 0;
  let total = 0;
  for (const d of days) {
    for (const process of PROCESSES) byProcess[process] += d.byProcess[process];
    for (const skill of SKILLS) bySkill[skill] += d.bySkill[skill];
    total += d.total;
    const split = splitByShift(ctx.site, d);
    for (const id of Object.keys(byShift)) {
      for (const skill of SKILLS) byShift[id] += split[id][skill];
    }
  }
  return { week, calendarWeek: calendarWeekOfDay(ctx.startWeek, week * 7), days, byProcess, bySkill, byShift, total };
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

interface ShiftWindow {
  id: string;
  start: number;
  end: number;
  breakStart: number;
  breakEnd: number;
  /** What the shift costs. */
  paidHours: number;
  /** What it is worth: paid, less the meal break and the paid indirect block. */
  productiveHours: number;
}

function shiftWindows(site: Site): ShiftWindow[] {
  return site.shifts.map((s) => {
    const start = hhmm(s.start);
    const span = shiftPaidHours(s.start, s.end) * 60;
    const breakStart = start + span / 2 - s.breakMin / 2;
    return {
      id: s.id,
      start,
      end: start + span,
      breakStart,
      breakEnd: breakStart + s.breakMin,
      paidHours: (span - s.breakMin) / 60,
      productiveHours: Math.max(0, (span - s.breakMin - s.indirectMin) / 60),
    };
  });
}

/** A shift covers a half hour if it falls inside the shift, less the meal break. */
function covers(w: ShiftWindow, minuteOfDay: number): boolean {
  const t = minuteOfDay < w.start ? minuteOfDay + 1440 : minuteOfDay;
  return t >= w.start && t < w.end && !(t >= w.breakStart && t < w.breakEnd);
}

/**
 * The shift a half hour nobody is rostered for is nearest to, measured round
 * the clock so the 04:00 trailer lands on the opening crew rather than on the
 * closers who went home six hours earlier.
 */
function nearestShift(windows: ShiftWindow[], minuteOfDay: number): ShiftWindow {
  const cyc = (x: number) => ((x % 1440) + 1440) % 1440;
  let best = windows[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const w of windows) {
    const gap = Math.min(cyc(w.start - minuteOfDay), cyc(minuteOfDay - w.end));
    if (gap < bestGap) {
      best = w;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * A day's minutes attributed to the shifts standing on the floor for them. Work
 * in a half hour two shifts overlap is split between them; work in a half hour
 * nobody covers — the trailer that lands before the opening crew clocks in — is
 * charged to the nearest shift, where it will show up as a requirement the
 * roster has to answer.
 */
function splitByShift(site: Site, day: DayWorkload): Record<string, Record<Skill, number>> {
  const windows = shiftWindows(site);
  const out: Record<string, Record<Skill, number>> = {};
  for (const w of windows) out[w.id] = zeroBySkill();
  for (const cell of day.halfHours) {
    if (cell.total <= 0) continue;
    const on = windows.filter((w) => covers(w, cell.minuteOfDay));
    const targets = on.length > 0 ? on : [nearestShift(windows, cell.minuteOfDay)];
    for (const process of PROCESSES) {
      const m = cell.minutes[process] ?? 0;
      if (m <= 0) continue;
      const skill = PROCESS_SKILL[process];
      for (const w of targets) out[w.id][skill] += m / targets.length;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The week's schedule
// ---------------------------------------------------------------------------

export interface ScheduleOptions {
  targetUtilization: number;
  /** Expected share of rostered shifts no-showed; it inflates the requirement. */
  absenteeism: number;
}

export const DEFAULT_SCHEDULE_OPTIONS: ScheduleOptions = { targetUtilization: 0.85, absenteeism: 0.05 };

export interface DayAssignment {
  day: number;
  weekday: number;
  shift: string;
  worker: string;
  /** The skill this person is on for the day; they flex off it when it is quiet. */
  primary: Skill;
  /** Paid hours, which is what the day costs and what counts against their week. */
  hours: number;
}

export interface SkillGap {
  skill: Skill;
  requiredHours: number;
  coveredHours: number;
  gapHours: number;
}

export interface WeekSchedule {
  week: number;
  calendarWeek: number;
  assignments: DayAssignment[];
  /** Hours the week needs of each skill, after productivity, utilization and absence. */
  required: Record<Skill, number>;
  covered: Record<Skill, number>;
  gaps: SkillGap[];
  /** Rostered hours no skill needed, which is the slack a flexing floor runs on. */
  spareHours: number;
  /** Days one person is the only one present who can do something. */
  risks: Array<{ skill: Skill; day: number; worker: string; note: string }>;
}

/**
 * Schedule one horizon week. Full-timers work every trading day their hours
 * reach; part-timers take the days their own shift needs most, which is what
 * puts the Saturday crew on Saturday. Each person present gets one primary
 * skill for the day, scarcest skill first to the least flexible person, so the
 * shift lead is left for whatever is still open.
 */
export function buildWeekSchedule(ctx: WorkloadContext, workers: Worker[], week: number, opts: ScheduleOptions = DEFAULT_SCHEDULE_OPTIONS): WeekSchedule {
  const { site } = ctx;
  const load = expectedWorkload(ctx, week);
  const windows = shiftWindows(site);
  const roster = [...workers].sort((a, b) => (a.id < b.id ? -1 : 1));
  const avgProd = roster.length ? roster.reduce((a, w) => a + w.productivity, 0) / roster.length : 1;
  const windowOf = (id: string) => windows.find((w) => w.id === id) ?? windows[0];

  // Requirement: standard minutes ÷ an average person ÷ the utilization a floor
  // can really hold ÷ what absence takes off the roster.
  const factor = 1 / 60 / avgProd / Math.max(1e-6, opts.targetUtilization) / Math.max(1e-6, 1 - opts.absenteeism);
  const need: Array<Record<string, Record<Skill, number>>> = load.days.map((d) => {
    const split = splitByShift(site, d);
    const out: Record<string, Record<Skill, number>> = {};
    for (const w of windows) {
      out[w.id] = zeroBySkill();
      for (const skill of SKILLS) out[w.id][skill] = split[w.id][skill] * factor;
    }
    return out;
  });
  const shiftTotal = (i: number, shift: string) => SKILLS.reduce((a, k) => a + need[i][shift][k], 0);

  const openDays = [0, 1, 2, 3, 4, 5, 6].filter((i) => load.days[i].open < load.days[i].close);

  /**
   * Who works which day.
   *
   * Coverage comes before volume. Left to sort themselves by how busy a day
   * looks, everybody picks Friday and Saturday and the shop opens on Monday
   * with nobody behind the till — which is not a staffing plan, it is a
   * staffing failure. So the first pass puts one person on every shift of
   * every trading day, preferring whoever holds the skill that day needs most,
   * and only then does the second pass spend what hours are left on the days
   * that carry the volume.
   */
  const workDays = new Map<string, Set<number>>();
  const daysLeft = new Map<string, number>();
  for (const w of roster) {
    workDays.set(w.id, new Set());
    const paid = Math.max(1e-6, windowOf(w.homeShift).paidHours);
    daysLeft.set(w.id, Math.min(openDays.length, Math.floor(w.maxWeeklyHours / paid + 1e-9)));
  }
  const rosterOn = (w: Worker, i: number) => {
    workDays.get(w.id)!.add(i);
    daysLeft.set(w.id, (daysLeft.get(w.id) ?? 0) - 1);
  };
  const free = (w: Worker, i: number) => (daysLeft.get(w.id) ?? 0) > 0 && !workDays.get(w.id)!.has(i);

  const cover = (i: number, shiftId: string): boolean => {
    const wanted = SKILLS.filter((k) => need[i][shiftId][k] > GAP_EPSILON).sort((a, b) => need[i][shiftId][b] - need[i][shiftId][a] || SKILLS.indexOf(a) - SKILLS.indexOf(b));
    const pool = roster.filter((w) => w.homeShift === shiftId && free(w, i));
    if (pool.length === 0) return false;
    const rank = (w: Worker) => {
      const k = wanted.findIndex((s) => w.skills.includes(s));
      return k < 0 ? SKILLS.length : k;
    };
    pool.sort((a, b) => rank(a) - rank(b) || (daysLeft.get(b.id) ?? 0) - (daysLeft.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1));
    rosterOn(pool[0], i);
    return true;
  };

  // Every trading day gets somebody on its heaviest shift before any day gets
  // a second person. A four-person shop cannot man three shifts seven days a
  // week, and when it runs out of people the day it leaves bare should not be
  // a day it is open — the schedule's `gaps` are where that shortfall is
  // meant to show up, not in an empty Sunday.
  for (const i of openDays) {
    const byLoad = [...windows].sort((a, b) => shiftTotal(i, b.id) - shiftTotal(i, a.id) || windows.indexOf(a) - windows.indexOf(b));
    for (const shift of byLoad) {
      if (shiftTotal(i, shift.id) <= GAP_EPSILON) continue;
      if (cover(i, shift.id)) break;
    }
  }

  // Then the rest of the shifts, heaviest first.
  const slots: Array<{ i: number; id: string; load: number }> = [];
  for (const i of openDays) {
    for (const shift of windows) {
      if (shiftTotal(i, shift.id) <= GAP_EPSILON) continue;
      if (roster.some((w) => w.homeShift === shift.id && workDays.get(w.id)!.has(i))) continue;
      slots.push({ i, id: shift.id, load: shiftTotal(i, shift.id) });
    }
  }
  slots.sort((a, b) => b.load - a.load || a.i - b.i || (a.id < b.id ? -1 : 1));
  for (const s of slots) cover(s.i, s.id);

  for (const w of roster) {
    const rest = openDays.filter((i) => free(w, i)).sort((a, b) => shiftTotal(b, w.homeShift) - shiftTotal(a, w.homeShift) || a - b);
    for (const i of rest) {
      if ((daysLeft.get(w.id) ?? 0) <= 0) break;
      rosterOn(w, i);
    }
  }

  const assignments: DayAssignment[] = [];
  const required = zeroBySkill();
  const covered = zeroBySkill();
  const shortfall = zeroBySkill();
  const risks: WeekSchedule["risks"] = [];
  let spareHours = 0;

  for (let i = 0; i < 7; i++) {
    const day = week * 7 + i;
    const weekday = weekdayOf(day);
    for (const shift of windows) {
      const open: Record<Skill, number> = zeroBySkill();
      for (const skill of SKILLS) {
        open[skill] = need[i][shift.id][skill];
        required[skill] += open[skill];
      }
      const present = roster.filter((w) => w.homeShift === shift.id && workDays.get(w.id)?.has(i) === true);
      if (present.length === 0) {
        for (const skill of SKILLS) shortfall[skill] += open[skill];
        continue;
      }
      const effective = (w: Worker) => (shift.productiveHours * w.productivity) / avgProd;
      const byId = new Map(present.map((w) => [w.id, w]));
      const unassigned = new Set(present.map((w) => w.id));

      // One person present who holds a skill the day needs is a day the shop is
      // one phone call from not being able to do it at all.
      for (const skill of SKILLS) {
        if (open[skill] <= GAP_EPSILON) continue;
        const holders = present.filter((w) => w.skills.includes(skill));
        if (holders.length !== 1) continue;
        risks.push({
          skill,
          day,
          worker: holders[0].id,
          note: `${holders[0].id} is the only person on the ${shift.id} shift who can ${SKILL_WORK[skill]}, and it needs ${open[skill].toFixed(1)} h of ${skill} work.`,
        });
      }

      // Scarcest first: the skill with the fewest present holders per hour needed.
      const order = SKILLS.filter((k) => open[k] > GAP_EPSILON).sort((a, b) => {
        const ha = present.filter((w) => w.skills.includes(a)).length;
        const hb = present.filter((w) => w.skills.includes(b)).length;
        return ha / Math.max(1e-9, open[a]) - hb / Math.max(1e-9, open[b]) || SKILLS.indexOf(a) - SKILLS.indexOf(b);
      });
      const assignedTo = new Map<Skill, string[]>();
      const take = (w: Worker, skill: Skill) => {
        unassigned.delete(w.id);
        assignments.push({ day, weekday, shift: shift.id, worker: w.id, primary: skill, hours: shift.paidHours });
        const h = effective(w);
        open[skill] -= h;
        covered[skill] += h;
        const list = assignedTo.get(skill);
        if (list) list.push(w.id);
        else assignedTo.set(skill, [w.id]);
      };
      for (const skill of order) {
        while (open[skill] > GAP_EPSILON) {
          const candidates = [...unassigned]
            .sort()
            .map((id) => byId.get(id))
            .filter((w): w is Worker => w !== undefined && w.skills.includes(skill));
          if (candidates.length === 0) break;
          // The least flexible person goes first, so the people who can cover
          // anything are still free when the awkward skill comes up.
          candidates.sort((a, b) => a.skills.length - b.skills.length || b.productivity - a.productivity || (a.id < b.id ? -1 : 1));
          take(candidates[0], skill);
        }
      }
      // Everyone still free goes where the most is left among their own skills.
      for (const id of [...unassigned].sort()) {
        const w = byId.get(id);
        if (!w || w.skills.length === 0) continue;
        const skill = [...w.skills].sort((a, b) => open[b] - open[a] || SKILLS.indexOf(a) - SKILLS.indexOf(b))[0];
        take(w, skill);
      }

      // A primary is a whole person-day, so most skills end up over-covered by
      // less than a person. Those hours are not lost: they go back into a spare
      // pool their owner spends on the short skills they also hold, which is
      // what the floor really does.
      const spare = new Map<string, number>();
      for (const skill of SKILLS) {
        if (open[skill] >= 0) continue;
        let over = -open[skill];
        open[skill] = 0;
        covered[skill] -= over;
        for (const id of [...(assignedTo.get(skill) ?? [])].reverse()) {
          if (over <= 0) break;
          const w = byId.get(id);
          if (!w) continue;
          const s = Math.min(over, effective(w));
          spare.set(id, (spare.get(id) ?? 0) + s);
          over -= s;
        }
      }
      // Down to the last minute here, not to a quarter hour: a sliver nobody
      // picked up as a primary is still an hour somebody has to work, and
      // keeping it exact is what makes required − covered = gap hold.
      for (const skill of SKILLS) {
        if (open[skill] <= 0) continue;
        for (const id of [...spare.keys()].sort()) {
          if (open[skill] <= 0) break;
          const have = spare.get(id) ?? 0;
          const w = byId.get(id);
          if (have <= 0 || !w || !w.skills.includes(skill)) continue;
          const t = Math.min(have, open[skill]);
          spare.set(id, have - t);
          open[skill] -= t;
          covered[skill] += t;
        }
        if (open[skill] > 0) shortfall[skill] += open[skill];
      }
      for (const left of spare.values()) spareHours += left;
    }
  }

  // Anything under a quarter hour across the whole week is rounding, not a gap.
  const gaps: SkillGap[] = SKILLS.filter((k) => shortfall[k] > GAP_EPSILON).map((skill) => ({
    skill,
    requiredHours: required[skill],
    coveredHours: covered[skill],
    gapHours: shortfall[skill],
  }));
  return { week, calendarWeek: load.calendarWeek, assignments, required, covered, gaps, spareHours, risks };
}

// ---------------------------------------------------------------------------
// The season plan
// ---------------------------------------------------------------------------

export interface SeasonPlanRow {
  week: number;
  calendarWeek: number;
  requiredHours: number;
  /** Paid hours the standing roster is scheduled for. */
  rosterHours: number;
  overtimeHours: number;
  tempHours: number;
  /** What neither overtime nor a temp can close. */
  gapHours: number;
  laborCost: number;
  notes: string[];
}

function who(workers: Worker[]): string {
  return workers.map((w) => w.id).join(", ");
}

/**
 * Plan a run of weeks. Each week's gap is closed in the order a store really
 * closes it: overtime for the people who already hold the skill, then agency
 * temps, then nothing — because a temp cannot work behind the glass or take the
 * van out, and the only answers to those two are cross-training someone who is
 * already on the payroll or hiring, both with a lead time the plan names.
 */
export function planSeason(
  ctx: WorkloadContext,
  workers: Worker[],
  costs: CostRates,
  fromWeek: number,
  weeks: number,
  opts: ScheduleOptions = DEFAULT_SCHEDULE_OPTIONS
): SeasonPlanRow[] {
  const roster = [...workers].sort((a, b) => (a.id < b.id ? -1 : 1));
  const rates = new Map(roster.map((w) => [w.id, w.hourlyRate]));
  const rows: SeasonPlanRow[] = [];
  for (let k = 0; k < weeks; k++) {
    const week = fromWeek + k;
    const sched = buildWeekSchedule(ctx, roster, week, opts);
    const requiredHours = SKILLS.reduce((a, s) => a + sched.required[s], 0);
    let rosterHours = 0;
    let regular = 0;
    for (const a of sched.assignments) {
      rosterHours += a.hours;
      regular += a.hours * (rates.get(a.worker) ?? 0);
    }

    const budget = new Map(roster.filter((w) => w.type !== "temp").map((w) => [w.id, MAX_OVERTIME_PER_WORKER]));
    let overtimeHours = 0;
    let overtimeCost = 0;
    let tempHours = 0;
    let gapHours = 0;
    const notes: string[] = [];
    for (const gap of sched.gaps) {
      let left = gap.gapHours;
      // Cheapest overtime first, and in worker-id order when rates tie.
      const holders = roster.filter((w) => w.type !== "temp" && w.skills.includes(gap.skill)).sort((a, b) => a.hourlyRate - b.hourlyRate || (a.id < b.id ? -1 : 1));
      for (const w of holders) {
        if (left <= 0) break;
        const avail = budget.get(w.id) ?? 0;
        if (avail <= 0) continue;
        const hours = Math.min(avail, left / Math.max(1e-6, w.productivity));
        budget.set(w.id, avail - hours);
        overtimeHours += hours;
        overtimeCost += hours * w.hourlyRate * costs.overtimeMultiplier;
        left -= hours * w.productivity;
      }
      if (left <= GAP_EPSILON) continue;
      if (TEMP_BLOCKED.includes(gap.skill)) {
        gapHours += left;
        const trainable = roster.filter((w) => w.type !== "temp" && !w.skills.includes(gap.skill));
        const gate = gap.skill === "counter" ? "a food handler's card" : "a licence and the store's insurance";
        const fix =
          trainable.length > 0
            ? `cross-train ${Math.min(trainable.length, Math.ceil(left / 32))} of ${who(trainable)} ($${costs.crossTrainCost} each, ${costs.crossTrainWeeks} weeks) or hire ($${costs.hireCost}, ${costs.hireWeeks} weeks)`
            : `hire ($${costs.hireCost}, ${costs.hireWeeks} weeks): everyone on the roster already holds it`;
        notes.push(`${Math.round(left)} h of ${gap.skill} work is short after overtime. A temp cannot cover it — that needs ${gate} — so ${fix}.`);
      } else {
        tempHours += left / Math.max(1e-6, costs.tempProductivity);
      }
    }
    if (tempHours > 0) {
      notes.push(`Book ${Math.ceil(tempHours / 30 - 1e-9)} agency temp(s), ${Math.round(tempHours)} h, at ${Math.round(costs.tempProductivity * 100)}% of standard.`);
    }
    if (overtimeHours > roster.length * 4 && roster.length > 0) {
      notes.push(`Overtime is over 4 h a person this week; at ${costs.overtimeMultiplier}× pay a hire ($${costs.hireCost}, ${costs.hireWeeks} weeks) pays back if the volume holds.`);
    }
    if (notes.length === 0) notes.push("The roster covers the week at the target utilization without overtime or temps.");

    rows.push({
      week,
      calendarWeek: sched.calendarWeek,
      requiredHours,
      rosterHours,
      overtimeHours,
      tempHours,
      gapHours,
      laborCost: regular + overtimeCost + tempHours * costs.tempHourly,
      notes,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Single points of failure
// ---------------------------------------------------------------------------

export interface SinglePoint {
  skill: Skill;
  /** Everyone on the standing roster who holds it; empty when nobody does. */
  workers: string[];
  note: string;
}

/**
 * Skills one person, or nobody, holds. Temps are not counted: they leave at the
 * end of the season, so a temp never makes a skill safe. In a shop of a dozen
 * people this usually finds the counter and the van, which is the point — both
 * are gated behind a card or a licence, so the day the one person who holds one
 * calls in sick is a day the shop cannot do that work at all.
 */
export function singlePointsOfFailure(workers: Worker[]): SinglePoint[] {
  const standing = workers.filter((w) => w.type !== "temp");
  const out: SinglePoint[] = [];
  for (const skill of SKILLS) {
    const holders = standing.filter((w) => w.skills.includes(skill)).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (holders.length > 1) continue;
    const note =
      holders.length === 0
        ? `Nobody on the roster can ${SKILL_WORK[skill]}. Any work needing ${skill} is uncovered every day of the week.`
        : `Only ${holders[0].id} (${holders[0].role}) can ${SKILL_WORK[skill]}. A day off, and the shop cannot${skill === "counter" || skill === "drive" ? " — a temp is not an answer, the skill is gated" : ""}.`;
    out.push({ skill, workers: holders.map((w) => w.id), note });
  }
  return out;
}
