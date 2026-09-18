/**
 * One playback sample, applied to the scene.
 *
 * `applyFrame` never reads engine state. Everything comes from the `Playback`
 * — typed-array tracks and CSR timelines — and from the `PlaybackCursor`
 * sample, which carries the interpolated poses and the half-open range of
 * dirty-list rows crossed since the last frame. A frame therefore costs the
 * keyframes it passed over plus the actors on the floor, whatever the horizon
 * is. Never re-read a timeline you did not cross; a seek says so explicitly
 * and only then is every timeline re-read at t by binary search.
 *
 * Determinism is a hard contract, so every time-driven effect here is a
 * function of the simulated minute, never of wall-clock time: the restock
 * pulse on a facing is `0.5 + 0.5·sin(2πt)`, the late-departure strobe is
 * `floor(t / 0.25) % 2`, and even the walk-cycle bob is `sin(t · BOB_RATE)`
 * rather than an accumulated real-time phase. That last one is a deliberate
 * departure from the reference, which drove the bob from `dtRealSec`: here a
 * paused frame renders identically every time it is drawn, which is what the
 * screenshot harness needs and what "seed 1 is run 1 of the table" means when
 * the thing on screen is the evidence.
 *
 * Two indexing conventions are worth stating, because both are easy to get
 * wrong and neither is visible from the type. The `doors` and `laneSlots`
 * timelines are indexed by GOODS door — the doors the trucks use — while
 * `World.frames` and `spec.doors` are indexed over every door including the
 * customer entrance; `goodsFrames` below maps between them, and falls back to
 * the identity when the compiler happens to have sized the timeline over all
 * the doors instead. And the pallet timeline is indexed by pallet ordinal, not
 * by entity, so `palletEntity` carries that mapping.
 *
 * Note also that the `World` the renderer draws is the one the playback
 * carries (`playback.world`), not one on the `WorldPayload`: the payload holds
 * the spec, the facings and the catalog, and the compiler's synthesized world
 * is the authority on where everything stands.
 */

import { Color, Vector3 } from "three";
import type { CursorSample } from "../trace/cursor";
import { POSE_STRIDE } from "../trace/cursor";
import { upperBound } from "../trace/search";
import { ActorState, DirtyKind, PalletAt, SegKind, type Playback, type TraceInit, type WorldPayload } from "../trace/types";
import { actorKindOf, ActorPool, type Actor, type InstancedActors } from "./actors";
import type { Building } from "./building";
import type { Environment } from "./environment";
import type { Fixtures } from "./fixtures";
import { PALLET_HEIGHT, PERSON_LABEL_Z } from "./geometry";
import { facingBadgeEntity, queueChipEntity, type LabelSource } from "./labels";
import { categoryColor, fillColor, roleColor, shopperColor, STATE_COLORS } from "./palette";

/** The pose layout `PlaybackCursor` writes: x, y, z, heading, state, segment, job, carried. */
export const POSE = { x: 0, y: 1, z: 2, h: 3, s: 4, seg: 5, job: 6, carry: 7 } as const;

/** Radians of walk cycle per simulated minute; a person's stride at shop pace. */
const BOB_RATE = 2 * Math.PI * 9;
/** How close to a doorway somebody has to be for the doors to open. */
const DOOR_TRIGGER_FT = 7;

export interface SceneRefs {
  building: Building;
  fixtures: Fixtures;
  env: Environment;
  actors: ActorPool;
  shoppers: InstancedActors;
  cars: InstancedActors;
  pallets: InstancedActors;
}

