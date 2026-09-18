/**
 * The contract between the simulation and the 3D page.
 *
 * Layer 1 is `TraceEvent`: a small, id-based, structured-clone-safe union the
 * engine emits at its own clock. Emitting never draws from a random stream,
 * never schedules an event and never touches engine state, so a traced run and
 * an untraced one produce identical numbers.
 *
 * Layer 2 is `compilePlayback` (compile.ts), which turns that stream plus a
 * `Layout` and a synthesized `World` into typed arrays the renderer samples
 * once a frame. Everything the engine does not decide — which register, which
 * dock, which cart, which parking stall, how a shopper walks between two
 * fixtures, where the van goes — is synthesized there as a pure function of
 * the ordered stream, so the same seed always plays back the same way and the
 * animation can never feed back into the results.
 *
 * Geometry everywhere: feet, x across the store, y from the storefront (y = 0)
 * toward the back wall, the parking lot at y < 0, z is height. The renderer
 * maps (x, y, z) to three.js (X = x, Y = z, Z = -y).
 *
 * `t` is engine minutes from 00:00 on horizon day 0, and is non-decreasing
 * across the whole stream: `init` at 0, `end` at `horizonEnd`.
 */

import type { Facing, Layout, StoragePosition } from "../twin/layout";
import type { BasketKind } from "../twin/demand";
import type { Kpis } from "../twin/replicate";
import type { LaborStandards, Process, Skill } from "../twin/types";

// ---------------------------------------------------------------------------
// The tracer
// ---------------------------------------------------------------------------

export interface Tracer {
  readonly enabled: boolean;
  emit(e: TraceEvent): void;
}

export const NOOP_TRACER: Tracer = { enabled: false, emit() {} };

export class RecordingTracer implements Tracer {
  readonly enabled = true;
  readonly events: TraceEvent[] = [];
  emit(e: TraceEvent): void {
    this.events.push(e);
  }
}

// ---------------------------------------------------------------------------
// Static information carried in `init`
// ---------------------------------------------------------------------------

export interface WorkerInfo {
  id: string;
  role: string;
  type: "full-time" | "part-time" | "temp";
  skills: Skill[];
  /** Roster productivity, already multiplied by the temp factor for temps. */
  productivity: number;
  hourlyRate: number;
  overtimeMultiplier: number;
}

export interface ShiftInfo {
  id: string;
  start: string;
  end: string;
  breakMin: number;
  indirectMin: number;
}

export interface DayHours {
  day: number;
  open: string;
  close: string;
}

/** A window an outage covers, in horizon days. */
export interface OutageSpan {
  fromDay: number;
  toDay: number;
  count: number;
}

export interface TraceInit {
  k: "init";
  t: 0;
  store: string;
  storeName: string;
  startWeek: number;
  days: number;
  seed: number;
  /** days × 1440. */
  horizonEnd: number;
  layoutName: string;

  /** Service point ids, in layout order. */
  registers: string[];
  counters: string[];
  wrap: string[];
  /** Door ids by kind, in layout order. */
  entrances: string[];
  docks: string[];
  ground: string[];

  palletJacks: number;
  stockCarts: number;
  vans: number;

  shifts: ShiftInfo[];
  operatingDays: number[];
  hours: DayHours[];
  times: {
    orderCutoff: string;
    pickStart: string;
    vanDeparture: string;
    vanSecondDeparture: string | null;
    overnightWindow: [string, string];
    directWindow: [string, string];
  };
  /** The standards this run used. */
  std: LaborStandards;
  workers: WorkerInfo[];
  outages: {
    registers: OutageSpan[];
    counters: OutageSpan[];
    vans: OutageSpan[];
    docks: OutageSpan[];
    /** The till network being down; count is unused. */
    pos: Array<{ day: number; start: string; hours: number }>;
  };

