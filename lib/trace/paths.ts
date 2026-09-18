/**
 * Routes.
 *
 * Every leg drawn on the floor is axis-aligned, because that is how people
 * move between shelving: down an aisle, along a cross aisle, down the next
 * one. The distances here reproduce the engine's own — `walkDistance`,
 * `sShapeDistance` and `stockDistance` in lib/twin/layout.ts — so what the
 * page shows a worker walking is the walk their job was costed at.
 *
 * Two routes have no engine number at all: the transfer leg from wherever
 * somebody finished their last job to the start of the next one, and the
 * customer's wander around the sales floor. Both are synthesized, and
 * lib/trace/fit.ts decides how they are squeezed into the minutes the engine
 * says a job took.
 */

import type { FixtureRun, StorageRun } from "../layout/spec";
import type { Facing, Layout, StoragePosition } from "../twin/layout";
import type { LaborStandards } from "../twin/types";
import type { DoorFrame, Pt, ServicePost, World } from "./types";

export interface PathStop {
  /** Feet along the path where the stop sits. */
  at: number;
  /** Index of the vertex the stop is on or just past. */
  i: number;
  id?: string;
  /** Minutes spent standing here. */
  minutes: number;
  /** Shelf or level reached for, when there is one. */
  shelf?: number;
}

export interface Path {
  pts: Pt[];
  feet: number;
  stops: PathStop[];
}

export function pathFeet(pts: readonly Pt[]): number {
  let f = 0;
  for (let i = 1; i < pts.length; i++) f += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
  return f;
}

/** Recompute each stop's distance along a path after the points have moved. */
export function refreshStops(path: Path): Path {
  const cum: number[] = [0];
  for (let i = 1; i < path.pts.length; i++) {
    cum.push(cum[i - 1] + Math.abs(path.pts[i][0] - path.pts[i - 1][0]) + Math.abs(path.pts[i][1] - path.pts[i - 1][1]));
  }
  return { ...path, feet: cum[cum.length - 1] ?? 0, stops: path.stops.map((s) => ({ ...s, at: cum[Math.min(s.i, cum.length - 1)] })) };
}

// ---------------------------------------------------------------------------
// Staying out of the shelving
// ---------------------------------------------------------------------------

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function runBox(r: FixtureRun | StorageRun): Box {
  return { x0: r.x - r.depthFt / 2, x1: r.x + r.depthFt / 2, y0: Math.min(r.y0, r.y1), y1: Math.max(r.y0, r.y1) };
}

/** Every fixture and storage footprint, cached per layout. */
const boxCache = new WeakMap<Layout, Box[]>();
function boxesOf(layout: Layout): Box[] {
  let b = boxCache.get(layout);
  if (!b) {
    b = [...layout.spec.fixtures.map(runBox), ...layout.spec.storage.map(runBox)];
    boxCache.set(layout, b);
  }
  return b;
}

/** Does an axis-aligned segment pass through a fixture? */
export function segmentHitsFixture(layout: Layout, a: Pt, b: Pt): boolean {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  const eps = 0.05;
  for (const r of boxesOf(layout)) {
    if (x1 <= r.x0 + eps || x0 >= r.x1 - eps) continue;
    if (y1 <= r.y0 + eps || y0 >= r.y1 - eps) continue;
    return true;
  }
  return false;
}

/**
 * An L or a Z between two points that keeps out of the shelving. Inside one
 * aisle it is a straight run; otherwise it leaves by the nearer cross aisle,
 * crosses, and comes back in. That is the same route `walkDistance` charges
 * for, so the drawn feet match the costed feet.
 */
export function walkRoute(layout: Layout, world: World, a: Pt, b: Pt): Pt[] {
  if (Math.abs(a[0] - b[0]) < 0.4) return [a, b];
  if (Math.abs(a[1] - b[1]) < 0.4 && !segmentHitsFixture(layout, a, b)) return [a, b];

  const backroom = a[1] > layout.spec.backroomY && b[1] > layout.spec.backroomY;
  const candidates = backroom
    ? [world.corridors.backroomFront, world.corridors.apron]
    : [world.corridors.front, world.corridors.back, world.corridors.backroomFront];

  let best: Pt[] | null = null;
  let bestFeet = Infinity;
  for (const cy of candidates) {
    const route: Pt[] = [a, [a[0], cy], [b[0], cy], b];
    if (route.some((p, i) => i > 0 && segmentHitsFixture(layout, route[i - 1], p))) continue;
    const f = pathFeet(route);
    if (f < bestFeet) {
      bestFeet = f;
      best = route;
    }
  }
  if (best) return best;

  // Nothing clean: go around the front of the building, which is always open.
  const cy = Math.max(1.5, Math.min(a[1], b[1], world.corridors.front));
  return [a, [a[0], cy], [b[0], cy], b];
}

