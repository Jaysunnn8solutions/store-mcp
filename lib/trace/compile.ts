/**
 * The playback compiler: the ordered event stream plus the `Layout` and the
 * synthesized `World` become the typed arrays the 3D page samples once a frame
 * — keyframe tracks per moving thing, CSR step timelines for every stateful
 * one, a merged dirty list, job rows with their fit, queue and KPI bins, hourly
 * checkpoints, a ticker and the quiet intervals skip-idle jumps.
 *
 * One linear pass, plus the prepass `kpiContext` makes. Everything the engine
 * does not decide is invented here as a pure function of the ordered stream —
 * which register a customer queues at, which stall their car takes, which cart
 * a stocker pushes, where a pallet ends up in the back, how a shopper walks the
 * floor — so the same seed compiles to byte-identical arrays and the animation
 * can never feed back into the numbers.
 *
 * The one rule everything else bends around: **engine durations are the truth**.
 * A job lasts `dur` whatever the drawn route needs, so `fitJob` (fit.ts) decides
 * how the route and the walk from the previous job share those minutes and says
 * how it managed, and a job's frames occupy exactly `[startAt, endAt]`.
 *
 * No DOM, no three.js, no Node built-ins: this runs in a Web Worker and in the
 * tests.
 */

import { BASKET_KINDS } from "../twin/demand";
import { isGoldenShelf, walkDistance, type Facing, type Layout, type StoragePosition } from "../twin/layout";
import { shiftPaidHours } from "../twin/standards";
import { PROCESSES, type LaborStandards, type Skill } from "../twin/types";
import { fitJob, type FitResult } from "./fit";
import { FreeList, StallAllocator, StorageAllocator } from "./identities";
import { applyEvent, cloneState, createState, finalize, kpiContext, type KpiContext, type KpiState } from "./kpis";
import {
  arrivePath,
  dockPath,
  leavePath,
  pathFeet,
  pickPath,
  putawayPath,
  restockPath,
  shopPath,
  transferPath,
  undockPath,
  vanRoundPath,
  walkInPath,
  type Path,
} from "./paths";
import { upperBound } from "./search";
import { tickerLine, type TickerNames } from "./ticker";
import {
  ActorState,
  DirtyKind,
  KPI_SERIES,
  LANE_SLOTS,
  PalletAt,
  SegKind,
  SYNTH_JOB,
  type ActorStateValue,
  type Bins,
  type Checkpoint,
  type CsrTimeline,
  type DirtyList,
  type EntityDef,
  type Interval,
  type JobInfo,
  type JobRow,
  type PalletTimeline,
  type Playback,
  type Pt,
  type SegKindValue,
  type ServicePost,
  type SkuInfo,
  type SupplierInfo,
  type TickerEvent,
  type Track,
  type TraceEvent,
  type TraceInit,
  type World,
} from "./types";
import { parkSpot, thresholdPoint, trailerPose } from "./world";

export const COMPILER_VERSION = "1.0.0";

/** Driving speed on the service drive and in the lot, ft/min (about 3 mph). */
export const ROAD_FT_PER_MIN = 280;
/** Idle: a worker lingers this long before walking home, a cart before it is put back. */
export const WORKER_LINGER_MIN = 2;
export const VEHICLE_LINGER_MIN = 5;
/** A fade-in teleport takes this long (invisible while Off). */
export const FADE_EPS_MIN = 0.01;
/** Backing a trailer onto a dock takes this long. */
export const BACK_IN_MIN = 1.5;
/** A trailer pulls off the door this long after its last pallet is off. */
export const UNDOCK_LINGER_MIN = 2;
/** Quiet intervals shorter than this are not worth skipping. */
export const QUIET_MIN = 10;
/** A shopper parks, gets out and walks in; and the reverse on the way out. */
export const PARK_MIN = 0.4;
/** Stepping one place forward in a queue. */
export const QUEUE_STEP_MIN = 0.2;
/** Longest walk drawn from wherever a shopper was to the back of a queue. */
export const QUEUE_JOIN_MAX_MIN = 0.6;
/** A shopper dawdles this long by the door before leaving. */
export const LEAVE_LINGER_MIN = 0.3;

export interface CompileOptions {
  /** Draw routes on the aisle-clearing polylines (default), or straight between stops. */
  offsets?: boolean;
  /** KPI checkpoint spacing, minutes (default 60). */
  checkpointMin?: number;
  /** Keep the raw events in the playback (default true). */
  keepEvents?: boolean;
}

export interface CompileInput {
  events: TraceEvent[];
  layout: Layout;
  world: World;
  skus: SkuInfo[];
  /** SKU id → the facing it is merchandised in. */
  planogram: Array<[sku: string, facing: string]>;
  /** Supplier names for the truck labels and the ticker; an unknown id falls back to itself. */
  suppliers?: SupplierInfo[];
  opts?: CompileOptions;
}

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Keyframe track builder
// ---------------------------------------------------------------------------

interface Frame {
  t: number;
  x: number;
  y: number;
  s: ActorStateValue;
  seg: SegKindValue;
  job: number;
  carry?: number;
  z?: number;
  h?: number;
}

/**
 * Growable keyframes with two rules that keep `t` strictly increasing: a push
 * at the last frame's time overwrites it (a job starting the minute the last
 * one ended subsumes the idle frame), and a push before it cuts the synthesized
 * future (an idle walk interrupted by the next job, a browse interrupted by the
 * queue). Every frame source goes through `push`; nothing appends directly.
 */
class TrackBuilder {
  t: number[] = [];
  x: number[] = [];
  y: number[] = [];
  z: number[] = [];
  h: number[] = [];
  s: number[] = [];
  seg: number[] = [];
  job: number[] = [];
  carry: number[] = [];

  constructor(readonly entity: number) {}

  get n(): number {
    return this.t.length;
  }

  get lastT(): number {
    return this.n ? this.t[this.n - 1] : 0;
  }

  pos(): Pt {
    const i = this.n - 1;
    return i >= 0 ? [this.x[i], this.y[i]] : [0, 0];
  }

  heading(): number {
    return this.n ? this.h[this.n - 1] : 0;
  }

  /** Pose in effect at t, dropping every frame after it. */
  cutAt(t: number): { x: number; y: number; z: number; h: number } {
    const k = upperBound(this.t, t);
    const n = this.n;
    if (k >= n) {
      const i = n - 1;
      return i >= 0 ? { x: this.x[i], y: this.y[i], z: this.z[i], h: this.h[i] } : { x: 0, y: 0, z: 0, h: 0 };
    }
    const p = Math.max(0, k - 1);
    const span = this.t[k] - this.t[p];
    const u = span > 0 && k > p ? (t - this.t[p]) / span : 0;
    const out = {
      x: this.x[p] + (this.x[k] - this.x[p]) * u,
      y: this.y[p] + (this.y[k] - this.y[p]) * u,
      z: this.z[p] + (this.z[k] - this.z[p]) * u,
      h: this.h[p],
    };
    for (const a of [this.t, this.x, this.y, this.z, this.h, this.s, this.seg, this.job, this.carry]) a.length = k;
    return out;
  }

  push(f: Frame): void {
    if (this.n && f.t < this.t[this.n - 1] - EPS) {
      const p = this.cutAt(f.t);
      if (this.n && Math.abs(this.t[this.n - 1] - f.t) > EPS) {
        this.push({
          t: f.t,
          x: p.x,
          y: p.y,
          z: p.z,
          h: p.h,
          s: this.s[this.n - 1] as ActorStateValue,
          seg: this.seg[this.n - 1] as SegKindValue,
          job: this.job[this.n - 1],
          carry: this.carry[this.n - 1],
        });
      }
    }
    const i = this.n - 1;
    let h = f.h;
    if (i >= 0) {
      const dx = f.x - this.x[i];
      const dy = f.y - this.y[i];
      if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
        // The segment that ends here pointed this way; the new frame keeps it until it moves again.
        const dir = Math.atan2(dy, dx);
        if (Math.abs(f.t - this.t[i]) > EPS) this.h[i] = dir;
        h ??= dir;
      } else h ??= this.h[i];
    }
    h ??= 0;
    if (i >= 0 && Math.abs(f.t - this.t[i]) <= EPS) {
      this.x[i] = f.x;
      this.y[i] = f.y;
      this.z[i] = f.z ?? 0;
      this.h[i] = h;
      this.s[i] = f.s;
      this.seg[i] = f.seg;
      this.job[i] = f.job;
      this.carry[i] = f.carry ?? -1;
      return;
    }
    this.t.push(f.t);
    this.x.push(f.x);
    this.y.push(f.y);
    this.z.push(f.z ?? 0);
    this.h.push(h);
    this.s.push(f.s);
    this.seg.push(f.seg);
    this.job.push(f.job);
    this.carry.push(f.carry ?? -1);
  }

  /** Freeze into typed arrays, cutting at the horizon; a job segment cut there is Truncated. */
  toTrack(horizonEnd: number): Track {
    const k = upperBound(this.t, horizonEnd);
    if (k < this.n) {
      const last = k - 1;
      const cutSeg = last >= 0 && this.job[last] >= 1 ? SegKind.Truncated : ((last >= 0 ? this.seg[last] : SegKind.Hold) as SegKindValue);
      const state = (last >= 0 ? this.s[last] : ActorState.Off) as ActorStateValue;
      const job = last >= 0 ? this.job[last] : SYNTH_JOB.none;
      const carry = last >= 0 ? this.carry[last] : -1;
      const p = this.cutAt(horizonEnd);
      this.push({ t: horizonEnd, x: p.x, y: p.y, z: p.z, h: p.h, s: state, seg: cutSeg, job, carry });
    }
    return {
      entity: this.entity,
      t: Float64Array.from(this.t),
      x: Float32Array.from(this.x),
      y: Float32Array.from(this.y),
      z: Float32Array.from(this.z),
      h: Float32Array.from(this.h),
      s: Uint8Array.from(this.s),
      seg: Uint8Array.from(this.seg),
      job: Int32Array.from(this.job),
      carry: Int32Array.from(this.carry),
    };
  }
}

// ---------------------------------------------------------------------------
// CSR timeline builders
// ---------------------------------------------------------------------------

interface CsrRow {
  t: number;
  v: number;
  ev: number;
}

/**
 * Where a row at t belongs in a per-item list whose t is non-decreasing: the
 * index of the first row later than t. Rows are placed by time and never by
 * call order, because a job start legitimately writes a change at a future
 * minute (a load frees a staging slot when the jack picks it up, a putaway
 * lands a pallet at the drop), so a later event can carry an earlier t. The
 * cursor's binary searches depend on it. Exported for the tests.
 */
export function rowInsertIndex(rows: ReadonlyArray<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].t <= t + EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A per-item value timeline with rows in time order and no two neighbours alike. */
export class CsrBuilder {
  readonly items: CsrRow[][];
  constructor(n: number, initial: (i: number) => number) {
    this.items = Array.from({ length: n }, (_, i) => [{ t: 0, v: initial(i), ev: -1 }]);
  }
  /** The value in force after the last row written. */
  get(i: number): number {
    const rows = this.items[i];
    return rows ? rows[rows.length - 1].v : 0;
  }
  set(i: number, t: number, v: number, ev: number): void {
    const rows = this.items[i];
    if (!rows) return;
    const k = rowInsertIndex(rows, t);
    const prev = rows[k - 1];
    // A row at the same minute as its predecessor replaces it (the initial row included).
    if (prev && Math.abs(prev.t - t) <= EPS) {
      const before = rows[k - 2];
      if (before && before.v === v) rows.splice(k - 1, 1);
      else {
        prev.v = v;
        prev.ev = ev;
      }
    } else if (prev && prev.v === v) return;
    else rows.splice(k, 0, { t, v, ev });
    // The next row is now a change from v; drop it when it changes to v itself.
    const at = rowInsertIndex(rows, t);
    const next = rows[at];
    if (next && next.v === v) rows.splice(at, 1);
  }
  build<V extends Uint8Array | Uint16Array | Int32Array | Uint32Array>(make: (n: number) => V, kind: number, dirty: DirtyEntry[]): CsrTimeline<V> {
    const total = this.items.reduce((a, r) => a + r.length, 0);
    const offsets = new Int32Array(this.items.length + 1);
    const t = new Float64Array(total);
    const v = make(total);
    const ev = new Int32Array(total);
    let k = 0;
    this.items.forEach((rows, i) => {
      offsets[i] = k;
      rows.forEach((r, j) => {
        t[k] = r.t;
        v[k] = r.v;
        ev[k] = r.ev;
        if (j > 0) dirty.push({ t: r.t, kind, idx: i, row: k });
        k++;
      });
    });
    offsets[this.items.length] = k;
    return { offsets, t, v, ev };
  }
}