  /** Selling units a facing holds when full, per SKU. */
  facingCap: Array<[sku: string, units: number]>;
  /** Units on the shelf after the warm-up. */
  facing: Array<[sku: string, units: number]>;
  /** Units in the stockroom after the warm-up. */
  back: Array<[sku: string, units: number]>;
  /** The stockroom position a SKU goes home to. */
  backLoc: Array<[sku: string, loc: string]>;
  /** The planogram: which facing each SKU is merchandised in. */
  planogram: Array<[sku: string, facing: string]>;
  /** Display names, so the ticker and the inspector can read well. */
  skuNames: Array<[sku: string, name: string]>;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * The per-job payload, attached where the job is queued. Near one-to-one with
 * `Process`; `serve` and `checkout` carry the customer they belong to.
 */
export type JobInfo =
  | { kind: "unload"; po: string; supplier: string; pallet: number; pallets: number; cases: number; door: string | null; items: Array<{ sku: string; cases: number }> }
  | { kind: "receive"; po: string; pallet: number; cases: number; importer: boolean; door: string | null }
  | { kind: "putaway"; po: string; pallet: number; items: Array<{ sku: string; units: number; loc: string }>; feet: number }
  | { kind: "restock"; cart: number; hot: boolean; trips: number; lines: Array<{ sku: string; units: number; from: string; to: string }>; feet: number; trays: number }
  | { kind: "serve"; customer: string; station: string; lines: Array<{ sku: string; units: number }>; wrap: boolean }
  | { kind: "checkout"; customer: string; register: string; lines: number; units: number; weighed: number; wrap: boolean; dollars: number }
  | { kind: "pick"; order: string; tour: number; tours: number; lines: Array<{ sku: string; units: number; loc: string }>; feet: number; walkMin: number; handleMin: number; reaches: number }
  | { kind: "pack"; order: string; lines: number; wrap: boolean }
  | { kind: "load"; order: string; van: number; orders: number; departAt: number }
  | { kind: "deliver"; van: number; orders: string[]; stops: number; miles: number; departAt: number };

// ---------------------------------------------------------------------------
// The event union
// ---------------------------------------------------------------------------

export type TraceEvent =
  | TraceInit
  | { k: "day"; t: number; day: number; weekday: number; calendarWeek: number; operating: boolean; openMin: number; closeMin: number }
  | { k: "doors"; t: number; open: boolean; day: number }

  // Supply in
  | { k: "poPlaced"; t: number; po: string; supplier: string; channel: "dc" | "direct"; placedDay: number; arriveDay: number; cases: number; pallets: number }
  | { k: "truckScheduled"; t: number; po: string; supplier: string; mode: "overnight" | "direct"; importer: boolean; appointment: number; eta: number; pallets: number; cases: number }
  | { k: "truckArrive"; t: number; po: string; supplier: string; mode: "overnight" | "direct"; importer: boolean; day: number; pallets: Array<{ items: Array<{ sku: string; cases: number }>; mixed: boolean }> }
  | { k: "truckDock"; t: number; po: string; door: string | null; waitMin: number }
  | { k: "truckUndock"; t: number; po: string }

  // Work
  | { k: "jobQueued"; t: number; job: number; process: Process; priority: number; queueLen: number; info: JobInfo }
  | { k: "jobStart"; t: number; job: number; worker: string; dur: number; waitMin: number; equipWaitMin: number; productivity: number }
  | { k: "jobEnd"; t: number; job: number; worker: string }
  | { k: "putaway"; t: number; job: number; po: string; pallet: number; items: Array<{ sku: string; units: number; loc: string }>; dockToStockMin: number }

  // Stock on the floor
  | { k: "facing"; t: number; sku: string; facing: number; back: number; delta: number; reason: "sale" | "serve" | "pick" | "restock" | "putaway" | "shrink"; job: number }
  | { k: "short"; t: number; sku: string; units: number; customer: string | null; order: string | null; hot: boolean; job: number }