function chain(layout: Layout, world: World, pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const leg = walkRoute(layout, world, out[out.length - 1], pts[i]);
    for (let k = 1; k < leg.length; k++) out.push(leg[k]);
  }
  // Drop repeats so the cursor's keyframe times stay strictly increasing.
  return out.filter((p, i) => i === 0 || Math.abs(p[0] - out[i - 1][0]) > 1e-6 || Math.abs(p[1] - out[i - 1][1]) > 1e-6);
}

function stopsFor(pts: Pt[], marks: Array<{ pt: Pt; id?: string; minutes: number; shelf?: number }>): PathStop[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]));
  return marks.map((m) => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i][0] - m.pt[0]) + Math.abs(pts[i][1] - m.pt[1]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return { at: cum[bi], i: bi, id: m.id, minutes: m.minutes, shelf: m.shelf };
  });
}

// ---------------------------------------------------------------------------
// The routes themselves
// ---------------------------------------------------------------------------

const pt = (p: { x: number; y: number }): Pt => [p.x, p.y];

/** A shopper's wander: in the door, past each facing they want, then the till. */
export function shopPath(layout: Layout, world: World, stops: Array<{ facing: Facing; minutes: number }>, end: Pt): Path {
  const marks = stops.map((s) => ({ pt: pt(s.facing), id: s.facing.id, minutes: s.minutes, shelf: s.facing.shelf }));
  const pts = chain(layout, world, [world.entry, ...marks.map((m) => m.pt), end]);
  return { pts, feet: pathFeet(pts), stops: stopsFor(pts, marks) };
}

/** A stocker's trip: out of the stockroom, round the facings, back for the cart. */
export function restockPath(layout: Layout, world: World, facings: Array<{ facing: Facing; minutes: number }>): Path {
  const marks = facings.map((f) => ({ pt: pt(f.facing), id: f.facing.id, minutes: f.minutes, shelf: f.facing.shelf }));
  const pts = chain(layout, world, [world.stockDoor, ...marks.map((m) => m.pt), world.stockDoor]);
  return { pts, feet: pathFeet(pts), stops: stopsFor(pts, marks) };
}

/**
 * An order pick: out of the stockroom, down every aisle that holds a line in
 * S-shape order, back to the bench. The aisles are walked end to end in
 * alternating directions, which is what `sShapeDistance` costs.
 */
export function pickPath(layout: Layout, world: World, lines: Array<{ facing: Facing; minutes: number }>, std: LaborStandards): Path {
  void std;
  const byAisle = new Map<number, Array<{ facing: Facing; minutes: number }>>();
  const loose: Array<{ facing: Facing; minutes: number }> = [];
  for (const l of lines) {
    if (l.facing.aisle < 0) {
      loose.push(l);
      continue;
    }
    const list = byAisle.get(l.facing.aisle);
    if (list) list.push(l);
    else byAisle.set(l.facing.aisle, [l]);
  }
  const ordered: Array<{ facing: Facing; minutes: number }> = [];
  const aisles = [...byAisle.keys()].sort((a, b) => a - b);
  aisles.forEach((a, i) => {
    const list = byAisle.get(a)!.slice().sort((x, y) => (i % 2 === 0 ? x.facing.y - y.facing.y : y.facing.y - x.facing.y));
    ordered.push(...list);
  });
  ordered.push(...loose.sort((a, b) => a.facing.x - b.facing.x));

  const marks = ordered.map((l) => ({ pt: pt(l.facing), id: l.facing.id, minutes: l.minutes, shelf: l.facing.shelf }));
  const pts = chain(layout, world, [world.bench, ...marks.map((m) => m.pt), world.bench]);
  return { pts, feet: pathFeet(pts), stops: stopsFor(pts, marks) };
}

/** A pallet from the goods door to its stockroom positions and back. */
export function putawayPath(layout: Layout, world: World, door: Pt, positions: Array<{ pos: StoragePosition; minutes: number }>): Path {
  const marks = positions.map((p) => ({ pt: pt(p.pos), id: p.pos.id, minutes: p.minutes, shelf: p.pos.level }));
  const pts = chain(layout, world, [door, ...marks.map((m) => m.pt), door]);
  return { pts, feet: pathFeet(pts), stops: stopsFor(pts, marks) };
}

/** Wherever somebody was, to wherever they are needed next. */
export function transferPath(layout: Layout, world: World, from: Pt, to: Pt): Path {
  const pts = chain(layout, world, [from, to]);
  return { pts, feet: pathFeet(pts), stops: [] };
}

/** Standing in a line: the walk from joining it to the place you end up. */
export function queuePath(post: ServicePost, fromSlot: number, toSlot: number): Path {
  const at = (i: number) => (i <= 0 ? post.head : post.queue[Math.min(i - 1, post.queue.length - 1)]);
  const pts: Pt[] = [at(fromSlot), at(toSlot)];
  return { pts, feet: pathFeet(pts), stops: [] };
}

