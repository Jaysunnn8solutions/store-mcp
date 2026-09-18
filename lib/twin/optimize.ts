/**
 * A genetic search over the levers a shop manager actually has: who is on the
 * floor and on which shift, who is cross-trained, how hard the schedule is
 * pushed, how many registers and showcase stations are open, the carts, jacks
 * and vans, the planogram and how deep its facings are, the buyer's service
 * level and forecast, when the pre-open pick starts and the van leaves, and
 * whether the heaviest days open earlier or close later.
 *
 * Every candidate is an ordinary `TwinScenario`, so the winning plan is
 * something `buildTwin` already accepts: it can be pasted into any tool or
 * replayed on the 3D page unchanged. Its fitness is one weekly dollar figure
 * with everything on the same axis — wages and overtime, the amortized cost of
 * a hire, a training course, a lane or a van, the carrying cost of the stock
 * held, **minus** the gross margin the week earns and **plus** the margin it
 * throws away: the sale nobody could make because the facing was empty, and
 * the customer who gave up on the queue and walked out. In a distribution
 * center a late truck is a penalty you argue about; in a shop a lost sale is a
 * priced, countable loss of margin, which is why the objective presets here
 * change only how dearly a walked-out customer is valued.
 *
 * Determinism is the point. The algorithm's own draws come from one seeded
 * generator, and every candidate is scored on engine seeds 1..n, so the same
 * store, week, base scenario and seed always give the same plan and the winner
 * replays exactly as run 1 on the 3D page. Nothing here reads the clock.
 */

import { findSite, loadRoster } from "../data/store";
import { randInt, seededRandom, type Rng } from "../util/random";
import { DAY_OF_WEEK } from "./demand";
import { DEFAULT_POLICY } from "./inventory";
import type { OperationsResult } from "./operations";
import { runOperations } from "./operations";
import { kpis, KPI_KEYS, type Kpis } from "./replicate";
import { ROLES } from "./roles";
import { clock, DEFAULT_COSTS, DEFAULT_STANDARDS, hhmm } from "./standards";
import { buildTwin, operationsOptions, type TwinContext, type TwinScenario } from "./twin";
import type { Site } from "./types";
import { DEFAULT_SCHEDULE_OPTIONS } from "./workforce";

// ---------------------------------------------------------------------------
// The shop the search is about
// ---------------------------------------------------------------------------

/**
 * Everything the genome needs to know about a shop before any scenario is
 * applied: which shifts to hire onto, which roles are actually on the payroll
 * (cross-training a role nobody holds is refused by the twin), and which
 * weekdays are worth extending.
 *
 * Derived once per search so the mapping from a gene to a scenario field is a
 * pure function of it.
 */
export interface Shop {
  site: Site;
  /** Distinct role names on this shop's roster, sorted, so the order never depends on file order. */
  roles: string[];
  /** Shift ids by position in the day: the opener, the one over the busiest hours, and the closer. */
  shifts: { early: string; peak: string; late: string };
  /** The trading days worth opening earlier or closing later, heaviest first. */
  heavyDays: number[];
}

/** How many of the week's days the `hours` levers extend. */
const HEAVY_DAYS = 3;

/** Read a shop out of the committed data. Pure: no scenario is applied. */
export function shopOf(store: string): Shop {
  const site = findSite(store);
  const roles = [...new Set(loadRoster().workers.filter((w) => w.store === site.id).map((w) => w.role))].sort();
  // Sorted by start time, id breaking ties, because the shift a hire lands on
  // must not depend on the order the JSON happens to list them in.
  const byStart = [...site.shifts].sort((a, b) => hhmm(a.start) - hhmm(b.start) || (a.id < b.id ? -1 : 1));
  const shifts = {
    early: byStart[0].id,
    peak: byStart[Math.min(1, byStart.length - 1)].id,
    late: byStart[byStart.length - 1].id,
  };
  const heavyDays = [...site.operatingDays]
    .sort((a, b) => DAY_OF_WEEK[b - 1] - DAY_OF_WEEK[a - 1] || a - b)
    .slice(0, HEAVY_DAYS);
  return { site, roles, shifts, heavyDays };
}

// ---------------------------------------------------------------------------
// Levers
// ---------------------------------------------------------------------------

export type LeverKey =
  | "confectioners"
  | "cashiersPeak"
  | "cashiersLate"
  | "stockers"
  | "drivers"
  | "trainCashiersCounter"
  | "trainStockersRegister"
  | "trainConfectionersPick"
  | "flex"
  | "overtimeMax"
  | "targetUtilization"
  | "registers"
  | "counters"
  | "stockCarts"
  | "palletJacks"
  | "vans"
  | "merchandising"
  | "facingDays"
  | "serviceLevel"
  | "forecast"
  | "pickStart"
  | "vanDeparture"
  | "openEarlier"
  | "closeLater";

/** How the levers group in a report or a form. */
export type LeverArea = "Labor" | "Service" | "Sales floor" | "Backroom" | "Supply" | "Hours";

export type GeneValue = number | string | boolean;

/**
 * Which family a lever belongs to, and therefore which flag on `Levers` turns
 * it on. Several levers share a family: `overtime` carries the whole labor
 * policy (flexing, the overtime cap and the utilization the schedule is built
 * to), and `stockCarts` carries the floor's handling equipment.
 */
export type LeverGroup = keyof Levers;

/**
 * One lever, declared rather than coded: its range, how a value reads, and
 * which scenario field it writes.
 *
 * `kind` is the invariant the gene helpers below lean on — an `"int"` lever
 * always has `min` and `max`, a `"choice"` lever always has `choices`, and a
 * `"bool"` lever has neither. The table is the only place that can break it,
 * which is why those helpers assert rather than branch.
 */