export interface StoreScene {
  refs: SceneRefs;
  /** The spec, the facings and the catalog the page sent over. */
  payload: WorldPayload;
  playback: Playback;
  /** Selling units a facing holds when full, and the units in one case (the amber threshold). */
  facingCap: Float64Array;
  facingPerCase: Float64Array;
  facingUnits: Uint16Array;
  facingHot: Uint8Array;
  hotFacings: Set<number>;
  /** Facings merchandised with nothing: hidden rather than drawn empty. */
  facingSku: Int32Array;
  storageCap: Float64Array;
  storageUnits: Uint16Array;
  storageSku: Int32Array;
  doorValue: Int32Array;
  /** Goods-door timeline index to World.frames index. */
  goodsFrames: Int32Array;
  laneOccupant: Int32Array;
  postValue: Int32Array;
  queueLen: Uint16Array;
  stallValue: Int32Array;
  /** Pallet timeline index to entity index. */
  palletEntity: Int32Array;
  /** Sku index to category palette index. */
  skuCategory: Int32Array;
  labels: LabelSource[];
  visibleActors: number;
  lastT: number;
}

const _c = new Color();
const _c2 = new Color();
const _hot = new Color(STATE_COLORS.hot);
const _v = new Vector3();

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/** Row of a CSR item in force at t (the last row at or before t), or -1 when the item has no rows. */
export function rowAt(tl: { offsets: Int32Array; t: Float64Array }, item: number, t: number): number {
  const lo = tl.offsets[item];
  const hi = tl.offsets[item + 1];
  if (hi <= lo) return -1;
  // A row whose time is exactly t is in force at t, so upperBound minus one.
  return Math.max(lo, upperBound(tl.t, t, lo, hi) - 1);
}

/** The largest value an item ever holds, which is the honest cap when the run carries no init event. */
function peakOf(tl: { offsets: Int32Array; v: ArrayLike<number> }, item: number): number {
  let max = 0;
  for (let r = tl.offsets[item]; r < tl.offsets[item + 1]; r++) max = Math.max(max, tl.v[r]);
  return max;
}

/**
 * The most entities of one kind alive at the same moment, by sweeping each
 * track's on and off keyframes. This is what sizes the instanced pools: a week
 * of trading puts thousands of customers through the door and tens of them
 * inside at once, and a pool sized on the former would be a hundred times too
 * big.
 */
export function peakConcurrent(pb: Pick<Playback, "tracks" | "entities">, kind: string): number {
  const events: Array<[number, number]> = [];
  for (const tr of pb.tracks) {
    if (!tr || tr.t.length === 0 || pb.entities[tr.entity]?.kind !== kind) continue;
    let from = -1;
    for (let i = 0; i < tr.t.length; i++) {
      const on = tr.s[i] !== ActorState.Off;
      if (on && from < 0) from = tr.t[i];
      else if (!on && from >= 0) {
        events.push([from, 1], [tr.t[i], -1]);
        from = -1;
      }
    }
    if (from >= 0) events.push([from, 1], [tr.t[tr.t.length - 1], -1]);
  }
  // Sorted by time, with a departure at the same instant applied first, so a
  // handover does not count as two people.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  for (const [, d] of events) {
    live += d;
    peak = Math.max(peak, live);
  }
  return peak;
}

function initOf(pb: Playback): TraceInit | null {
  const first = pb.events[0];
  return first && first.k === "init" ? first : null;
}