export interface LotPath extends Path {
  /** Index of the vertex where the car reaches the drive lane. */
  driveVertex: number;
}

/**
 * How far before a corner a vehicle starts turning into it.
 *
 * The playback sampler interpolates heading between keyframes, so a corner
 * with one vertex spreads its turn across the whole leg leading up to it: a
 * car driving a hundred and fifty feet of straight lane would rotate ninety
 * degrees as it went and arrive crabbing sideways across the stripes. Putting
 * a second vertex a few feet short of the corner pins the heading for the run
 * in and leaves the turn where the turn is. Only vehicles need it; a person
 * rounding a gondola end really does turn the whole way.
 */
const TURN_FT = 7;

/** A point `TURN_FT` back from `corner` along the leg arriving from `from`. */
function approach(from: Pt, corner: Pt): Pt {
  const dx = corner[0] - from[0];
  const dy = corner[1] - from[1];
  const len = Math.abs(dx) + Math.abs(dy);
  if (len <= TURN_FT * 2) return corner;
  const u = (len - TURN_FT) / len;
  return [from[0] + dx * u, from[1] + dy * u];
}

/** A car coming in off the road, into a stall, and its driver to the door. */
export function arrivePath(world: World, stall: Pt, fromLeft: boolean): LotPath {
  const spawn = fromLeft ? world.lot.spawnLeft : world.lot.spawnRight;
  const corner: Pt = [stall[0], world.lot.driveY];
  const pts: Pt[] = dedupe([spawn, approach(spawn, corner), corner, stall]);
  return { pts, feet: pathFeet(pts), stops: [], driveVertex: pts.length - 2 };
}

export function leavePath(world: World, stall: Pt, toRight: boolean): LotPath {
  const spawn = toRight ? world.lot.spawnRight : world.lot.spawnLeft;
  const corner: Pt = [stall[0], world.lot.driveY];
  const pts: Pt[] = dedupe([stall, approach(stall, corner), corner, spawn]);
  return { pts, feet: pathFeet(pts), stops: [], driveVertex: 1 };
}

function dedupe(pts: Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) > 1e-6 || Math.abs(p[1] - pts[i - 1][1]) > 1e-6);
}

/** A shopper on foot between their car and the shop door. */
export function walkInPath(world: World, stall: Pt): Path {
  const pts: Pt[] = [stall, [stall[0], -2], [world.entry[0], -2], world.entry];
  return { pts, feet: pathFeet(pts), stops: [] };
}

export interface ServiceDrivePath extends Path {
  roadVertex: number;
  queueVertex: number;
}

/** A trailer off the service road, optionally via a waiting spot, onto a door. */
export function dockPath(world: World, frame: DoorFrame, fromLeft: boolean, queueSpot: number): ServiceDrivePath {
  const spawn = fromLeft ? world.service.spawnLeft : world.service.spawnRight;
  const road: Pt = [frame.origin[0], world.service.roadY];
  const pts: Pt[] = dedupe([spawn, approach(spawn, road), road]);
  const roadVertex = pts.length - 1;
  let queueVertex = -1;
  if (queueSpot >= 0) {
    const spots = world.service.queue[frame.index] ?? [];
    const spot = spots[Math.min(queueSpot, spots.length - 1)];
    if (spot) {
      pts.push(spot);
      queueVertex = pts.length - 1;
    }
  }
  pts.push([frame.origin[0], frame.origin[1] + 6]);
  pts.push([frame.origin[0], frame.origin[1]]);
  return { pts, feet: pathFeet(pts), stops: [], roadVertex, queueVertex };
}

export function undockPath(world: World, frame: DoorFrame, toRight: boolean): ServiceDrivePath {
  const spawn = toRight ? world.service.spawnRight : world.service.spawnLeft;
  const pts: Pt[] = [[frame.origin[0], frame.origin[1]], [frame.origin[0], world.service.roadY], spawn];
  return { pts, feet: pathFeet(pts), stops: [], roadVertex: 1, queueVertex: -1 };
}

/** The delivery van leaving on its round and coming back. */
export function vanRoundPath(world: World, bay: Pt, toRight: boolean): Path {
  const out = toRight ? world.lot.spawnRight : world.lot.spawnLeft;
  const pts: Pt[] = [bay, [bay[0], world.lot.driveY], out];
  return { pts, feet: pathFeet(pts), stops: [] };
}

/** Handling minutes a single shelf reach costs, for fitting an animation. */
export function reachMinutes(std: LaborStandards, f: Facing, units: number): number {
  const tray = f.kind === "showcase" || f.kind === "bulk";
  return (tray ? std.restockPerTray : std.restockPerCase) * 0.25 + units * std.pickPerUnit;
}