export interface LeverDef {
  key: LeverKey;
  label: string;
  area: LeverArea;
  group: LeverGroup;
  /** The scenario field the lever writes, for a report that explains the plan. */
  field: string;
  kind: "int" | "choice" | "bool";
  min?: number;
  max?: number;
  choices?: readonly GeneValue[];
  /** A value as the plan describes it. */
  describe: (v: GeneValue) => string;
}

/** Minutes after midnight. The pre-open pick can start with the openers or an hour before them. */
const PICK_STARTS = [300, 330, 360, 390, 420] as const;
/** The van can leave any time up to the doors opening; later means a fuller, later-picked load. */
const VAN_DEPARTURES = [480, 510, 540, 570, 600] as const;
const SERVICE_LEVELS = [0.9, 0.95, 0.97, 0.985, 0.995] as const;
const FACING_DAYS = [2, 3, 4, 5, 7, 10] as const;
const TARGET_UTILIZATIONS = [0.75, 0.8, 0.85, 0.9, 0.95] as const;

const plural = (v: GeneValue, one: string, many = `${one}s`) => `${v} ${Number(v) === 1 ? one : many}`;

/**
 * The lever table. Order matters: it is the order genes are written, described
 * and seeded in, so changing it changes which plans a given seed explores.
 */
export const LEVERS: readonly LeverDef[] = [
  { key: "confectioners", label: "Counter confectioners added", area: "Labor", group: "addWorkers", field: "addWorkers", kind: "int", min: 0, max: 3, describe: (v) => `+${plural(v, "counter confectioner")} on the busy shift` },
  { key: "cashiersPeak", label: "Cashiers added, busy shift", area: "Labor", group: "addWorkers", field: "addWorkers", kind: "int", min: 0, max: 3, describe: (v) => `+${plural(v, "cashier")} on the busy shift` },
  { key: "cashiersLate", label: "Cashiers added, closing shift", area: "Labor", group: "addWorkers", field: "addWorkers", kind: "int", min: 0, max: 3, describe: (v) => `+${plural(v, "cashier")} on the closing shift` },
  { key: "stockers", label: "Stockers added", area: "Labor", group: "addWorkers", field: "addWorkers", kind: "int", min: 0, max: 2, describe: (v) => `+${plural(v, "stocker")} on the opening shift` },
  { key: "drivers", label: "Delivery drivers added", area: "Labor", group: "addWorkers", field: "addWorkers", kind: "int", min: 0, max: 1, describe: (v) => `+${plural(v, "delivery driver")} on the opening shift` },
  { key: "trainCashiersCounter", label: "Cross-train cashiers on the showcase", area: "Labor", group: "crossTrain", field: "crossTrain", kind: "bool", describe: (v) => (v ? "cross-train cashiers on the showcase" : "no showcase training for cashiers") },
  { key: "trainStockersRegister", label: "Cross-train stockers on the register", area: "Labor", group: "crossTrain", field: "crossTrain", kind: "bool", describe: (v) => (v ? "cross-train stockers on the register" : "no register training for stockers") },
  { key: "trainConfectionersPick", label: "Cross-train confectioners on picking", area: "Labor", group: "crossTrain", field: "crossTrain", kind: "bool", describe: (v) => (v ? "cross-train confectioners on picking" : "no picking training for confectioners") },
  { key: "flex", label: "Flex across skills", area: "Labor", group: "overtime", field: "flex", kind: "bool", describe: (v) => (v ? "flexing on" : "flexing off") },
  { key: "overtimeMax", label: "Overtime cap, h/day", area: "Labor", group: "overtime", field: "overtimeMaxHours", kind: "int", min: 0, max: 4, describe: (v) => `overtime cap ${v} h/day` },
  { key: "targetUtilization", label: "Scheduled utilization", area: "Labor", group: "overtime", field: "targetUtilization", kind: "choice", choices: TARGET_UTILIZATIONS, describe: (v) => `schedule to ${Math.round(Number(v) * 100)}% utilization` },
  { key: "registers", label: "Registers", area: "Service", group: "registers", field: "registers", kind: "int", min: 1, max: 6, describe: (v) => plural(v, "register") },
  { key: "counters", label: "Showcase stations", area: "Service", group: "counters", field: "counters", kind: "int", min: 0, max: 5, describe: (v) => plural(v, "showcase station") },
  { key: "stockCarts", label: "Stock carts", area: "Backroom", group: "stockCarts", field: "stockCarts", kind: "int", min: 1, max: 8, describe: (v) => plural(v, "stock cart") },
  { key: "palletJacks", label: "Pallet jacks", area: "Backroom", group: "stockCarts", field: "palletJacks", kind: "int", min: 0, max: 3, describe: (v) => plural(v, "pallet jack") },
  { key: "vans", label: "Delivery vans", area: "Backroom", group: "vans", field: "vans", kind: "int", min: 0, max: 3, describe: (v) => plural(v, "van") },
  { key: "merchandising", label: "Merchandising", area: "Sales floor", group: "merchandising", field: "merchandising", kind: "choice", choices: ["current", "optimized"], describe: (v) => `${v} merchandising` },
  { key: "facingDays", label: "Days of supply per facing", area: "Sales floor", group: "facingDays", field: "facingDays", kind: "choice", choices: FACING_DAYS, describe: (v) => `facings sized for ${plural(v, "day")} of supply` },
  { key: "serviceLevel", label: "Cycle service level", area: "Supply", group: "serviceLevel", field: "serviceLevel", kind: "choice", choices: SERVICE_LEVELS, describe: (v) => `service level ${(Number(v) * 100).toFixed(1)}%` },
  { key: "forecast", label: "Forecast", area: "Supply", group: "forecast", field: "forecast", kind: "choice", choices: ["seasonal", "trailing"], describe: (v) => `${v} forecast` },
  { key: "pickStart", label: "Pre-open pick starts", area: "Hours", group: "times", field: "times.pickStart", kind: "choice", choices: PICK_STARTS, describe: (v) => `pick starts at ${clock(Number(v))}` },
  { key: "vanDeparture", label: "Van departure", area: "Hours", group: "times", field: "times.vanDeparture", kind: "choice", choices: VAN_DEPARTURES, describe: (v) => `van leaves at ${clock(Number(v))}` },
  { key: "openEarlier", label: "Open earlier on the heaviest days", area: "Hours", group: "hours", field: "hours", kind: "int", min: 0, max: 2, describe: (v) => (Number(v) === 0 ? "open at the usual time" : `open ${plural(v, "hour")} earlier on the heaviest days`) },
  { key: "closeLater", label: "Close later on the heaviest days", area: "Hours", group: "hours", field: "hours", kind: "int", min: 0, max: 2, describe: (v) => (Number(v) === 0 ? "close at the usual time" : `close ${plural(v, "hour")} later on the heaviest days`) },
];