interface DirtyEntry {
  t: number;
  kind: number;
  idx: number;
  row: number;
}

interface PalletRow {
  t: number;
  at: number;
  ref: number;
  slot: number;
  ev: number;
}

const samePlace = (a: PalletRow, at: number, ref: number, slot: number) => a.at === at && a.ref === ref && a.slot === slot;

/** Per-pallet placement rows, in time order like CsrBuilder's. */
export class PalletBuilder {
  readonly items: PalletRow[][] = [];
  add(): number {
    this.items.push([{ t: 0, at: PalletAt.Unborn, ref: -1, slot: -1, ev: -1 }]);
    return this.items.length - 1;
  }
  set(i: number, t: number, at: number, ref: number, slot: number, ev: number): void {
    const rows = this.items[i];
    if (!rows) return;
    const k = rowInsertIndex(rows, t);
    const prev = rows[k - 1];
    if (prev && Math.abs(prev.t - t) <= EPS) {
      const before = rows[k - 2];
      if (before && samePlace(before, at, ref, slot)) rows.splice(k - 1, 1);
      else {
        prev.at = at;
        prev.ref = ref;
        prev.slot = slot;
        prev.ev = ev;
      }
    } else if (prev && samePlace(prev, at, ref, slot)) return;
    else rows.splice(k, 0, { t, at, ref, slot, ev });
    const atIdx = rowInsertIndex(rows, t);
    const next = rows[atIdx];
    if (next && samePlace(next, at, ref, slot)) rows.splice(atIdx, 1);
  }
  current(i: number): PalletRow {
    const rows = this.items[i];
    return rows[rows.length - 1];
  }
  build(dirty: DirtyEntry[]): PalletTimeline {
    const total = this.items.reduce((a, r) => a + r.length, 0);
    const offsets = new Int32Array(this.items.length + 1);
    const t = new Float64Array(total);
    const at = new Uint8Array(total);
    const ref = new Int32Array(total);
    const slot = new Int32Array(total);
    const ev = new Int32Array(total);
    let k = 0;
    this.items.forEach((rows, i) => {
      offsets[i] = k;
      rows.forEach((r, j) => {
        t[k] = r.t;
        at[k] = r.at;
        ref[k] = r.ref;
        slot[k] = r.slot;
        ev[k] = r.ev;
        if (j > 0) dirty.push({ t: r.t, kind: DirtyKind.Pallet, idx: i, row: k });
        k++;
      });
    });
    offsets[this.items.length] = k;
    return { offsets, t, at, ref, slot, ev };
  }
}

// ---------------------------------------------------------------------------
// Laying a route into a time window
// ---------------------------------------------------------------------------

interface Sink {
  tb: TrackBuilder;
  moveState: ActorStateValue;
  stopState: ActorStateValue;
  moveSeg: SegKindValue;
  /** Segment kind while carrying something; `moveSeg` otherwise. */
  loadedSeg: SegKindValue;
  stopSeg: SegKindValue;
  /** Raise the drawn hands to the shelf being reached. */
  lift: boolean;
  /** Entity carried on the leg starting at vertex i, -1 none. */
  carry: (vertex: number) => number;
}

interface RouteTimes {
  end: number;
  /** Per path stop, in the path's own order. */
  stops: Array<{ arrive: number; leave: number }>;
  /** Arrival time at each vertex. */
  vertex: number[];
}

/**
 * Lay a path onto its sinks from t0: legs at feet ÷ (moveMin per foot), stops
 * sharing stopMin **in proportion to their handling minutes** (all of it at the
 * last vertex when there are none), so a picker lingers longer over a forty-unit
 * line than a one-unit line. The last frame lands exactly at t0 + moveMin +
 * stopMin, which is how a job's animation is kept inside its engine duration.
 */
function layoutRoute(
  sinks: Sink[],
  path: Path,
  t0: number,
  moveMin: number,
  stopMin: number,
  job: number,
  heights: (shelf: number | undefined, id: string | undefined) => number
): RouteTimes {
  const pts = path.pts;
  const end = t0 + moveMin + stopMin;
  const times: RouteTimes = { end, stops: [], vertex: [] };
  if (pts.length === 0) return times;
  const perFoot = path.feet > 0 ? moveMin / path.feet : 0;
  const stopAt = new Map<number, { minutes: number; shelf?: number; id?: string; k: number[] }>();
  path.stops.forEach((s, k) => {
    const cur = stopAt.get(s.i);
    if (cur) {
      cur.minutes += s.minutes;
      cur.k.push(k);
      if (s.shelf !== undefined) cur.shelf = s.shelf;
      if (s.id) cur.id = s.id;
    } else stopAt.set(s.i, { minutes: s.minutes, shelf: s.shelf, id: s.id, k: [k] });
  });
  const totalW = [...stopAt.values()].reduce((a, s) => a + s.minutes, 0);
  const lastVertex = pts.length - 1;
  let t = t0;
  let remainingStop = stopMin;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    const stop = stopAt.get(i);
    const arrive = Math.min(end, t);
    times.vertex.push(arrive);
    let leave = arrive;
    if (stop) {
      const share = totalW > 0 ? (stopMin * stop.minutes) / totalW : i === lastVertex ? remainingStop : 0;
      const dur = Math.min(remainingStop, share);
      remainingStop -= dur;
      leave = Math.min(end, arrive + dur);
      for (const s of sinks) {
        const z = s.lift ? heights(stop.shelf, stop.id) : 0;
        const carry = Math.max(-1, s.carry(i));
        s.tb.push({ t: arrive, x, y, s: s.stopState, seg: s.stopSeg, job, carry });
        if (z > 0 && dur > 0.02) s.tb.push({ t: arrive + dur / 2, x, y, z, s: s.stopState, seg: s.stopSeg, job, carry });
      }
      for (const k of stop.k) times.stops[k] = { arrive, leave };
    }
    if (i < lastVertex) {
      for (const s of sinks) {
        // -1 empty-handed, -2 carrying something with no entity of its own, else the entity.
        const carry = s.carry(i);
        s.tb.push({ t: leave, x, y, s: s.moveState, seg: carry !== -1 ? s.loadedSeg : s.moveSeg, job, carry: Math.max(-1, carry) });
      }
      const legFeet = Math.abs(pts[i + 1][0] - x) + Math.abs(pts[i + 1][1] - y);
      t = leave + legFeet * perFoot;
    } else {
      // Whatever stop time is left (rounding, or no stops at all) is a hold at the end.
      for (const s of sinks) s.tb.push({ t: end, x, y, s: s.stopState, seg: s.stopSeg, job, carry: Math.max(-1, s.carry(i)) });
    }
  }
  times.stops = path.stops.map((_, k) => times.stops[k] ?? { arrive: end, leave: end });
  return times;
}

// ---------------------------------------------------------------------------
// Runtime records
// ---------------------------------------------------------------------------

interface Actor {
  id: string;
  entity: number;
  tb: TrackBuilder;
  prod: number;
  present: boolean;
  shiftEnd: number;
  home: Pt;
  lastCart: number;
  lastJack: number;
  lastPost: number;
}

interface Vehicle {
  kind: "cart" | "jack" | "van";
  index: number;
  entity: number;
  tb: TrackBuilder;
  park: Pt;
}

interface Shopper {
  id: string;
  entity: number;
  tb: TrackBuilder;
  car: number;
  carTb: TrackBuilder | null;
  stall: number;
  /** Service post they are queued at, -1 when on the floor. */
  post: number;
  slot: number;
}

interface TruckRec {
  entity: number;
  tb: TrackBuilder;
  po: string;
  arriveT: number;
  eta: number;
  mode: "overnight" | "direct";
  pallets: number[];
  queuePos: number;
  /** Goods-door index, -1 until it docks. */
  door: number;
  docked: boolean;
}

interface OrderRec {
  id: string;
  kind: "delivery" | "pickup";
  label: string;
  placedAt: number;
  dueAt: number;
  /** The packed tote, -1 until it is packed. */
  tote: number;
}

interface JobRun {
  row: JobRow;
  actor: Actor;
  vehicle: Vehicle | null;
  post: number;
  wrapPost: number;
  laneDoor: number;
  laneSlot: number;
  pallet: number;
  customer: number;
}

function pointPath(p: Pt, minutes: number): Path {
  return { pts: [[p[0], p[1]]], feet: 0, stops: [{ at: 0, i: 0, minutes }] };
}

function polyPath(pts: Pt[], stops: Array<{ i: number; minutes: number; id?: string; shelf?: number }>): Path {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) continue;
    out.push([p[0], p[1]]);
  }
  return { pts: out, feet: pathFeet(out), stops: stops.map((s) => ({ at: 0, i: Math.min(s.i, out.length - 1), minutes: s.minutes, id: s.id, shelf: s.shelf })) };
}

function dist(a: Pt, b: Pt): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

// ---------------------------------------------------------------------------
// compilePlayback
// ---------------------------------------------------------------------------

