/**
 * The running KPI reducer.
 *
 * Every figure accrues at the same point the engine accrues it: a customer at
 * `customerArrive`, a transaction and its dollars at `sale`, a lost basket at
 * `abandon`, an order's takings when the customer gets it, paid hours at
 * clock-in, busy hours at job start, overtime at clock-out. `finalize` then
 * closes the books the way `runOperations` does at the horizon — the facings
 * still empty accrue to the end and the orders still open become late. The
 * result is that `projectKpis(state, horizonEnd, init, samples, true)`
 * reproduces the MCP tools' `kpis(result)`, which is what makes "same engine,
 * same numbers" true rather than a claim (kpis.test.ts and compile.test.ts pin
 * it).
 *
 * Three things the stream does not say out loud are rebuilt in the one prepass
 * `kpiContext` makes, and are immutable afterwards:
 *
 * - **Counter short-falls.** When the glass runs out mid-order the engine
 *   counts the lost units and dollars but emits no event, so the prepass
 *   subtracts what the `facing` events say came out of the case from what the
 *   `serve` job asked for, and attaches the difference to `counterDone`.
 * - **The empty-facing stopwatch.** It is a per-SKU clock, and `RunningKpis` is
 *   a flat record of scalars, so the prepass replays the facings once and
 *   attaches the minutes each refill closes out.
 * - **Orders still out.** An order that never reached its customer is late by
 *   however long it has been waiting, and the stream can only say so by the
 *   absence of an `orderOut`; the prepass collects them.
 *
 * Because those steps are precomputed and immutable, a checkpoint plus a replay
 * of the events since gives exactly the state a replay from init gives.
 */

import { weekdayOf } from "../twin/demand";
import type { Kpis } from "../twin/replicate";
import { hhmm } from "../twin/standards";
import { PROCESSES, type Process } from "../twin/types";
import { mean, quantile } from "../util/random";
import type { RunningKpis, SkuInfo, TraceEvent, TraceInit, WorkerInfo } from "./types";

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

/**
 * What one event does to the books the stream does not carry, worked out in the
 * prepass because it needs the whole stream or per-SKU state to know. Attached
 * to the event object itself, so `applyEvent` can find it without an index and
 * a replay from a checkpoint sees exactly the same numbers.
 */
export interface EventStep {
  /** Empty-facing minutes this event closes out. */
  emptyMin: number;
  /** Counter lines the glass could not fill, in the engine's own order. */
  shorts: Array<{ units: number; dollars: number }>;
}

const NO_STEP: EventStep = { emptyMin: 0, shorts: [] };

export interface KpiContext {
  init: TraceInit;
  /** SKU id → retail price of one selling unit (a piece, or a pound). */
  retail: Map<string, number>;
  workers: Map<string, WorkerInfo>;
  /** Job id → process, from `jobQueued`. */
  jobProcess: Map<number, Process>;
  /** Restock job ids that were queued hot: an empty facing, not a top-up. */
  hotJobs: Set<number>;
  /** Orders never dispatched or collected, with the minute they were due. */
  openOrders: Array<{ order: string; dueAt: number }>;
  /** Checkout job ids whose customer wanted a gift wrap. */
  wrapJobs: Set<number>;
  /** Jobs that held a stock cart, and jobs that held a pallet jack. */
  cartJobs: Set<number>;
  jackJobs: Set<number>;
  /** PO id → master cases on it, from `truckScheduled`. */
  poCases: Map<string, number>;
  /** Per event, the books it moves; absent means none. */
  steps: Map<TraceEvent, EventStep>;
  /** Empty spells still open at the end of the stream, in the engine's own order. */
  emptyAtEnd: number[];
  /** Merchandised facings: what a shelf-level availability figure divides by. */
  ratedFacings: number;
}