export const LEVER_KEYS = LEVERS.map((l) => l.key);
const LEVER_BY_KEY = new Map(LEVERS.map((l) => [l.key, l]));

/**
 * Which families of levers the search may move. A family is active only when
 * its flag is `true`; leaving the whole `levers` option out uses
 * `DEFAULT_LEVERS`, which is every family.
 */
export interface Levers {
  /** Hire counter confectioners, cashiers, stockers or a driver, by shift. */
  addWorkers?: boolean;
  /** Teach cashiers the showcase, stockers the register, confectioners the pick. */
  crossTrain?: boolean;
  registers?: boolean;
  counters?: boolean;
  merchandising?: boolean;
  facingDays?: boolean;
  serviceLevel?: boolean;
  forecast?: boolean;
  vans?: boolean;
  /** The floor's handling equipment: stock carts and pallet jacks. */
  stockCarts?: boolean;
  /** The labor policy: flexing, the overtime cap, and the utilization the schedule targets. */
  overtime?: boolean;
  /** Open earlier or close later on the heaviest trading days. */
  hours?: boolean;
  /** When the pre-open pick starts and when the van leaves. */
  times?: boolean;
}

/** Everything on. A shop has no equivalent of the reference's "that is a building change" exclusion: a lane can be opened and a van hired inside a season. */
export const DEFAULT_LEVERS: Levers = {
  addWorkers: true,
  crossTrain: true,
  registers: true,
  counters: true,
  merchandising: true,
  facingDays: true,
  serviceLevel: true,
  forecast: true,
  vans: true,
  stockCarts: true,
  overtime: true,
  hours: true,
  times: true,
};

/** Which role a cross-training lever teaches, and what it teaches them. */
interface TrainingTarget {
  role: string;
  skill: "counter" | "register" | "pick";
}

/**
 * Keyed by lever, and deliberately a plain object literal rather than a Map:
 * `Object.keys` on it walks the keys in the order written here, on every
 * engine, which is one less place for the search to become order-dependent.
 */
const TRAINING = {
  trainCashiersCounter: { role: ROLES.cashier.role, skill: "counter" },
  trainStockersRegister: { role: ROLES.stocker.role, skill: "register" },
  trainConfectionersPick: { role: ROLES.confectioner.role, skill: "pick" },
} as const satisfies Record<string, TrainingTarget>;

type TrainingKey = keyof typeof TRAINING;
const TRAINING_KEYS = Object.keys(TRAINING) as TrainingKey[];
const trainingFor = (key: LeverKey): TrainingTarget | undefined => (TRAINING as Partial<Record<LeverKey, TrainingTarget>>)[key];

/**
 * The levers that are real at this shop. A lever whose family is off is
 * dropped, and so is one the building or the payroll makes meaningless: a shop
 * with no glass has no showcase stations to open, and cross-training a role
 * nobody holds is a scenario the twin refuses outright.
 */
export function leverKeysFor(shop: Shop, levers: Levers = DEFAULT_LEVERS): LeverKey[] {
  return LEVERS.filter((l) => {
    if (levers[l.group] !== true) return false;
    if (l.key === "counters" && !shop.site.showcase) return false;
    const t = trainingFor(l.key);
    if (t && !shop.roles.includes(t.role)) return false;
    return true;
  }).map((l) => l.key);
}

export type Genome = Record<LeverKey, GeneValue>;