export function bindScene(refs: SceneRefs, payload: WorldPayload, playback: Playback): StoreScene {
  const world = playback.world;
  const nFacings = playback.facingSku.length;
  const nStorage = Math.max(0, playback.storage.offsets.length - 1);
  const init = initOf(playback);
  const capBySku = new Map<string, number>(init?.facingCap ?? []);

  const facingCap = new Float64Array(nFacings);
  const facingPerCase = new Float64Array(nFacings);
  for (let i = 0; i < nFacings; i++) {
    const s = playback.facingSku[i];
    const sku = s >= 0 ? payload.skus[s] : undefined;
    if (!sku) continue;
    facingPerCase[i] = Math.max(1, sku.unitsPerInner * sku.innersPerCase);
    // With no init event to read the planogram's cap from, the most the facing
    // ever held over the run is the honest stand-in, and it is still a pure
    // function of the playback.
    facingCap[i] = capBySku.get(sku.id) ?? Math.max(1, peakOf(playback.facings, i));
  }

  const storageCap = new Float64Array(nStorage);
  for (let i = 0; i < nStorage; i++) storageCap[i] = Math.max(1, peakOf(playback.storage, i));

  // Sku index to category palette index, in first-seen order over the catalog
  // so the mapping does not depend on which SKUs happen to be on the shelf.
  const categories = new Map<string, number>();
  const skuCategory = new Int32Array(payload.skus.length);
  payload.skus.forEach((s, i) => {
    let c = categories.get(s.category);
    if (c === undefined) {
      c = categories.size;
      categories.set(s.category, c);
    }
    skuCategory[i] = c;
  });

  const palletEntity: number[] = [];
  playback.entities.forEach((e, i) => {
    if (e.kind === "pallet") palletEntity.push(i);
  });

  // The doors timeline is per goods door; World.frames is per door.
  const goods: number[] = [];
  world.frames.forEach((f, i) => {
    if (f.kind !== "entrance") goods.push(i);
  });
  const nDoors = Math.max(0, playback.doors.offsets.length - 1);
  const goodsFrames = Int32Array.from({ length: nDoors }, (_, i) => (nDoors === world.frames.length ? i : (goods[i] ?? -1)));

  return {
    refs,
    payload,
    playback,
    facingCap,
    facingPerCase,
    facingUnits: new Uint16Array(nFacings),
    facingHot: new Uint8Array(nFacings),
    hotFacings: new Set(),
    facingSku: playback.facingSku,
    storageCap,
    storageUnits: new Uint16Array(nStorage),
    storageSku: new Int32Array(nStorage).fill(-1),
    doorValue: new Int32Array(nDoors).fill(-1),
    goodsFrames,
    laneOccupant: new Int32Array(Math.max(0, playback.laneSlots.offsets.length - 1)).fill(-1),
    postValue: new Int32Array(Math.max(0, playback.posts.offsets.length - 1)).fill(-1),
    queueLen: new Uint16Array(Math.max(0, playback.queueLen.offsets.length - 1)),
    stallValue: new Int32Array(Math.max(0, playback.stalls.offsets.length - 1)).fill(-1),
    palletEntity: Int32Array.from(palletEntity),
    skuCategory,
    labels: [],
    visibleActors: 0,
    lastT: -1,
  };
}

/** Hide every moving thing: the playback has been detached. */
export function releaseScene(scene: StoreScene): void {
  scene.refs.actors.releaseAll();
  for (const pool of [scene.refs.shoppers, scene.refs.cars, scene.refs.pallets]) {
    pool.clear();
    pool.commit();
  }
  scene.labels = [];
  scene.visibleActors = 0;
}

// ---------------------------------------------------------------------------
// Timeline handlers
// ---------------------------------------------------------------------------

function refreshFacing(scene: StoreScene, i: number): void {
  if (scene.facingSku[i] < 0) {
    scene.refs.fixtures.setFacing(i, -1, null);
    return;
  }
  const units = scene.facingUnits[i];
  const cap = scene.facingCap[i];
  fillColor(_c, units, cap, scene.facingPerCase[i]);
  scene.refs.fixtures.setFacing(i, cap > 0 ? units / cap : 0, _c);
}

/**
 * Facings with a restock queued breathe orange on a one-simulated-minute
 * cycle, so the shelves the crew is behind on are findable from the overview.
 */
function pulseHot(scene: StoreScene, t: number): void {
  if (scene.hotFacings.size === 0) return;
  const k = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI);
  for (const i of scene.hotFacings) {
    if (scene.facingSku[i] < 0) continue;
    const units = scene.facingUnits[i];
    const cap = scene.facingCap[i];
    fillColor(_c2, units, cap, scene.facingPerCase[i]);
    _c.lerpColors(_c2, _hot, k);
    scene.refs.fixtures.setFacing(i, cap > 0 ? units / cap : 0, _c);
  }
}