export function compilePlayback(input: CompileInput): Playback {
  const { events, layout, world, skus } = input;
  const useOffsets = input.opts?.offsets ?? true;
  const checkpointMin = input.opts?.checkpointMin ?? 60;
  const keepEvents = input.opts?.keepEvents ?? true;
  const init = events.find((e): e is TraceInit => e.k === "init");
  if (!init) throw new Error("compilePlayback: the event stream has no init event.");
  const horizonEnd = init.horizonEnd;
  const std: LaborStandards = init.std;
  const walkFpm = std.walkFtPerMin;

  // --- Static lookups ---
  const skuIdx = new Map(skus.map((s, i) => [s.id, i]));
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const facingById = new Map<string, Facing>();
  const facingIndex = new Map<string, number>();
  layout.facings.forEach((f, i) => {
    facingById.set(f.id, f);
    facingIndex.set(f.id, i);
  });
  const storageById = new Map<string, StoragePosition>();
  const storageIndex = new Map<string, number>();
  layout.storage.forEach((p, i) => {
    storageById.set(p.id, p);
    storageIndex.set(p.id, i);
  });
  const facingOfSku = new Map<string, number>();
  const facingSku = new Int32Array(layout.facings.length).fill(-1);
  for (const [sku, id] of input.planogram) {
    const i = facingIndex.get(id);
    const s = skuIdx.get(sku);
    if (i === undefined || s === undefined) continue;
    facingOfSku.set(sku, i);
    facingSku[i] = s;
  }
  const shelvesOf = new Map(layout.spec.fixtures.map((r) => [r.id, r.shelves]));
  const heightOf = (shelf: number | undefined, id: string | undefined): number => {
    if (shelf === undefined || !id) return 0;
    const run = facingById.get(id)?.run ?? storageById.get(id)?.run;
    const hs = run ? world.shelfHeights[run] : undefined;
    return hs?.[shelf - 1] ?? 0;
  };
  const casesOf = (sku: string, units: number): number => {
    const s = skuById.get(sku);
    const per = s ? Math.max(1, s.innersPerCase * s.unitsPerInner) : 1;
    return Math.max(0, Math.ceil(units / per));
  };
  /** Insertion-ordered, so the colour a role gets never depends on Map iteration. */
  const roles = [...new Set(init.workers.map((w) => w.role))];

  // Goods doors index the door, lane and staging timelines; `world.lanes` is
  // built over the same filtered list, so the two indices agree.
  const goodsFrames = world.frames.filter((f) => f.kind !== "entrance");
  const goodsOfDoorId = new Map(goodsFrames.map((f, i) => [f.door, i]));
  const posts = world.posts;
  const postsOfKind = (kind: ServicePost["kind"]): number[] => posts.map((p, i) => (p.kind === kind ? i : -1)).filter((i) => i >= 0);
  const registerPosts = postsOfKind("register");
  const counterPosts = postsOfKind("counter");
  const wrapPosts = postsOfKind("wrap");

  // --- Entities and tracks ---
  const entities: EntityDef[] = [];
  const builders: Array<TrackBuilder | null> = [];
  const addEntity = (def: EntityDef, track: boolean): number => {
    entities.push(def);
    builders.push(track ? new TrackBuilder(entities.length - 1) : null);
    return entities.length - 1;
  };
  const pallets = new PalletBuilder();
  const palletOrdinal = new Map<number, number>();
  const addPallet = (def: EntityDef): number => {
    const e = addEntity(def, false);
    palletOrdinal.set(e, pallets.add());
    return e;
  };
  const setPallet = (entity: number, t: number, at: number, ref: number, slot: number, ev: number) => {
    const o = palletOrdinal.get(entity);
    if (o !== undefined) pallets.set(o, t, at, ref, slot, ev);
  };

  const actors = new Map<string, Actor>();
  for (const w of init.workers) {
    const entity = addEntity(
      {
        kind: "worker",
        id: w.id,
        label: w.id,
        colorIdx: Math.max(0, roles.indexOf(w.role)),
        meta: { role: w.role, type: w.type, skills: w.skills.join(", "), productivity: w.productivity, hourlyRate: w.hourlyRate },
      },
      true
    );
    const tb = builders[entity]!;
    tb.push({ t: 0, x: world.entry[0], y: world.entry[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.none });
    actors.set(w.id, { id: w.id, entity, tb, prod: w.productivity, present: false, shiftEnd: 0, home: world.homes.stock, lastCart: -1, lastJack: -1, lastPost: -1 });
  }

  const vehicles = { cart: new Map<number, Vehicle>(), jack: new Map<number, Vehicle>(), van: new Map<number, Vehicle>() };
  const getVehicle = (kind: "cart" | "jack" | "van", index: number): Vehicle => {
    const map = vehicles[kind];
    const hit = map.get(index);
    if (hit) return hit;
    const park = kind === "van" ? (world.lot.vanBays[index % Math.max(1, world.lot.vanBays.length)] ?? world.entry) : parkSpot(world, kind, index);
    const label = kind === "cart" ? `Stock cart ${index + 1}` : kind === "jack" ? `Pallet jack ${index + 1}` : `Delivery van ${index + 1}`;
    const entity = addEntity({ kind, id: `${kind[0].toUpperCase()}${index}`, label, colorIdx: 0, meta: { index } }, true);
    const tb = builders[entity]!;
    tb.push({ t: 0, x: park[0], y: park[1], s: ActorState.Idle, seg: SegKind.Hold, job: SYNTH_JOB.none });
    const v: Vehicle = { kind, index, entity, tb, park };
    map.set(index, v);
    return v;
  };
  for (let i = 0; i < init.stockCarts; i++) getVehicle("cart", i);
  for (let i = 0; i < init.palletJacks; i++) getVehicle("jack", i);
  for (let i = 0; i < init.vans; i++) getVehicle("van", i);

  // --- Free lists: the identities the engine counts but never names ---
  const carts = new FreeList(init.stockCarts);
  const jacks = new FreeList(init.palletJacks);
  const vans = new FreeList(init.vans);
  const registers = new FreeList(registerPosts.length);
  const counters = new FreeList(counterPosts.length);
  const wraps = new FreeList(wrapPosts.length);
  const docks = new FreeList(goodsFrames.length);
  const laneSpots = goodsFrames.map(() => new FreeList(LANE_SLOTS));
  const stalls = new StallAllocator(world.lot.stalls.map((s) => s.kind));
  /**
   * When each stall's last car is drawn as gone. A shopper's arrival is
   * back-dated by the walk in from the lot, which can reach behind the minute
   * the previous car pulled out, so the timeline clamps: the model frees the
   * bay when the shopper walks out, the picture frees it when the car has left.
   */
  const stallFreeAt = new Array<number>(world.lot.stalls.length).fill(0);

  /**
   * What the scenario has out of service today. The engine only subtracts a
   * count from the registers, counters or doors available, so the playback
   * takes the last `count` of that kind out: they show the outage colour and
   * nothing is drawn working at them while the window lasts.
   */
  const outPosts = new Set<number>();
  const outDoors = new Set<number>();
  const outOn = (list: Array<{ fromDay: number; toDay: number; count: number }>, pool: number[], day: number): number[] => {
    const count = Math.min(pool.length, list.filter((o) => day >= o.fromDay && day <= o.toDay).reduce((a, o) => a + o.count, 0));
    return pool.slice(pool.length - count);
  };
  const postSkip = (pool: number[]) => (i: number) => outPosts.has(pool[i] ?? -1);
  const doorSkip = (i: number) => outDoors.has(i);

  // --- Timelines ---
  const initFacing = new Map(init.facing);
  const facings = new CsrBuilder(layout.facings.length, (i) => (facingSku[i] >= 0 ? Math.max(0, Math.min(65535, Math.round(initFacing.get(skus[facingSku[i]].id) ?? 0))) : 0));
  const facingHot = new CsrBuilder(layout.facings.length, () => 0);
  const storage = new CsrBuilder(layout.storage.length, () => 0);
  const storageSku = new CsrBuilder(layout.storage.length, () => -1);
  const doors = new CsrBuilder(goodsFrames.length, () => -1);
  const laneSlotsT = new CsrBuilder(goodsFrames.length * LANE_SLOTS, () => -1);
  const postsT = new CsrBuilder(posts.length, () => -1);
  const queueLen = new CsrBuilder(posts.length, () => 0);
  const stallsT = new CsrBuilder(world.lot.stalls.length, () => -1);

  /**
   * Pallets standing on each lane spot, newest last. Past LANE_SLOTS the free
   * list hands out overflow indices, so the spot's timeline names whichever
   * pallet arrived last and stays occupied until the last one leaves.
   */
  const laneStacks = new Map<number, number[]>();
  const laneArrive = (door: number, rawSlot: number, pallet: number, t: number, ev: number) => {
    const item = door * LANE_SLOTS + (rawSlot % LANE_SLOTS);
    const stack = laneStacks.get(item) ?? [];
    stack.push(pallet);
    laneStacks.set(item, stack);
    laneSlotsT.set(item, t, pallet, ev);
  };
  const laneLeave = (door: number, rawSlot: number, pallet: number, t: number, ev: number) => {
    const item = door * LANE_SLOTS + (rawSlot % LANE_SLOTS);
    const stack = laneStacks.get(item) ?? [];
    const k = stack.indexOf(pallet);
    if (k >= 0) stack.splice(k, 1);
    laneSlotsT.set(item, t, stack.length ? stack[stack.length - 1] : -1, ev);
  };
  /** A door's or post's idle value: -2 while the scenario has it out, else -1. */
  const doorIdle = (i: number): number => (outDoors.has(i) ? -2 : -1);
  const postIdle = (i: number): number => (outPosts.has(i) ? -2 : -1);

  const homes: Array<[number, number]> = [];
  for (const [sku, loc] of init.backLoc) {
    const s = skuIdx.get(sku);
    const p = storageIndex.get(loc);
    if (s !== undefined && p !== undefined) homes.push([s, p]);
  }
  const allocator = new StorageAllocator(layout.storage, homes);
  const applyBack = (sku: string, units: number, t: number, ev: number) => {
    const s = skuIdx.get(sku);
    if (s === undefined) return;
    for (const c of allocator.set(s, casesOf(sku, units))) {
      storage.set(c.pos, t, Math.max(0, Math.min(65535, c.cases)), ev);
      storageSku.set(c.pos, t, c.sku, ev);
    }
  };
  for (const [sku, units] of init.back) applyBack(sku, units, 0, -1);

  // --- Runtime records ---
  const jobs: JobRow[] = [];
  const running = new Map<number, JobRun>();
  const trucks = new Map<string, TruckRec>();
  const waiting: TruckRec[] = [];
  const shoppers = new Map<string, Shopper>();
  const byEntity = new Map<number, Shopper>();
  const orders = new Map<string, OrderRec>();
  const palletSpot = new Map<number, { door: number; slot: number }>();
  /** Which post a shopper queued at, so the job that serves them uses it if it can. */
  const queuedPost = new Map<string, number>();
  const restockSkus = new Map<number, string[]>();
  const vanOfJob = new Map<number, number>();
  /** Rounds out on the road, oldest first: a van is released when the oldest returns. */
  const liveVans: Array<{ van: number; jobVan: number }> = [];
  const rounds: string[][] = [];

  // --- KPIs, bins, checkpoints, samples ---
  const kctx: KpiContext = kpiContext(init, events, skus);
  const state: KpiState = createState(init);
  const checkpoints: Checkpoint[] = [];
  let cpT = 0;
  const qCount = Math.max(1, Math.ceil(horizonEnd));
  const kCount = Math.max(1, Math.ceil(horizonEnd / 5));
  const queueBins: Bins = { binMin: 1, count: qCount, queues: new Uint16Array(qCount * PROCESSES.length), series: new Float32Array(0) };
  const kpiBins: Bins = { binMin: 5, count: kCount, queues: new Uint16Array(0), series: new Float32Array(kCount * KPI_SERIES.length) };
  let qBin = 0;
  let kBin = 0;
  const seriesValue = (k: (typeof KPI_SERIES)[number]): number => {
    switch (k) {
      case "salesDollars":
        return state.salesDollars;
      case "unitsSold":
        return state.unitsSold;
      case "transactions":
        return state.transactions;
      case "inStore":
        return state.inStore;
      case "lostShelfDollars":
        return state.lostShelfDollars;
      case "lostQueueDollars":
        return state.lostQueueDollars;
      case "counterWait":
        return state.counterWaitN > 0 ? state.counterWaitSum / state.counterWaitN : 0;
      case "registerWait":
        return state.registerWaitN > 0 ? state.registerWaitSum / state.registerWaitN : 0;
      case "abandoned":
        return state.abandonedCounter + state.abandonedRegister;
      case "onShelfShare": {
        // The share of what customers reached for that was actually there.
        const taken = state.unitsTaken ?? 0;
        const missed = state.lostShelfUnits ?? 0;
        return taken + missed > 0 ? taken / (taken + missed) : 1;
      }
      case "restocks":
        return state.restocks;
      case "hotRestocks":
        return state.hotRestocks;
      case "paidHours":
        return state.paidHours + state.overtimeHours;
      case "busyHours":
        return state.busyHours;
      case "overtimeHours":
        return state.overtimeHours;
      case "laborCost":
        return state.regularCost + state.overtimeCost;
      case "presentWorkers":
        return state.presentWorkers;
      case "queueTotal":
        return state.queues.reduce((a, b) => a + b, 0);
    }
  };
  const fillBins = (upTo: number) => {
    while (qBin < qCount && qBin + 1 < upTo) {
      state.queues.forEach((q, p) => (queueBins.queues[qBin * PROCESSES.length + p] = Math.max(0, Math.min(65535, q))));
      qBin++;
    }
    while (kBin < kCount && (kBin + 1) * 5 < upTo) {
      KPI_SERIES.forEach((k, j) => (kpiBins.series[kBin * KPI_SERIES.length + j] = seriesValue(k)));
      kBin++;
    }
    while (cpT < upTo && cpT <= horizonEnd) {
      checkpoints.push({ t: cpT, kpis: cloneState(state) });
      cpT += checkpointMin;
    }
  };

  const samples = { dockToStock: [] as number[], counterWait: [] as number[], registerWait: [] as number[], orderCycle: [] as number[] };
  const ticker: TickerEvent[] = [];
  const supplierName = new Map((input.suppliers ?? []).map((s) => [s.id, s.name]));
  const poSupplier = new Map<string, string>();
  const skuName = new Map(init.skuNames);
  const tickerNames: TickerNames = {
    sku: (id) => skuName.get(id) ?? skuById.get(id)?.name ?? id,
    supplier: (id) => supplierName.get(id) ?? id,
    po: (po) => {
      const s = poSupplier.get(po);
      return s === undefined ? po : (supplierName.get(s) ?? s);
    },
    order: (id) => orders.get(id)?.label ?? id,
  };
  /** One "till down" line per outage: overlapping windows make the engine note a second one. */
  let posDown = false;

  const quiet: Array<[number, number]> = [];
  let inBuilding = 0;
  let quietStart = 0;
  const floorChange = (t: number, delta: number) => {
    const before = inBuilding;
    inBuilding = Math.max(0, inBuilding + delta);
    if (before === 0 && inBuilding > 0) {
      if (t - quietStart >= QUIET_MIN) quiet.push([quietStart, t]);
    } else if (before > 0 && inBuilding === 0) quietStart = t;
  };
  const onFloorIds = new Set<string>();

  // --- Synthesized movement ---
  const walkSink = (tb: TrackBuilder, moveState: ActorStateValue, seg: SegKindValue, restState: ActorStateValue): Sink => ({
    tb,
    moveState,
    stopState: restState,
    moveSeg: seg,
    loadedSeg: seg,
    stopSeg: SegKind.Hold,
    lift: false,
    carry: () => -1,
  });
  /** Cut whatever was planned for this track at t and hold there. */
  const hold = (tb: TrackBuilder, t: number, s: ActorStateValue, job: number = SYNTH_JOB.none): Pt => {
    const p = tb.cutAt(t);
    tb.push({ t, x: p.x, y: p.y, z: 0, h: p.h, s, seg: SegKind.Hold, job });
    return [p.x, p.y];
  };
  const settle = (a: Actor, t: number): Pt => hold(a.tb, t, a.present ? (t >= a.shiftEnd ? ActorState.Overtime : ActorState.Idle) : ActorState.Off);
  /** After a job: linger, then walk home; cut short by whatever comes next. */
  const idleAfter = (a: Actor, t: number) => {
    const pos = settle(a, t);
    if (!a.present) return;
    const rest = t >= a.shiftEnd ? ActorState.Overtime : ActorState.Idle;
    if (dist(pos, a.home) < 0.5) return;
    const path = transferPath(layout, world, pos, a.home);
    const start = t + WORKER_LINGER_MIN;
    a.tb.push({ t: start, x: pos[0], y: pos[1], s: rest, seg: SegKind.IdleReturn, job: SYNTH_JOB.none });
    layoutRoute([walkSink(a.tb, ActorState.Walk, SegKind.IdleReturn, rest)], path, start, path.feet / (walkFpm * a.prod), 0, SYNTH_JOB.none, heightOf);
  };
  const vehicleIdle = (v: Vehicle, t: number) => {
    const pos = hold(v.tb, t, ActorState.Idle);
    if (dist(pos, v.park) < 0.5) return;
    const path = transferPath(layout, world, pos, v.park);
    const start = t + VEHICLE_LINGER_MIN;
    v.tb.push({ t: start, x: pos[0], y: pos[1], s: ActorState.Idle, seg: SegKind.IdleReturn, job: SYNTH_JOB.none });
    layoutRoute([walkSink(v.tb, ActorState.Push, SegKind.IdleReturn, ActorState.Idle)], path, start, path.feet / walkFpm, 0, SYNTH_JOB.none, heightOf);
  };

  // --- Queues: the most visible thing on the page ---
  const lines: number[][] = posts.map(() => []);
  const slotPt = (p: ServicePost, slot: number): Pt => (slot <= 0 ? p.head : (p.queue[Math.min(slot - 1, p.queue.length - 1)] ?? p.head));
  const joinQueue = (post: number, c: Shopper, t: number, ev: number) => {
    const p = posts[post];
    const line = lines[post];
    line.push(c.entity);
    c.post = post;
    c.slot = line.length - 1;
    const from = hold(c.tb, t, ActorState.Walk, SYNTH_JOB.shop);
    const to = slotPt(p, c.slot);
    const path = transferPath(layout, world, from, to);
    const walk = Math.min(QUEUE_JOIN_MAX_MIN, path.feet / walkFpm);
    layoutRoute([walkSink(c.tb, ActorState.Walk, SegKind.Walk, ActorState.Queue)], path, t, walk, 0, SYNTH_JOB.shop, heightOf);
    queueLen.set(post, t, Math.min(65535, line.length), ev);
  };
  const leaveQueue = (c: Shopper, t: number, ev: number) => {
    const post = c.post;
    if (post < 0) return;
    c.post = -1;
    const line = lines[post];
    const i = line.indexOf(c.entity);
    if (i < 0) return;
    line.splice(i, 1);
    queueLen.set(post, t, Math.min(65535, line.length), ev);
    // Everyone behind shuffles up a place, which is what makes a line read as a line.
    for (let k = i; k < line.length; k++) {
      const other = byEntity.get(line[k]);
      if (!other) continue;
      const p = posts[post];
      const from = hold(other.tb, t, ActorState.Queue, SYNTH_JOB.shop);
      other.slot = k;
      const path = transferPath(layout, world, from, slotPt(p, k));
      layoutRoute([walkSink(other.tb, ActorState.Walk, SegKind.Walk, ActorState.Queue)], path, t, Math.min(QUEUE_STEP_MIN, path.feet / walkFpm), 0, SYNTH_JOB.shop, heightOf);
    }
  };

  // --- Vehicles on the road ---
  const spawnLeftOf = (fromLeft: boolean, lot: boolean): Pt => (lot ? (fromLeft ? world.lot.spawnLeft : world.lot.spawnRight) : fromLeft ? world.service.spawnLeft : world.service.spawnRight);
  /**
   * Spawn → service drive → (waiting spot) → backed onto the door at dockT.
   * Back-dated so the trailer is at the waiting spot by the minute it arrived,
   * with the wait absorbing the rest. `dockT` null means it never got a door.
   */
  const layoutDock = (tb: TrackBuilder, g: number, earliest: number, arriveT: number, dockT: number | null, queueSpot: number) => {
    const frame = goodsFrames[g];
    const path = dockPath(world, frame, true, queueSpot);
    const holdV = path.queueVertex >= 0 ? path.queueVertex : path.roadVertex;
    const backV = path.queueVertex >= 0 ? path.queueVertex + 1 : path.roadVertex;
    const cum: number[] = [0];
    for (let i = 1; i < path.pts.length; i++) cum.push(cum[i - 1] + dist(path.pts[i], path.pts[i - 1]));
    const toHold = cum[holdV] / ROAD_FT_PER_MIN;
    const rest = (cum[backV] - cum[holdV]) / ROAD_FT_PER_MIN;
    const backStart = dockT === null ? Infinity : dockT - BACK_IN_MIN;
    const leaveHold = backStart - rest;
    const dayStart = Math.floor(arriveT / 1440) * 1440;
    let spawnT = Math.min(earliest, arriveT - toHold, Number.isFinite(leaveHold) ? leaveHold - toHold : Infinity);
    spawnT = Math.max(0, dayStart, spawnT);
    const spawn = spawnLeftOf(true, false);
    const dock = trailerPose(frame);
    tb.push({ t: 0, x: spawn[0], y: spawn[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.road });
    let t = spawnT;
    let roadFrame = -1;
    let roadH = 0;
    for (let i = 0; i <= holdV; i++) {
      const p = path.pts[i];
      t = spawnT + cum[i] / ROAD_FT_PER_MIN;
      tb.push({ t, x: p[0], y: p[1], s: ActorState.Drive, seg: SegKind.Lot, job: SYNTH_JOB.road });
      if (i === path.roadVertex) {
        roadFrame = tb.n - 1;
        roadH = tb.heading();
      }
    }
    /**
     * From the road point on, the trailer reverses. The track position is its
     * rear and the renderer draws the box forward along the heading, so every
     * frame after the road vertex is forced to point the nose away from the
     * door — a motion-derived heading would swing the trailer through the wall.
     */
    const noseOut = () => {
      if (roadFrame < 0) return;
      tb.h[roadFrame] = roadH;
      for (let k = roadFrame + 1; k < tb.n; k++) tb.h[k] = dock.heading;
    };
    const holdP = path.pts[holdV];
    tb.push({ t, x: holdP[0], y: holdP[1], s: ActorState.Wait, seg: SegKind.Hold, job: SYNTH_JOB.road });
    if (dockT === null) {
      noseOut();
      return;
    }
    let leave = Math.max(t, leaveHold);
    tb.push({ t: leave, x: holdP[0], y: holdP[1], s: ActorState.Drive, seg: SegKind.Lot, job: SYNTH_JOB.road });
    for (let i = holdV + 1; i <= backV; i++) {
      const p = path.pts[i];
      leave = leave + dist(p, path.pts[i - 1]) / ROAD_FT_PER_MIN;
      tb.push({ t: leave, x: p[0], y: p[1], s: ActorState.Drive, seg: SegKind.Lot, job: SYNTH_JOB.road });
    }
    const road = path.pts[backV];
    const bs = Math.max(leave, backStart);
    tb.push({ t: bs, x: road[0], y: road[1], s: ActorState.Drive, seg: SegKind.Lot, job: SYNTH_JOB.road });
    tb.push({ t: Math.max(dockT, bs + FADE_EPS_MIN), x: dock.pt[0], y: dock.pt[1], h: dock.heading, s: ActorState.Docked, seg: SegKind.Hold, job: SYNTH_JOB.road });
    noseOut();
  };
  const layoutUndock = (tb: TrackBuilder, g: number, leaveT: number) => {
    const frame = goodsFrames[g];
    const path = undockPath(world, frame, true);
    const p = tb.cutAt(leaveT);
    tb.push({ t: leaveT, x: p.x, y: p.y, h: p.h, s: ActorState.Depart, seg: SegKind.Lot, job: SYNTH_JOB.road });
    let t = leaveT + BACK_IN_MIN;
    for (let i = 1; i < path.pts.length; i++) {
      if (i > 1) t += dist(path.pts[i], path.pts[i - 1]) / ROAD_FT_PER_MIN;
      tb.push({ t, x: path.pts[i][0], y: path.pts[i][1], h: p.h, s: ActorState.Depart, seg: SegKind.Lot, job: SYNTH_JOB.road });
    }
    const last = path.pts[path.pts.length - 1];
    tb.push({ t: t + FADE_EPS_MIN, x: last[0], y: last[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.road });
  };

  // --- Job starts ---
  const laneCenter = (g: number, slot: number): { spot: Pt; center: Pt } => {
    const f = goodsFrames[g];
    const k = slot % LANE_SLOTS;
    const row = Math.floor(k / 2);
    const spot = world.lanes[g]?.slots[k] ?? thresholdPoint(f);
    return { spot, center: [f.origin[0] + f.inward[0] * (8 + 5 * row), f.origin[1] + f.inward[1] * (8 + 5 * row)] };
  };
  const doorOf = (po: string): number => trucks.get(po)?.door ?? (goodsFrames.length > 0 ? 0 : -1);
  /** The same trip drawn straight through the fixtures, for `offsets: false`. */
  const straightFacingPath = (marks: Array<{ facing: Facing; minutes: number }>, origin: Pt, back: Pt): Path =>
    polyPath(
      [origin, ...marks.map((m) => [m.facing.x, m.facing.y] as Pt), back],
      marks.map((m, i) => ({ i: i + 1, minutes: m.minutes, id: m.facing.id, shelf: m.facing.shelf }))
    );

  const startJob = (e: Extract<TraceEvent, { k: "jobStart" }>, ev: number) => {
    const row = jobs[e.job - 1];
    const a = actors.get(e.worker);
    if (!row || !a || row.startAt >= 0) return;
    const info = row.info;
    const t = e.t;
    const dur = e.dur;
    const prod = e.productivity;
    row.startAt = t;
    row.endAt = t + dur;
    row.truncated = row.endAt > horizonEnd;
    row.worker = e.worker;
    row.productivity = prod;
    row.dur = dur;
    row.waitMin = e.waitMin;
    row.equipWaitMin = e.equipWaitMin;
    const from = settle(a, t);
    a.present = true;

    let H = 0;
    let route: Path = pointPath(from, 0);
    let vehicle: Vehicle | null = null;
    let carryOf: (v: number) => number = () => -1;
    let loadedOf: (v: number) => boolean = () => false;
    let post = -1;
    let wrapPost = -1;
    let laneDoor = -1;
    let laneSlot = -1;
    let pallet = -1;
    let customer = -1;
    let dropPos = -1;
    let dropStop = -1;
    let lift = false;

    // A worker keeps the cart or jack they had last when it is free, which
    // reads far better on screen than shuffling equipment between people.
    const takeCart = (): Vehicle => {
      const v = getVehicle("cart", carts.acquire(a.lastCart >= 0 ? a.lastCart : undefined).index);
      a.lastCart = v.index;
      row.cart = v.index;
      return v;
    };
    const takeJack = (): Vehicle => {
      const v = getVehicle("jack", jacks.acquire(a.lastJack >= 0 ? a.lastJack : undefined).index);
      a.lastJack = v.index;
      row.jack = v.index;
      return v;
    };
    /** The shopper this job is about, already standing in a line. */
    const takeCustomer = (id: string, pool: number[], list: FreeList): number => {
      const c = shoppers.get(id);
      customer = c?.entity ?? -1;
      const want = queuedPost.get(id);
      const prefer = want !== undefined ? pool.indexOf(want) : -1;
      const got = list.acquire(prefer >= 0 ? prefer : undefined, postSkip(pool));
      const p = pool[got.index % Math.max(1, pool.length)] ?? -1;
      if (c) {
        // They step out of the line and up to whichever position took them,
        // which is what "next till please" looks like on the floor.
        leaveQueue(c, t, ev);
        if (p >= 0) {
          const at = posts[p].head;
          c.tb.push({ t, x: at[0], y: at[1], s: ActorState.Queue, seg: SegKind.Hold, job: e.job });
          c.tb.push({ t: t + dur, x: at[0], y: at[1], s: ActorState.Queue, seg: SegKind.Hold, job: e.job });
        }
      }
      if (p >= 0 && customer >= 0) postsT.set(p, t, customer, ev);
      return p;
    };

    switch (info.kind) {
      case "unload": {
        const truck = trucks.get(info.po);
        const g = doorOf(info.po);
        if (kctx.jackJobs.has(e.job)) vehicle = takeJack();
        laneDoor = g;
        laneSlot = g >= 0 ? laneSpots[g].acquire().index : -1;
        pallet = truck?.pallets[info.pallet] ?? -1;
        const { spot, center } = laneCenter(Math.max(0, g), Math.max(0, laneSlot));
        const thr = thresholdPoint(goodsFrames[Math.max(0, g)] ?? world.frames[0]);
        H = (truck?.mode === "direct" ? info.cases * std.unloadPerCase : std.unloadPerPallet) + (info.pallet === 0 ? std.unloadPerTruck : 0);
        route = polyPath([thr, center, spot], [{ i: 0, minutes: H }]);
        const p = pallet;
        carryOf = () => p;
        row.door = g;
        break;
      }
      case "receive": {
        const truck = trucks.get(info.po);
        pallet = truck?.pallets[info.pallet] ?? -1;
        const rec = palletSpot.get(pallet);
        const g = rec?.door ?? doorOf(info.po);
        const at: Pt = rec ? laneCenter(rec.door, rec.slot).spot : [layout.staging.x, layout.staging.y];
        H = info.cases * std.receivePerCase + (info.importer ? info.cases * std.labelPerImportCase : 0);
        route = pointPath(at, H);
        row.door = g;
        break;
      }
      case "putaway": {
        const truck = trucks.get(info.po);
        pallet = truck?.pallets[info.pallet] ?? -1;
        const rec = palletSpot.get(pallet);
        const g = rec?.door ?? doorOf(info.po);
        const origin: Pt = rec ? laneCenter(rec.door, rec.slot).spot : [layout.staging.x, layout.staging.y];
        if (kctx.jackJobs.has(e.job)) vehicle = takeJack();
        const seen = new Set<string>();
        const positions: Array<{ pos: StoragePosition; minutes: number }> = [];
        for (const it of info.items) {
          const p = storageById.get(it.loc);
          if (!p || seen.has(p.id)) continue;
          seen.add(p.id);
          positions.push({ pos: p, minutes: std.putawayHandling });
        }
        H = std.putawayHandling * Math.max(1, info.items.length);
        route = useOffsets
          ? putawayPath(layout, world, origin, positions)
          : polyPath([origin, ...positions.map((p) => [p.pos.x, p.pos.y] as Pt), origin], positions.map((p, i) => ({ i: i + 1, minutes: p.minutes, id: p.pos.id, shelf: p.pos.level })));
        lift = true;
        const lastStop = route.stops.length - 1;
        const lastV = lastStop >= 0 ? route.stops[lastStop].i : 0;
        const p = pallet;
        carryOf = (v) => (v < lastV ? p : -1);
        dropStop = lastStop;
        const far = positions.reduce<StoragePosition | null>((best, x) => (!best || dist(origin, [x.pos.x, x.pos.y]) > dist(origin, [best.x, best.y]) ? x.pos : best), null);
        dropPos = far ? (storageIndex.get(far.id) ?? -1) : -1;
        if (rec && pallet >= 0) {
          laneSpots[rec.door]?.release(rec.slot);
          laneLeave(rec.door, rec.slot, pallet, t, ev);
          palletSpot.delete(pallet);
        }
        if (pallet >= 0 && vehicle) setPallet(pallet, t, PalletAt.Jack, vehicle.entity, -1, ev);
        row.door = g;
        break;
      }
      case "restock": {
        if (kctx.cartJobs.has(e.job)) vehicle = takeCart();
        const marks: Array<{ facing: Facing; minutes: number }> = [];
        let handling = 0;
        for (const l of info.lines) {
          const f = facingById.get(l.to);
          if (!f) continue;
          // A shop works in display boxes, not master cases: the box is what
          // comes off the cart, gets opened, priced and faced.
          const boxes = Math.max(1, Math.ceil(l.units / Math.max(1, skuById.get(l.sku)?.unitsPerInner ?? 1)));
          const tray = f.kind === "showcase" || f.kind === "bulk";
          const shelves = shelvesOf.get(f.run) ?? 1;
          let m = (tray ? std.restockPerTray : std.restockPerCase) * boxes;
          if (!isGoldenShelf(f.shelf, shelves)) m += (boxes * std.restockBendReachSec) / 60;
          handling += m;
          marks.push({ facing: f, minutes: m });
        }
        // Worked in floor order, which is the order the engine costed the walk in.
        marks.sort((x, y) => x.facing.aisle - y.facing.aisle || x.facing.y - y.facing.y);
        H = std.restockPerTrip + handling;
        route = marks.length > 0 ? (useOffsets ? restockPath(layout, world, marks) : straightFacingPath(marks, world.stockDoor, world.stockDoor)) : pointPath(world.stockDoor, H);
        lift = true;
        const lastDrop = route.stops[route.stops.length - 1]?.i ?? 0;
        loadedOf = (v) => v < lastDrop;
        break;
      }
      case "serve": {
        post = takeCustomer(info.customer, counterPosts, counters);
        H = std.servePerCustomer + info.lines.length * std.servePerItem;
        route = pointPath(post >= 0 ? posts[post].worker : world.homes.counter, H);
        break;
      }
      case "checkout": {
        post = takeCustomer(info.customer, registerPosts, registers);
        H = std.checkoutPerCustomer + info.lines * std.checkoutPerItem + (info.weighed * std.checkoutWeighSec) / 60 + (info.wrap ? std.giftWrapPerOrder : 0);
        route = pointPath(post >= 0 ? posts[post].worker : world.homes.register, H);
        break;
      }
      case "pick": {
        vehicle = takeCart();
        const marks: Array<{ facing: Facing; minutes: number }> = [];
        for (const l of info.lines) {
          const f = facingById.get(l.loc);
          if (f) marks.push({ facing: f, minutes: std.pickPerLine + l.units * std.pickPerUnit });
        }
        H = info.handleMin + (info.reaches * std.restockBendReachSec) / 60;
        route = marks.length > 0 ? (useOffsets ? pickPath(layout, world, marks, std) : straightFacingPath(marks, world.bench, world.bench)) : pointPath(world.bench, H);
        lift = true;
        loadedOf = () => true;
        break;
      }
      case "pack": {
        H = std.packPerOrder + info.lines * std.packPerLine + (info.wrap ? std.giftWrapPerOrder : 0);
        route = pointPath(world.bench, H);
        if (info.wrap && wrapPosts.length > 0) {
          const got = wraps.acquire(a.lastPost >= 0 ? a.lastPost : undefined);
          wrapPost = wrapPosts[got.index % wrapPosts.length];
          a.lastPost = got.index;
          postsT.set(wrapPost, t, a.entity, ev);
        }
        const o = orders.get(info.order);
        if (o && o.tote < 0) {
          o.tote = addPallet({ kind: "pallet", id: `${o.id}#tote`, label: o.label, colorIdx: 1, meta: { order: o.id, kind: o.kind } });
          setPallet(o.tote, t + dur, PalletAt.Bench, -1, -1, ev);
        }
        break;
      }
      case "load": {
        const got = vans.acquire(info.van);
        const v = getVehicle("van", got.index);
        vanOfJob.set(e.job, got.index);
        liveVans.push({ van: got.index, jobVan: e.job });
        row.van = got.index;
        H = std.loadPerVan + info.orders * std.loadPerOrder;
        route = polyPath([world.bench, v.park], [{ i: 1, minutes: H }]);
        break;
      }
      case "deliver": {
        // The round itself happens off the model — the shop is what is drawn —
        // so the route is out of the lot and back, and the minutes in between
        // are a hold at the edge of the world with the driver switched off.
        vehicle = getVehicle("van", info.van);
        row.van = vehicle.index;
        const out = vanRoundPath(world, vehicle.park, true);
        const back = out.pts.slice(0, -1).reverse();
        H = info.stops * std.deliverPerStop + info.miles * std.deliverPerMile;
        route = polyPath([...out.pts, ...back], [{ i: out.pts.length - 1, minutes: H }]);
        break;
      }
    }

    // --- The transfer leg, and the fit ---
    // A cart or a jack has to be fetched first: the worker walks to it (a) and
    // the two go on to the route origin together (b).
    const origin = route.pts[0] ?? from;
    const pathA = transferPath(layout, world, from, vehicle ? vehicle.tb.pos() : origin);
    const pathB = vehicle ? transferPath(layout, world, vehicle.tb.pos(), origin) : null;
    const feetA = pathA.feet;
    const feetB = pathB?.feet ?? 0;
    if (vehicle) {
      // Whatever the cart was planning to do next is cut here.
      const p = vehicle.tb.cutAt(t);
      vehicle.tb.push({ t, x: p.x, y: p.y, z: 0, h: p.h, s: ActorState.Idle, seg: SegKind.Hold, job: e.job });
    }

    const fit: FitResult = fitJob({ dur, productivity: prod, nominal: walkFpm, handleMin: H, routeFeet: route.feet, transferFeet: feetA + feetB });
    row.routeFeet = route.feet;
    row.transferFeet = feetA + feetB;
    row.visualFeet = fit.visualFeet;
    row.stopMin = fit.stopMin;
    row.moveMin = fit.moveMin;
    row.speedRatio = fit.speedRatio;
    row.fit = fit.fit;
    row.post = post >= 0 ? post : wrapPost;

    const driving = vehicle?.kind === "van";
    const carrying = vehicle?.kind === "jack" ? SegKind.Jack : driving ? SegKind.Drive : SegKind.WalkCart;
    const workerSink: Sink = {
      tb: a.tb,
      moveState: driving ? ActorState.Drive : vehicle ? ActorState.Push : ActorState.Walk,
      stopState:
        info.kind === "serve" ? ActorState.Serve : info.kind === "checkout" ? ActorState.Ring : info.kind === "deliver" ? ActorState.Off : ActorState.Work,
      moveSeg: vehicle ? carrying : SegKind.Walk,
      loadedSeg: carrying,
      stopSeg: lift ? SegKind.Reach : SegKind.Handle,
      lift,
      carry: vehicle ? () => vehicle.entity : () => -1,
    };
    const vehicleSink: Sink | null = vehicle
      ? {
          tb: vehicle.tb,
          moveState: driving ? ActorState.Drive : ActorState.Push,
          stopState: driving ? ActorState.Off : ActorState.Work,
          moveSeg: carrying,
          loadedSeg: carrying,
          stopSeg: SegKind.Hold,
          lift: false,
          carry: carryOf,
        }
      : null;
    const routeSinks: Sink[] = vehicleSink ? [workerSink, vehicleSink] : [workerSink];
    const loadedSinks = routeSinks.map((s) => ({ ...s, carry: (v: number) => (loadedOf(v) && s.carry(v) === -1 ? -2 : s.carry(v)) }));

    let tRoute = t;
    let stopLeft = fit.stopMin;
    const ratio = fit.speedRatio;
    if (fit.fit === "fadeIn" || (fit.transferFeet === 0 && feetA + feetB > 0.5)) {
      // Teleport: Off where they were, back at the route origin a moment later.
      a.tb.push({ t, x: from[0], y: from[1], s: ActorState.Off, seg: SegKind.Hold, job: e.job });
      a.tb.push({ t: t + FADE_EPS_MIN, x: origin[0], y: origin[1], s: workerSink.moveState, seg: SegKind.Hold, job: e.job });
      if (vehicle) {
        const at = vehicle.tb.pos();
        vehicle.tb.push({ t, x: at[0], y: at[1], s: ActorState.Off, seg: SegKind.Hold, job: e.job });
        vehicle.tb.push({ t: t + FADE_EPS_MIN, x: origin[0], y: origin[1], s: ActorState.Idle, seg: SegKind.Hold, job: e.job });
      }
      tRoute = t + FADE_EPS_MIN;
      stopLeft -= Math.min(FADE_EPS_MIN, stopLeft);
    } else {
      if (feetA > 0) {
        const minA = feetA / (walkFpm * prod * ratio);
        layoutRoute([walkSink(a.tb, ActorState.Walk, SegKind.Transfer, ActorState.Walk)], pathA, tRoute, minA, 0, e.job, heightOf);
        tRoute += minA;
      }
      if (vehicle && pathB && feetB > 0) {
        const v = vehicle;
        const minB = feetB / (walkFpm * prod * ratio);
        const ride = walkSink(a.tb, ActorState.Push, carrying, ActorState.Push);
        const vs = walkSink(v.tb, ActorState.Push, SegKind.Transfer, ActorState.Idle);
        layoutRoute([{ ...ride, carry: () => v.entity }, vs], pathB, tRoute, minB, 0, e.job, heightOf);
        tRoute += minB;
      }
    }

    // The route itself, ending exactly at t + dur.
    const total = Math.max(0, t + dur - tRoute);
    const stopMin = Math.min(stopLeft, total);
    const moveMin = Math.max(0, total - stopMin);
    const times = layoutRoute(loadedSinks, route, tRoute, moveMin, stopMin, e.job, heightOf);

    if (info.kind === "unload" && pallet >= 0 && vehicle) setPallet(pallet, times.stops[0]?.leave ?? t, PalletAt.Jack, vehicle.entity, -1, ev);
    if (info.kind === "putaway" && pallet >= 0 && dropStop >= 0) {
      const at = times.stops[dropStop]?.arrive ?? times.end;
      setPallet(pallet, at, PalletAt.Storage, dropPos, dropPos >= 0 ? allocator.casesAtPos(dropPos) : -1, ev);
    }
    if (info.kind === "load") {
      const v = vehicles.van.get(row.van);
      if (v) {
        // Every tote due on this round is carried out to the van at the drop
        // stop. `orders` is keyed by id but only read through, never iterated
        // for an allocation, so the order of the walk cannot affect anything.
        const dropT = times.stops[0]?.arrive ?? times.end;
        for (const o of orders.values()) {
          if (o.tote >= 0 && o.kind === "delivery" && o.dueAt === info.departAt) setPallet(o.tote, dropT, PalletAt.Van, v.entity, -1, ev);
        }
      }
    }
    running.set(e.job, { row, actor: a, vehicle, post, wrapPost, laneDoor, laneSlot, pallet, customer });
  };

  const endJob = (e: Extract<TraceEvent, { k: "jobEnd" }>, ev: number) => {
    const run = running.get(e.job);
    const a = actors.get(e.worker);
    if (!run) {
      if (a) idleAfter(a, e.t);
      return;
    }
    running.delete(e.job);
    const info = run.row.info;
    if (info.kind === "unload" && run.pallet >= 0 && run.laneDoor >= 0 && run.laneSlot >= 0) {
      palletSpot.set(run.pallet, { door: run.laneDoor, slot: run.laneSlot });
      setPallet(run.pallet, e.t, PalletAt.DockLane, run.laneDoor, run.laneSlot, ev);
      laneArrive(run.laneDoor, run.laneSlot, run.pallet, e.t, ev);
    }
    if (info.kind === "restock") {
      for (const sku of restockSkus.get(e.job) ?? []) {
        const f = facingOfSku.get(sku);
        if (f !== undefined) facingHot.set(f, e.t, 0, ev);
      }
    }
    if (run.post >= 0 && (info.kind === "serve" || info.kind === "checkout")) {
      const pool = info.kind === "serve" ? counterPosts : registerPosts;
      const list = info.kind === "serve" ? counters : registers;
      const i = pool.indexOf(run.post);
      if (i >= 0) list.release(i);
      postsT.set(run.post, e.t, postIdle(run.post), ev);
    }
    if (run.wrapPost >= 0) {
      const i = wrapPosts.indexOf(run.wrapPost);
      if (i >= 0) wraps.release(i);
      postsT.set(run.wrapPost, e.t, postIdle(run.wrapPost), ev);
    }
    if (run.vehicle) {
      const v = run.vehicle;
      if (v.kind === "cart") carts.release(v.index);
      else if (v.kind === "jack") jacks.release(v.index);
      vehicleIdle(v, e.t);
    }
    idleAfter(run.actor, e.t);
  };

  // --- Main pass ---
  /**
   * The bin clock. Three events are dated by something other than the stream
   * position: the doors carry the opening minute although the day announces
   * them at midnight, and an order going out — and the lateness beside it —
   * carries the minute the van left although the van reports it on its return.
   * None of them is the engine's `now`, so none is allowed to move the bins on.
   */
  let clock = 0;
  for (let ev = 0; ev < events.length; ev++) {
    const e = events[ev];
    if (e.k !== "doors" && e.k !== "orderLate" && e.k !== "orderOut" && e.t > clock) clock = e.t;
    fillBins(clock);
    applyEvent(state, e, kctx);
    let tickerEntity = -1;
    let tickerPos: Pt | undefined;
    let skipLine = false;

    switch (e.k) {
      case "init":
        break;
      case "day": {
        // Today's outages: what comes back into service goes idle again, what
        // goes out shows the outage colour as soon as it is free.
        const todayPosts = new Set([...outOn(init.outages.registers, registerPosts, e.day), ...outOn(init.outages.counters, counterPosts, e.day)]);
        for (const i of [...outPosts]) {
          if (todayPosts.has(i)) continue;
          outPosts.delete(i);
          if (postsT.get(i) === -2) postsT.set(i, e.t, -1, ev);
        }
        for (const i of todayPosts) {
          if (outPosts.has(i)) continue;
          outPosts.add(i);
          if (postsT.get(i) === -1) postsT.set(i, e.t, -2, ev);
        }
        const todayDoors = new Set(outOn(init.outages.docks, goodsFrames.map((_, i) => i), e.day));
        for (const i of [...outDoors]) {
          if (todayDoors.has(i)) continue;
          outDoors.delete(i);
          if (doors.get(i) === -2) doors.set(i, e.t, -1, ev);
        }
        for (const i of todayDoors) {
          if (outDoors.has(i)) continue;
          outDoors.add(i);
          if (doors.get(i) === -1) doors.set(i, e.t, -2, ev);
        }
        break;
      }
      case "doors":
        break;
      case "poPlaced":
        poSupplier.set(e.po, e.supplier);
        break;
      case "truckScheduled":
        poSupplier.set(e.po, e.supplier);
        break;

      case "truckArrive": {
        poSupplier.set(e.po, e.supplier);
        const entity = addEntity(
          {
            kind: "truck",
            id: e.po,
            label: `${e.mode === "overnight" ? "Overnight trailer" : "Box truck"} — ${tickerNames.supplier(e.supplier)}`,
            colorIdx: e.mode === "overnight" ? 0 : 1,
            meta: { po: e.po, supplier: e.supplier, mode: e.mode, importer: e.importer, pallets: e.pallets.length, day: e.day },
          },
          true
        );
        const palletEntities = e.pallets.map((p, i) =>
          addPallet({
            kind: "pallet",
            id: `${e.po}#${i}`,
            label: `${e.po} pallet ${i + 1}`,
            colorIdx: Math.max(0, skuById.get(p.items[0]?.sku ?? "")?.colorIdx ?? 0),
            meta: { po: e.po, index: i, mixed: p.mixed, items: p.items.map((it) => `${it.sku}×${it.cases}`).join(", "), supplier: e.supplier },
          })
        );
        for (const p of palletEntities) setPallet(p, e.t, PalletAt.Trailer, entity, -1, ev);
        const rec: TruckRec = {
          entity,
          tb: builders[entity]!,
          po: e.po,
          arriveT: e.t,
          eta: e.t,
          mode: e.mode,
          pallets: palletEntities,
          queuePos: waiting.length,
          door: -1,
          docked: false,
        };
        trucks.set(e.po, rec);
        waiting.push(rec);
        tickerEntity = entity;
        break;
      }
      case "truckDock": {
        const truck = trucks.get(e.po);
        if (!truck) break;
        const prefer = e.door !== null ? goodsOfDoorId.get(e.door) : undefined;
        const got = docks.acquire(prefer, doorSkip);
        const g = got.index % Math.max(1, goodsFrames.length);
        truck.door = g;
        truck.docked = true;
        const wi = waiting.indexOf(truck);
        if (wi >= 0) waiting.splice(wi, 1);
        const waited = e.t - truck.arriveT > 0.01;
        layoutDock(truck.tb, g, truck.arriveT - 3, truck.arriveT, e.t, waited ? truck.queuePos : -1);
        doors.set(g, e.t, truck.entity, ev);
        tickerEntity = truck.entity;
        tickerPos = goodsFrames[g]?.origin;
        break;
      }
      case "truckUndock": {
        const truck = trucks.get(e.po);
        if (!truck || !truck.docked || truck.door < 0) break;
        docks.release(truck.door);
        doors.set(truck.door, e.t, doorIdle(truck.door), ev);
        layoutUndock(truck.tb, truck.door, e.t + UNDOCK_LINGER_MIN);
        tickerEntity = truck.entity;
        break;
      }

      case "jobQueued": {
        const engineFeet =
          e.info.kind === "pick" || e.info.kind === "restock" || e.info.kind === "putaway" ? e.info.feet : e.info.kind === "deliver" ? e.info.miles * 5280 : 0;
        while (jobs.length < e.job - 1) jobs.push(placeholderJob(jobs.length + 1));
        jobs[e.job - 1] = {
          id: e.job,
          process: e.process,
          info: e.info,
          priority: e.priority,
          queuedAt: e.t,
          startAt: -1,
          endAt: -1,
          truncated: false,
          worker: "",
          productivity: 0,
          dur: 0,
          waitMin: 0,
          equipWaitMin: 0,
          cart: -1,
          jack: -1,
          van: -1,
          post: -1,
          door: -1,
          engineFeet,
          routeFeet: 0,
          transferFeet: 0,
          visualFeet: 0,
          stopMin: 0,
          moveMin: 0,
          speedRatio: 1,
          fit: "stationary",
          ev,
        };
        if (e.info.kind === "restock") {
          // Every facing on the trip shows as pending until the cart gets there.
          const skus = e.info.lines.map((l) => l.sku);
          restockSkus.set(e.job, skus);
          for (const sku of skus) {
            const f = facingOfSku.get(sku);
            if (f !== undefined) facingHot.set(f, e.t, 1, ev);
          }
        }
        break;
      }
      case "jobStart":
        startJob(e, ev);
        break;
      case "jobEnd":
        endJob(e, ev);
        break;

      case "putaway": {
        const truck = trucks.get(e.po);
        const p = truck?.pallets[e.pallet];
        if (p !== undefined) setPallet(p, e.t, PalletAt.Gone, -1, -1, ev);
        samples.dockToStock.push(e.dockToStockMin);
        break;
      }
      case "facing": {
        const f = facingOfSku.get(e.sku);
        if (f !== undefined) facings.set(f, e.t, Math.max(0, Math.min(65535, Math.round(e.facing))), ev);
        applyBack(e.sku, e.back, e.t, ev);
        break;
      }
      case "short": {
        const f = facingOfSku.get(e.sku);
        if (f !== undefined) tickerPos = [layout.facings[f].x, layout.facings[f].y];
        break;
      }

      case "customerArrive": {
        const kindLabel = e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
        const entity = addEntity(
          {
            kind: "customer",
            id: e.customer,
            label: `${kindLabel} shopper ${e.customer}`,
            colorIdx: Math.max(0, BASKET_KINDS.indexOf(e.kind)),
            meta: { basket: e.kind, lines: e.lines, units: e.units, dollars: Math.round(e.dollars * 100) / 100, served: e.served, wrap: e.wrap },
          },
          true
        );
        const car = addEntity({ kind: "car", id: `${e.customer}-car`, label: `Car (${e.customer})`, colorIdx: Math.max(0, BASKET_KINDS.indexOf(e.kind)), meta: { customer: e.customer } }, true);
        const tb = builders[entity]!;
        const carTb = builders[car]!;
        const stall = e.stall >= 0 && e.stall < world.lot.stalls.length ? e.stall : stalls.take("standard");
        const stallPt: Pt = stall >= 0 ? world.lot.stalls[stall].pt : [world.entry[0], world.lot.driveY];
        const walk = walkInPath(world, stallPt);
        const walkMin = walk.feet / walkFpm;
        // Which end of the lot they come in from alternates with the entity
        // number: a deterministic stand-in for a fact the engine has no view of.
        const drive = arrivePath(world, stallPt, entity % 2 === 0);
        const driveMin = drive.feet / ROAD_FT_PER_MIN;
        const t0 = Math.max(0, e.t - walkMin - PARK_MIN - driveMin);
        carTb.push({ t: t0, x: drive.pts[0][0], y: drive.pts[0][1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.road });
        if (stall >= 0) {
          layoutRoute([walkSink(carTb, ActorState.Drive, SegKind.Lot, ActorState.Idle)], drive, t0, driveMin, 0, SYNTH_JOB.road, heightOf);
          stallsT.set(stall, Math.max(0, e.t - walkMin - PARK_MIN, stallFreeAt[stall] + FADE_EPS_MIN), car, ev);
        } else {
          // The lot is full — Halloween Saturday — so the car holds on the
          // drive lane and the shopper is drawn walking in from the kerb.
          const holdAt: Pt = [stallPt[0], world.lot.driveY];
          layoutRoute([walkSink(carTb, ActorState.Drive, SegKind.Lot, ActorState.Wait)], { pts: [drive.pts[0], holdAt], feet: dist(drive.pts[0], holdAt), stops: [] }, t0, driveMin, 0, SYNTH_JOB.road, heightOf);
        }
        const onFoot = Math.max(t0 + FADE_EPS_MIN, e.t - walkMin);
        tb.push({ t: t0, x: stallPt[0], y: stallPt[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.shop });
        tb.push({ t: onFoot, x: stallPt[0], y: stallPt[1], s: ActorState.Walk, seg: SegKind.Walk, job: SYNTH_JOB.shop });
        layoutRoute([walkSink(tb, ActorState.Walk, SegKind.Walk, ActorState.Browse)], walk, onFoot, Math.max(0, e.t - onFoot), 0, SYNTH_JOB.shop, heightOf);
        const c: Shopper = { id: e.customer, entity, tb, car, carTb, stall, post: -1, slot: -1 };
        shoppers.set(e.customer, c);
        byEntity.set(entity, c);
        floorChange(e.t, 1);
        tickerEntity = entity;
        break;
      }
      case "customerShop": {
        const c = shoppers.get(e.customer);
        if (!c) break;
        const marks: Array<{ facing: Facing; minutes: number }> = [];
        let feet = 0;
        let prev: { x: number; y: number } = layout.entry;
        for (const s of e.stops) {
          const f = facingById.get(s.facing);
          if (!f) continue;
          feet += walkDistance(layout, prev, f);
          prev = f;
          marks.push({ facing: f, minutes: 1 });
        }
        // The engine's own shopping time: the browse the basket implies plus
        // the walk between the fixtures on their list.
        const shopMin = Math.max(0.5, e.dwellMin + feet / walkFpm);
        const end = registerPosts.length > 0 ? slotPt(posts[registerPosts[0]], 3) : world.entry;
        const path = marks.length > 0 ? (useOffsets ? shopPath(layout, world, marks, end) : polyPath([world.entry, ...marks.map((m) => [m.facing.x, m.facing.y] as Pt), end], marks.map((m, i) => ({ i: i + 1, minutes: 1, id: m.facing.id, shelf: m.facing.shelf })))) : polyPath([world.entry, end], []);
        const moveMin = Math.min(shopMin, path.feet / walkFpm);
        hold(c.tb, e.t, ActorState.Browse, SYNTH_JOB.shop);
        layoutRoute(
          [{ tb: c.tb, moveState: ActorState.Browse, stopState: ActorState.Browse, moveSeg: SegKind.Walk, loadedSeg: SegKind.Walk, stopSeg: SegKind.Reach, lift: true, carry: () => -1 }],
          path,
          e.t,
          moveMin,
          shopMin - moveMin,
          SYNTH_JOB.shop,
          heightOf
        );
        break;
      }
      case "counterJoin": {
        const c = shoppers.get(e.customer);
        if (!c || counterPosts.length === 0) break;
        // The shortest open line, which is what anybody does.
        let best = counterPosts[0];
        for (const p of counterPosts) if (!outPosts.has(p) && lines[p].length < lines[best].length) best = p;
        queuedPost.set(e.customer, best);
        joinQueue(best, c, e.t, ev);
        tickerEntity = c.entity;
        break;
      }
      case "queueJoin": {
        const c = shoppers.get(e.customer);
        if (!c) break;
        const pool = registerPosts.length > 0 ? registerPosts : counterPosts;
        if (pool.length === 0) break;
        let best = pool[0];
        for (const p of pool) if (!outPosts.has(p) && lines[p].length < lines[best].length) best = p;
        queuedPost.set(e.customer, best);
        joinQueue(best, c, e.t, ev);
        tickerEntity = c.entity;
        break;
      }
      case "counterDone": {
        const c = shoppers.get(e.customer);
        if (c) tickerEntity = c.entity;
        samples.counterWait.push(e.waitMin);
        break;
      }
      case "sale": {
        const c = shoppers.get(e.customer);
        if (c) tickerEntity = c.entity;
        samples.registerWait.push(e.waitMin);
        break;
      }
      case "abandon": {
        const c = shoppers.get(e.customer);
        if (!c) break;
        leaveQueue(c, e.t, ev);
        tickerEntity = c.entity;
        if (c.post >= 0) tickerPos = posts[c.post].head;
        break;
      }
      case "customerLeave": {
        const c = shoppers.get(e.customer);
        if (!c) break;
        leaveQueue(c, e.t, ev);
        const from = hold(c.tb, e.t, ActorState.Leave, SYNTH_JOB.shop);
        const stallPt: Pt = c.stall >= 0 ? world.lot.stalls[c.stall].pt : [world.entry[0], world.lot.driveY];
        const out = transferPath(layout, world, from, world.entry);
        const start = e.t + LEAVE_LINGER_MIN;
        c.tb.push({ t: start, x: from[0], y: from[1], s: ActorState.Leave, seg: SegKind.Walk, job: SYNTH_JOB.shop });
        layoutRoute([walkSink(c.tb, ActorState.Leave, SegKind.Walk, ActorState.Leave)], out, start, out.feet / walkFpm, 0, SYNTH_JOB.shop, heightOf);
        const toCar: Path = { pts: [...walkInPath(world, stallPt).pts].reverse(), feet: walkInPath(world, stallPt).feet, stops: [] };
        const t1 = start + out.feet / walkFpm;
        layoutRoute([walkSink(c.tb, ActorState.Leave, SegKind.Walk, ActorState.Off)], toCar, t1, toCar.feet / walkFpm, 0, SYNTH_JOB.shop, heightOf);
        const t2 = t1 + toCar.feet / walkFpm + PARK_MIN;
        c.tb.push({ t: t2, x: stallPt[0], y: stallPt[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.shop });
        if (c.carTb) {
          const away = leavePath(world, stallPt, c.entity % 2 === 1);
          // Pin the parked heading a moment before the car pulls out. The
          // frame at t2 is about to be given the heading of the first leg of
          // the way out — the opposite of the way it came in — and without a
          // frame here the sampler would spread that half-turn across the
          // whole visit, so a car would rotate slowly in its bay for the
          // thirteen minutes its owner was inside.
          hold(c.carTb, Math.max(c.carTb.lastT, t2 - FADE_EPS_MIN), ActorState.Idle, SYNTH_JOB.road);
          hold(c.carTb, t2, ActorState.Drive, SYNTH_JOB.road);
          layoutRoute([walkSink(c.carTb, ActorState.Drive, SegKind.Lot, ActorState.Off)], away, t2, away.feet / ROAD_FT_PER_MIN, 0, SYNTH_JOB.road, heightOf);
          c.carTb.push({ t: t2 + away.feet / ROAD_FT_PER_MIN + FADE_EPS_MIN, x: away.pts[away.pts.length - 1][0], y: away.pts[away.pts.length - 1][1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.road });
        }
        if (c.stall >= 0) {
          stalls.release(c.stall);
          stallsT.set(c.stall, t2, -1, ev);
          stallFreeAt[c.stall] = t2;
        }
        byEntity.delete(c.entity);
        shoppers.delete(e.customer);
        queuedPost.delete(e.customer);
        floorChange(e.t, -1);
        tickerEntity = c.entity;
        break;
      }

      case "orderPlaced": {
        const label = `${e.kind === "delivery" ? "Delivery" : "Collection"} order ${e.order}`;
        orders.set(e.order, { id: e.order, kind: e.kind, label, placedAt: e.t, dueAt: e.dueDay * 1440 + e.dueMin, tote: -1 });
        break;
      }
      case "orderPacked":
        break;
      case "vanDepart": {
        const idx = vanOfJob.get(e.job) ?? e.van;
        const v = vehicles.van.get(idx);
        if (v) tickerEntity = v.entity;
        rounds.push(e.orders);
        for (const id of e.orders) {
          const o = orders.get(id);
          if (o && o.tote >= 0 && v) setPallet(o.tote, e.t, PalletAt.Van, v.entity, -1, ev);
        }
        break;
      }
      case "vanReturn": {
        const live = liveVans.shift();
        const idx = live?.van ?? e.van;
        vans.release(idx);
        const v = vehicles.van.get(idx);
        if (v) {
          tickerEntity = v.entity;
          vehicleIdle(v, e.t);
        }
        // The van comes back empty: every tote on that round was handed over.
        for (const id of rounds.shift() ?? []) {
          const o = orders.get(id);
          if (o && o.tote >= 0) setPallet(o.tote, e.t, PalletAt.Gone, -1, -1, ev);
        }
        break;
      }
      case "orderOut": {
        const o = orders.get(e.order);
        if (!o) break;
        // The engine dates a delivery by the minute the van left, so the cycle
        // is measured to there and never comes out negative.
        samples.orderCycle.push(Math.max(0, e.t - o.placedAt));
        if (e.kind === "pickup" && o.tote >= 0) setPallet(o.tote, Math.max(e.t, clock), PalletAt.Gone, -1, -1, ev);
        break;
      }

      case "worker": {
        const a = actors.get(e.id);
        if (!a) break;
        tickerEntity = a.entity;
        switch (e.state) {
          case "in": {
            a.present = true;
            a.shiftEnd = e.shiftEnd ?? e.t + 480;
            a.home = world.homes[(e.primary ?? "stock") as Skill] ?? world.homes.stock;
            a.tb.cutAt(e.t);
            const door = world.entry;
            a.tb.push({ t: e.t, x: door[0], y: door[1], s: ActorState.Indirect, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            const path = transferPath(layout, world, door, a.home);
            const walkMin = path.feet / (walkFpm * a.prod);
            const indirect = e.indirectMin ?? 0;
            const start = Math.max(e.t, e.t + indirect - walkMin);
            a.tb.push({ t: start, x: door[0], y: door[1], s: ActorState.Indirect, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
            layoutRoute([walkSink(a.tb, ActorState.Indirect, SegKind.IdleReturn, ActorState.Idle)], path, start, walkMin, 0, SYNTH_JOB.shift, heightOf);
            if (indirect <= 0 && !onFloorIds.has(e.id)) {
              onFloorIds.add(e.id);
              floorChange(e.t, 1);
            }
            break;
          }
          case "absent": {
            const shift = init.shifts.find((s) => s.id === e.shift);
            const span = shift ? Math.max(0, shiftPaidHours(shift.start, shift.end)) * 60 : 480;
            a.tb.cutAt(e.t);
            a.tb.push({ t: e.t, x: world.entry[0], y: world.entry[1], s: ActorState.Absent, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            a.tb.push({ t: e.t + span, x: world.entry[0], y: world.entry[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            break;
          }
          case "indirectEnd":
            if (!onFloorIds.has(e.id)) {
              onFloorIds.add(e.id);
              floorChange(e.t, 1);
            }
            break;
          case "break": {
            const breakMin = e.breakMin ?? 0;
            const pos = settle(a, e.t);
            const there = transferPath(layout, world, pos, world.breakArea);
            const back = transferPath(layout, world, world.breakArea, a.home);
            const goMin = there.feet / (walkFpm * a.prod);
            const backMin = back.feet / (walkFpm * a.prod);
            if (goMin + backMin + 0.5 <= breakMin) {
              a.tb.push({ t: e.t, x: pos[0], y: pos[1], s: ActorState.Break, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
              layoutRoute([walkSink(a.tb, ActorState.Break, SegKind.IdleReturn, ActorState.Break)], there, e.t, goMin, 0, SYNTH_JOB.shift, heightOf);
              const leave = e.t + breakMin - backMin;
              a.tb.push({ t: leave, x: world.breakArea[0], y: world.breakArea[1], s: ActorState.Break, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
              layoutRoute([walkSink(a.tb, ActorState.Break, SegKind.IdleReturn, ActorState.Idle)], back, leave, backMin, 0, SYNTH_JOB.shift, heightOf);
            } else {
              a.tb.push({ t: e.t, x: pos[0], y: pos[1], s: ActorState.Break, seg: SegKind.Hold, job: SYNTH_JOB.shift });
              a.tb.push({ t: e.t + breakMin, x: pos[0], y: pos[1], s: ActorState.Idle, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            }
            if (onFloorIds.delete(e.id)) floorChange(e.t, -1);
            break;
          }
          case "breakEnd":
            if (a.present && !onFloorIds.has(e.id)) {
              onFloorIds.add(e.id);
              floorChange(e.t, 1);
            }
            break;
          case "out": {
            const pos = settle(a, e.t);
            a.present = false;
            const path = transferPath(layout, world, pos, world.entry);
            a.tb.push({ t: e.t, x: pos[0], y: pos[1], s: ActorState.Walk, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
            layoutRoute([walkSink(a.tb, ActorState.Walk, SegKind.IdleReturn, ActorState.Off)], path, e.t, path.feet / (walkFpm * a.prod), 0, SYNTH_JOB.shift, heightOf);
            if (onFloorIds.delete(e.id)) floorChange(e.t, -1);
            break;
          }
        }
        break;
      }
      case "pos":
        if (e.down === posDown) skipLine = true;
        posDown = e.down;
        break;
      case "end":
        break;
      default:
        break;
    }

    const line = skipLine ? null : tickerLine(e, tickerNames);
    if (line) ticker.push({ t: e.t, kind: e.k, text: line.text, severity: line.severity, entity: tickerEntity, ev, x: tickerPos?.[0], y: tickerPos?.[1] });
  }

  fillBins(Infinity);
  // The doors line is dated by the opening minute rather than by where it was
  // announced, so the feed is put back in clock order before it is frozen.
  ticker.sort((a, b) => a.t - b.t || a.ev - b.ev);
  // The books close the way runOperations closes them, and the last checkpoint
  // carries the closed state: that is the one the HUD reads at the horizon and
  // the one compile.test.ts checks against the tools' kpis(result).
  finalize(state, horizonEnd, kctx);
  const lastCp = checkpoints[checkpoints.length - 1];
  if (lastCp && Math.abs(lastCp.t - horizonEnd) <= EPS) lastCp.kpis = cloneState(state);
  else checkpoints.push({ t: horizonEnd, kpis: cloneState(state) });
  if (inBuilding === 0 && horizonEnd - quietStart >= QUIET_MIN) quiet.push([quietStart, horizonEnd]);
  // A trailer that never got a door waits on the service drive to the horizon.
  for (const truck of waiting) {
    const g = truck.queuePos % Math.max(1, goodsFrames.length);
    layoutDock(truck.tb, g, truck.arriveT - 3, truck.arriveT, null, truck.queuePos);
  }

  // --- Freeze ---
  const dirtyEntries: DirtyEntry[] = [];
  const facingsT = facings.build((n) => new Uint16Array(n), DirtyKind.Facing, dirtyEntries);
  const facingHotT = facingHot.build((n) => new Uint8Array(n), DirtyKind.FacingHot, dirtyEntries);
  const storageT = storage.build((n) => new Uint16Array(n), DirtyKind.Storage, dirtyEntries);
  const storageSkuT = storageSku.build((n) => new Int32Array(n), DirtyKind.StorageSku, dirtyEntries);
  const doorsT = doors.build((n) => new Int32Array(n), DirtyKind.Door, dirtyEntries);
  const laneSlotsOut = laneSlotsT.build((n) => new Int32Array(n), DirtyKind.LaneSlot, dirtyEntries);
  const postsOut = postsT.build((n) => new Int32Array(n), DirtyKind.Post, dirtyEntries);
  const queueLenOut = queueLen.build((n) => new Uint16Array(n), DirtyKind.QueueLen, dirtyEntries);
  const stallsOut = stallsT.build((n) => new Int32Array(n), DirtyKind.Stall, dirtyEntries);
  const palletsOut = pallets.build(dirtyEntries);
  // Sorted by time, then kind, index and row: the cursor's half-open dirty
  // range and its backward step both depend on this exact order.
  dirtyEntries.sort((p, q) => p.t - q.t || p.kind - q.kind || p.idx - q.idx || p.row - q.row);
  const dirty: DirtyList = {
    t: Float64Array.from(dirtyEntries.map((d) => d.t)),
    kind: Uint8Array.from(dirtyEntries.map((d) => d.kind)),
    idx: Int32Array.from(dirtyEntries.map((d) => d.idx)),
    row: Int32Array.from(dirtyEntries.map((d) => d.row)),
  };
  const quietT: Interval = { t0: Float64Array.from(quiet.map((q) => q[0])), t1: Float64Array.from(quiet.map((q) => q[1])) };
  const tracks = builders.map((b) => (b ? b.toTrack(horizonEnd) : null));

  return {
    meta: {
      store: init.store,
      storeName: init.storeName,
      startWeek: init.startWeek,
      days: init.days,
      seed: init.seed,
      horizonEnd,
      layoutName: init.layoutName,
      compiler: COMPILER_VERSION,
      offsets: useOffsets,
      checkpointMin,
    },
    entities,
    tracks,
    facings: facingsT,
    facingHot: facingHotT,
    facingSku,
    storage: storageT,
    storageSku: storageSkuT,
    doors: doorsT,
    laneSlots: laneSlotsOut,
    posts: postsOut,
    queueLen: queueLenOut,
    stalls: stallsOut,
    pallets: palletsOut,
    dirty,
    jobs,
    queueBins,
    kpiBins,
    checkpoints,
    samples: {
      dockToStock: Float32Array.from(samples.dockToStock),
      counterWait: Float32Array.from(samples.counterWait),
      registerWait: Float32Array.from(samples.registerWait),
      orderCycle: Float32Array.from(samples.orderCycle),
    },
    ticker,
    quiet: quietT,
    events: keepEvents ? events : [],
    world,
  };
}

function placeholderJob(id: number): JobRow {
  const info: JobInfo = { kind: "pack", order: "", lines: 0, wrap: false };
  return {
    id,
    process: "pack",
    info,
    priority: 0,
    queuedAt: 0,
    startAt: -1,
    endAt: -1,
    truncated: false,
    worker: "",
    productivity: 0,
    dur: 0,
    waitMin: 0,
    equipWaitMin: 0,
    cart: -1,
    jack: -1,
    van: -1,
    post: -1,
    door: -1,
    engineFeet: 0,
    routeFeet: 0,
    transferFeet: 0,
    visualFeet: 0,
    stopMin: 0,
    moveMin: 0,
    speedRatio: 1,
    fit: "stationary",
    ev: -1,
  };
}

/** Every typed array's buffer, listed once, for postMessage transfer. */
export function collectBuffers(pb: Playback): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const out: ArrayBuffer[] = [];
  const add = (a: ArrayBufferView | undefined) => {
    if (!a) return;
    const b = a.buffer as ArrayBuffer;
    if (seen.has(b)) return;
    seen.add(b);
    out.push(b);
  };
  for (const tr of pb.tracks) {
    if (!tr) continue;
    for (const a of [tr.t, tr.x, tr.y, tr.z, tr.h, tr.s, tr.seg, tr.job, tr.carry]) add(a);
  }
  for (const c of [pb.facings, pb.facingHot, pb.storage, pb.storageSku, pb.doors, pb.laneSlots, pb.posts, pb.queueLen, pb.stalls]) {
    for (const a of [c.offsets, c.t, c.v, c.ev]) add(a);
  }
  add(pb.facingSku);
  for (const a of [pb.pallets.offsets, pb.pallets.t, pb.pallets.at, pb.pallets.ref, pb.pallets.slot, pb.pallets.ev]) add(a);
  for (const a of [pb.dirty.t, pb.dirty.kind, pb.dirty.idx, pb.dirty.row]) add(a);
  for (const a of [pb.queueBins.queues, pb.queueBins.series, pb.kpiBins.queues, pb.kpiBins.series]) add(a);
  for (const a of [pb.samples.dockToStock, pb.samples.counterWait, pb.samples.registerWait, pb.samples.orderCycle]) add(a);
  for (const a of [pb.quiet.t0, pb.quiet.t1]) add(a);
  return out;
}
