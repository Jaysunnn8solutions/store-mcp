/**
 * What the inspector says about whatever is selected.
 *
 * A job, an actor, a shelf facing, a stockroom position, a register or a
 * queue, plus the playback and the minute the clock stands at, become sections
 * of label/value rows. Every row is one of two things, and the page renders
 * them differently:
 *
 *   - an **engine fact**: a time, a duration, a wait, a dollar figure, a count
 *     of units — something the simulation decided and that a different
 *     animation would not change;
 *   - a **shown** detail, flagged `shown: true`: which cart, which register,
 *     which parking stall, the route drawn on the floor, the fit that made the
 *     walk take the engine's minutes. The compiler invented it so the picture
 *     would make sense, and it feeds back into nothing.
 *
 * Keeping those apart is the product's whole credibility claim: nothing is
 * animated that the engine did not do, and anything the engine did not decide
 * says so. A job card always carries both, so a reader can see the seam.
 *
 * Pure: playback + world payload + t in, strings out. `indexEvents` builds the
 * per-customer, per-order, per-purchase-order and per-worker lookups in one
 * pass; the page memoizes it per run.
 */

import { upperBound } from "../trace/search";
import {
  ActorState,
  LANE_SLOTS,
  PalletAt,
  type CsrTimeline,
  type EntityDef,
  type JobInfo,
  type JobRow,
  type Playback,
  type TraceEvent,
  type TraceInit,
  type Track,
  type WorldPayload,
} from "../trace/types";
import { PROCESSES, PROCESS_SKILL, type Process } from "../twin/types";
import { clockLabel, dayClock, dayOf } from "./clock";
import { count, feet, minutes, money, percent, units } from "./format";

export interface DescribeRow {
  label: string;
  value: string;
  /** Synthesized by the playback for the picture, not an engine fact. */
  shown?: true;
}

export interface DescribeSection {
  title: string;
  rows: DescribeRow[];
}

const fact = (label: string, value: string): DescribeRow => ({ label, value });
const synth = (label: string, value: string): DescribeRow => ({ label, value, shown: true });

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// Entity metadata is whatever the compiler chose to put in it, so it is read
// defensively: a field that is not there reads as "" or -1, never "undefined".
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const numOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : -1);

// ---------------------------------------------------------------------------
// Sampling helpers, shared with the minimap
// ---------------------------------------------------------------------------

export interface TrackPose {
  x: number;
  y: number;
  z: number;
  h: number;
  s: number;
  seg: number;
  job: number;
  carry: number;
}

/** The interpolated pose of a track at t, or null before its first keyframe. After the last one it holds. */
export function trackPoseAt(track: Track, t: number): TrackPose | null {
  const n = track.t.length;
  const k = upperBound(track.t, t) - 1;
  if (k < 0) return null;
  if (k + 1 < n) {
    const span = track.t[k + 1] - track.t[k];
    const f = span > 0 ? (t - track.t[k]) / span : 0;
    // Headings are wrapped to the short way round, so somebody turning past
    // north does not spin the long way in the drawing.
    let dh = track.h[k + 1] - track.h[k];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return {
      x: track.x[k] + (track.x[k + 1] - track.x[k]) * f,
      y: track.y[k] + (track.y[k + 1] - track.y[k]) * f,
      z: track.z[k] + (track.z[k + 1] - track.z[k]) * f,
      h: track.h[k] + dh * f,
      s: track.s[k],
      seg: track.seg[k],
      job: track.job[k],
      carry: track.carry[k],
    };
  }
  return { x: track.x[k], y: track.y[k], z: track.z[k], h: track.h[k], s: track.s[k], seg: track.seg[k], job: track.job[k], carry: track.carry[k] };
}

/** The compressed-sparse-row row of item i in force at t, or -1 for an item with no rows at all. */
export function csrRowAt(tl: { offsets: Int32Array; t: Float64Array }, item: number, t: number): number {
  const lo = tl.offsets[item];
  const hi = tl.offsets[item + 1];
  if (lo === undefined || hi === undefined || hi <= lo) return -1;
  const k = upperBound(tl.t, t, lo, hi);
  return Math.max(lo, k - 1);
}

export function csrValueAt<V extends Uint8Array | Uint16Array | Int32Array | Uint32Array>(tl: CsrTimeline<V>, item: number, t: number, fallback: number): number {
  const r = csrRowAt(tl, item, t);
  return r < 0 ? fallback : tl.v[r];
}

/** Everyone in the building at t (state not Off), at the position the playback drew them, for the minimap. */
export interface ActorDot {
  entity: number;
  kind: EntityDef["kind"];
  x: number;
  y: number;
  state: number;
}