function setHot(scene: StoreScene, i: number, hot: number): void {
  scene.facingHot[i] = hot;
  if (hot) scene.hotFacings.add(i);
  else {
    scene.hotFacings.delete(i);
    refreshFacing(scene, i);
  }
}

function refreshStorage(scene: StoreScene, i: number): void {
  const units = scene.storageUnits[i];
  const sku = scene.storageSku[i];
  _c.setHex(sku >= 0 && sku < scene.skuCategory.length ? categoryColor(scene.skuCategory[sku]) : 0x8b5e3c);
  scene.refs.fixtures.setStorage(i, units > 0 ? Math.min(1, units / Math.max(1, scene.storageCap[i])) : 0, _c);
}

function setDoor(scene: StoreScene, i: number, v: number): void {
  scene.doorValue[i] = v;
  const frame = scene.goodsFrames[i];
  if (frame < 0) return;
  scene.refs.building.setDoor(frame, v === -2 ? "outage" : v >= 0 ? "busy" : "free");
  // A goods door is open exactly while something is on it.
  scene.refs.building.setDoorOpen(frame, v >= 0 ? 1 : 0);
}

function setPost(scene: StoreScene, i: number, v: number): void {
  scene.postValue[i] = v;
  scene.refs.fixtures.setPost(i, v === -2 ? "closed" : v >= 0 ? "busy" : "idle");
}

function palletColor(scene: StoreScene, entity: number): Color {
  const def = scene.playback.entities[entity];
  return _c.setHex(categoryColor(def?.colorIdx ?? 0));
}

/**
 * Where a pallet is standing. Only the two places a pallet is loose on the
 * floor draw one: in a lane inside a goods door, and on the pick-and-pack
 * bench. On a jack it is the jack's own carried child, on a rack it is a
 * storage instance, and in a trailer or the van it is out of sight.
 */
function placePallet(scene: StoreScene, p: number, row: number): void {
  const tl = scene.playback.pallets;
  const entity = scene.palletEntity[p];
  const pool = scene.refs.pallets;
  if (entity === undefined || row < 0) return;
  const at = tl.at[row];
  const ref = tl.ref[row];
  const slot = tl.slot[row];
  const w = scene.playback.world;
  if (at === PalletAt.DockLane) {
    const lane = w.lanes[ref];
    if (!lane || lane.slots.length === 0) {
      pool.release(entity);
      return;
    }
    const n = lane.slots.length;
    const spot = lane.slots[((slot % n) + n) % n];
    // More pallets than lane slots stack a tier at a time, which is what a
    // receiving apron looks like when the crew is behind.
    const tier = Math.max(0, Math.floor(slot / n));
    pool.place(entity, spot[0], spot[1], tier * PALLET_HEIGHT, 0, palletColor(scene, entity));
  } else if (at === PalletAt.Bench) {
    const k = slot >= 0 ? slot % 3 : 0;
    pool.place(entity, w.bench[0] + (k - 1) * 3.6, w.bench[1] - 4, 0, 0, palletColor(scene, entity));
  } else {
    pool.release(entity);
  }
}

function applyDirty(scene: StoreScene, from: number, to: number): void {
  const pb = scene.playback;
  const d = pb.dirty;
  for (let r = from; r < to; r++) {
    const idx = d.idx[r];
    const row = d.row[r];
    switch (d.kind[r]) {
      case DirtyKind.Facing:
        scene.facingUnits[idx] = pb.facings.v[row];
        refreshFacing(scene, idx);
        break;
      case DirtyKind.FacingHot:
        setHot(scene, idx, pb.facingHot.v[row]);
        break;
      case DirtyKind.Storage:
        scene.storageUnits[idx] = pb.storage.v[row];
        refreshStorage(scene, idx);
        break;
      case DirtyKind.StorageSku:
        scene.storageSku[idx] = pb.storageSku.v[row];
        refreshStorage(scene, idx);
        break;
      case DirtyKind.Door:
        setDoor(scene, idx, pb.doors.v[row]);
        break;
      case DirtyKind.LaneSlot:
        scene.laneOccupant[idx] = pb.laneSlots.v[row];
        break;
      case DirtyKind.Post:
        setPost(scene, idx, pb.posts.v[row]);
        break;
      case DirtyKind.Pallet:
        placePallet(scene, idx, row);
        break;
      case DirtyKind.Stall:
        scene.stallValue[idx] = pb.stalls.v[row];
        scene.refs.env.setStallTaken(idx, pb.stalls.v[row] >= 0);
        break;
      case DirtyKind.QueueLen:
        scene.queueLen[idx] = pb.queueLen.v[row];
        break;
    }
  }
}