/** The value in `choices` nearest `v`; ties go to the earlier choice. */
function nearest(choices: readonly number[], v: number): number {
  return choices.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

/** The shop as it is: every lever at the value the site and the base scenario give it. */
export function baseGenome(shop: Shop, base: TwinScenario): Genome {
  const { site } = shop;
  return {
    confectioners: 0,
    cashiersPeak: 0,
    cashiersLate: 0,
    stockers: 0,
    drivers: 0,
    trainCashiersCounter: false,
    trainStockersRegister: false,
    trainConfectionersPick: false,
    flex: base.flex ?? true,
    overtimeMax: Math.round(base.overtimeMaxHours ?? 2),
    targetUtilization: nearest(TARGET_UTILIZATIONS, base.targetUtilization ?? DEFAULT_SCHEDULE_OPTIONS.targetUtilization),
    registers: base.registers ?? site.checkout.registers,
    counters: base.counters ?? site.showcase?.stations ?? 0,
    stockCarts: base.stockCarts ?? site.equipment.stockCarts,
    palletJacks: base.palletJacks ?? site.equipment.palletJacks,
    vans: base.vans ?? site.equipment.vans,
    merchandising: base.merchandising ?? "current",
    facingDays: nearest(FACING_DAYS, base.facingDays ?? DEFAULT_STANDARDS.facingDaysOfSupply),
    serviceLevel: nearest(SERVICE_LEVELS, base.serviceLevel ?? DEFAULT_POLICY.serviceLevel),
    forecast: base.forecast ?? DEFAULT_POLICY.forecast,
    pickStart: nearest(PICK_STARTS, hhmm(base.times?.pickStart ?? site.times.pickStart)),
    vanDeparture: nearest(VAN_DEPARTURES, hhmm(base.times?.vanDeparture ?? site.times.vanDeparture)),
    openEarlier: 0,
    closeLater: 0,
  };
}

/**
 * The candidate as a scenario: the base scenario with the genes that differ
 * from the base genome written on top. A gene at its base value writes
 * nothing, so a base-valued genome reproduces the base scenario exactly and
 * the twin's own change list names only what the plan changes.
 *
 * Note the asymmetry the snapping in `baseGenome` creates: a base scenario
 * that picks a service level or a van time off the lever's ladder keeps its
 * own value in every candidate that leaves that lever alone, even though the
 * genome rounded it. That is deliberate — the search should not quietly move
 * something the caller set on purpose.
 */
export function genomeToScenario(genome: Genome, base: TwinScenario, baseG: Genome, shop: Shop): TwinScenario {
  const s: TwinScenario = structuredClone(base);
  const { site, shifts } = shop;

  const adds: NonNullable<TwinScenario["addWorkers"]> = [...(s.addWorkers ?? [])];
  const hire = (role: keyof typeof ROLES, shift: string, type: "full-time" | "part-time", count: GeneValue) => {
    if (Number(count) > 0) adds.push({ role, shift, type, count: Number(count) });
  };
  hire("confectioner", shifts.peak, "full-time", genome.confectioners);
  hire("cashier", shifts.peak, "part-time", genome.cashiersPeak);
  hire("cashier", shifts.late, "part-time", genome.cashiersLate);
  hire("stocker", shifts.early, "full-time", genome.stockers);
  hire("driver", shifts.early, "full-time", genome.drivers);
  if (adds.length) s.addWorkers = adds;

  const trains: NonNullable<TwinScenario["crossTrain"]> = [...(s.crossTrain ?? [])];
  for (const key of TRAINING_KEYS) {
    const t = TRAINING[key];
    if (!genome[key]) continue;
    if (trains.some((x) => x.role === t.role && x.skill === t.skill)) continue;
    trains.push({ role: t.role, skill: t.skill });
  }
  if (trains.length) s.crossTrain = trains;

  if (genome.flex !== baseG.flex) s.flex = Boolean(genome.flex);
  if (genome.overtimeMax !== baseG.overtimeMax) s.overtimeMaxHours = Number(genome.overtimeMax);
  if (genome.targetUtilization !== baseG.targetUtilization) s.targetUtilization = Number(genome.targetUtilization);
  if (genome.registers !== baseG.registers) s.registers = Number(genome.registers);
  if (genome.counters !== baseG.counters) s.counters = Number(genome.counters);
  if (genome.stockCarts !== baseG.stockCarts) s.stockCarts = Number(genome.stockCarts);
  if (genome.palletJacks !== baseG.palletJacks) s.palletJacks = Number(genome.palletJacks);
  if (genome.vans !== baseG.vans) s.vans = Number(genome.vans);
  if (genome.merchandising !== baseG.merchandising) s.merchandising = genome.merchandising as "current" | "optimized";
  if (genome.facingDays !== baseG.facingDays) s.facingDays = Number(genome.facingDays);
  if (genome.serviceLevel !== baseG.serviceLevel) s.serviceLevel = Number(genome.serviceLevel);
  if (genome.forecast !== baseG.forecast) s.forecast = genome.forecast as "seasonal" | "trailing";
  if (genome.pickStart !== baseG.pickStart) s.times = { ...(s.times ?? {}), pickStart: clock(Number(genome.pickStart)) };
  if (genome.vanDeparture !== baseG.vanDeparture) s.times = { ...(s.times ?? {}), vanDeparture: clock(Number(genome.vanDeparture)) };

  const earlier = Number(genome.openEarlier);
  const later = Number(genome.closeLater);
  if (earlier > 0 || later > 0) {
    const hours: NonNullable<TwinScenario["hours"]> = [...(s.hours ?? [])];
    for (const day of shop.heavyDays) {
      const cur = hours.find((h) => h.day === day) ?? site.hours.find((h) => h.day === day);
      if (!cur) continue;
      const next = { day, open: clock(hhmm(cur.open) - earlier * 60), close: clock(hhmm(cur.close) + later * 60) };
      const i = hours.findIndex((h) => h.day === day);
      if (i < 0) hours.push(next);
      else hours[i] = next;
    }
    hours.sort((a, b) => a.day - b.day);
    s.hours = hours;
  }
  return s;
}

/**
 * What the plan changes against the shop as it is, one line per lever. A hire
 * or a training course reads as the thing it adds; everything else is a value
 * that moved, so it prints what it moved from.
 */
export function describeChanges(genome: Genome, baseG: Genome): string[] {
  const out: string[] = [];
  for (const l of LEVERS) {
    if (genome[l.key] === baseG[l.key]) continue;
    if (l.kind === "bool" || l.field === "addWorkers") out.push(l.describe(genome[l.key]));
    else out.push(`${l.describe(genome[l.key])} (was ${l.describe(baseG[l.key])})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a week costs
// ---------------------------------------------------------------------------

/**
 * Every price the objective uses. They are inputs, not constants: the result
 * carries the set it was scored with, so a plan can always be argued with.
 */
export interface Assumptions {
  /** Share of a retail dollar that is gross margin. Both the margin earned and every lost sale are priced with it. */
  grossMargin: number;
  /**
   * What a customer who walked out of a queue costs, as a multiple of the
   * margin on the basket they abandoned. Above 1 because they may not come
   * back, and this is the single number the three presets disagree about.
   */
  walkoutMultiplier: number;
  /** Annual carrying cost of stock as a share of its cost value: capital, space, shrink and the candy that goes stale. */
  stockCarryingAnnual: number;
  /** A special order that misses its promised time. */
  lateOrderCost: number;
  /** Per minute late, on top of the flat cost. */
  lateOrderMinuteCost: number;
  /** A special order still unpicked at the end of the run: the customer arrives and it is not there. */
  missedOrderCost: number;
  /** A full-time hire's one-off cost spread over a year; a part-timer counts half. */
  hireWeekly: number;
  /** One person's cross-training spread over the half-year it pays back across. */
  crossTrainWeekly: number;
  /** Weekly cost of a register lane beyond (or saved below) the shop's own count. */
  registerWeekly: number;
  /** Weekly cost of a showcase serving station beyond the shop's own. */
  counterWeekly: number;
  /** Weekly cost of a delivery van beyond the shop's own: standing charges plus running. */
  vanWeekly: number;
  stockCartWeekly: number;
  palletJackWeekly: number;
}

export type Objective = "service" | "balanced" | "cost";

/** The prices every preset shares. */
const SHARED_ASSUMPTIONS = {
  grossMargin: Math.round((1 - DEFAULT_COSTS.costOfGoods) * 100) / 100,
  stockCarryingAnnual: 0.25,
  hireWeekly: Math.round(DEFAULT_COSTS.hireCost / 52),
  crossTrainWeekly: Math.round(DEFAULT_COSTS.crossTrainCost / 26),
  registerWeekly: DEFAULT_COSTS.registerWeekly,
  counterWeekly: DEFAULT_COSTS.counterWeekly,
  vanWeekly: DEFAULT_COSTS.vanWeekly,
  stockCartWeekly: 12,
  palletJackWeekly: 25,
} as const;

/**
 * The three presets differ only in what a failed customer is worth against an
 * hour of wages. "Service first" says a walked-out shopper costs four times
 * the basket they dropped, because a sweet shop lives on the people who come
 * back; "cost first" says they cost exactly that basket and no more.
 */
export const DEFAULT_ASSUMPTIONS: Record<Objective, Assumptions> = {
  service: { ...SHARED_ASSUMPTIONS, walkoutMultiplier: 4, lateOrderCost: 250, lateOrderMinuteCost: 1.5, missedOrderCost: 700 },
  balanced: { ...SHARED_ASSUMPTIONS, walkoutMultiplier: 2, lateOrderCost: 100, lateOrderMinuteCost: 0.6, missedOrderCost: 300 },
  cost: { ...SHARED_ASSUMPTIONS, walkoutMultiplier: 1, lateOrderCost: 40, lateOrderMinuteCost: 0.2, missedOrderCost: 120 },
};

/**
 * How late a delivery can get before being late stops mattering. Past a
 * working day the customer has written it off, and the order is priced as a
 * miss rather than as a growing number of minutes.
 */
const MAX_LATE_MIN = 480;

/** A preset with the caller's overrides on top. */
export function assumptionsFor(objective: Objective, overrides: Partial<Assumptions> = {}): Assumptions {
  return { ...DEFAULT_ASSUMPTIONS[objective], ...overrides };
}

/**
 * One week of trading in dollars. Everything above `total` is a cost; `margin`
 * is what the week earns, and `net = total - margin` is the number the search
 * minimises. A plan that sells more can be worth more wages, which is the
 * whole reason the margin is in here rather than a service KPI on the side.
 */
export interface CostBreakdown {
  /** Wages at plain time. */
  labor: number;
  /** Wages at the overtime multiplier. */
  overtime: number;
  /** New hires, amortized. */
  hiring: number;
  /** Cross-training, amortized. */
  training: number;
  /** Registers, showcase stations, vans, carts and jacks beyond the shop's own; negative when the plan gives some back. */
  equipment: number;
  /** Carrying cost of the average stock held. */
  stock: number;
  /** Margin on sales nobody could make because the facing was empty. */
  lostShelf: number;
  /** Margin on the customers who gave up on a queue, at the walkout multiple. */
  lostQueue: number;
  /** Late, missed and cut special orders. */
  lateOrders: number;
  /** Everything above: what the week costs. */
  total: number;
  /** Gross margin the week earns. */
  margin: number;
  /** `total - margin`: the score. */
  net: number;
}

/**
 * The three figures the cost model needs that `Kpis` does not carry. They are
 * averaged over the evaluation seeds alongside it, so a caller pricing a
 * single run can build one with `costExtras`.
 */
export interface CostExtras {
  /** Overtime dollars, so plain time and overtime can be shown apart. */
  overtimeCost: number;
  /** Mean retail value of the stock held over the run. */
  stockRetail: number;
  /** Special orders placed but never picked by the end of the run. */
  ordersUnfilled: number;
}

/** Pull the cost model's extra inputs out of one run. */
export function costExtras(r: OperationsResult): CostExtras {
  return {
    overtimeCost: r.labor.overtimeCost,
    stockRetail: (r.stock.retailStart + r.stock.retailEnd) / 2,
    ordersUnfilled: Math.max(0, r.orders.placed - r.orders.picked),
  };
}

/**
 * The objective function. Costs that scale with the horizon are put on a
 * weekly footing; the stock carrying charge is already an annual rate, so it
 * is divided by 52 and left alone.
 */
export function costOf(k: Kpis, extras: CostExtras, genome: Genome, baseG: Genome, ctx: TwinContext, days: number, a: Assumptions): CostBreakdown {
  const perWeek = 7 / days;
  const overtime = extras.overtimeCost * perWeek;
  const labor = k.laborCost * perWeek - overtime;

  const fullTime = Number(genome.confectioners) + Number(genome.stockers) + Number(genome.drivers);
  const partTime = Number(genome.cashiersPeak) + Number(genome.cashiersLate);
  // Training is charged on everyone who holds the role after the hires land:
  // teaching the cashiers the showcase means teaching the new ones too.
  let trained = 0;
  for (const key of TRAINING_KEYS) {
    if (genome[key]) trained += ctx.workers.filter((w) => w.role === TRAINING[key].role).length;
  }
  const hiring = (fullTime + 0.5 * partTime) * a.hireWeekly;
  const training = trained * a.crossTrainWeekly;

  const equipment =
    (Number(genome.registers) - Number(baseG.registers)) * a.registerWeekly +
    (Number(genome.counters) - Number(baseG.counters)) * a.counterWeekly +
    (Number(genome.vans) - Number(baseG.vans)) * a.vanWeekly +
    (Number(genome.stockCarts) - Number(baseG.stockCarts)) * a.stockCartWeekly +
    (Number(genome.palletJacks) - Number(baseG.palletJacks)) * a.palletJackWeekly;

  const stock = (extras.stockRetail * ctx.costs.costOfGoods * a.stockCarryingAnnual) / 52;
  const lostShelf = k.lostShelfDollars * a.grossMargin * perWeek;
  const lostQueue = k.lostQueueDollars * a.grossMargin * a.walkoutMultiplier * perWeek;
  // An order is either late or missed, never both. An order that was never
  // picked accrues lateness all the way to the horizon, so charging it flat,
  // by the minute *and* as a miss counted it three times and let the lateness
  // term swamp everything else — at Avalon in Halloween week it was 78% of the
  // whole cost, and the search went off optimising the van timetable instead
  // of the shop. Past a working day late the customer has given up anyway, so
  // the per-minute term is capped there.
  const missed = Math.max(0, Math.min(k.ordersPlaced, extras.ordersUnfilled));
  const lateDelivered = Math.max(0, k.ordersLate - missed);
  const lateMinutes = Math.min(k.orderLateMinTotal, lateDelivered * MAX_LATE_MIN);
  const lateOrders =
    (lateDelivered * a.lateOrderCost + lateMinutes * a.lateOrderMinuteCost + missed * a.missedOrderCost + k.orderCutDollars * a.grossMargin) * perWeek;
  const margin = k.salesDollars * a.grossMargin * perWeek;

  const total = labor + overtime + hiring + training + equipment + stock + lostShelf + lostQueue + lateOrders;
  return { labor, overtime, hiring, training, equipment, stock, lostShelf, lostQueue, lateOrders, total, margin, net: total - margin };
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/** A plan the twin ran, priced. */
export interface Candidate {
  /** The scenario to run: the base with this plan on top. Paste it into any tool. */
  scenario: TwinScenario;
  /** Means over engine seeds 1..n; the same seeds for every candidate. */
  kpis: Kpis;
  cost: CostBreakdown;
  /** `cost.net`, lifted out because it is what the search ranks on. */
  score: number;
  /** What the plan changes against the shop as it is, one line per lever. */
  changes: string[];
}

export interface OptimizeOptions {
  /** How dearly a lost customer is priced. Default "balanced". */
  objective?: Objective;
  /** Which families of levers to move. Default: all of them. */
  levers?: Levers;
  /**
   * Plans per generation. Default 16. Generation 0 wants the base plus every
   * one-lever step, which with the full lever table is more plans than this;
   * the surplus is shuffled and a subset kept, so raise it when the "one
   * obvious fix in generation 0" guarantee matters more than depth.
   */
  population?: number;
  /**
   * Generations after the first. Default 10; generation 0 is the shop as it is
   * plus every one-lever step from it, so 0 is a useful setting on its own.
   */
  generations?: number;
  /** Engine seeds 1..seeds averaged per plan. Default 1; 2–3 smooth noisy weeks. */
  seeds?: number;
  /** The search's own seed: selection, crossover, mutation and immigrant draws. Default 1. */
  seed?: number;
  /** Horizon per evaluation, days. Default 7, which sees a whole delivery week. */
  days?: number;
  /** Prices to override on the objective's preset. */
  assumptions?: Partial<Assumptions>;
  /**
   * A budget in simulated weeks — `evaluations × seeds × days / 7`. The hosted
   * tool passes `MAX_EVALUATION_WEEKS` so the call fits inside a serverless
   * timeout; the browser leaves it out and runs uncapped.
   */
  maxEvaluationWeeks?: number;
  /** Called once per generation with the best plan so far. */
  onGeneration?: (g: { index: number; best: number; mean: number; plan: TwinScenario }) => void;
}

export interface OptimizeResult {
  best: Candidate;
  /** The shop as it is, evaluated exactly the same way. */
  baseline: Candidate;
  /** The next best distinct plans over the whole search, best first. */
  runnersUp: Candidate[];
  generations: Array<{ index: number; best: number; mean: number }>;
  /** Plans actually run through the engine; repeats are served from a memo and not counted. */
  evaluated: number;
  assumptions: Assumptions;
  objective: Objective;
  /** True when patience or the evaluation budget ended the search before its last generation. */
  stoppedEarly: boolean;
}

export const OPTIMIZE_LIMITS = {
  population: { min: 3, max: 60 },
  generations: { min: 0, max: 60 },
  seeds: { min: 1, max: 5 },
  days: { min: 1, max: 28 },
} as const;

/**
 * The hosted budget, in simulated weeks. A week of this shop costs the engine
 * roughly a fifth of a second, so 180 of them leaves room inside a 60 s
 * serverless call for the twin build in front of each one. The default search
 * (16 plans over 10 generations of a 7-day week) fits it with a little to
 * spare. Re-measure both when the engine's per-day cost moves.
 */
export const MAX_EVALUATION_WEEKS = 180;

/** What a search of this size will run through the engine, in simulated weeks. */
export function evaluationWeeks(population: number, generations: number, seeds: number, days: number): number {
  return (population * (generations + 1) * seeds * days) / 7;
}

/** Generations without an improvement before the search gives up. */
const PATIENCE = 6;
/** The most distinct alternatives reported beside the winner. */
const RUNNERS_UP = 5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

function geneKey(genome: Genome, levers: LeverKey[]): string {
  return levers.map((k) => `${k}=${String(genome[k])}`).join("|");
}

function randomGene(l: LeverDef, rng: Rng): GeneValue {
  if (l.kind === "bool") return rng() < 0.5;
  if (l.kind === "choice") return l.choices![randInt(rng, 0, l.choices!.length - 1)];
  return randInt(rng, l.min!, l.max!);
}

function mutateGene(l: LeverDef, v: GeneValue, rng: Rng): GeneValue {
  if (l.kind === "bool") return !v;
  if (l.kind === "choice") {
    const i = l.choices!.indexOf(v);
    // Ordered ladders (service levels, van times, days of supply) mostly step
    // to a neighbour; anything can still jump across.
    if (i >= 0 && rng() < 0.7) return l.choices![Math.min(l.choices!.length - 1, Math.max(0, i + (rng() < 0.5 ? -1 : 1)))];
    return l.choices![randInt(rng, 0, l.choices!.length - 1)];
  }
  const n = Number(v);
  if (rng() < 0.7) return Math.min(l.max!, Math.max(l.min!, n + (rng() < 0.5 ? -1 : 1)));
  return randInt(rng, l.min!, l.max!);
}

/**
 * Every one-lever step away from the base. Seeding generation 0 with these is
 * what makes a single obvious fix — one more register, one more cashier at
 * close — show up in the first generation, before any crossover.
 */
function neighbours(baseG: Genome, levers: LeverKey[]): Genome[] {
  const out: Genome[] = [];
  for (const k of levers) {
    const l = LEVER_BY_KEY.get(k)!;
    const v = baseG[k];
    const values: GeneValue[] =
      l.kind === "bool" ? [!v] : l.kind === "choice" ? l.choices!.filter((c) => c !== v) : [Number(v) + 1, Number(v) - 1].filter((n) => n >= l.min! && n <= l.max!);
    for (const c of values) out.push({ ...baseG, [k]: c });
  }
  return out;
}

function meanKpis(list: Kpis[]): Kpis {
  const out = {} as Record<keyof Kpis, number>;
  for (const k of KPI_KEYS) out[k] = list.reduce((a, x) => a + x[k], 0) / list.length;
  return out as Kpis;
}

/** A genome the engine has an answer for, or a reason it refused. */
interface Scored {
  genome: Genome;
  key: string;
  candidate: Candidate | null;
  score: number;
  error?: string;
}

/**
 * Search the shop's levers for the cheapest week.
 *
 * `base` is the operation as it is: anything the levers do not touch — a
 * demand shock, an outage, an imported layout — is carried into every
 * candidate, so the search answers "what should we do about *this*", not
 * "what would a different shop do".
 */
export async function optimizeOperations(store: string, startWeek: number, base: TwinScenario, opts: OptimizeOptions = {}): Promise<OptimizeResult> {
  const shop = shopOf(store);
  const objective = opts.objective ?? "balanced";
  const assumptions = assumptionsFor(objective, opts.assumptions);
  const levers = leverKeysFor(shop, opts.levers ?? DEFAULT_LEVERS);
  if (levers.length === 0) throw new RangeError("Pick at least one lever to optimize: every family was off, or none of them applies to this shop.");

  const seeds = clamp(opts.seeds ?? 1, OPTIMIZE_LIMITS.seeds.min, OPTIMIZE_LIMITS.seeds.max);
  const days = clamp(opts.days ?? 7, OPTIMIZE_LIMITS.days.min, OPTIMIZE_LIMITS.days.max);
  const budget = opts.maxEvaluationWeeks ?? Number.POSITIVE_INFINITY;
  const weeksPerEval = (seeds * days) / 7;

  let population = clamp(opts.population ?? 16, OPTIMIZE_LIMITS.population.min, OPTIMIZE_LIMITS.population.max);
  let generations = clamp(opts.generations ?? 10, OPTIMIZE_LIMITS.generations.min, OPTIMIZE_LIMITS.generations.max);
  // Trim the search to the budget before it starts: generations first, because
  // a wide generation 0 is where the one-lever fixes live, and a narrow
  // population would throw them away.
  while (generations > OPTIMIZE_LIMITS.generations.min && evaluationWeeks(population, generations, seeds, days) > budget) generations--;
  while (population > OPTIMIZE_LIMITS.population.min && evaluationWeeks(population, generations, seeds, days) > budget) population--;

  // One generator for selection, crossover, mutation, immigrants and the
  // generation-0 shuffle. The odd multiplier spreads neighbouring seeds apart.
  const rng = seededRandom(((opts.seed ?? 1) * 2654435761) >>> 0);
  const baseG = baseGenome(shop, base);

  const memo = new Map<string, Scored>();
  let evaluated = 0;
  let stoppedEarly = false;

  /** True while another engine run still fits the budget. */
  const affordable = () => (evaluated + 1) * weeksPerEval <= budget + 1e-9;

  const evaluate = async (genome: Genome): Promise<Scored> => {
    const key = geneKey(genome, levers);
    const hit = memo.get(key);
    if (hit) return hit;
    // Genes outside the active levers are pinned to base, so equal keys mean
    // equal scenarios and the memo can never serve the wrong candidate.
    const full: Genome = { ...baseG };
    for (const k of levers) full[k] = genome[k];
    const scenario = genomeToScenario(full, base, baseG, shop);
    const changes = describeChanges(full, baseG);
    let out: Scored;
    try {
      const ctx = await buildTwin(store, startWeek, scenario);
      const list: Kpis[] = [];
      const extras: CostExtras = { overtimeCost: 0, stockRetail: 0, ordersUnfilled: 0 };
      for (let s = 1; s <= seeds; s++) {
        const r = runOperations(ctx, operationsOptions(ctx, days, s));
        list.push(kpis(r));
        const e = costExtras(r);
        extras.overtimeCost += e.overtimeCost / seeds;
        extras.stockRetail += e.stockRetail / seeds;
        extras.ordersUnfilled += e.ordersUnfilled / seeds;
      }
      const k = meanKpis(list);
      const cost = costOf(k, extras, full, baseG, ctx, days, assumptions);
      out = { genome: full, key, candidate: { scenario, kpis: k, cost, score: cost.net, changes }, score: cost.net };
    } catch (err) {
      // The twin refuses scenarios the data cannot support. Keep the plan in
      // the population so the search can walk back out of the region, but
      // sort it last and never report it.
      out = { genome: full, key, candidate: null, score: Number.POSITIVE_INFINITY, error: err instanceof Error ? err.message : String(err) };
    }
    evaluated++;
    memo.set(key, out);
    return out;
  };

  // Generation 0: the shop as it is, every one-lever step, then random plans.
  const baseline = await evaluate(baseG);
  if (!baseline.candidate) throw new Error(`The base scenario does not run at ${store}: ${baseline.error}`);
  const basePlan = baseline.candidate;

  let pop: Genome[] = [baseG, ...neighbours(baseG, levers)];
  const seen = new Set(pop.map((g) => geneKey(g, levers)));
  // Bounded: a small lever space has fewer distinct plans than the population
  // asks for, and the loop must still end.
  let tries = 0;
  while (pop.length < population && tries++ < population * 50) {
    const g: Genome = { ...baseG };
    for (const k of levers) g[k] = randomGene(LEVER_BY_KEY.get(k)!, rng);
    const key = geneKey(g, levers);
    if (seen.has(key)) continue;
    seen.add(key);
    pop.push(g);
  }
  if (pop.length > population) {
    // More one-lever steps than the population holds: keep the base and a
    // shuffled subset, so which fixes get a first look is at least unbiased.
    const rest = pop.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = randInt(rng, 0, i);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    pop = [baseG, ...rest.slice(0, population - 1)];
  }

  const history: OptimizeResult["generations"] = [];
  // The best starts as the shop as it is, which is why the winner can never be
  // worse than the baseline on the objective it was scored with.
  let best = baseline;
  let bestPlan = basePlan;
  let sinceImprovement = 0;
  const elite = Math.max(1, Math.round(population * 0.1));

  for (let gen = 0; gen <= generations; gen++) {
    const scored: Scored[] = [];
    let outOfBudget = false;
    for (const g of pop) {
      if (!memo.has(geneKey(g, levers)) && !affordable()) {
        outOfBudget = true;
        break;
      }
      scored.push(await evaluate(g));
    }
    if (scored.length === 0) scored.push(baseline);
    // Ties broken on the gene key so the winner never depends on the order the
    // population happened to be built in.
    scored.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const genBest = scored[0];
    if (genBest.candidate && genBest.score < best.score - 1e-6) {
      best = genBest;
      bestPlan = genBest.candidate;
      sinceImprovement = 0;
    } else sinceImprovement++;

    const feasible = scored.filter((s) => s.candidate);
    const mean = feasible.length ? feasible.reduce((a, s) => a + s.score, 0) / feasible.length : Number.POSITIVE_INFINITY;
    history.push({ index: gen, best: best.score, mean });
    opts.onGeneration?.({ index: gen, best: best.score, mean, plan: bestPlan.scenario });

    if (outOfBudget) {
      stoppedEarly = true;
      break;
    }
    if (gen === generations) break;
    if (sinceImprovement >= PATIENCE) {
      stoppedEarly = true;
      break;
    }

    // Next generation: elites carried whole, then children of tournament
    // winners, and one immigrant in the last slot to keep the pool from
    // collapsing onto the elites. No duplicates within a generation.
    const next: Genome[] = scored.slice(0, elite).map((s) => s.genome);
    const keys = new Set(next.map((g) => geneKey(g, levers)));
    const tournament = () => {
      let pick = scored[randInt(rng, 0, scored.length - 1)];
      for (let i = 1; i < 3; i++) {
        const other = scored[randInt(rng, 0, scored.length - 1)];
        if (other.score < pick.score) pick = other;
      }
      return pick.genome;
    };
    let guard = 0;
    while (next.length < population && guard++ < population * 20) {
      let child: Genome;
      if (next.length === population - 1 && rng() < 0.8) {
        child = { ...baseG };
        for (const k of levers) child[k] = randomGene(LEVER_BY_KEY.get(k)!, rng);
      } else {
        const a = tournament();
        const b = tournament();
        child = { ...baseG };
        for (const k of levers) child[k] = rng() < 0.5 ? a[k] : b[k];
        for (const k of levers) if (rng() < 0.2) child[k] = mutateGene(LEVER_BY_KEY.get(k)!, child[k], rng);
      }
      const key = geneKey(child, levers);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(child);
    }
    pop = next;
  }

  // The best distinct plans over the whole search, not just the last
  // generation. The memo is insertion-ordered by a deterministic evaluation
  // order, and the sort breaks ties on the gene key, so the list is stable.
  const runnersUp: Candidate[] = [];
  for (const s of [...memo.values()].sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : 1))) {
    if (!s.candidate || s.key === best.key) continue;
    runnersUp.push(s.candidate);
    if (runnersUp.length === RUNNERS_UP) break;
  }

  return {
    best: bestPlan,
    baseline: basePlan,
    runnersUp,
    generations: history,
    evaluated,
    assumptions,
    objective,
    stoppedEarly,
  };
}