  // Customers
  | { k: "customerArrive"; t: number; customer: string; kind: BasketKind; lines: number; units: number; dollars: number; served: number; wrap: boolean; stall: number }
  | { k: "customerShop"; t: number; customer: string; stops: Array<{ sku: string; units: number; facing: string }>; dwellMin: number }
  | { k: "counterJoin"; t: number; customer: string; queueLen: number }
  | { k: "counterDone"; t: number; customer: string; waitMin: number; job: number }
  | { k: "queueJoin"; t: number; customer: string; register: string; queueLen: number }
  | { k: "sale"; t: number; customer: string; register: string; waitMin: number; lines: number; units: number; dollars: number; lostDollars: number; job: number }
  | { k: "abandon"; t: number; customer: string; at: "counter" | "register"; waitMin: number; dollars: number }
  | { k: "customerLeave"; t: number; customer: string; bought: boolean; dollars: number; minutesInStore: number }

  // Orders out
  | { k: "orderPlaced"; t: number; order: string; kind: "delivery" | "pickup"; day: number; dueDay: number; dueMin: number; lines: Array<{ sku: string; units: number; cut: number }>; dollars: number; miles: number; tours: number }
  | { k: "orderPicked"; t: number; order: string; lines: number; units: number }
  | { k: "orderPacked"; t: number; order: string; wrap: boolean; job: number }
  | { k: "orderCut"; t: number; order: string; lines: number; dollars: number }
  | { k: "orderLate"; t: number; order: string; lateMin: number; reason: "notPicked" | "notPacked" | "notLoaded" }
  /**
   * An order reached the customer: driven to the door, or collected from the
   * shelf by it. Exactly one per order that leaves the shop, and the single
   * place order revenue, units and lateness are stated — so a reducer never
   * has to add them up from the events that led here.
   */
  | { k: "orderOut"; t: number; order: string; kind: "delivery" | "pickup"; units: number; dollars: number; lateMin: number; van: number }
  | { k: "vanLoad"; t: number; van: number; orders: string[]; job: number }
  | { k: "vanDepart"; t: number; van: number; orders: string[]; lateMin: number; stops: number; miles: number; job: number }
  | { k: "vanReturn"; t: number; van: number; minutes: number }
  | { k: "orderCollected"; t: number; order: string; lateMin: number }