/** One pass over the whole stream: the static facts the reducer needs at any point. */
export function kpiContext(init: TraceInit, events: readonly TraceEvent[], skus: readonly SkuInfo[]): KpiContext {
  const retail = new Map(skus.map((s) => [s.id, s.unitRetail]));
  const workers = new Map(init.workers.map((w) => [w.id, w]));
  const jobProcess = new Map<number, Process>();
  const hotJobs = new Set<number>();
  const wrapJobs = new Set<number>();
  const cartJobs = new Set<number>();
  const jackJobs = new Set<number>();
  const poCases = new Map<string, number>();
  const steps = new Map<TraceEvent, EventStep>();

  // A trailer comes on pallets and is worked with a jack; a vendor's box truck
  // is loose cases and is not, which is what decides whether a job held one.
  const palletised = new Set<string>();

  const emptySince = new Map<string, number>();
  /** Per serve job: what was asked for at the glass, and what came out of it. */
  const serveWant = new Map<number, Array<{ sku: string; units: number }>>();
  const serveSold = new Map<number, Map<string, number>>();
  /** Orders placed and not yet out, with the minute they were promised for. */
  const open = new Map<string, number>();

  const step = (e: TraceEvent): EventStep => {
    let s = steps.get(e);
    if (!s) {
      s = { emptyMin: 0, shorts: [] };
      steps.set(e, s);
    }
    return s;
  };

  for (const e of events) {
    switch (e.k) {
      case "jobQueued": {
        jobProcess.set(e.job, e.process);
        const info = e.info;
        if (info.kind === "restock") {
          if (info.hot) hotJobs.add(e.job);
          // One line is carried by hand; a round of the floor takes a cart.
          else if (info.lines.length > 1) cartJobs.add(e.job);
        } else if (info.kind === "checkout") {
          if (info.wrap) wrapJobs.add(e.job);
        } else if (info.kind === "pick") {
          cartJobs.add(e.job);
        } else if (info.kind === "serve") {
          serveWant.set(e.job, info.lines.map((l) => ({ sku: l.sku, units: l.units })));
        } else if ((info.kind === "unload" || info.kind === "putaway") && palletised.has(info.po)) {
          jackJobs.add(e.job);
        }
        break;
      }
      case "truckScheduled":
        poCases.set(e.po, e.cases);
        break;
      case "truckArrive":
        if (e.mode === "overnight") palletised.add(e.po);
        if (!poCases.has(e.po)) poCases.set(e.po, e.pallets.reduce((a, p) => a + p.items.reduce((b, it) => b + it.cases, 0), 0));
        break;

      case "facing": {
        // The engine's own empty stopwatch: it starts on the first traced zero
        // and stops on the first traced refill.
        const since = emptySince.get(e.sku);
        if (e.facing <= 0 && since === undefined) emptySince.set(e.sku, e.t);
        else if (e.facing > 0 && since !== undefined) {
          step(e).emptyMin = e.t - since;
          emptySince.delete(e.sku);
        }
        if (e.reason === "serve") {
          const sold = serveSold.get(e.job) ?? new Map<string, number>();
          sold.set(e.sku, (sold.get(e.sku) ?? 0) + -e.delta);
          serveSold.set(e.job, sold);
        }
        break;
      }
      case "counterDone": {
        const want = serveWant.get(e.job);
        if (!want) break;
        const sold = serveSold.get(e.job);
        const s = step(e);
        for (const l of want) {
          const lost = l.units - (sold?.get(l.sku) ?? 0);
          if (lost > 0) s.shorts.push({ units: lost, dollars: lost * (retail.get(l.sku) ?? 0) });
        }
        serveWant.delete(e.job);
        serveSold.delete(e.job);
        break;
      }

      case "orderPlaced":
        open.set(e.order, e.dueDay * 1440 + e.dueMin);
        break;
      case "orderOut":
        open.delete(e.order);
        break;
      default:
        break;
    }
  }

  const openOrders = [...open].map(([order, dueAt]) => ({ order, dueAt }));
  let ratedFacings = 0;
  for (const [, cap] of init.facingCap) if (cap > 0) ratedFacings++;

  return {
    init,
    retail,
    workers,
    jobProcess,
    hotJobs,
    openOrders,
    wrapJobs,
    cartJobs,
    jackJobs,
    poCases,
    steps,
    emptyAtEnd: [...emptySince.values()],
    ratedFacings,
  };
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

/**
 * The figures that do not fit in `RunningKpis`, which is the page's flat record
 * and cannot be changed here. They are optional so a plain `RunningKpis` — a
 * checkpoint read back off a `Playback`, say — is still a legal argument; the
 * compiler's own state always carries them.
 */
export interface ExtraState {
  /** Minutes merchandised facings have stood empty, closed spells only. */
  emptyFacingMin?: number;
  /** Selling units that came off the shelf or the back and went out of the shop. */
  unitsTaken?: number;
  /** Selling units a customer wanted and the shelf did not have. */
  lostShelfUnits?: number;
  /** Dollars rung at a till, and dollars of orders handed over, kept apart. */
  tillDollars?: number;
  orderDollars?: number;
}

export type KpiState = RunningKpis & ExtraState;

export function createState(init: TraceInit): KpiState {
  void init;
  return {
    customers: 0,
    transactions: 0,
    unitsSold: 0,
    salesDollars: 0,
    lostShelfDollars: 0,
    lostQueueDollars: 0,
    abandonedCounter: 0,
    abandonedRegister: 0,
    counterServed: 0,
    counterWaitSum: 0,
    counterWaitN: 0,
    registerWaitSum: 0,
    registerWaitN: 0,
    worstWaitMin: 0,
    giftWraps: 0,
    shortAtShelf: 0,
    restocks: 0,
    hotRestocks: 0,
    ordersPlaced: 0,
    ordersPicked: 0,
    ordersLate: 0,
    orderLateMin: 0,
    ordersCutDollars: 0,
    vanRounds: 0,
    vanLateRounds: 0,
    deliveryStops: 0,
    inboundTrucks: 0,
    inboundPallets: 0,
    inboundCases: 0,
    palletsInFlight: 0,
    dockToStockN: 0,
    doorWaitN: 0,
    paidHours: 0,
    overtimeHours: 0,
    busyHours: 0,
    absences: 0,
    regularCost: 0,
    overtimeCost: 0,
    presentWorkers: 0,
    busyWorkers: 0,
    inStore: 0,
    jacksBusy: 0,
    cartsBusy: 0,
    registersBusy: 0,
    countersBusy: 0,
    lastT: 0,
    queues: PROCESSES.map(() => 0),
    emptyFacingMin: 0,
    unitsTaken: 0,
    lostShelfUnits: 0,
    tillDollars: 0,
    orderDollars: 0,
  };
}

export function cloneState(s: KpiState): KpiState {
  return { ...s, queues: [...s.queues] };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Minutes a resource was held. The engine releases it when the job ends, and a
 * job still running at the horizon is cut there, so what it charged is the part
 * of the duration inside the horizon.
 */
function held(dur: number, t: number, horizonEnd: number): number {
  return Math.min(dur, Math.max(0, horizonEnd - t));
}

const qi = (p: Process): number => PROCESSES.indexOf(p);

export function applyEvent(s: KpiState, e: TraceEvent, ctx: KpiContext): void {
  // The engine dates the doors event by the opening minute and an order's
  // lateness by the minute the van left, so the clock only moves forward.
  if (e.t > s.lastT) s.lastT = e.t;
  const horizonEnd = ctx.init.horizonEnd;
  const step = ctx.steps.get(e) ?? NO_STEP;
  if (step.emptyMin !== 0) s.emptyFacingMin = (s.emptyFacingMin ?? 0) + step.emptyMin;
  for (const x of step.shorts) {
    s.shortAtShelf++;
    s.lostShelfUnits = (s.lostShelfUnits ?? 0) + x.units;
    s.lostShelfDollars += x.dollars;
  }

  switch (e.k) {
    case "truckArrive":
      s.inboundTrucks++;
      s.inboundPallets += e.pallets.length;
      s.palletsInFlight += e.pallets.length;
      s.inboundCases += ctx.poCases.get(e.po) ?? 0;
      break;
    case "truckDock":
      s.doorWaitN++;
      break;
    case "putaway":
      s.dockToStockN++;
      s.palletsInFlight--;
      break;

    case "jobQueued":
      s.queues[qi(e.process)] = e.queueLen;
      break;
    case "jobStart": {
      const p = ctx.jobProcess.get(e.job);
      if (p) s.queues[qi(p)] = Math.max(0, s.queues[qi(p)] - 1);
      s.busyHours += e.dur / 60;
      s.busyWorkers++;
      const min = held(e.dur, e.t, horizonEnd);
      if (p === "checkout") s.registersBusy += min;
      else if (p === "serve") s.countersBusy += min;
      if (ctx.cartJobs.has(e.job)) s.cartsBusy += min;
      if (ctx.jackJobs.has(e.job)) s.jacksBusy += min;
      break;
    }
    case "jobEnd":
      s.busyWorkers--;
      // A restock is a trip, not a SKU: one job takes a cart round a run of
      // facings, so the count is jobs finished, which is what the engine
      // counts. Counting the lines instead would report a morning fill as
      // fourteen restocks and make the figure meaningless.
      if (ctx.jobProcess.get(e.job) === "restock") {
        s.restocks++;
        if (ctx.hotJobs.has(e.job)) s.hotRestocks++;
      }
      break;

    case "facing":
      // What actually left the shop through a customer's hands or an order.
      if (e.reason === "sale" || e.reason === "serve" || e.reason === "pick") s.unitsTaken = (s.unitsTaken ?? 0) + -e.delta;
      break;
    case "short":
      // A pick cut is counted as cut dollars at `orderCut`, not as a shelf short.
      if (e.customer !== null) {
        s.shortAtShelf++;
        s.lostShelfUnits = (s.lostShelfUnits ?? 0) + e.units;
        s.lostShelfDollars += e.units * (ctx.retail.get(e.sku) ?? 0);
      }
      break;

    case "customerArrive":
      s.customers++;
      s.inStore++;
      break;
    case "customerLeave":
      s.inStore--;
      break;
    case "counterDone":
      s.counterServed++;
      s.counterWaitSum += e.waitMin;
      s.counterWaitN++;
      s.worstWaitMin = Math.max(s.worstWaitMin, e.waitMin);
      break;
    case "sale":
      s.transactions++;
      s.tillDollars = (s.tillDollars ?? 0) + e.dollars;
      s.salesDollars += e.dollars;
      s.unitsSold += e.units;
      if (ctx.wrapJobs.has(e.job)) s.giftWraps++;
      s.registerWaitSum += e.waitMin;
      s.registerWaitN++;
      s.worstWaitMin = Math.max(s.worstWaitMin, e.waitMin);
      break;
    case "abandon":
      if (e.at === "counter") {
        s.abandonedCounter++;
        s.queues[qi("serve")] = Math.max(0, s.queues[qi("serve")] - 1);
      } else {
        s.abandonedRegister++;
        s.queues[qi("checkout")] = Math.max(0, s.queues[qi("checkout")] - 1);
      }
      s.lostQueueDollars += e.dollars;
      break;

    case "orderPlaced":
      s.ordersPlaced++;
      break;
    case "orderPicked":
      s.ordersPicked++;
      break;
    case "orderPacked":
      if (e.wrap) s.giftWraps++;
      break;
    case "orderCut":
      s.ordersCutDollars += e.dollars;
      break;
    case "orderOut":
      // An order is a sale like any other, rung up when the customer gets it —
      // and this is the one event that says so. Its dollars, its units and its
      // lateness are all read from here, never rebuilt out of `orderLate`,
      // `orderCollected` and `vanDepart`: those fire per attempt and per round
      // rather than per order, and adding them up counts a stubborn order twice.
      s.orderDollars = (s.orderDollars ?? 0) + e.dollars;
      s.salesDollars += e.dollars;
      s.unitsSold += e.units;
      if (e.lateMin > 0) {
        s.ordersLate++;
        s.orderLateMin += e.lateMin;
      }
      break;
    case "vanDepart":
      s.vanRounds++;
      if (e.lateMin > 0) s.vanLateRounds++;
      s.deliveryStops += e.stops;
      break;

    case "worker": {
      const w = ctx.workers.get(e.id);
      const rate = w?.hourlyRate ?? 0;
      if (e.state === "in") {
        const paid = ((e.shiftEnd ?? 0) - (e.shiftStart ?? 0) - (e.breakMin ?? 0)) / 60;
        s.paidHours += paid;
        s.regularCost += paid * rate;
        s.presentWorkers++;
      } else if (e.state === "absent") {
        s.absences++;
      } else if (e.state === "out") {
        const ot = (e.overtimeMin ?? 0) / 60;
        s.overtimeHours += ot;
        s.overtimeCost += ot * rate * (w?.overtimeMultiplier ?? 1);
        s.presentWorkers--;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Close the books at the horizon, the way `runOperations` does after its loop:
 * every facing still empty accrues to the end, and every order never dispatched
 * or collected is late by however long it has been waiting.
 */
export function finalize(s: KpiState, horizonEnd: number, ctx: KpiContext): void {
  if (horizonEnd > s.lastT) s.lastT = horizonEnd;
  for (const since of ctx.emptyAtEnd) s.emptyFacingMin = (s.emptyFacingMin ?? 0) + Math.max(0, horizonEnd - since);
  for (const o of ctx.openOrders) {
    const late = Math.max(0, horizonEnd - o.dueAt);
    if (late > 0) {
      s.ordersLate++;
      s.orderLateMin += late;
    }
  }
}

/**
 * Minutes the shop's doors were open: the whole horizon when `full`, otherwise
 * up to `t`. This is what the engine divides register and counter busy minutes
 * by, so a till that ran three hours of a ten-hour day reads 30%.
 */
export function openMinutes(init: TraceInit, t: number, full: boolean): number {
  const hours = new Map(init.hours.map((h) => [h.day, h]));
  let total = 0;
  for (let d = 0; d < init.days; d++) {
    const wd = weekdayOf(d);
    if (!init.operatingDays.includes(wd)) continue;
    const h = hours.get(wd);
    if (!h) continue;
    const open = hhmm(h.open);
    const close = hhmm(h.close);
    total += full ? close - open : Math.max(0, Math.min(close - open, t - (d * 1440 + open)));
  }
  return Math.max(1, total);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The sample arrays the compiler collects alongside the state. They are here
 * rather than in the state because a p90 needs every observation, and they are
 * Float32 because they cross to the page as transferable buffers — which costs
 * the last few digits of the sampled averages and percentiles, and nothing else.
 */
export interface KpiSamples {
  dockToStock: ArrayLike<number>;
  counterWait: ArrayLike<number>;
  registerWait: ArrayLike<number>;
  orderCycle: ArrayLike<number>;
}

function head(a: ArrayLike<number>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(n, a.length); i++) out.push(a[i]);
  return out;
}

/**
 * The tools' `Kpis` at minute t. `final` means the state has been finalized at
 * the horizon, so the orders still open count as late and the utilizations
 * divide by the whole horizon's trading minutes rather than the minutes so far.
 */
export function projectKpis(s: KpiState, t: number, init: TraceInit, samples: KpiSamples, final: boolean): Kpis {
  const dts = head(samples.dockToStock, s.dockToStockN);
  const cw = head(samples.counterWait, s.counterWaitN);
  const rw = head(samples.registerWait, s.registerWaitN);
  const till = s.tillDollars ?? 0;
  const salesDollars = till + (s.orderDollars ?? 0);
  const lost = s.lostShelfDollars + s.lostQueueDollars;
  const potential = salesDollars + lost;
  const abandoned = s.abandonedCounter + s.abandonedRegister;
  const paidAndOvertime = s.paidHours + s.overtimeHours;
  const laborCost = s.regularCost + s.overtimeCost;
  const taken = s.unitsTaken ?? 0;
  const missed = s.lostShelfUnits ?? 0;
  const openMin = openMinutes(init, t, final);

  return {
    customers: s.customers,
    transactions: s.transactions,
    unitsSold: s.unitsSold,
    salesDollars,
    averageBasket: s.transactions > 0 ? till / s.transactions : 0,
    conversionRate: s.customers > 0 ? s.transactions / s.customers : 0,

    lostShelfDollars: s.lostShelfDollars,
    lostQueueDollars: s.lostQueueDollars,
    lostSalesShare: potential > 0 ? lost / potential : 0,

    // Availability as the customer meets it: the share of what was reached for
    // that was actually there.
    onShelfShare: taken + missed > 0 ? taken / (taken + missed) : 1,
    shortAtShelf: s.shortAtShelf,
    emptyFacingHours: (s.emptyFacingMin ?? 0) / 60,
    restocks: s.restocks,
    hotRestocks: s.hotRestocks,

    counterWaitAvgMin: s.counterWaitN > 0 ? s.counterWaitSum / s.counterWaitN : 0,
    counterWaitP90Min: quantile(cw, 0.9),
    registerWaitAvgMin: s.registerWaitN > 0 ? s.registerWaitSum / s.registerWaitN : 0,
    registerWaitP90Min: quantile(rw, 0.9),
    worstWaitMin: s.worstWaitMin,
    abandoned,
    abandonRate: s.customers > 0 ? abandoned / s.customers : 0,
    giftWraps: s.giftWraps,

    ordersPlaced: s.ordersPlaced,
    ordersLate: s.ordersLate,
    orderLateMinTotal: s.orderLateMin,
    orderCutDollars: s.ordersCutDollars,
    vanRounds: s.vanRounds,
    vanLateRounds: s.vanLateRounds,

    inboundTrucks: s.inboundTrucks,
    inboundCases: s.inboundCases,
    dockToStockAvgMin: mean(dts),
    dockToStockP90Min: quantile(dts, 0.9),
    palletsNotPutAway: s.palletsInFlight,

    paidHours: s.paidHours,
    overtimeHours: s.overtimeHours,
    busyHours: s.busyHours,
    utilization: paidAndOvertime > 0 ? s.busyHours / paidAndOvertime : 0,
    absences: s.absences,
    laborCost,
    laborShareOfSales: salesDollars > 0 ? laborCost / salesDollars : 0,
    salesPerPaidHour: s.paidHours > 0 ? salesDollars / s.paidHours : 0,

    registerUtilization: init.registers.length > 0 ? s.registersBusy / (openMin * init.registers.length) : 0,
    counterUtilization: init.counters.length > 0 ? s.countersBusy / (openMin * init.counters.length) : 0,
  };
}
