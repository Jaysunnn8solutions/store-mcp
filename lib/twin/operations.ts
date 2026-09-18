/**
 * The store floor, minute by minute.
 *
 * A discrete-event simulation over a binary min-heap of closures keyed on
 * engine minutes from 00:00 of horizon day 0 (the Monday of `startWeek`).
 * Every unit of work is a `Job` in one of ten per-process queues, and a
 * `dispatch()` pass runs after every heap event: each present, idle, off-break
 * worker takes the lowest-priority, earliest-ready job their primary skill
 * allows, falling back to what they are cross-trained for when `flex` is on.
 *
 * What makes a shop different from the warehouse this engine was modelled on:
 *
 * - **A customer is waiting.** `serve` and `checkout` outrank every other job,
 *   because a person is standing there. And unlike a pallet, a person leaves:
 *   each shopper carries a patience, and a queue longer than it is a lost sale
 *   rather than a late one. That is the store's version of a truck going out
 *   late, and it is the number the whole model exists to put a figure on.
 * - **The shelf is the pick face.** Customers take stock off the facings
 *   themselves. A facing that runs out between restocks is a lost sale even
 *   when the stockroom is full, so the interesting question is not whether the
 *   store has the candy but whether it is in front of the customer.
 * - **The day has two halves.** Before the doors open the crew receives the
 *   overnight trailer, fills the shelves and picks, packs and loads the
 *   special orders the van takes out. After ten it is all service. The
 *   pre-open window is what binds, the way the pick window before the 14:00
 *   truck binds in a distribution center.
 *
 * An optional `Tracer` observes the run for the 3D page. Emitting never draws
 * from a random stream, never schedules an event and never mutates state, so a
 * traced run and an untraced one produce identical numbers.
 */

import { MinHeap } from "../util/heap";
import { normal, quantile, substream, type Rng } from "../util/random";
import type { Tracer, JobInfo, TraceEvent, WorkerInfo } from "../trace/types";
import { NOOP_TRACER } from "../trace/types";
import type { Basket, BasketLine, SpecialOrder } from "./demand";
import { customersOn, hoursOn, isOperating, ordersPlacedOn, weekdayOf } from "./demand";
import { buildPallets, InventoryBook } from "./inventory";
import type { Facing } from "./layout";
import { sShapeDistance, walkDistance } from "./layout";
import { calendarWeekOfDay } from "./season";
import { hhmm, shiftPaidHours } from "./standards";
import type { TwinContext } from "./twin";
import { PROCESSES, PROCESS_SKILL, type Process, type Skill, type Worker } from "./types";
import { buildWeekSchedule } from "./workforce";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface Disruptions {
  /** Share of scheduled shifts nobody turns up for. */
  absenteeism: number;
  registerOutages: Array<{ fromDay: number; toDay: number; count: number }>;
  counterOutages: Array<{ fromDay: number; toDay: number; count: number }>;
  dockOutages: Array<{ fromDay: number; toDay: number; count: number }>;
  vanOutages: Array<{ fromDay: number; toDay: number; count: number }>;
  /** The till network down: nothing can be rung up, so every queue stalls. */
  posOutages: Array<{ day: number; start: string; hours: number }>;
  workerLeave: Array<{ worker?: string; role?: string; count?: number; fromDay: number; toDay: number }>;
  /** Standard deviation of a truck's arrival around its appointment. */
  inboundLatenessSdMin: number;
  /** Multiplier on every shopper's patience; 0.5 is a crowd in a hurry. */
  patience: number;
}

export const NO_DISRUPTIONS: Disruptions = {
  absenteeism: 0.05,
  registerOutages: [],
  counterOutages: [],
  dockOutages: [],
  vanOutages: [],
  posOutages: [],
  workerLeave: [],
  inboundLatenessSdMin: 35,
  patience: 1,
};