  // People and the till
  | {
      k: "worker";
      t: number;
      id: string;
      state: "in" | "absent" | "indirectEnd" | "break" | "breakEnd" | "out";
      shift?: string;
      primary?: Skill;
      shiftStart?: number;
      shiftEnd?: number;
      breakAt?: number;
      breakMin?: number;
      indirectMin?: number;
      lastShift?: boolean;
      overtimeMin?: number;
    }
  | { k: "pos"; t: number; down: boolean; until?: number }
  | { k: "end"; t: number };

export type TraceEventKind = TraceEvent["k"];

// ---------------------------------------------------------------------------
// The synthesized world
// ---------------------------------------------------------------------------

export type Pt = [x: number, y: number];

export interface DoorFrame {
  door: string;
  kind: "entrance" | "dock" | "ground";
  /** Index in layout.doors. */
  index: number;
  origin: Pt;
  /** Unit vector into the building. */
  inward: Pt;
  /** Unit vector along the wall. */
  tangent: Pt;
  widthFt: number;
}

/** Where pallets and cases land just inside a goods door. */
export interface Lane {
  door: string;
  slots: Pt[];
}

/** One parking stall in the customer lot. */
export interface Stall {
  index: number;
  pt: Pt;
  kind: "standard" | "accessible" | "curbside";
  /** Heading a car sits at, radians. */
  heading: number;
}

export interface ServicePost {
  id: string;
  kind: "counter" | "register" | "wrap";
  /** Where the worker stands. */
  worker: Pt;
  /** Where the first customer in the line stands. */
  head: Pt;
  /** Where the rest of the line stands, in order. */
  queue: Pt[];
  facing: number;
}

export interface World {
  bbox: { w: number; d: number };
  frames: DoorFrame[];
  lanes: Lane[];
  posts: ServicePost[];
  /** Just inside the customer entrance. */
  entry: Pt;
  /** The pick-and-pack bench in the stockroom. */
  bench: Pt;
  /** Where a stock cart is built. */
  cartPark: Pt[];
  /** Where a pallet jack lives between jobs. */
  jackPark: Pt[];
  /** The stockroom door onto the sales floor. */
  stockDoor: Pt;
  breakArea: Pt;
  lot: {
    /** Centre line of the drive in front of the stalls. */
    driveY: number;
    stalls: Stall[];
    /** Where a delivery van stands between rounds. */
    vanBays: Pt[];
    spawnLeft: Pt;
    spawnRight: Pt;
  };
  /** The service drive behind the store, where trailers back on. */
  service: { roadY: number; queue: Record<number, Pt[]>; spawnLeft: Pt; spawnRight: Pt };
  corridors: { front: number; back: number; backroomFront: number; apron: number };
  /** Fixture run id → base height of each shelf, index shelf − 1. */
  shelfHeights: Record<string, number[]>;
  /** Where an idle worker waits, by primary skill. */
  homes: Record<Skill, Pt>;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type EntityKind = "worker" | "customer" | "cart" | "jack" | "pallet" | "van" | "truck" | "car";

export interface EntityDef {
  kind: EntityKind;
  id: string;
  label: string;
  colorIdx: number;
  meta: Record<string, string | number | boolean>;
}

export const ActorState = {
  Off: 0,
  Idle: 1,
  Walk: 2,
  Push: 3,
  Work: 4,
  Browse: 5,
  Queue: 6,
  Serve: 7,
  Ring: 8,
  Wait: 9,
  Break: 10,
  Indirect: 11,
  Overtime: 12,
  Absent: 13,
  Drive: 14,
  Docked: 15,
  Loading: 16,
  Depart: 17,
  Late: 18,
  Leave: 19,
} as const;
export type ActorStateValue = (typeof ActorState)[keyof typeof ActorState];

export const SegKind = {
  Hold: 0,
  Walk: 1,
  WalkCart: 2,
  Jack: 3,
  Handle: 4,
  Reach: 5,
  Transfer: 6,
  IdleReturn: 7,
  Drive: 8,
  Lot: 9,
  Truncated: 10,
} as const;
export type SegKindValue = (typeof SegKind)[keyof typeof SegKind];

/** Job ids the compiler invents for movement no job owns. */
export const SYNTH_JOB = { none: -1, shift: -2, road: -3, shop: -4 } as const;

export interface Track {
  entity: number;
  /** Strictly increasing. */
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Heading in radians, 0 = +x. */
  h: Float32Array;
  /** ActorState, held from frame i to i + 1. */
  s: Uint8Array;
  /** SegKind of the segment starting at frame i. */
  seg: Uint8Array;
  /** Owning job id, or a SYNTH_JOB tag. */
  job: Int32Array;
  /** Entity carried (a pallet, a cart), or -1. */
  carry: Int32Array;
}

/**
 * A compressed-sparse-row timeline: item i's rows are `offsets[i]` through
 * `offsets[i + 1] - 1`, sorted by `t`, row 0 at t = 0, each value holding
 * until the next row.
 */
export interface CsrTimeline<V extends Uint8Array | Uint16Array | Int32Array | Uint32Array> {
  offsets: Int32Array;
  t: Float64Array;
  v: V;
  /** Index of the event that caused the row, or -1. */
  ev: Int32Array;
}

export const PalletAt = {
  Unborn: 0,
  Trailer: 1,
  DockLane: 2,
  Jack: 3,
  Storage: 4,
  Bench: 5,
  Van: 6,
  Gone: 7,
} as const;

export interface PalletTimeline {
  offsets: Int32Array;
  t: Float64Array;
  at: Uint8Array;
  ref: Int32Array;
  slot: Int32Array;
  ev: Int32Array;
}

export const DirtyKind = {
  Facing: 0,
  FacingHot: 1,
  Storage: 2,
  StorageSku: 3,
  Door: 4,
  LaneSlot: 5,
  Post: 6,
  Pallet: 7,
  Stall: 8,
  QueueLen: 9,
} as const;

export interface DirtyList {
  t: Float64Array;
  kind: Uint8Array;
  idx: Int32Array;
  row: Int32Array;
}

export type JobFit = "stationary" | "exact" | "borrowed" | "fadeIn" | "fast";

export interface JobRow {
  id: number;
  process: Process;
  info: JobInfo;
  priority: number;
  queuedAt: number;
  /** -1 when the job never started. */
  startAt: number;
  endAt: number;
  truncated: boolean;
  worker: string;
  productivity: number;
  dur: number;
  waitMin: number;
  equipWaitMin: number;
  /** Synthesized identities, -1 when not applicable. */
  cart: number;
  jack: number;
  van: number;
  post: number;
  door: number;
  engineFeet: number;
  routeFeet: number;
  transferFeet: number;
  visualFeet: number;
  stopMin: number;
  moveMin: number;
  speedRatio: number;
  fit: JobFit;
  /** Index of the jobQueued event in Playback.events. */
  ev: number;
}

// ---------------------------------------------------------------------------
// Running KPIs
// ---------------------------------------------------------------------------

export interface RunningKpis {
  customers: number;
  transactions: number;
  unitsSold: number;
  salesDollars: number;
  lostShelfDollars: number;
  lostQueueDollars: number;
  abandonedCounter: number;
  abandonedRegister: number;
  counterServed: number;
  counterWaitSum: number;
  counterWaitN: number;
  registerWaitSum: number;
  registerWaitN: number;
  worstWaitMin: number;
  giftWraps: number;
  shortAtShelf: number;
  restocks: number;
  hotRestocks: number;
  ordersPlaced: number;
  ordersPicked: number;
  ordersLate: number;
  orderLateMin: number;
  ordersCutDollars: number;
  vanRounds: number;
  vanLateRounds: number;
  deliveryStops: number;
  inboundTrucks: number;
  inboundPallets: number;
  inboundCases: number;
  palletsInFlight: number;
  dockToStockN: number;
  doorWaitN: number;
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  absences: number;
  regularCost: number;
  overtimeCost: number;
  presentWorkers: number;
  busyWorkers: number;
  inStore: number;
  jacksBusy: number;
  cartsBusy: number;
  registersBusy: number;
  countersBusy: number;
  lastT: number;
  /** One per PROCESSES entry. */
  queues: number[];
}

export interface Checkpoint {
  t: number;
  kpis: RunningKpis;
}

export interface TickerEvent {
  t: number;
  kind: TraceEventKind;
  text: string;
  severity: 0 | 1 | 2;
  entity: number;
  ev: number;
  x?: number;
  y?: number;
}

export const KPI_SERIES = [
  "salesDollars",
  "unitsSold",
  "transactions",
  "inStore",
  "lostShelfDollars",
  "lostQueueDollars",
  "counterWait",
  "registerWait",
  "abandoned",
  "onShelfShare",
  "restocks",
  "hotRestocks",
  "paidHours",
  "busyHours",
  "overtimeHours",
  "laborCost",
  "presentWorkers",
  "queueTotal",
] as const;
export type KpiSeries = (typeof KPI_SERIES)[number];

export interface Bins {
  binMin: number;
  count: number;
  /** count × PROCESSES.length. */
  queues: Uint16Array;
  /** count × KPI_SERIES.length. */
  series: Float32Array;
}

export interface Interval {
  t0: Float64Array;
  t1: Float64Array;
}

export interface PlaybackMeta {
  store: string;
  storeName: string;
  startWeek: number;
  days: number;
  seed: number;
  horizonEnd: number;
  layoutName: string;
  compiler: string;
  offsets: boolean;
  checkpointMin: number;
}

export interface Playback {
  meta: PlaybackMeta;
  entities: EntityDef[];
  /** null for pallet entities, which live in `pallets` instead. */
  tracks: Array<Track | null>;
  /** Per layout.facings index: selling units on the facing. */
  facings: CsrTimeline<Uint16Array>;
  /** 1 while a restock is pending for that facing. */
  facingHot: CsrTimeline<Uint8Array>;
  /** Static: layout.facings index → sku index, -1 when empty. */
  facingSku: Int32Array;
  /** Per layout.storage index: cases stacked there. */
  storage: CsrTimeline<Uint16Array>;
  /** Per layout.storage index: occupying sku index, -1. */
  storageSku: CsrTimeline<Int32Array>;
  /** Per goods door index: truck entity, -1 free, -2 outage. */
  doors: CsrTimeline<Int32Array>;
  /** Per (door × LANE_SLOTS + slot): pallet entity, -1 free. */
  laneSlots: CsrTimeline<Int32Array>;
  /** Per service post: customer entity being served, -1 idle, -2 closed. */
  posts: CsrTimeline<Int32Array>;
  /** Per service post: people waiting. */
  queueLen: CsrTimeline<Uint16Array>;
  /** Per parking stall: car entity, -1 empty. */
  stalls: CsrTimeline<Int32Array>;
  pallets: PalletTimeline;
  dirty: DirtyList;
  /** Index = job id − 1. */
  jobs: JobRow[];
  queueBins: Bins;
  kpiBins: Bins;
  checkpoints: Checkpoint[];
  samples: { dockToStock: Float32Array; counterWait: Float32Array; registerWait: Float32Array; orderCycle: Float32Array };
  ticker: TickerEvent[];
  /** Nobody in the building; skip-idle jumps these. */
  quiet: Interval;
  /** [] when keepEvents is false. */
  events: TraceEvent[];
  world: World;
}

export const LANE_SLOTS = 8;

// ---------------------------------------------------------------------------
// The page ↔ worker protocol
// ---------------------------------------------------------------------------

export interface SkuInfo {
  id: string;
  name: string;
  category: string;
  supplier: string;
  unitRetail: number;
  sellBy: "each" | "weight";
  unitsPerInner: number;
  innersPerCase: number;
  fixture: string;
  colorIdx: number;
}

export interface SupplierInfo {
  id: string;
  name: string;
  channel: "dc" | "direct";
}

/** Everything the page needs to label the scene, sent once with the playback. */
export interface WorldPayload {
  skus: SkuInfo[];
  suppliers: SupplierInfo[];
  facings: Array<Pick<Facing, "id" | "kind" | "run" | "aisle" | "side" | "bay" | "shelf" | "slot" | "x" | "y" | "served">>;
  storage: Array<Pick<StoragePosition, "id" | "kind" | "run" | "aisle" | "side" | "bay" | "level" | "x" | "y">>;
  layoutName: string;
  spec: Layout["spec"];
  changes: string[];
}

export interface RunSpec {
  store: string;
  startWeek: number;
  days: number;
  seed: number;
  scenario: Record<string, unknown>;
}

export type TwinRequest = { type: "run"; id: number; spec: RunSpec } | { type: "cancel"; id: number };

export type ProgressPhase = "building" | "simulating" | "compiling";

export type TwinResponse =
  | { type: "progress"; id: number; phase: ProgressPhase; day?: number; days?: number }
  | { type: "done"; id: number; playback: Playback; world: WorldPayload; kpis: Kpis; issues: string[] }
  | { type: "error"; id: number; message: string };