function rereadAll(scene: StoreScene, t: number): void {
  const pb = scene.playback;
  scene.hotFacings.clear();
  for (let i = 0; i < scene.facingUnits.length; i++) {
    const r = rowAt(pb.facings, i, t);
    scene.facingUnits[i] = r >= 0 ? pb.facings.v[r] : 0;
    const h = rowAt(pb.facingHot, i, t);
    scene.facingHot[i] = h >= 0 ? pb.facingHot.v[h] : 0;
    if (scene.facingHot[i]) scene.hotFacings.add(i);
    refreshFacing(scene, i);
  }
  for (let i = 0; i < scene.storageUnits.length; i++) {
    const r = rowAt(pb.storage, i, t);
    scene.storageUnits[i] = r >= 0 ? pb.storage.v[r] : 0;
    const s = rowAt(pb.storageSku, i, t);
    scene.storageSku[i] = s >= 0 ? pb.storageSku.v[s] : -1;
    refreshStorage(scene, i);
  }
  for (let i = 0; i < scene.doorValue.length; i++) {
    const r = rowAt(pb.doors, i, t);
    setDoor(scene, i, r >= 0 ? pb.doors.v[r] : -1);
  }
  for (let i = 0; i < scene.laneOccupant.length; i++) {
    const r = rowAt(pb.laneSlots, i, t);
    scene.laneOccupant[i] = r >= 0 ? pb.laneSlots.v[r] : -1;
  }
  for (let i = 0; i < scene.postValue.length; i++) {
    const r = rowAt(pb.posts, i, t);
    setPost(scene, i, r >= 0 ? pb.posts.v[r] : -1);
  }
  for (let i = 0; i < scene.queueLen.length; i++) {
    const r = rowAt(pb.queueLen, i, t);
    scene.queueLen[i] = r >= 0 ? pb.queueLen.v[r] : 0;
  }
  for (let i = 0; i < scene.stallValue.length; i++) {
    const r = rowAt(pb.stalls, i, t);
    scene.stallValue[i] = r >= 0 ? pb.stalls.v[r] : -1;
    scene.refs.env.setStallTaken(i, scene.stallValue[i] >= 0);
  }
  scene.refs.pallets.clear();
  for (let p = 0; p < scene.palletEntity.length; p++) placePallet(scene, p, rowAt(pb.pallets, p, t));
}