export interface OperationsOptions {
  days: number;
  seed: number;
  /** Cross-trained people may take work outside their primary when idle. */
  flex: boolean;
  /** Per worker per day, closing shift only. */
  overtimeMaxHours: number;
  disruptions: Disruptions;
  /** Days of stock warm-up before day 0. */
  warmupWeeks: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ProcessStats {
  jobs: number;
  busyMin: number;
  waitTotalMin: number;
  waitMaxMin: number;
  maxQueue: number;
  /** The part of the wait with a qualified worker free but the till, the counter or a cart taken. */
  equipmentWaitMin: number;
}

export interface WorkerRecord {
  id: string;
  role: string;
  type: Worker["type"];
  shiftsWorked: number;
  absences: number;
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  primaries: Partial<Record<Skill, number>>;
  byProcess: Partial<Record<Process, number>>;
}

export interface DayRecord {
  day: number;
  weekday: number;
  calendarWeek: number;
  open: boolean;
  customers: number;
  transactions: number;
  unitsSold: number;
  salesDollars: number;
  lostShelfDollars: number;
  lostQueueDollars: number;
  abandoned: number;
  counterWaitAvgMin: number;
  registerWaitAvgMin: number;
  worstWaitMin: number;
  restocks: number;
  hotRestocks: number;
  shortAtShelf: number;
  ordersDue: number;
  ordersLate: number;
  inboundTrucks: number;
  inboundCases: number;
  overtimeHours: number;
  absences: number;
}

export interface OrderRecord {
  id: string;
  kind: "delivery" | "pickup";
  dueDay: number;
  dueMin: number;
  pickedAt: number | null;
  packedAt: number | null;
  outAt: number | null;
  lateMin: number;
  lines: number;
  cutLines: number;
  dollars: number;
  cutDollars: number;
}

export interface ResourceStat {
  count: number;
  utilization: number;
}

export interface OperationsResult {
  store: string;
  storeName: string;
  startWeek: number;
  days: number;
  seed: number;
  sales: {
    customers: number;
    /** Baskets rung up at a register; a delivery order is counted with the orders. */
    transactions: number;
    unitsSold: number;
    /** Everything the shop took: the till plus the orders that went out. */
    salesDollars: number;
    tillDollars: number;
    orderDollars: number;
    averageBasket: number;
    lostShelfUnits: number;
    lostShelfDollars: number;
    lostQueueDollars: number;
    giftWraps: number;
    counterCustomers: number;
    counterServed: number;
  };
  service: {
    counterWaitAvgMin: number;
    counterWaitP90Min: number;
    registerWaitAvgMin: number;
    registerWaitP90Min: number;
    worstWaitMin: number;
    abandonedCounter: number;
    abandonedRegister: number;
    abandonRate: number;
  };
  availability: {
    shortAtShelf: number;
    /**
     * Share of the units customers reached for that were actually there. The
     * retailer's measure: a shop can have 97% of its facings in stock and
     * still miss a fifth of its demand, because the empty ones are the
     * fast movers.
     */
    onShelfShare: number;
    /** Share of facings holding stock at the end of the run, for comparison. */
    facingsInStock: number;
    restocks: number;
    hotRestocks: number;
    emptyFacingMinutes: number;
  };
  orders: {
    placed: number;
    /** Delivered or collected. */
    fulfilled: number;
    /** What those orders were worth. */
    dollars: number;
    picked: number;
    cutLines: number;
    cutDollars: number;
    late: number;
    lateMinTotal: number;
    vanRounds: number;
    vanLateRounds: number;
    stops: number;
    miles: number;
  };
  inbound: {
    trucks: number;
    pallets: number;
    cases: number;
    dockToStockAvgMin: number;
    dockToStockP90Min: number;
    doorWaitAvgMin: number;
    palletsNotPutAway: number;
  };
  processes: Record<Process, ProcessStats>;
  labor: {
    paidHours: number;
    overtimeHours: number;
    busyHours: number;
    absences: number;
    regularCost: number;
    overtimeCost: number;
    utilization: number;
    salesPerPaidHour: number;
    laborShareOfSales: number;
  };
  resources: {
    registers: ResourceStat;
    counters: ResourceStat;
    wrap: ResourceStat;
    palletJacks: ResourceStat;
    stockCarts: ResourceStat;
    vans: ResourceStat;
    docks: ResourceStat;
  };
  stock: {
    retailStart: number;
    retailEnd: number;
    backroomCases: number;
    backroomPositions: number;
  };
  bottleneck: { process: Process | null; constraint: string; waitHours: number };
  orderRecords: OrderRecord[];
  workers: WorkerRecord[];
  daily: DayRecord[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Job {
  id: number;
  process: Process;
  /** Engine minute the job became available. */
  ready: number;
  /** Lower runs first. */
  priority: number;
  /** Standard minutes at productivity 1. */
  std: number;
  register?: boolean;
  counter?: boolean;
  wrap?: boolean;
  palletJack?: boolean;
  cart?: boolean;
  van?: boolean;
  /** First minute a free qualified worker found it blocked by a resource. */
  heldSince?: number;
  /** True while the customer is still willing to wait. */
  live?: () => boolean;
  info: JobInfo;
  onDone: (t: number, jobId: number) => void;
  /** Called instead of onDone when the customer walked out before it started. */
  onDrop?: (t: number) => void;
}

/**
 * Lower runs first. A customer at the till or the glass beats everything: they
 * are standing in the shop and they can leave. After them comes the work that
 * has a deadline (the van), then the empty shelf, then everything else.
 */
const PRIORITY = {
  checkout: 0,
  serve: 0,
  load: 1,
  pack: 1,
  hotRestock: 2,
  pick: 2,
  deliver: 2,
  putaway: 4,
  unload: 4,
  receive: 5,
  restock: 6,
} as const;

/** How long before a van's departure the loading job is raised. */
const LOAD_LEAD_MIN = 30;

/** Order a flexing worker looks through other people's work in. */
const FLEX_ORDER: Process[] = ["checkout", "serve", "load", "pack", "pick", "restock", "unload", "receive", "putaway", "deliver"];

/** Work the closing shift may stay on past the end of their shift. */
const OVERTIME_PROCESSES: Process[] = ["checkout", "serve", "restock", "pack"];

interface WorkerState {
  w: Worker;
  productivity: number;
  skills: Skill[];
  present: boolean;
  primary: Skill | null;
  shiftId: string | null;
  shiftStart: number;
  shiftEnd: number;
  breakAt: number;
  breakMin: number;
  onBreak: boolean;
  breakTaken: boolean;
  busy: boolean;
  lastShift: boolean;
  rec: WorkerRecord;
}

type CustomerPhase = "shopping" | "counter" | "register" | "gone";

interface CustomerState {
  basket: Basket;
  entity: string;
  arrivedAt: number;
  phase: CustomerPhase;
  /** Units actually taken off the shelf, by SKU. */
  taken: Map<string, number>;
  dollars: number;
  lostDollars: number;
  servedUnits: Map<string, number>;
  queuedAt: number;
  patience: number;
  left: boolean;
}

interface OrderState {
  order: SpecialOrder;
  placedAt: number;
  dueAt: number;
  lines: BasketLine[];
  cutLines: number;
  cutDollars: number;
  dollars: number;
  pending: number;
  pickedUnits: number;
  /** Already loaded onto a round, so a later round does not take it as well. */
  onRound: boolean;
  pickedAt: number | null;
  packedAt: number | null;
  outAt: number | null;
  rec: OrderRecord;
}

interface TruckState {
  po: string;
  supplier: string;
  mode: "overnight" | "direct";
  importer: boolean;
  arrivedAt: number;
  pallets: Array<{ items: Array<{ sku: string; cases: number }>; mixed: boolean }>;
  cases: number;
  start: () => void;
}

const EMPTY_STATS = (): ProcessStats => ({ jobs: 0, busyMin: 0, waitTotalMin: 0, waitMaxMin: 0, maxQueue: 0, equipmentWaitMin: 0 });

function outageCount(list: Array<{ fromDay: number; toDay: number; count: number }>, t: number): number {
  const d = Math.floor(t / 1440);
  let n = 0;
  for (const o of list) if (d >= o.fromDay && d <= o.toDay) n += o.count;
  return n;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function runOperations(ctx: TwinContext, opts: OperationsOptions, tracer: Tracer = NOOP_TRACER): OperationsResult {
  const { site, layout, catalog, model, std, costs, plan, facingUnits } = ctx;
  const dis = opts.disruptions;
  const horizonEnd = opts.days * 1440;
  const trace: ((e: TraceEvent) => void) | null = tracer.enabled ? (e) => tracer.emit(e) : null;

  // Named substreams, salted with the store, so adding a draw in one process
  // never shifts the numbers in another.
  const rngFor = (label: string): Rng => substream(opts.seed, `${label}-${site.id}`);
  const attendRng = rngFor("attendance");
  const arrivalRng = rngFor("truck-arrivals");
  const shopperRng = rngFor("shoppers");
  const orderRng = rngFor("special-orders");
  const warmRng = rngFor("warmup");

  const skuMap = new Map(catalog.skus.map((s) => [s.id, s]));
  const supplierMap = new Map(catalog.suppliers.map((s) => [s.id, s]));

  // ------------------------------------------------------------------ people
  const closingShiftId = site.shifts.reduce((best, s) => {
    const end = hhmm(s.start) + shiftPaidHours(s.start, s.end) * 60;
    const bestEnd = hhmm(best.start) + shiftPaidHours(best.start, best.end) * 60;
    return end > bestEnd ? s : best;
  }, site.shifts[0]).id;

  const workers: WorkerState[] = ctx.workers.map((w) => ({
    w,
    productivity: w.productivity * (w.type === "temp" ? costs.tempProductivity : 1),
    skills: w.skills,
    present: false,
    primary: null,
    shiftId: null,
    shiftStart: 0,
    shiftEnd: 0,
    breakAt: 0,
    breakMin: 0,
    onBreak: false,
    breakTaken: true,
    busy: false,
    lastShift: false,
    rec: { id: w.id, role: w.role, type: w.type, shiftsWorked: 0, absences: 0, paidHours: 0, overtimeHours: 0, busyHours: 0, primaries: {}, byProcess: {} },
  }));
  const workerById = new Map(workers.map((ws) => [ws.w.id, ws]));

  // Role-based leave resolves once, so the same people are away all window.
  const roleLeave = new Map<string, Set<string>>();
  dis.workerLeave.forEach((l, i) => {
    if (!l.role) return;
    const pool = ctx.workers.filter((w) => w.role === l.role).slice(0, l.count ?? 1);
    roleLeave.set(String(i), new Set(pool.map((w) => w.id)));
  });
  const onLeave = (ws: WorkerState, d: number) =>
    dis.workerLeave.some((l, i) => d >= l.fromDay && d <= l.toDay && (l.worker === ws.w.id || roleLeave.get(String(i))?.has(ws.w.id) === true));

  // ------------------------------------------------------------------- clock
  const hoursFor = (d: number) => hoursOn(site, d);
  const openMinOf = (d: number) => {
    const h = hoursFor(d);
    return h ? d * 1440 + hhmm(h.open) : null;
  };
  const closeMinOf = (d: number) => {
    const h = hoursFor(d);
    return h ? d * 1440 + hhmm(h.close) : null;
  };

  /**
   * Minutes between two times while somebody is on the floor. A queue does not
   * build overnight, so a wait that spans a closed shop is not a wait.
   */
  const floorMinutesBetween = (a: number, b: number): number => {
    if (b <= a) return 0;
    let total = 0;
    for (let d = Math.floor(a / 1440) - 1; d <= Math.floor(b / 1440); d++) {
      if (d < 0 || !isOperating(site, d)) continue;
      const spans: Array<[number, number]> = site.shifts.map((s) => {
        const start = d * 1440 + hhmm(s.start) + s.indirectMin;
        return [start, d * 1440 + hhmm(s.start) + shiftPaidHours(s.start, s.end) * 60];
      });
      spans.sort((x, y) => x[0] - y[0]);
      let curStart = -1;
      let curEnd = -1;
      for (const [s0, s1] of spans) {
        if (curEnd < 0 || s0 > curEnd) {
          if (curEnd >= 0) total += Math.max(0, Math.min(curEnd, b) - Math.max(curStart, a));
          curStart = s0;
          curEnd = s1;
        } else curEnd = Math.max(curEnd, s1);
      }
      if (curEnd >= 0) total += Math.max(0, Math.min(curEnd, b) - Math.max(curStart, a));
    }
    return total;
  };

  const nextShiftStart = (t: number): number => {
    for (let i = 0; i <= 8; i++) {
      const d = Math.floor(t / 1440) + i;
      if (!isOperating(site, d)) continue;
      for (const s of site.shifts) {
        const start = d * 1440 + hhmm(s.start);
        if (start > t) return start;
      }
    }
    return t + 7 * 1440;
  };

  const dayOf = (t: number) => Math.min(opts.days - 1, Math.max(0, Math.floor(t / 1440)));

  // --------------------------------------------------------------- inventory
  const facingCap = new Map<string, number>();
  for (const sku of catalog.skus) facingCap.set(sku.id, Math.max(1, Math.round(facingUnits.get(sku.id) ?? 1)));

  const book = new InventoryBook(model, catalog, ctx.policy, ctx.startWeek, ctx.supplierDelays, opts.seed, facingCap);
  const warmFrom = -opts.warmupWeeks * 7;
  book.initialize(warmFrom);
  for (let d = warmFrom; d < 0; d++) {
    book.review(d);
    for (const po of book.arrivals(d)) for (const l of po.lines) book.receive(l.sku, l.units);
    for (const s of book.skus) {
      const need = book.restockNeed(s.sku.id);
      if (need > 0) book.restock(s.sku.id, need);
    }
    if (d < -1 && isOperating(site, d)) {
      for (const c of customersOn(model, d, ctx.startWeek, warmRng)) {
        for (const l of c.lines) book.sell(l.sku, l.units);
      }
    }
    book.endDay();
  }
  // The warm-up must not pollute the horizon's numbers.
  const totals = book.totals as unknown as Record<string, number>;
  for (const k of Object.keys(totals)) totals[k] = 0;
  const retailStart = book.retailValue();

  const facingBySku = new Map<string, Facing>();
  for (const [sku, f] of plan) facingBySku.set(sku, f);
  const homeFor = (sku: string): Facing | null => facingBySku.get(sku) ?? null;

  const storageHome = new Map<string, string>();
  catalog.skus.forEach((s, i) => {
    if (layout.storage.length > 0) storageHome.set(s.id, layout.storage[i % layout.storage.length].id);
  });

  // ------------------------------------------------------------------- state
  const events = new MinHeap<() => void>();
  let now = 0;
  const at = (t: number, fn: () => void) => events.push(Math.max(t, now), fn);

  const queues: Record<Process, Job[]> = {
    unload: [],
    receive: [],
    putaway: [],
    restock: [],
    serve: [],
    checkout: [],
    pick: [],
    pack: [],
    load: [],
    deliver: [],
  };
  const stats: Record<Process, ProcessStats> = {
    unload: EMPTY_STATS(),
    receive: EMPTY_STATS(),
    putaway: EMPTY_STATS(),
    restock: EMPTY_STATS(),
    serve: EMPTY_STATS(),
    checkout: EMPTY_STATS(),
    pick: EMPTY_STATS(),
    pack: EMPTY_STATS(),
    load: EMPTY_STATS(),
    deliver: EMPTY_STATS(),
  };
  let jobSeq = 0;

  const busy = { register: 0, counter: 0, wrap: 0, palletJack: 0, cart: 0, van: 0, dock: 0 };
  const busyMin = { register: 0, counter: 0, wrap: 0, palletJack: 0, cart: 0, van: 0, dock: 0 };
  let lastResourceT = 0;
  const accrueResources = (t: number) => {
    const dt = t - lastResourceT;
    if (dt <= 0) return;
    busyMin.register += busy.register * dt;
    busyMin.counter += busy.counter * dt;
    busyMin.wrap += busy.wrap * dt;
    busyMin.palletJack += busy.palletJack * dt;
    busyMin.cart += busy.cart * dt;
    busyMin.van += busy.van * dt;
    busyMin.dock += busy.dock * dt;
    lastResourceT = t;
  };

  const registerIds = layout.service.filter((s) => s.kind === "register").map((s) => s.id);
  const counterIds = layout.service.filter((s) => s.kind === "counter").map((s) => s.id);
  const wrapIds = layout.service.filter((s) => s.kind === "wrap").map((s) => s.id);
  const dockDoors = layout.doors.filter((d) => d.kind === "dock" || d.kind === "ground");

  const registersAvail = (t: number) => Math.max(0, registerIds.length - outageCount(dis.registerOutages, t));
  const countersAvail = (t: number) => Math.max(0, counterIds.length - outageCount(dis.counterOutages, t));
  const vansAvail = (t: number) => Math.max(0, site.equipment.vans - outageCount(dis.vanOutages, t));
  const docksAvail = (t: number) => Math.max(0, dockDoors.length - outageCount(dis.dockOutages, t));

  // The till network: while it is down nothing can be rung and nothing starts.
  const posDownUntil = (t: number): number | null => {
    for (const o of dis.posOutages) {
      const s = o.day * 1440 + hhmm(o.start);
      const e = s + o.hours * 60;
      if (t >= s && t < e) return e;
    }
    return null;
  };
  let posNotedUntil = -1;
  const notePos = (until: number) => {
    if (until === posNotedUntil) return;
    posNotedUntil = until;
    trace?.({ k: "pos", t: now, down: true, until });
    at(until, () => {
      trace?.({ k: "pos", t: now, down: false });
    });
  };

  // ----------------------------------------------------------------- records
  const daily: DayRecord[] = Array.from({ length: opts.days }, (_, d) => ({
    day: d,
    weekday: weekdayOf(d),
    calendarWeek: calendarWeekOfDay(ctx.startWeek, d),
    open: isOperating(site, d),
    customers: 0,
    transactions: 0,
    unitsSold: 0,
    salesDollars: 0,
    lostShelfDollars: 0,
    lostQueueDollars: 0,
    abandoned: 0,
    counterWaitAvgMin: 0,
    registerWaitAvgMin: 0,
    worstWaitMin: 0,
    restocks: 0,
    hotRestocks: 0,
    shortAtShelf: 0,
    ordersDue: 0,
    ordersLate: 0,
    inboundTrucks: 0,
    inboundCases: 0,
    overtimeHours: 0,
    absences: 0,
  }));
  const dayWaits: Array<{ counter: number[]; register: number[] }> = Array.from({ length: opts.days }, () => ({ counter: [], register: [] }));

  const counterWaits: number[] = [];
  const registerWaits: number[] = [];
  const dockToStock: number[] = [];
  const doorWaits: number[] = [];
  const orderRecords: OrderRecord[] = [];

  let customersIn = 0;
  /** Baskets rung up at a register. A special order is not one of these. */
  let transactions = 0;
  let unitsSold = 0;
  /** Takings at the till, and takings from orders that left the shop. */
  let tillDollars = 0;
  let orderDollars = 0;
  let ordersFulfilled = 0;
  /** Units that came off a facing into somebody's hand, sold or not. */
  let unitsTaken = 0;
  let lostShelfUnits = 0;
  let lostShelfDollars = 0;
  let lostQueueDollars = 0;
  let giftWraps = 0;
  let counterCustomers = 0;
  let counterServed = 0;
  let abandonedCounter = 0;
  let abandonedRegister = 0;
  let shortAtShelf = 0;
  let restocks = 0;
  let hotRestocks = 0;
  let inboundTrucks = 0;
  let inboundPallets = 0;
  let inboundCases = 0;
  let palletsInFlight = 0;
  let vanRounds = 0;
  let vanLateRounds = 0;
  let deliveryStops = 0;
  let deliveryMiles = 0;
  let ordersPlaced = 0;
  let ordersPicked = 0;
  let ordersLate = 0;
  let orderLateMin = 0;
  let cutLines = 0;
  let cutDollars = 0;

  // Empty-facing minutes: accrued lazily whenever a facing's stock crosses zero.
  let emptySince = new Map<string, number>();
  let emptyFacingMinutes = 0;
  const noteFacing = (sku: string, after: number) => {
    const wasEmpty = emptySince.has(sku);
    if (after <= 0 && !wasEmpty) emptySince.set(sku, now);
    else if (after > 0 && wasEmpty) {
      emptyFacingMinutes += now - emptySince.get(sku)!;
      emptySince.delete(sku);
    }
  };

  const traceFacing = (sku: string, delta: number, reason: "sale" | "serve" | "pick" | "restock" | "putaway" | "shrink", job: number) => {
    const s = book.skuMap.get(sku);
    if (!s) return;
    noteFacing(sku, s.onFacing);
    trace?.({ k: "facing", t: now, sku, facing: s.onFacing, back: s.onHandBack, delta, reason, job });
  };

  // -------------------------------------------------------------------- jobs
  const pushJob = (j: Omit<Job, "id">): Job => {
    const job: Job = { ...j, id: ++jobSeq };
    queues[job.process].push(job);
    const st = stats[job.process];
    st.maxQueue = Math.max(st.maxQueue, queues[job.process].length);
    trace?.({ k: "jobQueued", t: now, job: job.id, process: job.process, priority: job.priority, queueLen: queues[job.process].length, info: job.info });
    return job;
  };

  const dropJob = (job: Job) => {
    const q = queues[job.process];
    const i = q.indexOf(job);
    if (i >= 0) q.splice(i, 1);
  };

  const canStart = (job: Job): boolean => {
    if (job.register && busy.register >= registersAvail(now)) return false;
    if (job.counter && busy.counter >= countersAvail(now)) return false;
    if (job.wrap && wrapIds.length > 0 && busy.wrap >= wrapIds.length) return false;
    if (job.palletJack && busy.palletJack >= site.equipment.palletJacks) return false;
    if (job.cart && busy.cart >= site.equipment.stockCarts) return false;
    if (job.van && busy.van >= vansAvail(now)) return false;
    return true;
  };

  const skillsFor = (ws: WorkerState): Process[] => {
    const primary = PROCESSES.filter((p) => PROCESS_SKILL[p] === ws.primary).sort((a, b) => FLEX_ORDER.indexOf(a) - FLEX_ORDER.indexOf(b));
    if (!opts.flex) return primary;
    return [...primary, ...FLEX_ORDER.filter((p) => !primary.includes(p) && ws.skills.includes(PROCESS_SKILL[p]))];
  };

  /**
   * What somebody picks up next.
   *
   * Urgency comes first and the person's own job second — which is where a
   * shop parts company with a warehouse. In a distribution center a forklift
   * driver works through the forklift queue and only wanders off when it is
   * empty, because nothing there is more urgent than anything else. In a shop
   * there is always another case to put out, so a stocker whose own queue can
   * never run dry would never once walk over to an open till. Everybody goes
   * to the customer; the primary skill only breaks ties between jobs that are
   * equally pressing, which is what keeps the stocker stocking when the floor
   * is quiet.
   */
  const chooseJob = (ws: WorkerState, overtime: boolean): Job | null => {
    const allowed = skillsFor(ws);
    let best: Job | null = null;
    let bestPrimary = false;
    for (const p of allowed) {
      if (overtime && !OVERTIME_PROCESSES.includes(p)) continue;
      const isPrimary = PROCESS_SKILL[p] === ws.primary;
      for (const j of queues[p]) {
        if (j.ready > now) continue;
        if (j.live && !j.live()) continue;
        if (best) {
          if (j.priority > best.priority) continue;
          if (j.priority === best.priority) {
            if (bestPrimary && !isPrimary) continue;
            if (bestPrimary === isPrimary && j.ready >= best.ready) continue;
          }
        }
        if (!canStart(j)) {
          j.heldSince ??= now;
          continue;
        }
        best = j;
        bestPrimary = isPrimary;
      }
    }
    return best;
  };

  /** A customer-facing job's wait is real minutes: the person is standing there. */
  const waitFor = (job: Job): number => (job.process === "serve" || job.process === "checkout" ? now - job.ready : floorMinutesBetween(job.ready, now));

  const startJob = (ws: WorkerState, job: Job) => {
    dropJob(job);
    accrueResources(now);
    if (job.register) busy.register++;
    if (job.counter) busy.counter++;
    if (job.wrap && wrapIds.length > 0) busy.wrap++;
    if (job.palletJack) busy.palletJack++;
    if (job.cart) busy.cart++;
    if (job.van) busy.van++;

    const wait = waitFor(job);
    const equipWait = job.heldSince !== undefined ? waitFor({ ...job, ready: job.heldSince }) : 0;
    const st = stats[job.process];
    st.jobs++;
    st.waitTotalMin += wait;
    st.waitMaxMin = Math.max(st.waitMaxMin, wait);
    if (job.heldSince !== undefined) st.equipmentWaitMin += equipWait;

    const dur = Math.max(0.1, job.std / ws.productivity);
    st.busyMin += dur;
    ws.rec.busyHours += dur / 60;
    ws.rec.byProcess[job.process] = (ws.rec.byProcess[job.process] ?? 0) + dur;
    ws.busy = true;

    trace?.({ k: "jobStart", t: now, job: job.id, worker: ws.w.id, dur, waitMin: wait, equipWaitMin: equipWait, productivity: ws.productivity });

    at(now + dur, () => {
      accrueResources(now);
      if (job.register) busy.register--;
      if (job.counter) busy.counter--;
      if (job.wrap && wrapIds.length > 0) busy.wrap--;
      if (job.palletJack) busy.palletJack--;
      if (job.cart) busy.cart--;
      // The van is released when the round returns, not when loading ends.
      ws.busy = false;
      trace?.({ k: "jobEnd", t: now, job: job.id, worker: ws.w.id });
      job.onDone(now, job.id);
    });
  };

  const clockOut = (ws: WorkerState) => {
    const ot = Math.max(0, now - ws.shiftEnd) / 60;
    ws.rec.overtimeHours += ot;
    daily[dayOf(ws.shiftStart)].overtimeHours += ot;
    ws.present = false;
    trace?.({ k: "worker", t: now, id: ws.w.id, state: "out", overtimeMin: Math.max(0, now - ws.shiftEnd) });
  };

  /** Anything still owed before the next crew is on the floor. */
  const workOutstanding = (): boolean => {
    if (customersIn > 0) return true;
    const back = nextShiftStart(now);
    for (const os of orders) if (os.outAt === null && os.dueAt < back) return true;
    return false;
  };

  const dispatch = () => {
    const down = posDownUntil(now);
    if (down !== null) {
      notePos(down);
      return;
    }
    for (const ws of workers) {
      if (!ws.present || ws.busy || ws.onBreak) continue;
      if (!ws.breakTaken && now >= ws.breakAt && now < ws.shiftEnd) {
        ws.onBreak = true;
        ws.breakTaken = true;
        trace?.({ k: "worker", t: now, id: ws.w.id, state: "break", breakMin: ws.breakMin });
        at(now + ws.breakMin, () => {
          ws.onBreak = false;
          trace?.({ k: "worker", t: now, id: ws.w.id, state: "breakEnd" });
        });
        continue;
      }
      const overtime = now >= ws.shiftEnd;
      if (overtime) {
        const capped = now >= ws.shiftEnd + opts.overtimeMaxHours * 60;
        if (!ws.lastShift || capped || !workOutstanding()) {
          clockOut(ws);
          continue;
        }
      }
      const job = chooseJob(ws, overtime);
      if (job) startJob(ws, job);
    }
  };

  // ------------------------------------------------------------- restocking
  /**
   * Nobody walks to the stockroom and back for one line of gummy bears.
   *
   * A stocker loads a cart with every display box the floor is short of, works
   * a run, and brings the cart back. So a restock is a *trip*, not a SKU: the
   * shop collects what wants filling and flushes it into cart-sized jobs, and
   * only an empty facing with a customer standing at it earns a dash to the
   * back on its own. Modelling one trip per SKU is the difference between a
   * morning fill taking three hours and taking seventeen.
   */
  const restockWanted = new Set<string>();
  const restockPending = new Set<string>();
  let flushScheduled = false;
  /** SKUs that fill a cart before its cube does; a shop works a run at a time. */
  const BATCH_SKUS = 14;
  const FLUSH_EVERY_MIN = 20;

  /** Shelves between knee and shoulder need no bend or stretch to fill. */
  const isGolden = (f: Facing): boolean => {
    const run = layout.spec.fixtures.find((r) => r.id === f.run);
    if (!run) return true;
    const r = f.shelf / run.shelves;
    return r > 0.35 && r <= 0.8;
  };

  const buildRestockJob = (skus: string[], hot: boolean) => {
    const lines: Array<{ sku: string; units: number; from: string; to: string }> = [];
    const facings: Facing[] = [];
    let handling = 0;
    let reach = 0;
    let trays = 0;
    for (const sku of skus) {
      const s = book.skuMap.get(sku);
      if (!s || s.onHandBack <= 0) continue;
      const f = homeFor(sku);
      if (!f) continue;
      const need = Math.min(book.restockNeed(sku), s.onHandBack);
      if (need <= 0) continue;
      restockPending.add(sku);
      // A shop works in display boxes, not master cases: the box is what comes
      // off the cart, gets opened, priced and faced.
      const boxes = Math.max(1, Math.ceil(need / Math.max(1, s.sku.unitsPerInner)));
      const tray = f.kind === "showcase" || f.kind === "bulk";
      if (tray) trays += boxes;
      handling += (tray ? std.restockPerTray : std.restockPerCase) * boxes;
      if (!isGolden(f)) reach += (boxes * std.restockBendReachSec) / 60;
      lines.push({ sku, units: need, from: storageHome.get(sku) ?? "", to: f.id });
      facings.push(f);
    }
    if (lines.length === 0) return;

    // Out of the stockroom, round every facing on the cart in floor order, back.
    facings.sort((a, b) => a.aisle - b.aisle || a.y - b.y);
    let feet = 0;
    let prev: { x: number; y: number } = layout.stockDoor;
    for (const f of facings) {
      feet += walkDistance(layout, prev, f);
      prev = f;
    }
    feet += walkDistance(layout, prev, layout.stockDoor);

    pushJob({
      process: "restock",
      ready: now,
      priority: hot ? PRIORITY.hotRestock : PRIORITY.restock,
      std: std.restockPerTrip + handling + reach + feet / std.walkFtPerMin,
      // A dash to the back for one line is carried by hand.
      cart: !hot && lines.length > 1,
      info: { kind: "restock", cart: 0, hot, trips: 1, lines, feet, trays },
      onDone: (t, jobId) => {
        for (const l of lines) {
          restockPending.delete(l.sku);
          const moved = book.restock(l.sku, book.restockNeed(l.sku));
          if (moved > 0) traceFacing(l.sku, moved, "restock", jobId);
        }
        restocks++;
        daily[dayOf(t)].restocks++;
        if (hot) {
          hotRestocks++;
          daily[dayOf(t)].hotRestocks++;
        }
      },
    });
  };

  const flushRestocks = () => {
    if (restockWanted.size === 0) return;
    const list = [...restockWanted]
      .filter((sku) => !restockPending.has(sku) && (book.skuMap.get(sku)?.onHandBack ?? 0) > 0 && book.restockNeed(sku) > 0)
      .sort((a, b) => {
        const fa = homeFor(a);
        const fb = homeFor(b);
        if (!fa || !fb) return a < b ? -1 : 1;
        return fa.aisle - fb.aisle || fa.y - fb.y || (a < b ? -1 : 1);
      });
    restockWanted.clear();

    let batch: string[] = [];
    let cube = 0;
    for (const sku of list) {
      const s = book.skuMap.get(sku);
      if (!s) continue;
      const boxes = Math.max(1, Math.ceil(Math.min(book.restockNeed(sku), s.onHandBack) / Math.max(1, s.sku.unitsPerInner)));
      const c = boxes * s.sku.innerCubeFt;
      if (batch.length > 0 && (cube + c > std.cartCubeFt || batch.length >= BATCH_SKUS)) {
        buildRestockJob(batch, false);
        batch = [];
        cube = 0;
      }
      batch.push(sku);
      cube += c;
    }
    if (batch.length > 0) buildRestockJob(batch, false);
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    at(now + FLUSH_EVERY_MIN, () => {
      flushScheduled = false;
      flushRestocks();
    });
  };

  const wantRestock = (sku: string, hot: boolean) => {
    const s = book.skuMap.get(sku);
    if (!s || s.onHandBack <= 0) return;
    if (restockPending.has(sku) || !homeFor(sku)) return;
    if (hot) {
      restockWanted.delete(sku);
      buildRestockJob([sku], true);
      return;
    }
    restockWanted.add(sku);
    if (restockWanted.size >= BATCH_SKUS) flushRestocks();
    else scheduleFlush();
  };

  /** A facing down to its last few units gets a routine top-up. */
  const checkFacing = (sku: string) => {
    const s = book.skuMap.get(sku);
    if (!s) return;
    const cap = facingCap.get(sku) ?? 1;
    if (s.onFacing <= 0) wantRestock(sku, true);
    else if (s.onFacing <= cap * 0.35) wantRestock(sku, false);
  };

  // --------------------------------------------------------------- customers
  const customers: CustomerState[] = [];

  const takeLine = (cs: CustomerState, line: BasketLine, jobId: number) => {
    const sku = skuMap.get(line.sku);
    if (!sku) return;
    const { sold, lost } = book.sell(line.sku, line.units);
    if (sold > 0) {
      cs.taken.set(line.sku, (cs.taken.get(line.sku) ?? 0) + sold);
      cs.dollars += sold * sku.unitRetail;
      unitsTaken += sold;
      traceFacing(line.sku, -sold, "sale", jobId);
    }
    if (lost > 0) {
      shortAtShelf++;
      lostShelfUnits += lost;
      lostShelfDollars += lost * sku.unitRetail;
      cs.lostDollars += lost * sku.unitRetail;
      daily[dayOf(now)].shortAtShelf++;
      daily[dayOf(now)].lostShelfDollars += lost * sku.unitRetail;
      trace?.({ k: "short", t: now, sku: line.sku, units: lost, customer: cs.basket.id, order: null, hot: true, job: jobId });
      wantRestock(line.sku, true);
    }
    checkFacing(line.sku);
  };

  const leaveStore = (cs: CustomerState, bought: boolean) => {
    if (cs.left) return;
    cs.left = true;
    cs.phase = "gone";
    customersIn--;
    trace?.({ k: "customerLeave", t: now, customer: cs.basket.id, bought, dollars: cs.dollars, minutesInStore: now - cs.arrivedAt });
  };

  const joinRegister = (cs: CustomerState) => {
    // A basket with nothing in it never reaches the till.
    if (cs.taken.size === 0 && cs.servedUnits.size === 0) {
      leaveStore(cs, false);
      return;
    }
    cs.phase = "register";
    cs.queuedAt = now;
    const register = registerIds[0] ?? "REG-1";
    trace?.({ k: "queueJoin", t: now, customer: cs.basket.id, register, queueLen: queues.checkout.length + 1 });

    let units = 0;
    let weighed = 0;
    for (const [sku, n] of cs.taken) {
      units += n;
      if (skuMap.get(sku)?.sellBy === "weight") weighed++;
    }
    const lines = cs.taken.size + cs.servedUnits.size;
    const minutes = std.checkoutPerCustomer + lines * std.checkoutPerItem + (weighed * std.checkoutWeighSec) / 60 + (cs.basket.wrap ? std.giftWrapPerOrder : 0);
    let dollars = cs.dollars;
    for (const [sku, n] of cs.servedUnits) dollars += n * (skuMap.get(sku)?.unitRetail ?? 0);

    const job = pushJob({
      process: "checkout",
      ready: now,
      priority: PRIORITY.checkout,
      std: minutes,
      register: true,
      wrap: cs.basket.wrap,
      live: () => !cs.left,
      info: { kind: "checkout", customer: cs.basket.id, register, lines, units, weighed, wrap: cs.basket.wrap, dollars },
      onDone: (t, jobId) => {
        transactions++;
        tillDollars += dollars;
        unitsSold += units;
        if (cs.basket.wrap) giftWraps++;
        const wait = t - cs.queuedAt;
        registerWaits.push(wait);
        dayWaits[dayOf(t)].register.push(wait);
        const day = daily[dayOf(t)];
        day.transactions++;
        day.salesDollars += dollars;
        day.unitsSold += units;
        day.worstWaitMin = Math.max(day.worstWaitMin, wait);
        trace?.({ k: "sale", t, customer: cs.basket.id, register, waitMin: wait, lines, units, dollars, lostDollars: cs.lostDollars, job: jobId });
        leaveStore(cs, true);
      },
    });

    // Patience: if the line has not moved by then, the basket goes back.
    at(now + cs.patience, () => {
      if (cs.left || cs.phase !== "register") return;
      if (!queues.checkout.includes(job)) return;
      dropJob(job);
      abandonedRegister++;
      lostQueueDollars += dollars;
      const day = daily[dayOf(now)];
      day.abandoned++;
      day.lostQueueDollars += dollars;
      // An abandoned basket is re-shelved: the sale is lost, the stock is not.
      for (const [sku, n] of cs.taken) book.returnToShelf(sku, n);
      trace?.({ k: "abandon", t: now, customer: cs.basket.id, at: "register", waitMin: now - cs.queuedAt, dollars });
      leaveStore(cs, false);
    });
  };

  const joinCounter = (cs: CustomerState) => {
    cs.phase = "counter";
    cs.queuedAt = now;
    counterCustomers++;
    trace?.({ k: "counterJoin", t: now, customer: cs.basket.id, queueLen: queues.serve.length + 1 });

    const station = counterIds[0] ?? "CTR-1";
    const items = cs.basket.servedLines.length;
    const minutes = std.servePerCustomer + items * std.servePerItem;
    const job = pushJob({
      process: "serve",
      ready: now,
      priority: PRIORITY.serve,
      std: minutes,
      counter: true,
      live: () => !cs.left,
      info: { kind: "serve", customer: cs.basket.id, station, lines: cs.basket.servedLines.map((l) => ({ sku: l.sku, units: l.units })), wrap: cs.basket.wrap },
      onDone: (t, jobId) => {
        for (const l of cs.basket.servedLines) {
          const { sold, lost } = book.sell(l.sku, l.units);
          if (sold > 0) {
            cs.servedUnits.set(l.sku, (cs.servedUnits.get(l.sku) ?? 0) + sold);
            unitsTaken += sold;
            traceFacing(l.sku, -sold, "serve", jobId);
          }
          if (lost > 0) {
            const sku = skuMap.get(l.sku);
            shortAtShelf++;
            lostShelfUnits += lost;
            lostShelfDollars += lost * (sku?.unitRetail ?? 0);
            daily[dayOf(t)].shortAtShelf++;
            daily[dayOf(t)].lostShelfDollars += lost * (sku?.unitRetail ?? 0);
            wantRestock(l.sku, true);
          }
          checkFacing(l.sku);
        }
        counterServed++;
        const wait = t - cs.queuedAt;
        counterWaits.push(wait);
        dayWaits[dayOf(t)].counter.push(wait);
        daily[dayOf(t)].worstWaitMin = Math.max(daily[dayOf(t)].worstWaitMin, wait);
        trace?.({ k: "counterDone", t, customer: cs.basket.id, waitMin: wait, job: jobId });
        joinRegister(cs);
      },
    });

    at(now + cs.patience, () => {
      if (cs.left || cs.phase !== "counter") return;
      if (!queues.serve.includes(job)) return;
      dropJob(job);
      abandonedCounter++;
      let dollars = 0;
      for (const l of cs.basket.servedLines) dollars += l.units * (skuMap.get(l.sku)?.unitRetail ?? 0);
      lostQueueDollars += dollars;
      daily[dayOf(now)].abandoned++;
      daily[dayOf(now)].lostQueueDollars += dollars;
      trace?.({ k: "abandon", t: now, customer: cs.basket.id, at: "counter", waitMin: now - cs.queuedAt, dollars });
      // They still pay for whatever they picked up off the shelf themselves.
      joinRegister(cs);
    });
  };

  const admitCustomer = (basket: Basket) => {
    const close = closeMinOf(dayOf(basket.arriveMin));
    if (close !== null && basket.arriveMin >= close) return;
    const cs: CustomerState = {
      basket,
      entity: basket.id,
      arrivedAt: now,
      phase: "shopping",
      taken: new Map(),
      dollars: 0,
      lostDollars: 0,
      servedUnits: new Map(),
      queuedAt: now,
      patience: Math.max(1, basket.patienceMin * dis.patience),
      left: false,
    };
    customers.push(cs);
    customersIn++;
    daily[dayOf(now)].customers++;

    const selfLines = basket.lines.filter((l) => skuMap.get(l.sku)?.fixture !== "showcase");
    let units = 0;
    for (const l of basket.lines) units += l.units;
    trace?.({
      k: "customerArrive",
      t: now,
      customer: basket.id,
      kind: basket.kind,
      lines: basket.lines.length,
      units,
      dollars: basket.dollars,
      served: basket.servedLines.length,
      wrap: basket.wrap,
      stall: -1,
    });
    trace?.({
      k: "customerShop",
      t: now,
      customer: basket.id,
      stops: selfLines.map((l) => ({ sku: l.sku, units: l.units, facing: homeFor(l.sku)?.id ?? "" })),
      dwellMin: basket.dwellMin,
    });

    // Walking the floor takes as long as the fixtures are apart, on top of the
    // browsing the basket kind implies.
    let feet = 0;
    let prev = layout.entry;
    for (const l of selfLines) {
      const f = homeFor(l.sku);
      if (!f) continue;
      feet += walkDistance(layout, prev, f);
      prev = f;
    }
    const walkMin = feet / std.walkFtPerMin;
    const shopMin = Math.max(0.5, basket.dwellMin + walkMin);

    // Each line is taken as they reach it, so a restock part-way through a
    // visit really does save the sale.
    selfLines.forEach((l, i) => {
      at(now + (shopMin * (i + 1)) / (selfLines.length + 1), () => {
        if (cs.left) return;
        takeLine(cs, l, -1);
      });
    });

    at(now + shopMin, () => {
      if (cs.left) return;
      if (basket.servedLines.length === 0) {
        joinRegister(cs);
        return;
      }
      if (countersAvail(now) > 0) {
        joinCounter(cs);
        return;
      }
      // Nobody behind the glass. Everything that had to be weighed and boxed
      // is a sale the shop cannot make however full its shelves are, and it
      // has to be counted — otherwise closing the counter looks free, and an
      // optimizer will happily close it to save the standing cost.
      let dollars = 0;
      for (const l of basket.servedLines) dollars += l.units * (skuMap.get(l.sku)?.unitRetail ?? 0);
      abandonedCounter++;
      lostQueueDollars += dollars;
      daily[dayOf(now)].abandoned++;
      daily[dayOf(now)].lostQueueDollars += dollars;
      trace?.({ k: "abandon", t: now, customer: cs.basket.id, at: "counter", waitMin: 0, dollars });
      joinRegister(cs);
    });
  };

  // ------------------------------------------------------------ inbound
  const waitingTrucks: TruckState[] = [];

  const startTrucks = () => {
    while (waitingTrucks.length > 0 && busy.dock < docksAvail(now)) {
      accrueResources(now);
      busy.dock++;
      waitingTrucks.shift()!.start();
    }
  };

  const truckArrives = (po: { id: string; supplier: string; channel: "dc" | "direct"; lines: Array<{ sku: string; cases: number; units: number }>; cases: number }, d: number) => {
    const supplier = supplierMap.get(po.supplier);
    const importer = supplier?.kind === "importer";
    const mode: "overnight" | "direct" = po.channel === "dc" ? "overnight" : "direct";
    // The distribution center's trailer arrives on pallets; a vendor's box
    // truck is loose cases, so it is worked as one notional load.
    const pallets = mode === "overnight" ? buildPallets(po.lines, skuMap, std.palletCubeFt) : [];
    const list = pallets.length > 0 ? pallets : [{ items: po.lines.map((l) => ({ sku: l.sku, cases: l.cases })), mixed: true }];
    inboundTrucks++;
    inboundPallets += list.length;
    inboundCases += po.cases;
    daily[d].inboundTrucks++;
    daily[d].inboundCases += po.cases;
    palletsInFlight += list.length;
    const arrivedAt = now;

    trace?.({ k: "truckArrive", t: now, po: po.id, supplier: po.supplier, mode, importer, day: d, pallets: list });

    const state: TruckState = {
      po: po.id,
      supplier: po.supplier,
      mode,
      importer,
      arrivedAt,
      pallets: list,
      cases: po.cases,
      start: () => {
        doorWaits.push(now - arrivedAt);
        const door = dockDoors[busy.dock % Math.max(1, dockDoors.length)];
        trace?.({ k: "truckDock", t: now, po: po.id, door: door?.id ?? null, waitMin: now - arrivedAt });
        let left = list.length;
        list.forEach((p, i) => {
          const cases = p.items.reduce((a, it) => a + it.cases, 0);
          pushJob({
            process: "unload",
            ready: now,
            priority: PRIORITY.unload,
            std: (mode === "overnight" ? std.unloadPerPallet : cases * std.unloadPerCase) + (i === 0 ? std.unloadPerTruck : 0),
            palletJack: mode === "overnight",
            info: { kind: "unload", po: po.id, supplier: po.supplier, pallet: i, pallets: list.length, cases, door: door?.id ?? null, items: p.items },
            onDone: () => {
              left--;
              if (left === 0) {
                accrueResources(now);
                busy.dock--;
                trace?.({ k: "truckUndock", t: now, po: po.id });
                startTrucks();
              }
              pushJob({
                process: "receive",
                ready: now,
                priority: PRIORITY.receive,
                std: cases * std.receivePerCase + (importer ? cases * std.labelPerImportCase : 0),
                info: { kind: "receive", po: po.id, pallet: i, cases, importer, door: door?.id ?? null },
                onDone: () => {
                  const items = p.items.map((it) => {
                    const sku = skuMap.get(it.sku);
                    const units = sku ? it.cases * sku.innersPerCase * sku.unitsPerInner : 0;
                    return { sku: it.sku, units, loc: storageHome.get(it.sku) ?? "" };
                  });
                  const feet = 2 * (layout.storage.length > 0 ? Math.abs(layout.staging.y - layout.storage[0].y) + Math.abs(layout.staging.x - layout.storage[0].x) : 20);
                  pushJob({
                    process: "putaway",
                    ready: now,
                    priority: PRIORITY.putaway,
                    std: std.putawayHandling * Math.max(1, p.items.length) + feet / std.walkFtPerMin,
                    palletJack: mode === "overnight",
                    info: { kind: "putaway", po: po.id, pallet: i, items, feet },
                    onDone: (t, jobId) => {
                      palletsInFlight--;
                      dockToStock.push(t - arrivedAt);
                      for (const it of items) {
                        book.receive(it.sku, it.units);
                        traceFacing(it.sku, 0, "putaway", jobId);
                        checkFacing(it.sku);
                      }
                      trace?.({ k: "putaway", t, job: jobId, po: po.id, pallet: i, items, dockToStockMin: t - arrivedAt });
                    },
                  });
                },
              });
            },
          });
        });
      },
    };
    waitingTrucks.push(state);
    startTrucks();
  };

  // --------------------------------------------------------- special orders
  const orders: OrderState[] = [];

  const placeOrders = (d: number) => {
    for (const o of ordersPlacedOn(model, d, ctx.startWeek, orderRng)) {
      ordersPlaced++;
      const rec: OrderRecord = {
        id: o.id,
        kind: o.kind,
        dueDay: o.dueDay,
        dueMin: o.dueMin,
        pickedAt: null,
        packedAt: null,
        outAt: null,
        lateMin: 0,
        lines: o.lines.length,
        cutLines: 0,
        dollars: o.dollars,
        cutDollars: 0,
      };
      orderRecords.push(rec);
      const os: OrderState = {
        order: o,
        placedAt: now,
        dueAt: o.dueDay * 1440 + o.dueMin,
        lines: o.lines,
        cutLines: 0,
        cutDollars: 0,
        dollars: o.dollars,
        pending: 0,
        pickedUnits: 0,
        onRound: false,
        pickedAt: null,
        packedAt: null,
        outAt: null,
        rec,
      };
      orders.push(os);
      if (o.dueDay < opts.days) daily[o.dueDay].ordersDue++;
      trace?.({
        k: "orderPlaced",
        t: now,
        order: o.id,
        kind: o.kind,
        day: d,
        dueDay: o.dueDay,
        dueMin: o.dueMin,
        lines: o.lines.map((l) => ({ sku: l.sku, units: l.units, cut: 0 })),
        dollars: o.dollars,
        miles: o.miles,
        tours: 1,
      });
      // The pick starts when the crew comes in, before the doors open.
      const start = o.dueDay * 1440 + hhmm(site.times.pickStart);
      at(Math.max(start, now), () => queuePick(os));
    }
  };

  const queuePick = (os: OrderState) => {
    const facings: Facing[] = [];
    const lines: Array<{ sku: string; units: number; loc: string }> = [];
    for (const l of os.lines) {
      const f = homeFor(l.sku);
      if (f) facings.push(f);
      lines.push({ sku: l.sku, units: l.units, loc: f?.id ?? "" });
    }
    const feet = sShapeDistance(layout, facings);
    let units = 0;
    for (const l of os.lines) units += l.units;
    const walkMin = feet / std.walkFtPerMin;
    const handleMin = std.pickPerTour + os.lines.length * std.pickPerLine + units * std.pickPerUnit;
    const reaches = facings.filter((f) => !isGolden(f)).length;

    os.pending = 1;
    pushJob({
      process: "pick",
      ready: now,
      priority: PRIORITY.pick,
      std: walkMin + handleMin + (reaches * std.restockBendReachSec) / 60,
      cart: true,
      info: { kind: "pick", order: os.order.id, tour: 0, tours: 1, lines, feet, walkMin, handleMin, reaches },
      onDone: (t, jobId) => {
        let picked = 0;
        for (const l of os.lines) {
          const { picked: got, cut } = book.pick(l.sku, l.units);
          picked += got;
          if (got > 0) traceFacing(l.sku, -got, "pick", jobId);
          if (cut > 0) {
            os.cutLines++;
            const sku = skuMap.get(l.sku);
            os.cutDollars += cut * (sku?.unitRetail ?? 0);
            trace?.({ k: "short", t, sku: l.sku, units: cut, customer: null, order: os.order.id, hot: false, job: jobId });
          }
          checkFacing(l.sku);
        }
        os.pending = 0;
        os.pickedUnits = picked;
        unitsTaken += picked;
        os.pickedAt = t;
        os.rec.pickedAt = t;
        os.rec.cutLines = os.cutLines;
        os.rec.cutDollars = os.cutDollars;
        cutLines += os.cutLines;
        cutDollars += os.cutDollars;
        ordersPicked++;
        trace?.({ k: "orderPicked", t, order: os.order.id, lines: os.lines.length, units: picked });
        if (os.cutLines > 0) trace?.({ k: "orderCut", t, order: os.order.id, lines: os.cutLines, dollars: os.cutDollars });
        queuePack(os);
      },
    });
  };

  /**
   * A delivery or a collection is a sale like any other: it is rung up when
   * the customer takes it, not when it was picked. Counting it here keeps the
   * shop's takings whole — without it the twin would quietly drop an eighth of
   * candystore's dollars on the floor.
   */
  const completeOrder = (os: OrderState, t: number, van: number, reason: "notPicked" | "notPacked" | "notLoaded") => {
    if (os.outAt !== null) return;
    os.outAt = t;
    os.rec.outAt = t;
    const net = Math.max(0, os.dollars - os.cutDollars);
    orderDollars += net;
    ordersFulfilled++;
    unitsSold += os.pickedUnits;
    const day = daily[dayOf(t)];
    day.salesDollars += net;
    day.unitsSold += os.pickedUnits;

    const late = Math.max(0, t - os.dueAt);
    os.rec.lateMin = late;
    if (late > 0) {
      ordersLate++;
      orderLateMin += late;
      if (os.order.dueDay < opts.days) daily[os.order.dueDay].ordersLate++;
      trace?.({ k: "orderLate", t, order: os.order.id, lateMin: late, reason });
    }
    trace?.({ k: "orderOut", t, order: os.order.id, kind: os.order.kind, units: os.pickedUnits, dollars: net, lateMin: late, van });
  };

  const queuePack = (os: OrderState) => {
    pushJob({
      process: "pack",
      ready: now,
      priority: PRIORITY.pack,
      std: std.packPerOrder + os.lines.length * std.packPerLine + (os.order.wrap ? std.giftWrapPerOrder : 0),
      wrap: os.order.wrap,
      info: { kind: "pack", order: os.order.id, lines: os.lines.length, wrap: os.order.wrap },
      onDone: (t, jobId) => {
        os.packedAt = t;
        os.rec.packedAt = t;
        if (os.order.wrap) giftWraps++;
        trace?.({ k: "orderPacked", t, order: os.order.id, wrap: os.order.wrap, job: jobId });
        if (os.order.kind === "pickup") {
          // A collection order simply waits on the shelf by the door.
          completeOrder(os, t, -1, "notPacked");
          trace?.({ k: "orderCollected", t, order: os.order.id, lateMin: os.rec.lateMin });
        }
      },
    });
  };

  /**
   * A round takes every packed delivery order that is due by now, so an order
   * the morning pick missed rides the afternoon van rather than being
   * abandoned. The van is held a little while for an order that is picked but
   * still on the packing bench — a driver waits five minutes for a gift box —
   * but not indefinitely: after an hour it goes with what is loaded.
   */
  const runVan = (dueAt: number, attempt = 0) => {
    // `onRound` matters because a morning round that is still holding for the
    // packing bench can still be waiting when the afternoon one is raised, and
    // without it both would take the same orders and send two vans.
    const due = orders.filter((os) => os.order.kind === "delivery" && os.outAt === null && !os.onRound && os.dueAt <= dueAt);
    if (due.length === 0) return;
    const ready = due.filter((os) => os.packedAt !== null);
    if (ready.length < due.length && attempt < 12) {
      at(now + 5, () => runVan(dueAt, attempt + 1));
      return;
    }
    if (ready.length === 0) return;
    for (const os of ready) os.onRound = true;
    const vanIndex = 0;
    const stops = ready.length;
    const miles = std.routeBaseMiles + ready.reduce((a, os) => a + os.order.miles, 0);
    const ids = ready.map((os) => os.order.id);

    pushJob({
      process: "load",
      ready: now,
      priority: PRIORITY.load,
      std: std.loadPerVan + stops * std.loadPerOrder,
      van: true,
      info: { kind: "load", order: ids[0], van: vanIndex, orders: stops, departAt: dueAt },
      onDone: (t, jobId) => {
        trace?.({ k: "vanLoad", t, van: vanIndex, orders: ids, job: jobId });
        const late = Math.max(0, t - dueAt);
        vanRounds++;
        if (late > 0) vanLateRounds++;
        deliveryStops += stops;
        deliveryMiles += miles;
        trace?.({ k: "vanDepart", t, van: vanIndex, orders: ids, lateMin: late, stops, miles, job: jobId });
        // The order leaves the shop when the van does, so it is booked here
        // rather than when the round gets back — which also keeps every
        // `orderOut` stamped with the minute it was emitted.
        for (const os of ready) completeOrder(os, t, vanIndex, "notLoaded");

        pushJob({
          process: "deliver",
          ready: t,
          priority: PRIORITY.deliver,
          std: stops * std.deliverPerStop + miles * std.deliverPerMile,
          info: { kind: "deliver", van: vanIndex, orders: ids, stops, miles, departAt: dueAt },
          onDone: (t2) => {
            accrueResources(t2);
            busy.van--;
            trace?.({ k: "vanReturn", t: t2, van: vanIndex, minutes: t2 - t });
          },
        });
      },
    });
  };

  // ------------------------------------------------------------ the calendar
  const workerInfos: WorkerInfo[] = ctx.workers.map((w) => ({
    id: w.id,
    role: w.role,
    type: w.type,
    skills: w.skills,
    productivity: w.productivity * (w.type === "temp" ? costs.tempProductivity : 1),
    hourlyRate: w.type === "temp" ? costs.tempHourly : w.hourlyRate,
    overtimeMultiplier: w.type === "temp" ? 1 : costs.overtimeMultiplier,
  }));

  if (trace) {
    const facingInit: Array<[string, number]> = [];
    const backInit: Array<[string, number]> = [];
    const capInit: Array<[string, number]> = [];
    for (const s of book.skus) {
      facingInit.push([s.sku.id, s.onFacing]);
      backInit.push([s.sku.id, s.onHandBack]);
      capInit.push([s.sku.id, facingCap.get(s.sku.id) ?? 1]);
    }
    trace({
      k: "init",
      t: 0,
      store: site.id,
      storeName: site.name,
      startWeek: ctx.startWeek,
      days: opts.days,
      seed: opts.seed,
      horizonEnd,
      layoutName: layout.spec.name,
      registers: registerIds,
      counters: counterIds,
      wrap: wrapIds,
      entrances: layout.doors.filter((d) => d.kind === "entrance").map((d) => d.id),
      docks: layout.doors.filter((d) => d.kind === "dock").map((d) => d.id),
      ground: layout.doors.filter((d) => d.kind === "ground").map((d) => d.id),
      palletJacks: site.equipment.palletJacks,
      stockCarts: site.equipment.stockCarts,
      vans: site.equipment.vans,
      shifts: site.shifts.map((s) => ({ id: s.id, start: s.start, end: s.end, breakMin: s.breakMin, indirectMin: s.indirectMin })),
      operatingDays: site.operatingDays,
      hours: site.hours.map((h) => ({ day: h.day, open: h.open, close: h.close })),
      times: {
        orderCutoff: site.times.orderCutoff,
        pickStart: site.times.pickStart,
        vanDeparture: site.times.vanDeparture,
        vanSecondDeparture: site.times.vanSecondDeparture,
        overnightWindow: site.times.overnightWindow,
        directWindow: site.times.directWindow,
      },
      std,
      workers: workerInfos,
      outages: {
        registers: dis.registerOutages,
        counters: dis.counterOutages,
        vans: dis.vanOutages,
        docks: dis.dockOutages,
        pos: dis.posOutages,
      },
      facingCap: capInit,
      facing: facingInit,
      back: backInit,
      backLoc: catalog.skus.map((s) => [s.id, storageHome.get(s.id) ?? ""] as [string, string]),
      planogram: [...plan.entries()].map(([sku, f]) => [sku, f.id] as [string, string]),
      skuNames: catalog.skus.map((s) => [s.id, s.name] as [string, string]),
    });
  }

  // The planner works in horizon weeks (day = week * 7 + i), not calendar
  // weeks, and its assignments carry the horizon day.
  const scheduleCache = new Map<number, ReturnType<typeof buildWeekSchedule>>();
  const scheduleForWeek = (d: number) => {
    const week = Math.floor(d / 7);
    let s = scheduleCache.get(week);
    if (!s) {
      s = ctx.schedule ?? buildWeekSchedule(ctx.workloadContext, ctx.workers, week, ctx.scheduleOptions);
      scheduleCache.set(week, s);
    }
    return s;
  };

  for (let d = 0; d < opts.days; d++) {
    const dayStart = d * 1440;
    const weekday = weekdayOf(d);
    const operating = isOperating(site, d);

    at(dayStart, () => {
      for (const po of book.review(d)) {
        trace?.({ k: "poPlaced", t: now, po: po.id, supplier: po.supplier, channel: po.channel, placedDay: po.placedDay, arriveDay: po.arriveDay, cases: po.cases, pallets: po.pallets });
      }
      trace?.({
        k: "day",
        t: now,
        day: d,
        weekday,
        calendarWeek: calendarWeekOfDay(ctx.startWeek, d),
        operating,
        openMin: openMinOf(d) ?? -1,
        closeMin: closeMinOf(d) ?? -1,
      });
      if (!operating) return;

      // Inbound: the distribution center's trailer overnight, vendors by day.
      for (const po of book.arrivals(d)) {
        const overnight = po.channel === "dc";
        const [a, b] = (overnight ? site.times.overnightWindow : site.times.directWindow).map(hhmm);
        const appointment = a + arrivalRng() * (b - a);
        const late = dis.inboundLatenessSdMin > 0 ? normal(arrivalRng, 0, dis.inboundLatenessSdMin) : 0;
        const eta = dayStart + Math.max(a - 30, appointment + late);
        trace?.({ k: "truckScheduled", t: now, po: po.id, supplier: po.supplier, mode: overnight ? "overnight" : "direct", importer: supplierMap.get(po.supplier)?.kind === "importer", appointment: dayStart + appointment, eta, pallets: po.pallets, cases: po.cases });
        at(eta, () => truckArrives(po, d));
      }
    });

    if (!operating) continue;

    // Shoppers. The doors opening is scheduled for the minute it happens, not
    // announced at midnight when the day's arrivals are drawn: `t` has to be
    // the minute the event occurred, or the stream stops being non-decreasing
    // and every reducer downstream has to special-case it.
    at(dayStart, () => {
      for (const basket of customersOn(model, d, ctx.startWeek, shopperRng)) {
        at(basket.arriveMin, () => admitCustomer(basket));
      }
    });
    const open = openMinOf(d);
    if (open !== null) at(open, () => trace?.({ k: "doors", t: now, open: true, day: d }));
    const close = closeMinOf(d);
    if (close !== null) at(close, () => trace?.({ k: "doors", t: now, open: false, day: d }));

    // Orders for the next trading day are taken during this one.
    at(dayStart + hhmm(site.times.orderCutoff), () => placeOrders(d));

    // The van's rounds. Loading starts before the departure time, not at it —
    // otherwise every round would leave late by however long it takes to load.
    const vanOut = dayStart + hhmm(site.times.vanDeparture);
    at(vanOut - LOAD_LEAD_MIN, () => runVan(vanOut));
    if (site.times.vanSecondDeparture) {
      const t2 = dayStart + hhmm(site.times.vanSecondDeparture);
      at(t2 - LOAD_LEAD_MIN, () => runVan(t2));
    }

    // The morning fill: before the doors open, anything the floor is meaningfully
    // short of goes on a cart. Catalog order, not Map order, so the carts come
    // out the same way run to run.
    at(dayStart + hhmm(site.shifts[0].start) + site.shifts[0].indirectMin, () => {
      for (const s of [...book.skus].sort((a, b) => a.sku.id.localeCompare(b.sku.id))) {
        const cap = facingCap.get(s.sku.id) ?? 1;
        if (s.onHandBack > 0 && s.onFacing < cap * 0.75) restockWanted.add(s.sku.id);
      }
      flushRestocks();
    });

    // Clock-in per shift.
    const sched = scheduleForWeek(d);
    for (const shift of site.shifts) {
      const start = dayStart + hhmm(shift.start);
      const end = start + shiftPaidHours(shift.start, shift.end) * 60;
      at(start, () => {
        // Match on the weekday so a fixed schedule handed in by the optimizer
        // works as well as one built for this horizon week.
        for (const a of sched.assignments.filter((x) => x.day % 7 === d % 7 && x.shift === shift.id)) {
          const ws = workerById.get(a.worker);
          if (!ws) continue;
          if (onLeave(ws, d) || attendRng() < dis.absenteeism) {
            ws.rec.absences++;
            daily[d].absences++;
            trace?.({ k: "worker", t: now, id: ws.w.id, state: "absent", shift: shift.id });
            continue;
          }
          ws.present = true;
          ws.primary = a.primary;
          ws.shiftId = shift.id;
          ws.shiftStart = start;
          ws.shiftEnd = end;
          ws.breakMin = shift.breakMin;
          ws.breakAt = start + (end - start) / 2 - shift.breakMin / 2;
          ws.breakTaken = shift.breakMin <= 0;
          ws.lastShift = shift.id === closingShiftId;
          ws.busy = false;
          ws.onBreak = shift.indirectMin > 0;
          if (ws.onBreak) {
            at(start + shift.indirectMin, () => {
              ws.onBreak = false;
              trace?.({ k: "worker", t: now, id: ws.w.id, state: "indirectEnd" });
            });
          }
          ws.rec.shiftsWorked++;
          ws.rec.primaries[a.primary] = (ws.rec.primaries[a.primary] ?? 0) + 1;
          ws.rec.paidHours += (end - start - shift.breakMin) / 60;
          trace?.({
            k: "worker",
            t: now,
            id: ws.w.id,
            state: "in",
            shift: shift.id,
            primary: a.primary,
            shiftStart: start,
            shiftEnd: end,
            breakAt: ws.breakAt,
            breakMin: ws.breakMin,
            indirectMin: shift.indirectMin,
            lastShift: ws.lastShift,
          });
        }
      });
      // Wake-ups so dispatch runs when a shift ends and when overtime runs out.
      at(end, () => {});
      at(end + opts.overtimeMaxHours * 60, () => {});
    }

    at(dayStart + 1439, () => book.endDay());
  }

  // Orders for day 0 were taken the evening before the horizon began.
  at(0, () => placeOrders(-1));

  // ---------------------------------------------------------------- the loop
  while (events.size > 0) {
    const next = events.peekKey();
    if (next === undefined || next > horizonEnd) break;
    const e = events.pop();
    if (!e) break;
    now = e.key;
    e.value();
    dispatch();
  }
  now = horizonEnd;
  accrueResources(now);
  for (const ws of workers) if (ws.present) clockOut(ws);
  for (const [, since] of emptySince) emptyFacingMinutes += Math.max(0, horizonEnd - since);
  emptySince = new Map();
  trace?.({ k: "end", t: horizonEnd });

  // -------------------------------------------------------------- the report
  for (const os of orders) {
    if (os.outAt !== null) continue;
    const late = Math.max(0, horizonEnd - os.dueAt);
    os.rec.lateMin = late;
    if (late > 0) {
      ordersLate++;
      orderLateMin += late;
      if (os.order.dueDay < opts.days) daily[os.order.dueDay].ordersLate++;
    }
  }

  for (let d = 0; d < opts.days; d++) {
    const w = dayWaits[d];
    daily[d].counterWaitAvgMin = w.counter.length > 0 ? w.counter.reduce((a, b) => a + b, 0) / w.counter.length : 0;
    daily[d].registerWaitAvgMin = w.register.length > 0 ? w.register.reduce((a, b) => a + b, 0) / w.register.length : 0;
  }

  let paidHours = 0;
  let overtimeHours = 0;
  let busyHours = 0;
  let absences = 0;
  let regularCost = 0;
  let overtimeCost = 0;
  for (const ws of workers) {
    paidHours += ws.rec.paidHours;
    overtimeHours += ws.rec.overtimeHours;
    busyHours += ws.rec.busyHours;
    absences += ws.rec.absences;
    const rate = ws.w.type === "temp" ? costs.tempHourly : ws.w.hourlyRate;
    const otMult = ws.w.type === "temp" ? 1 : costs.overtimeMultiplier;
    regularCost += ws.rec.paidHours * rate;
    overtimeCost += ws.rec.overtimeHours * rate * otMult;
  }

  const firstStart = Math.min(...site.shifts.map((s) => hhmm(s.start)));
  const lastEnd = Math.max(...site.shifts.map((s) => hhmm(s.start) + shiftPaidHours(s.start, s.end) * 60));
  const opDays = daily.filter((d) => d.open).length;
  const opMin = Math.max(1, opDays * (lastEnd - firstStart));
  const openMinTotal = Math.max(
    1,
    daily.reduce((a, d) => {
      const h = hoursFor(d.day);
      return a + (h ? hhmm(h.close) - hhmm(h.open) : 0);
    }, 0)
  );

  const res = (count: number, mins: number, denom: number): ResourceStat => ({ count, utilization: count > 0 ? mins / (denom * count) : 0 });

  let bottleneck: OperationsResult["bottleneck"] = { process: null, constraint: "none: no process kept work waiting more than an hour in total", waitHours: 0 };
  for (const p of PROCESSES) {
    const wh = stats[p].waitTotalMin / 60;
    if (wh <= 1 || wh <= bottleneck.waitHours) continue;
    const equipment = stats[p].equipmentWaitMin > stats[p].waitTotalMin * 0.5;
    const what =
      p === "checkout"
        ? "registers"
        : p === "serve"
          ? "counter stations"
          : p === "restock" || p === "pick"
            ? "stock carts"
            : p === "load" || p === "deliver"
              ? "vans"
              : p === "unload" || p === "putaway"
                ? "goods doors or pallet jacks"
                : "equipment";
    bottleneck = { process: p, constraint: equipment ? `equipment: ${what}` : `labor: ${PROCESS_SKILL[p]} hours`, waitHours: wh };
  }

  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    store: site.id,
    storeName: site.name,
    startWeek: ctx.startWeek,
    days: opts.days,
    seed: opts.seed,
    sales: {
      customers: customers.length,
      transactions,
      unitsSold,
      salesDollars: tillDollars + orderDollars,
      tillDollars,
      orderDollars,
      averageBasket: transactions > 0 ? tillDollars / transactions : 0,
      lostShelfUnits,
      lostShelfDollars,
      lostQueueDollars,
      giftWraps,
      counterCustomers,
      counterServed,
    },
    service: {
      counterWaitAvgMin: avg(counterWaits),
      counterWaitP90Min: counterWaits.length > 0 ? quantile(counterWaits, 0.9) : 0,
      registerWaitAvgMin: avg(registerWaits),
      registerWaitP90Min: registerWaits.length > 0 ? quantile(registerWaits, 0.9) : 0,
      worstWaitMin: Math.max(0, ...counterWaits, ...registerWaits),
      abandonedCounter,
      abandonedRegister,
      abandonRate: customers.length > 0 ? (abandonedCounter + abandonedRegister) / customers.length : 0,
    },
    availability: {
      shortAtShelf,
      onShelfShare: unitsTaken + lostShelfUnits > 0 ? unitsTaken / (unitsTaken + lostShelfUnits) : 1,
      facingsInStock: book.shelfShare(),
      restocks,
      hotRestocks,
      emptyFacingMinutes,
    },
    orders: {
      placed: ordersPlaced,
      fulfilled: ordersFulfilled,
      dollars: orderDollars,
      picked: ordersPicked,
      cutLines,
      cutDollars,
      late: ordersLate,
      lateMinTotal: orderLateMin,
      vanRounds,
      vanLateRounds,
      stops: deliveryStops,
      miles: deliveryMiles,
    },
    inbound: {
      trucks: inboundTrucks,
      pallets: inboundPallets,
      cases: inboundCases,
      dockToStockAvgMin: avg(dockToStock),
      dockToStockP90Min: dockToStock.length > 0 ? quantile(dockToStock, 0.9) : 0,
      doorWaitAvgMin: avg(doorWaits),
      palletsNotPutAway: palletsInFlight,
    },
    processes: stats,
    labor: {
      paidHours,
      overtimeHours,
      busyHours,
      absences,
      regularCost,
      overtimeCost,
      utilization: paidHours + overtimeHours > 0 ? busyHours / (paidHours + overtimeHours) : 0,
      salesPerPaidHour: paidHours > 0 ? (tillDollars + orderDollars) / paidHours : 0,
      laborShareOfSales: tillDollars + orderDollars > 0 ? (regularCost + overtimeCost) / (tillDollars + orderDollars) : 0,
    },
    resources: {
      registers: res(registerIds.length, busyMin.register, openMinTotal),
      counters: res(counterIds.length, busyMin.counter, openMinTotal),
      wrap: res(wrapIds.length, busyMin.wrap, openMinTotal),
      palletJacks: res(site.equipment.palletJacks, busyMin.palletJack, opMin),
      stockCarts: res(site.equipment.stockCarts, busyMin.cart, opMin),
      vans: res(site.equipment.vans, busyMin.van, opMin),
      docks: res(dockDoors.length, busyMin.dock, Math.max(1, opDays * 1440)),
    },
    stock: {
      retailStart,
      retailEnd: book.retailValue(),
      backroomCases: book.backroomCases(),
      backroomPositions: layout.storage.length,
    },
    bottleneck,
    orderRecords,
    workers: workers.map((ws) => ws.rec),
    daily,
  };
}