export function actorsAt(pb: Playback, t: number): ActorDot[] {
  const out: ActorDot[] = [];
  for (const tr of pb.tracks) {
    if (!tr) continue;
    const p = trackPoseAt(tr, t);
    if (!p || p.s === ActorState.Off) continue;
    out.push({ entity: tr.entity, kind: pb.entities[tr.entity].kind, x: p.x, y: p.y, state: p.s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event index
// ---------------------------------------------------------------------------

type Ev<K extends TraceEvent["k"]> = Extract<TraceEvent, { k: K }>;

/** A delivery into the shop: the order, the appointment, the trailer, the put-aways. */
export interface PoRecord {
  placed?: Ev<"poPlaced">;
  scheduled?: Ev<"truckScheduled">;
  arrive?: Ev<"truckArrive">;
  dock?: Ev<"truckDock">;
  undock?: Ev<"truckUndock">;
  putaways: Ev<"putaway">[];
}

/** A special order going out: placed, picked, packed, loaded, delivered or collected. */
export interface OrderRecord {
  placed?: Ev<"orderPlaced">;
  picked?: Ev<"orderPicked">;
  packed?: Ev<"orderPacked">;
  cut?: Ev<"orderCut">;
  late?: Ev<"orderLate">;
  loaded?: Ev<"vanLoad">;
  departed?: Ev<"vanDepart">;
  collected?: Ev<"orderCollected">;
  shorts: Ev<"short">[];
}

/** One shopper, from the car park to the door. */
export interface CustomerRecord {
  arrive?: Ev<"customerArrive">;
  shop?: Ev<"customerShop">;
  counterJoin?: Ev<"counterJoin">;
  counterDone?: Ev<"counterDone">;
  queueJoin?: Ev<"queueJoin">;
  sale?: Ev<"sale">;
  abandon?: Ev<"abandon">;
  leave?: Ev<"customerLeave">;
}

export interface EventIndex {
  init: TraceInit | null;
  /** Event times, for binary search into Playback.events. */
  times: Float64Array;
  po: Map<string, PoRecord>;
  order: Map<string, OrderRecord>;
  customer: Map<string, CustomerRecord>;
  worker: Map<string, Ev<"worker">[]>;
  /** Every time a SKU was not on the shelf when somebody reached for it. */
  shortsBySku: Map<string, Ev<"short">[]>;
  pos: Ev<"pos">[];
  /** Serve and checkout jobs by customer id, so a shopper's card can show them. */
  customerJobs: Map<string, JobRow[]>;
  /** Pick, pack and load jobs by order id. */
  orderJobs: Map<string, JobRow[]>;
}

/** One pass over the stream and the job table. Cheap enough to do per run, far too expensive to do per frame. */
export function indexEvents(pb: Playback): EventIndex {
  const events = pb.events;
  const init = events[0]?.k === "init" ? (events[0] as TraceInit) : null;
  const times = Float64Array.from(events, (e) => e.t);
  const po = new Map<string, PoRecord>();
  const order = new Map<string, OrderRecord>();
  const customer = new Map<string, CustomerRecord>();
  const worker = new Map<string, Ev<"worker">[]>();
  const shortsBySku = new Map<string, Ev<"short">[]>();
  const pos: Ev<"pos">[] = [];
  const customerJobs = new Map<string, JobRow[]>();
  const orderJobs = new Map<string, JobRow[]>();

  const push = <T>(m: Map<string, T[]>, k: string, v: T): void => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const poRec = (id: string): PoRecord => {
    let r = po.get(id);
    if (!r) {
      r = { putaways: [] };
      po.set(id, r);
    }
    return r;
  };
  const orderRec = (id: string): OrderRecord => {
    let r = order.get(id);
    if (!r) {
      r = { shorts: [] };
      order.set(id, r);
    }
    return r;
  };
  const custRec = (id: string): CustomerRecord => {
    let r = customer.get(id);
    if (!r) {
      r = {};
      customer.set(id, r);
    }
    return r;
  };

  for (const j of pb.jobs) {
    if ("customer" in j.info) push(customerJobs, j.info.customer, j);
    if ("order" in j.info) push(orderJobs, j.info.order, j);
  }

  for (const e of events) {
    switch (e.k) {
      case "poPlaced":
        poRec(e.po).placed = e;
        break;
      case "truckScheduled":
        poRec(e.po).scheduled = e;
        break;
      case "truckArrive":
        poRec(e.po).arrive = e;
        break;
      case "truckDock":
        poRec(e.po).dock = e;
        break;
      case "truckUndock":
        poRec(e.po).undock = e;
        break;
      case "putaway":
        poRec(e.po).putaways.push(e);
        break;
      case "orderPlaced":
        orderRec(e.order).placed = e;
        break;
      case "orderPicked":
        orderRec(e.order).picked = e;
        break;
      case "orderPacked":
        orderRec(e.order).packed = e;
        break;
      case "orderCut":
        orderRec(e.order).cut = e;
        break;
      case "orderLate":
        orderRec(e.order).late = e;
        break;
      case "orderCollected":
        orderRec(e.order).collected = e;
        break;
      case "vanLoad":
        for (const id of e.orders) orderRec(id).loaded = e;
        break;
      case "vanDepart":
        for (const id of e.orders) orderRec(id).departed = e;
        break;
      case "customerArrive":
        custRec(e.customer).arrive = e;
        break;
      case "customerShop":
        custRec(e.customer).shop = e;
        break;
      case "counterJoin":
        custRec(e.customer).counterJoin = e;
        break;
      case "counterDone":
        custRec(e.customer).counterDone = e;
        break;
      case "queueJoin":
        custRec(e.customer).queueJoin = e;
        break;
      case "sale":
        custRec(e.customer).sale = e;
        break;
      case "abandon":
        custRec(e.customer).abandon = e;
        break;
      case "customerLeave":
        custRec(e.customer).leave = e;
        break;
      case "short":
        push(shortsBySku, e.sku, e);
        if (e.order) orderRec(e.order).shorts.push(e);
        break;
      case "worker":
        push(worker, e.id, e);
        break;
      case "pos":
        pos.push(e);
        break;
      default:
        break;
    }
  }
  return { init, times, po, order, customer, worker, shortsBySku, pos, customerJobs, orderJobs };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const STATE_NAMES: Record<number, string> = {
  [ActorState.Off]: "not in the building",
  [ActorState.Idle]: "idle",
  [ActorState.Walk]: "walking",
  [ActorState.Push]: "pushing a cart",
  [ActorState.Work]: "working",
  [ActorState.Browse]: "browsing the floor",
  [ActorState.Queue]: "waiting in line",
  [ActorState.Serve]: "being served at the counter",
  [ActorState.Ring]: "at the register",
  [ActorState.Wait]: "waiting",
  [ActorState.Break]: "on break",
  [ActorState.Indirect]: "indirect time (huddle, counts, cash-up)",
  [ActorState.Overtime]: "on overtime",
  [ActorState.Absent]: "absent",
  [ActorState.Drive]: "driving",
  [ActorState.Docked]: "docked",
  [ActorState.Loading]: "loading",
  [ActorState.Depart]: "departing",
  [ActorState.Late]: "late, still at the door",
  [ActorState.Leave]: "leaving",
};

/**
 * States the events establish outright. Everything else — walking an aisle,
 * pushing a cart out of the stockroom, idling between jobs — is the playback
 * moving somebody between two engine facts.
 */
const ENGINE_STATES = new Set<number>([ActorState.Off, ActorState.Break, ActorState.Indirect, ActorState.Overtime, ActorState.Absent, ActorState.Browse, ActorState.Queue, ActorState.Serve, ActorState.Ring, ActorState.Docked, ActorState.Late]);

export function stateName(s: number): string {
  return STATE_NAMES[s] ?? `state ${s}`;
}

/** How the compiler fitted the drawn walk into the minutes the engine paid for. */
const FIT_WORDS: Record<JobRow["fit"], string> = {
  stationary: "stationary: no travel in this job",
  exact: "exact: the walk and the handling take the engine's own minutes",
  borrowed: "borrowed: the walk to the start was paid for out of handling time",
  fadeIn: "fade-in: getting there would have cost more than half the job, so the worker appears at the start of the route",
  fast: "fast: even the route needs more than half the job at the engine's walking speed, so the worker moves quicker than the engine assumes",
};

const BASKET_WORDS: Record<string, string> = {
  quick: "Quick basket",
  browse: "Browse basket",
  counter: "Counter basket",
  bulk: "Bulk-bin basket",
  gift: "Gift basket",
};

/** One line saying what a job is, in the shop's own words. */
export function jobSummary(info: JobInfo): string {
  switch (info.kind) {
    case "unload":
      return `Unload ${info.po} from ${info.supplier}, pallet ${info.pallet + 1} of ${info.pallets}: ${plural(info.cases, "case")}${info.door ? ` at ${info.door}` : ""}`;
    case "receive":
      return `Check in ${info.po} pallet ${info.pallet + 1}: ${plural(info.cases, "case")}${info.importer ? ", compliance labels" : ""}`;
    case "putaway":
      return `Put away ${info.po} pallet ${info.pallet + 1} into ${info.items.map((i) => `${i.loc} (${i.sku})`).join(", ")}`;
    case "restock":
      return `${info.hot ? "Hot restock" : "Restock"}: ${plural(info.lines.length, "facing")} on ${plural(info.trips, "cart trip")}${info.trays > 0 ? `, ${plural(info.trays, "tray or bin")} decanted` : ""}`;
    case "serve":
      return `Serve ${info.customer} at ${info.station}: ${plural(info.lines.length, "line")} from the case${info.wrap ? ", gift wrapped" : ""}`;
    case "checkout":
      return `Ring up ${info.customer} at ${info.register}: ${plural(info.lines, "line")}, ${count(info.units)} units, ${money(info.dollars, 2)}${info.weighed > 0 ? `, ${info.weighed} weighed` : ""}`;
    case "pick":
      return `Pick tour ${info.tour + 1} of ${info.tours} for ${info.order}: ${plural(info.lines.length, "line")}, ${feet(info.feet)} walked`;
    case "pack":
      return `Pack ${info.order}: ${plural(info.lines, "line")}${info.wrap ? ", gift wrapped" : ""}`;
    case "load":
      return `Load ${info.order} onto van ${info.van + 1} (${plural(info.orders, "order")} on the round); it leaves ${clockLabel(info.departAt)}`;
    case "deliver":
      return `Van ${info.van + 1} round: ${plural(info.stops, "stop")}, ${info.miles.toFixed(1)} miles, left ${clockLabel(info.departAt)}`;
  }
}

function doorId(world: WorldPayload, index: number): string | null {
  return index >= 0 ? (world.spec.doors[index]?.id ?? null) : null;
}

function postId(world: WorldPayload, index: number): string | null {
  return index >= 0 ? (world.spec.service[index]?.id ?? null) : null;
}

function skuName(world: WorldPayload, id: string): string {
  return world.skus.find((s) => s.id === id)?.name ?? id;
}

function poseOf(pb: Playback, entity: number, t: number): TrackPose | null {
  const track = pb.tracks[entity];
  return track ? trackPoseAt(track, t) : null;
}

function jobAt(pb: Playback, jobId: number): JobRow | null {
  return jobId >= 1 ? (pb.jobs[jobId - 1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// The job card
// ---------------------------------------------------------------------------

/**
 * A job: engine facts first, then everything the picture added. This is the one
 * card that always shows both halves — "4.2 min at productivity 1.03, waited 11
 * min for a register" is the model; "38 ft walked, fitted borrowed" is the
 * drawing.
 */
export function describeJob(job: JobRow, world: WorldPayload, t: number): DescribeSection {
  const rows: DescribeRow[] = [];
  rows.push(fact("What", jobSummary(job.info)));
  rows.push(fact("Queued", `${dayClock(job.queuedAt)}, priority ${job.priority}`));
  if (job.startAt < 0) {
    rows.push(fact("Started", "never: the run ended with it still in the queue"));
  } else {
    const held = job.equipWaitMin > 0 ? ` (${minutes(job.equipWaitMin)} of it waiting for a register, a counter or a cart rather than for a person)` : "";
    rows.push(fact("Started", `${clockLabel(job.startAt)} by ${job.worker} after ${minutes(job.waitMin)} in the queue${held}`));
    rows.push(fact("Took", `${job.dur.toFixed(1)} min = the engineered standard divided by productivity ${job.productivity.toFixed(2)}`));
    rows.push(fact("Ends", job.truncated ? `${clockLabel(job.endAt)}, past the end of the run` : job.endAt > t ? `${clockLabel(job.endAt)}, ${minutes(job.endAt - t)} to go` : clockLabel(job.endAt)));
  }
  if (job.engineFeet > 0) rows.push(fact("Distance the engine paid for", `${feet(job.engineFeet)} at walking speed`));

  if (job.startAt >= 0) {
    if (job.visualFeet > 0 || job.transferFeet > 0) {
      rows.push(synth("Route drawn", `${feet(job.routeFeet)} on the floor${job.transferFeet > 0 ? ` plus ${feet(job.transferFeet)} to get there` : ""} = ${feet(job.visualFeet)} drawn`));
    }
    rows.push(synth("Fit", FIT_WORDS[job.fit]));
    rows.push(synth("Speed", `${job.speedRatio.toFixed(2)} times the engine's walking speed — moving ${job.moveMin.toFixed(1)} min, handling ${job.stopMin.toFixed(1)} min`));
    const assigned: string[] = [];
    if (job.cart >= 0) assigned.push(`stock cart ${job.cart + 1}`);
    if (job.jack >= 0) assigned.push(`pallet jack ${job.jack + 1}`);
    if (job.van >= 0) assigned.push(`van ${job.van + 1}`);
    const post = postId(world, job.post);
    if (post) assigned.push(post);
    const door = doorId(world, job.door);
    if (door) assigned.push(door);
    if (assigned.length) rows.push(synth("Using", `${assigned.join(", ")} — the engine counts how many are busy, the playback decides which one`));
  }
  return { title: `Job ${job.id} · ${job.process}`, rows };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function shiftToday(index: EventIndex, id: string, t: number): DescribeRow[] {
  const day = dayOf(t);
  const rows: DescribeRow[] = [];
  const evs = (index.worker.get(id) ?? []).filter((e) => dayOf(e.t) === day && e.t <= t);
  const inEv = evs.find((e) => e.state === "in");
  const absent = evs.find((e) => e.state === "absent");
  const out = evs.find((e) => e.state === "out");
  if (absent) rows.push(fact("Today", absent.shift ? `absent from the ${absent.shift} shift` : "absent"));
  else if (inEv) {
    rows.push(fact("Today", `${inEv.shift ?? "the"} shift ${clockLabel(inEv.shiftStart ?? 0)}–${clockLabel(inEv.shiftEnd ?? 0)} on ${inEv.primary ?? "the floor"}, ${inEv.breakMin ?? 0} min break at ${clockLabel(inEv.breakAt ?? 0)}, ${inEv.indirectMin ?? 0} min indirect`));
    if (out) rows.push(fact("Clocked out", `${clockLabel(out.t)}${(out.overtimeMin ?? 0) > 0.5 ? ` after ${minutes(out.overtimeMin ?? 0)} of overtime` : ""}`));
  } else rows.push(fact("Today", "not clocked in yet"));
  return rows;
}

function describeWorker(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const rows: DescribeRow[] = [];
  const role = str(def.meta.role);
  const type = str(def.meta.type);
  const skills = str(def.meta.skills);
  if (role) rows.push(fact("Role", type && type !== "full-time" ? `${role}, ${type}` : role));
  if (skills) rows.push(fact("Trained on", skills));
  const productivity = numOf(def.meta.productivity);
  if (productivity > 0) rows.push(fact("Productivity", `${productivity.toFixed(2)} times the engineered standard`));
  rows.push(...shiftToday(index, def.id, t));
  const done = pb.jobs.filter((j) => j.worker === def.id && j.startAt >= 0 && j.endAt <= t && dayOf(j.startAt) === dayOf(t)).length;
  rows.push(fact("Jobs finished today", String(done)));

  const sections: DescribeSection[] = [{ title: def.label || def.id, rows }];
  const pose = poseOf(pb, entity, t);
  const now: DescribeRow[] = [];
  if (pose) {
    now.push(ENGINE_STATES.has(pose.s) ? fact("Doing", stateName(pose.s)) : synth("Doing", stateName(pose.s)));
    if (pose.s !== ActorState.Off && pose.s !== ActorState.Absent) now.push(synth("Standing", `${Math.round(pose.x)}, ${Math.round(pose.y)} ft`));
    if (pose.carry >= 0) now.push(synth("With", pb.entities[pose.carry]?.label ?? `entity ${pose.carry}`));
  }
  sections.push({ title: "Now", rows: now.length ? now : [fact("Doing", "not in the building")] });
  const job = pose ? jobAt(pb, pose.job) : null;
  if (job) sections.push(describeJob(job, world, t));
  return sections;
}

/**
 * A shopper's story in a sentence or two: what they came in for, what happened
 * at the counter and the till, and whether they left with a bag or without one.
 * Walking out of a queue is the number this whole model exists to put a figure
 * on, so it is said plainly.
 */
export function customerStory(rec: CustomerRecord, t: number): string {
  const a = rec.arrive;
  if (!a) return "A shopper the trace has no arrival for.";
  const kind = BASKET_WORDS[a.kind] ?? `${a.kind} basket`;
  const parts: string[] = [`${kind}, ${plural(a.lines, "line")}, ${money(a.dollars, 2)}${a.served > 0 ? `, ${a.served} of them from behind the glass` : ""}${a.wrap ? ", wants it wrapped" : ""}.`];
  const bail = rec.abandon && rec.abandon.t <= t ? rec.abandon : null;
  if (bail) {
    parts.push(`Waited ${minutes(bail.waitMin)} at the ${bail.at === "counter" ? "showcase" : "register"} and walked out, leaving ${money(bail.dollars, 2)} behind.`);
    return parts.join(" ");
  }
  const sale = rec.sale && rec.sale.t <= t ? rec.sale : null;
  if (sale) {
    parts.push(`Queued ${minutes(sale.waitMin)} at ${sale.register} and paid ${money(sale.dollars, 2)}${sale.lostDollars > 0 ? `, with ${money(sale.lostDollars, 2)} of the basket not on the shelf` : ""}.`);
    if (rec.leave && rec.leave.t <= t) parts.push(`In the shop ${minutes(rec.leave.minutesInStore)}.`);
    return parts.join(" ");
  }
  if (rec.queueJoin && rec.queueJoin.t <= t) parts.push(`In the line at ${rec.queueJoin.register} since ${clockLabel(rec.queueJoin.t)}, ${minutes(t - rec.queueJoin.t)} so far.`);
  else if (rec.counterDone && rec.counterDone.t <= t) parts.push(`Served at the showcase after ${minutes(rec.counterDone.waitMin)}, still shopping.`);
  else if (rec.counterJoin && rec.counterJoin.t <= t) parts.push(`Waiting at the showcase since ${clockLabel(rec.counterJoin.t)}, ${rec.counterJoin.queueLen} ahead when they joined.`);
  else if (rec.shop && rec.shop.t <= t) parts.push(`Working through the floor, about ${minutes(rec.shop.dwellMin)} of browsing.`);
  else parts.push(`Just in the door at ${clockLabel(a.t)}.`);
  return parts.join(" ");
}

function describeCustomer(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const rec = index.customer.get(def.id) ?? {};
  const rows: DescribeRow[] = [fact("Story", customerStory(rec, t))];
  const a = rec.arrive;
  if (a) {
    rows.push(fact("Walked in", dayClock(a.t)));
    rows.push(fact("Basket", `${plural(a.lines, "line")}, ${count(a.units)} units, ${money(a.dollars, 2)}`));
    if (a.stall >= 0) rows.push(synth("Parked", `stall ${a.stall + 1} — the engine counts a car in the lot, the playback picks the space`));
  }
  if (rec.shop) {
    const stops = rec.shop.stops.slice(0, 6).map((s) => `${skuName(world, s.sku)} at ${s.facing}`);
    rows.push(fact("Went to", `${stops.join(", ")}${rec.shop.stops.length > 6 ? `, and ${rec.shop.stops.length - 6} more` : ""}`));
  }
  if (rec.counterJoin) rows.push(fact("Joined the showcase queue", `${clockLabel(rec.counterJoin.t)}, ${rec.counterJoin.queueLen} ahead`));
  if (rec.counterDone) rows.push(fact("Served", `${clockLabel(rec.counterDone.t)} after ${minutes(rec.counterDone.waitMin)}`));
  if (rec.queueJoin) rows.push(fact("Joined the till queue", `${clockLabel(rec.queueJoin.t)} at ${rec.queueJoin.register}, ${rec.queueJoin.queueLen} ahead`));
  if (rec.sale) rows.push(fact("Paid", `${clockLabel(rec.sale.t)}: ${plural(rec.sale.lines, "line")}, ${money(rec.sale.dollars, 2)} after ${minutes(rec.sale.waitMin)} in line`));
  if (rec.abandon) rows.push(fact("Walked out", `${clockLabel(rec.abandon.t)} from the ${rec.abandon.at === "counter" ? "showcase" : "register"} after ${minutes(rec.abandon.waitMin)}, ${money(rec.abandon.dollars, 2)} lost`));
  if (rec.leave) rows.push(fact("Left", `${clockLabel(rec.leave.t)}, ${minutes(rec.leave.minutesInStore)} in the shop, ${rec.leave.bought ? `${money(rec.leave.dollars, 2)} spent` : "nothing bought"}`));

  const sections: DescribeSection[] = [{ title: def.label || def.id, rows }];
  const pose = poseOf(pb, entity, t);
  if (pose) {
    sections.push({
      title: "Now",
      rows: [
        ENGINE_STATES.has(pose.s) ? fact("Doing", stateName(pose.s)) : synth("Doing", stateName(pose.s)),
        synth("Standing", `${Math.round(pose.x)}, ${Math.round(pose.y)} ft — the engine knows which fixtures they shop, the playback draws the walk between them`),
      ],
    });
  }
  const job = pose ? jobAt(pb, pose.job) : null;
  if (job) sections.push(describeJob(job, world, t));
  return sections;
}

// ---------------------------------------------------------------------------
// Things that move goods
// ---------------------------------------------------------------------------

/** The dock-lane spot a pallet stands on; past LANE_SLOTS a lane stacks tier on tier at the same spots. */
function laneSpot(slot: number): string {
  const tier = Math.floor(slot / LANE_SLOTS);
  return `spot ${(slot % LANE_SLOTS) + 1}${tier > 0 ? `, tier ${tier + 1}` : ""}`;
}

function palletPlace(pb: Playback, world: WorldPayload, ordinal: number, t: number): string {
  const tl = pb.pallets;
  const r = csrRowAt(tl, ordinal, t);
  if (r < 0) return "not yet";
  const at = tl.at[r];
  const ref = tl.ref[r];
  const slot = tl.slot[r];
  switch (at) {
    case PalletAt.Unborn:
      return "not yet: still on the truck's manifest";
    case PalletAt.Trailer:
      return `on the trailer (${pb.entities[ref]?.label ?? `truck ${ref}`})`;
    case PalletAt.DockLane:
      return `on the apron inside ${doorId(world, ref) ?? `door ${ref}`}, ${laneSpot(slot)}`;
    case PalletAt.Jack:
      return `on ${pb.entities[ref]?.label ?? `pallet jack ${ref + 1}`}`;
    case PalletAt.Storage:
      return `in the stockroom at ${world.storage[ref]?.id ?? ref}${slot > 0 ? `, stacked ${slot + 1} high` : ""}`;
    case PalletAt.Bench:
      return "on the pick-and-pack bench";
    case PalletAt.Van:
      return `loaded on ${pb.entities[ref]?.label ?? `van ${ref + 1}`}`;
    case PalletAt.Gone:
      return "gone: broken down into stockroom cases, or away on the van";
    default:
      return `state ${at}`;
  }
}

function palletOrdinal(pb: Playback, entity: number): number {
  let o = 0;
  for (let i = 0; i < entity; i++) if (pb.entities[i].kind === "pallet") o++;
  return o;
}

function describePallet(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const rows: DescribeRow[] = [];
  const poId = str(def.meta.po);
  if (poId) {
    rows.push(fact("Delivery", `${poId} from ${str(def.meta.supplier)}${def.meta.importer ? " (imported: every case is labelled at check-in)" : ""}`));
    const contents = str(def.meta.items);
    if (contents) rows.push(fact("On it", `${contents}${def.meta.mixed ? " (mixed pallet)" : ""}`));
    const rec = index.po.get(poId);
    if (rec?.arrive && rec.arrive.t <= t) rows.push(fact("Arrived", dayClock(rec.arrive.t)));
    const put = rec?.putaways.find((p) => p.pallet === numOf(def.meta.index));
    if (put && put.t <= t) rows.push(fact("Put away", `${dayClock(put.t)}, ${minutes(put.dockToStockMin)} from the door into the stockroom, at ${put.items.map((i) => i.loc).join(", ")}`));
    else if (rec?.arrive && rec.arrive.t <= t) rows.push(fact("Put away", "not yet"));
  }
  rows.push(synth("Where now", palletPlace(pb, world, palletOrdinal(pb, entity), t)));
  rows.push(synth("Placement", "lane spots, the bench and rack stacks are the playback's; the engine tracks cases per SKU and pallets per truck"));
  return [{ title: def.label || def.id, rows }];
}

function visualDoorOf(pb: Playback, world: WorldPayload, entity: number, t: number): string | null {
  const n = pb.doors.offsets.length - 1;
  for (let d = 0; d < n; d++) if (csrValueAt(pb.doors, d, t, -1) === entity) return doorId(world, d);
  return null;
}

/** An inbound trailer or box truck: what it brought, when it was due, how long it stood on the drive. */
export function describeTruck(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const poId = str(def.meta.po) || def.id;
  const rec = index.po.get(poId);
  const rows: DescribeRow[] = [];
  const supplierId = str(def.meta.supplier) || rec?.placed?.supplier || "";
  const supplier = world.suppliers.find((s) => s.id === supplierId);
  const channel = supplier?.channel ?? rec?.placed?.channel;
  rows.push(fact("Delivery", `${poId} from ${supplier ? `${supplier.name} (${supplierId})` : supplierId || "an unknown supplier"}${channel ? `, ${channel === "dc" ? "the overnight trailer from the distribution center" : "a vendor's own box truck"}` : ""}`));
  if (rec?.placed) rows.push(fact("Ordered", `day ${rec.placed.placedDay + 1} for day ${rec.placed.arriveDay + 1}: ${plural(rec.placed.cases, "case")} on ${plural(rec.placed.pallets, "pallet")}`));
  if (rec?.scheduled) rows.push(fact("Booked in", `${clockLabel(rec.scheduled.appointment)}, expected ${clockLabel(rec.scheduled.eta)}${rec.scheduled.importer ? "; imported, so every case is labelled at check-in" : ""}`));
  if (rec?.arrive && rec.arrive.t <= t) {
    const late = rec.scheduled ? rec.arrive.t - rec.scheduled.appointment : null;
    rows.push(fact("Arrived", `${dayClock(rec.arrive.t)}${late === null ? "" : late >= 0 ? `, ${minutes(late)} after the appointment` : `, ${minutes(-late)} early`}`));
  }
  if (rec?.dock && rec.dock.t <= t) rows.push(fact("On the door", `${clockLabel(rec.dock.t)}${rec.dock.waitMin > 0.5 ? ` after ${minutes(rec.dock.waitMin)} on the service drive` : ", straight on"}${rec.dock.door ? ` at ${rec.dock.door}` : ""}`));
  else if (rec?.arrive && rec.arrive.t <= t) rows.push(fact("On the door", "still waiting for a goods door"));
  if (rec?.undock && rec.undock.t <= t) rows.push(fact("Pulled off", clockLabel(rec.undock.t)));
  const pallets = rec?.arrive?.pallets.length ?? numOf(def.meta.pallets);
  const put = rec?.putaways.filter((p) => p.t <= t).length ?? 0;
  if (pallets > 0) rows.push(fact("Pallets put away", `${put} of ${pallets}`));
  const engineDoor = rec?.dock?.door ?? null;
  const shownDoor = visualDoorOf(pb, world, entity, t);
  if (engineDoor && shownDoor && shownDoor !== engineDoor) rows.push(synth("Door", `the engine measured from ${engineDoor}; drawn at ${shownDoor}`));
  else if (!engineDoor && shownDoor) rows.push(synth("Door", `${shownDoor} — the engine counts goods doors, the playback picks one`));
  const pose = poseOf(pb, entity, t);
  if (pose) rows.push(pose.s === ActorState.Docked ? fact("Now", stateName(pose.s)) : synth("Now", `${stateName(pose.s)} — the service drive, the queue spot and backing onto the dock are drawn, not simulated`));
  return [{ title: def.label || poId, rows }];
}

function describeVan(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const rows: DescribeRow[] = [];
  const idx = numOf(def.meta.index);
  rows.push(fact("Vehicle", `the shop's own delivery van${idx >= 0 ? ` ${idx + 1}` : ""}`));
  const rounds = pb.jobs.filter((j) => j.info.kind === "deliver" && j.van === idx && j.startAt >= 0 && j.startAt <= t);
  rows.push(fact("Rounds so far", String(rounds.length)));
  const last = rounds[rounds.length - 1];
  if (last && last.info.kind === "deliver") {
    rows.push(fact("This round", `${plural(last.info.stops, "stop")}, ${last.info.miles.toFixed(1)} miles, booked out at ${clockLabel(last.info.departAt)}`));
    const late = last.info.orders.map((id) => index.order.get(id)?.departed).find((d) => d && d.lateMin > 0);
    if (late) rows.push(fact("Left", `${clockLabel(late.t)}, ${minutes(late.lateMin)} late`));
  }
  const pose = poseOf(pb, entity, t);
  if (pose) {
    rows.push(synth("Now", stateName(pose.s)));
    rows.push(synth("Route", "the engine costs a round by its stops and miles; where the van goes once it is off the lot is not modelled"));
  }
  const sections: DescribeSection[] = [{ title: def.label || def.id, rows }];
  const job = pose ? jobAt(pb, pose.job) : null;
  if (job) sections.push(describeJob(job, world, t));
  return sections;
}

function describeEquipment(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number): DescribeSection[] {
  const isCart = def.kind === "cart";
  const idx = numOf(def.meta.index);
  const rows: DescribeRow[] = [];
  rows.push(fact("Fleet", `${isCart ? "stock cart" : "pallet jack"} ${idx + 1} of the ${isCart ? "carts" : "jacks"} the engine counts`));
  rows.push(synth("Identity", "the engine only counts how many are in use; the playback keeps each job on one unit so the picture stays readable"));
  const used = pb.jobs.filter((j) => (isCart ? j.cart : j.jack) === idx && j.startAt >= 0 && j.startAt <= t).length;
  rows.push(synth("Jobs on this one so far", String(used)));
  const pose = poseOf(pb, entity, t);
  if (pose) {
    rows.push(synth("Now", stateName(pose.s)));
    rows.push(synth("Standing", `${Math.round(pose.x)}, ${Math.round(pose.y)} ft`));
  }
  const sections: DescribeSection[] = [{ title: def.label || def.id, rows }];
  const job = pose ? jobAt(pb, pose.job) : null;
  if (job) sections.push(describeJob(job, world, t));
  else sections.push({ title: "Now", rows: [synth("Parked", `idle at its park spot until the next ${isCart ? "restock" : "pallet"} job`)] });
  return sections;
}

function describeCar(entity: number, def: EntityDef, pb: Playback, t: number, index: EventIndex): DescribeSection[] {
  const rows: DescribeRow[] = [];
  const owner = str(def.meta.customer) || def.id;
  const rec = index.customer.get(owner);
  rows.push(fact("Belongs to", owner));
  if (rec?.arrive) rows.push(fact("Arrived", `${dayClock(rec.arrive.t)}, ${BASKET_WORDS[rec.arrive.kind] ?? rec.arrive.kind}`));
  const stall = rec?.arrive?.stall ?? numOf(def.meta.stall);
  if (stall >= 0) rows.push(synth("Stall", `${stall + 1} — the engine counts cars in the lot, the playback parks them`));
  if (rec?.leave) rows.push(fact("Drove off", dayClock(rec.leave.t)));
  const pose = poseOf(pb, entity, t);
  if (pose) rows.push(synth("Now", stateName(pose.s)));
  return [{ title: def.label || def.id, rows }];
}

/** The sections for any entity in the playback, dispatched on its kind. */
export function describeEntity(entity: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex = indexEvents(pb)): DescribeSection[] {
  const def = pb.entities[entity];
  if (!def) return [{ title: "Unknown", rows: [fact("Entity", String(entity))] }];
  switch (def.kind) {
    case "worker":
      return describeWorker(entity, def, pb, world, t, index);
    case "customer":
      return describeCustomer(entity, def, pb, world, t, index);
    case "cart":
    case "jack":
      return describeEquipment(entity, def, pb, world, t);
    case "pallet":
      return describePallet(entity, def, pb, world, t, index);
    case "van":
      return describeVan(entity, def, pb, world, t, index);
    case "truck":
      return describeTruck(entity, def, pb, world, t, index);
    case "car":
      return describeCar(entity, def, pb, t, index);
  }
}

// ---------------------------------------------------------------------------
// The building
// ---------------------------------------------------------------------------

/** Cases sitting in the stockroom for one SKU, summed over the positions holding it. */
function backroomCases(pb: Playback, skuIdx: number, t: number): number {
  let cases = 0;
  const n = pb.storage.offsets.length - 1;
  for (let i = 0; i < n; i++) {
    if (csrValueAt(pb.storageSku, i, t, -1) !== skuIdx) continue;
    cases += csrValueAt(pb.storage, i, t, 0);
  }
  return cases;
}

/** The last time this facing went up rather than down, which is the last time somebody filled it. */
function lastFilled(pb: Playback, facing: number, t: number): number | null {
  const lo = pb.facings.offsets[facing];
  const hi = csrRowAt(pb.facings, facing, t);
  if (hi < lo) return null;
  for (let r = hi; r > lo; r--) if (pb.facings.v[r] > pb.facings.v[r - 1]) return pb.facings.t[r];
  return null;
}

/**
 * A shelf facing: "Gummy bears, 24 units of 40, last filled 41 min ago, 3 lost
 * sales today." The facing is this model's pick face — customers take stock off
 * it themselves, so one that runs dry between restocks is a lost sale even with
 * a full stockroom. That is the thing this view exists to show.
 */
export function describeFacing(i: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex = indexEvents(pb)): DescribeSection[] {
  const f = world.facings[i];
  if (!f) return [{ title: "Facing", rows: [fact("Index", String(i))] }];
  const rows: DescribeRow[] = [];
  rows.push(fact("Fixture", `${f.run} (${f.kind}), bay ${f.bay + 1}, shelf ${f.shelf}, facing ${f.slot + 1}, ${f.side === "L" ? "left" : "right"} side`));
  rows.push(fact("Reached from", f.aisle >= 0 ? `aisle ${f.aisle + 1}, standing at ${Math.round(f.x)}, ${Math.round(f.y)} ft` : `open floor at ${Math.round(f.x)}, ${Math.round(f.y)} ft`));
  if (f.served) rows.push(fact("Served", "behind the glass: a clerk weighs and boxes it, the shopper never touches it"));

  const skuIdx = pb.facingSku[i];
  const sku = skuIdx >= 0 ? world.skus[skuIdx] : null;
  if (!sku) {
    rows.push(fact("Merchandised", "empty shelf: the planogram puts nothing here"));
    return [{ title: `Facing ${f.id}`, rows }];
  }
  rows.push(fact("SKU", `${sku.id} · ${sku.name} (${sku.category})`));
  const on = csrValueAt(pb.facings, i, t, 0);
  const cap = index.init?.facingCap.find(([id]) => id === sku.id)?.[1] ?? 0;
  rows.push(fact("On the shelf", `${units(on, sku.sellBy)} of ${units(cap, sku.sellBy)}${cap > 0 ? `, ${percent(on / cap)} full` : ""}, at ${money(sku.unitRetail, 2)} ${sku.sellBy === "weight" ? "a pound" : "each"}`));
  const filled = lastFilled(pb, i, t);
  rows.push(fact("Last filled", filled === null ? "not since the run started" : `${clockLabel(filled)}, ${minutes(t - filled)} ago`));
  if (csrValueAt(pb.facingHot, i, t, 0)) rows.push(fact("Hot", "a restock is already on its way: somebody reached for this and it was not there"));
  rows.push(fact("In the stockroom", `${count(backroomCases(pb, skuIdx, t))} cases of ${sku.innersPerCase} inners`));

  const day = dayOf(t);
  const shorts = (index.shortsBySku.get(sku.id) ?? []).filter((s) => s.t <= t && dayOf(s.t) === day);
  const lost = shorts.filter((s) => s.customer !== null).length;
  rows.push(fact("Came up short today", `${shorts.length} time${shorts.length === 1 ? "" : "s"}${lost > 0 ? `, ${lost} of them with a shopper standing in front of it` : ""}`));
  rows.push(synth("Colour", "green stocked, amber down to the last few units, red empty; the heat view shades by units sold over the run"));
  return [{ title: `Facing ${f.id}`, rows }];
}

/** A stockroom pallet position or case shelf. */
export function describeStorage(i: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex = indexEvents(pb)): DescribeSection[] {
  const p = world.storage[i];
  if (!p) return [{ title: "Stockroom position", rows: [fact("Index", String(i))] }];
  const rows: DescribeRow[] = [];
  rows.push(fact("Position", `${p.run} (${p.kind === "rack" ? "pallet rack" : "case shelving"}), bay ${p.bay + 1}, level ${p.level}, at ${Math.round(p.x)}, ${Math.round(p.y)} ft`));
  const homes = index.init?.backLoc.filter(([, loc]) => loc === p.id).map(([sku]) => sku) ?? [];
  rows.push(fact("Home of", homes.length ? homes.map((s) => `${s} · ${skuName(world, s)}`).join(", ") : "no SKU: a spare position"));
  const skuIdx = csrValueAt(pb.storageSku, i, t, -1);
  const sku = skuIdx >= 0 ? world.skus[skuIdx] : null;
  if (sku) {
    const cases = csrValueAt(pb.storage, i, t, 0);
    rows.push(fact("Holding", `${count(cases)} cases of ${sku.id} · ${sku.name} (${sku.innersPerCase} inners a case, ${sku.unitsPerInner} ${sku.sellBy === "weight" ? "lb" : "pc"} an inner)`));
    if (homes.length && !homes.includes(sku.id)) rows.push(synth("Overflow", `${sku.id} is here because its own position was full`));
  } else rows.push(fact("Holding", "nothing at the moment"));
  return [{ title: `Stockroom ${p.id}`, rows }];
}

/** A register, a showcase station or the gift-wrap bench. */
export function describePost(i: number, pb: Playback, world: WorldPayload, t: number): DescribeSection[] {
  const s = world.spec.service[i];
  if (!s) return [{ title: "Service point", rows: [fact("Index", String(i))] }];
  const kindWord = s.kind === "register" ? "register" : s.kind === "counter" ? "showcase station" : "gift-wrap station";
  const rows: DescribeRow[] = [];
  rows.push(fact("Point", `${s.id}, a ${kindWord} at ${Math.round(s.x)}, ${Math.round(s.y)} ft`));
  const at = csrValueAt(pb.posts, i, t, -1);
  if (at === -2) rows.push(fact("Now", "closed: nobody on it, or it is out in this scenario"));
  else if (at >= 0) rows.push(fact("Now", `serving ${pb.entities[at]?.label ?? `customer ${at}`}`));
  else rows.push(fact("Now", "open and free"));
  const q = csrValueAt(pb.queueLen, i, t, 0);
  rows.push(fact("In the line", `${q} ${q === 1 ? "person" : "people"}`));
  const here = pb.jobs.filter((j) => j.post === i && j.startAt >= 0 && j.startAt <= t);
  rows.push(fact("Served today", String(here.filter((j) => dayOf(j.startAt) === dayOf(t)).length)));
  rows.push(synth("Line", "the engine knows how many are waiting and for how long; where they stand is the playback's"));
  const sections: DescribeSection[] = [{ title: s.id, rows }];
  const busy = here.find((j) => j.startAt <= t && j.endAt > t);
  if (busy) sections.push(describeJob(busy, world, t));
  return sections;
}

/** A goods door or a customer entrance. */
export function describeDoor(i: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex = indexEvents(pb)): DescribeSection[] {
  const d = world.spec.doors[i];
  if (!d) return [{ title: "Door", rows: [fact("Index", String(i))] }];
  const word = d.kind === "entrance" ? "customer entrance" : d.kind === "dock" ? "raised dock" : "ground-level roll-up";
  const rows: DescribeRow[] = [fact("Door", `${d.id}, a ${word} ${d.widthFt} ft wide at x ${Math.round(d.x)} ft`)];
  if (d.kind !== "entrance") {
    const v = csrValueAt(pb.doors, i, t, -1);
    if (v === -2) rows.push(fact("Now", "out of service in this scenario"));
    else if (v >= 0) rows.push(synth("Now", `${pb.entities[v]?.label ?? `truck ${v}`} on the door`));
    else rows.push(synth("Now", "free"));
    let occupied = 0;
    for (let s = 0; s < LANE_SLOTS; s++) if (csrValueAt(pb.laneSlots, i * LANE_SLOTS + s, t, -1) >= 0) occupied++;
    rows.push(synth("Apron", `${occupied} of ${LANE_SLOTS} pallet spots in use inside the door`));
    let engineDockings = 0;
    for (const rec of index.po.values()) if (rec.dock && rec.dock.t <= t && rec.dock.door === d.id) engineDockings++;
    rows.push(fact("Trucks the engine put here", `${engineDockings} so far`));
  }
  return [{ title: `Door ${d.id}`, rows }];
}

/** A queue chip: which work is stacked up on this process, and what is holding it. */
export function describeQueue(process: Process, pb: Playback, t: number): DescribeSection[] {
  const p = PROCESSES.indexOf(process);
  const bins = pb.queueBins;
  const n = PROCESSES.length;
  const k = Math.max(0, Math.min(bins.count - 1, Math.floor(t / Math.max(1, bins.binMin))));
  const len = bins.count > 0 && p >= 0 ? bins.queues[k * n + p] : 0;
  const rows: DescribeRow[] = [];
  rows.push(fact("Queue", `${len} ${process} job${len === 1 ? "" : "s"} waiting; it takes the ${PROCESS_SKILL[process]} skill`));
  const waiting = pb.jobs.filter((j) => j.process === process && j.queuedAt <= t && (j.startAt < 0 || j.startAt > t)).sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
  rows.push(fact("Waiting right now", String(waiting.length)));
  const sections: DescribeSection[] = [{ title: `${process} queue`, rows }];
  for (const j of waiting.slice(0, 8)) {
    const held = j.startAt > t && j.equipWaitMin > 0 && t >= j.startAt - j.equipWaitMin;
    sections.push({
      title: `Job ${j.id}`,
      rows: [
        fact("What", jobSummary(j.info)),
        fact("Waiting", `${minutes(t - j.queuedAt)} since ${clockLabel(j.queuedAt)}, priority ${j.priority}`),
        held ? fact("Held by", `somebody qualified is free, but the register, counter or cart is taken (${minutes(j.equipWaitMin)} of the wait)`) : fact("Starts", j.startAt < 0 ? "never: the run ends first" : `${clockLabel(j.startAt)} with ${j.worker}`),
      ],
    });
  }
  if (waiting.length > 8) sections.push({ title: `${waiting.length - 8} more`, rows: [fact("Also waiting", waiting.slice(8).map((j) => `#${j.id}`).join(", "))] });
  return sections;
}

/** A one-line name for whatever is selected, for the inspector header and the camera pill. */
export function entityTitle(pb: Playback, entity: number): string {
  return pb.entities[entity]?.label ?? `entity ${entity}`;
}