/** Re-colour every facing: the theme changed, or the playback was rebound. */
export function recolorFacings(scene: StoreScene): void {
  for (let i = 0; i < scene.facingUnits.length; i++) refreshFacing(scene, i);
  scene.refs.fixtures.commit();
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

function ringFor(state: number): number | null {
  switch (state) {
    case ActorState.Overtime:
      return STATE_COLORS.overtime;
    case ActorState.Break:
      return STATE_COLORS.break;
    case ActorState.Indirect:
      return STATE_COLORS.indirect;
    case ActorState.Wait:
      return STATE_COLORS.queue;
    case ActorState.Serve:
    case ActorState.Ring:
      return STATE_COLORS.serving;
    case ActorState.Late:
      return STATE_COLORS.late;
    default:
      return null;
  }
}

const WALK_SEGS = new Set<number>([SegKind.Walk, SegKind.WalkCart, SegKind.Transfer, SegKind.IdleReturn, SegKind.Lot]);

function applyActor(scene: StoreScene, actor: Actor, b: number, sample: CursorSample): void {
  const pool = scene.refs.actors;
  const pb = scene.playback;
  const p = sample.poses;
  const def = pb.entities[actor.entity];
  const state = p[b + POSE.s];
  const seg = p[b + POSE.seg];
  const carry = p[b + POSE.carry];
  const t = sample.t;
  const absent = state === ActorState.Absent;
  const w = pb.world;

  // Somebody who called in sick is parked in the break room as a ghost, rather
  // than standing on the sales floor doing nothing.
  if (absent) actor.group.position.set(w.breakArea[0], 0, -w.breakArea[1]);
  else actor.group.position.set(p[b + POSE.x], 0, -p[b + POSE.y]);
  actor.group.rotation.y = p[b + POSE.h];

  let tint: number;
  if (actor.kind === "worker") tint = roleColor(def?.colorIdx ?? 0);
  else if (actor.kind === "cart") tint = 0x9aa5b1;
  else if (actor.kind === "jack") tint = 0x1c7ed6;
  else if (actor.kind === "van") tint = 0x1c7ed6;
  else if (actor.kind === "boxTruck") tint = 0xd9480f;
  else tint = 0x2f9e44;
  if (actor.baseTint !== tint) pool.setTint(actor, tint);
  pool.setGhost(actor, absent);

  if (actor.carried) {
    const show = actor.kind === "cart" ? state !== ActorState.Idle && state !== ActorState.Off : carry >= 0;
    actor.carried.visible = show;
    if (show) {
      const cdef = carry >= 0 ? pb.entities[carry] : undefined;
      actor.carried.material = pool.materials.lambert(categoryColor(cdef?.colorIdx ?? 0));
    }
  }

  // The late strobe is a function of simulated time, so a paused frame always
  // shows the same lamp.
  const strobeOn = Math.floor(t / 0.25) % 2 === 0;
  if (state === ActorState.Late) {
    pool.setLights(actor, strobeOn);
    pool.setRing(actor, strobeOn ? STATE_COLORS.late : null);
  } else {
    pool.setLights(actor, false);
    pool.setRing(actor, ringFor(state));
  }

  if (actor.bob) actor.bob.position.y = WALK_SEGS.has(seg) ? 0.07 * Math.abs(Math.sin(t * BOB_RATE)) : 0;

  if (def && (actor.kind === "worker" || actor.kind === "van" || actor.kind === "truck" || actor.kind === "boxTruck")) {
    const worker = actor.kind === "worker";
    scene.labels.push({
      entity: actor.entity,
      text: def.label,
      kind: worker ? "staff" : "vehicle",
      x: actor.group.position.x,
      y: -actor.group.position.z,
      z: worker ? PERSON_LABEL_Z : 12,
      priority: worker ? 1 : 2,
      // A vehicle stands at a wall or in the lot and keeps its pill; a member
      // of staff deep inside is hidden by the walls from a low camera outside.
      occludable: worker,
    });
  }
}

/** A shopper's colour: their basket kind, pushed toward the state they are in. */
function shopperTint(target: Color, colorIdx: number, state: number): Color {
  target.setHex(shopperColor(colorIdx));
  if (state === ActorState.Queue) return target.lerp(_c2.setHex(STATE_COLORS.queue), 0.55);
  if (state === ActorState.Serve || state === ActorState.Ring) return target.lerp(_c2.setHex(STATE_COLORS.serving), 0.5);
  if (state === ActorState.Leave) return target.lerp(_c2.setHex(STATE_COLORS.abandoned), 0.35);
  return target;
}

/**
 * Apply one sample. `reset` says the cursor jumped rather than stepped — a
 * `PlaybackCursor.seek` reports an empty dirty range whether it moved an hour
 * or not at all, and a backward step reports rows whose values are the ones on
 * the far side of them, so the caller, which knows which it did, has to say.
 * On a reset every timeline is re-read at t; otherwise only the rows the
 * cursor crossed are applied.
 */
export function applyFrame(scene: StoreScene, sample: CursorSample, playback: Playback, reset = false): void {
  if (playback !== scene.playback) throw new Error("applyFrame: the sample's playback is not the one the scene was bound to.");
  const t = sample.t;
  if (reset || scene.lastT < 0) rereadAll(scene, t);
  else applyDirty(scene, sample.dirtyFrom, sample.dirtyTo);

  scene.labels = [];
  const pool = scene.refs.actors;
  const { shoppers, cars } = scene.refs;
  const w = playback.world;
  // How near the customer entrance anybody is this frame, so the doors open
  // for them; one number per door, reset each frame.
  const entranceNear = w.frames.map(() => Infinity);
  let visible = 0;

  for (let i = 0; i < playback.tracks.length; i++) {
    const tr = playback.tracks[i];
    if (!tr) continue;
    const b = i * POSE_STRIDE;
    const state = sample.poses[b + POSE.s];
    const entity = tr.entity;
    const def = playback.entities[entity];
    if (!def) continue;
    if (state === ActorState.Off) {
      pool.release(entity);
      if (def.kind === "customer") shoppers.release(entity);
      else if (def.kind === "car") cars.release(entity);
      continue;
    }
    const x = sample.poses[b + POSE.x];
    const y = sample.poses[b + POSE.y];
    if (def.kind === "customer") {
      shoppers.place(entity, x, y, 0, sample.poses[b + POSE.h], shopperTint(_c, def.colorIdx, state));
      visible++;
    } else if (def.kind === "car") {
      // Cars take a different slice of the same ramp, so a full lot does not
      // look like the queue at the till.
      cars.place(entity, x, y, 0, sample.poses[b + POSE.h], _c.setHex(shopperColor(def.colorIdx + 2)));
      visible++;
    } else {
      const kind = actorKindOf(def.kind, def.meta);
      if (!kind) continue;
      applyActor(scene, pool.acquire(entity, kind), b, sample);
      visible++;
    }
    if (def.kind === "customer" || def.kind === "worker") {
      for (let fi = 0; fi < w.frames.length; fi++) {
        const f = w.frames[fi];
        if (f.kind !== "entrance") continue;
        entranceNear[fi] = Math.min(entranceNear[fi], Math.hypot(x - f.origin[0], y - f.origin[1]));
      }
    }
  }
  scene.visibleActors = visible;

  for (let fi = 0; fi < w.frames.length; fi++) {
    if (w.frames[fi].kind !== "entrance") continue;
    scene.refs.building.setDoorOpen(fi, entranceNear[fi] < DOOR_TRIGGER_FT ? 1 : 0);
  }

  pulseHot(scene, t);

  // Queue chips: one per service post with anybody waiting, at the head of the
  // line and well above the people standing in it.
  for (let i = 0; i < scene.queueLen.length; i++) {
    const n = scene.queueLen[i];
    const post = w.posts[i];
    if (n <= 0 || !post) continue;
    scene.labels.push({ entity: queueChipEntity(i), text: `${post.id} ${n}`, kind: "queue", x: post.head[0], y: post.head[1], z: 9, priority: 3 });
  }

  // A badge on a facing that has run out with a restock still pending: the
  // shelf a shopper is about to walk away from.
  for (const i of scene.hotFacings) {
    if (scene.facingUnits[i] > 0 || scene.facingSku[i] < 0) continue;
    scene.refs.fixtures.facingWorld(i, _v);
    scene.labels.push({ entity: facingBadgeEntity(i), text: "out", kind: "short", x: _v.x, y: -_v.z, z: _v.y + 0.8, priority: 0 });
  }

  scene.refs.fixtures.commit();
  shoppers.commit();
  cars.commit();
  scene.refs.pallets.commit();
  scene.lastT = t;
}
