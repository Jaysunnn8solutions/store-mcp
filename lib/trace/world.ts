/**
 * Everything the engine has no number for.
 *
 * The simulation knows that a customer queued four minutes at a register and
 * that a trailer waited eleven for a dock. It does not know where the line
 * stands, which stall the car took, how high the third shelf of a gondola is,
 * or where the van waits between rounds. None of that changes a result, so it
 * is built here, once per layout, as a pure function of the geometry — which
 * is what lets the same seed play back the same way every time.
 *
 * Frame: feet, x across the store, y from the storefront (y = 0) toward the
 * back wall. The customer lot is at y < 0 and the service drive behind the
 * building is at y > depthFt.
 */

import type { FixtureKind } from "../layout/spec";
import type { Layout } from "../twin/layout";
import { SKILLS, type Skill } from "../twin/types";
import type { DoorFrame, Lane, Pt, ServicePost, Stall, World, WorkerInfo } from "./types";
import { LANE_SLOTS } from "./types";

/** Overall height of each fixture family, feet. */
export const FIXTURE_HEIGHT: Record<FixtureKind, number> = {
  gondola: 6,
  wall: 7,
  endcap: 6,
  bulk: 6.5,
  showcase: 3.6,
  impulse: 4,
  seasonal: 3,
};

/** Height of one stockroom level, by kind. */
export const STORAGE_LEVEL_FT = { rack: 5, shelving: 1.6 } as const;

/** Toe kick under the bottom shelf. */
const TOE_KICK_FT = 0.5;

/** Stall geometry, feet. */
const STALL_W = 9;
const STALL_D = 18;
/** The drive lane between the storefront walk and the first row of stalls. */
const DRIVE_FT = 24;
/** Pedestrian walk across the front of the shop. */
const WALK_FT = 8;

/** Where a waiting trailer stands on the service drive. */
const SERVICE_ROAD_FT = 55;
const QUEUE_FIRST_FT = 34;
const QUEUE_PITCH_FT = 62;
const QUEUE_SPOTS = 2;
const SPAWN_MARGIN_FT = 90;

/** Spacing of people standing in a line. */
const QUEUE_PITCH = 3;
const QUEUE_DEPTH = 12;

function norm(v: Pt): Pt {
  const m = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / m, v[1] / m];
}

/** Where a person or a truck stands just outside a door. */
export function thresholdPoint(frame: DoorFrame): Pt {
  return [frame.origin[0] + frame.inward[0] * 3, frame.origin[1] + frame.inward[1] * 3];
}

/** Where a trailer's rear sits when it is backed onto a door. */
export function trailerPose(frame: DoorFrame): { pt: Pt; heading: number } {
  return { pt: [frame.origin[0], frame.origin[1]], heading: Math.atan2(-frame.inward[1], -frame.inward[0]) };
}

/** The point on the service drive in front of a goods door. */
export function roadPoint(world: World, frame: DoorFrame): Pt {
  return [frame.origin[0], world.service.roadY];
}

export function parkSpot(world: World, kind: "cart" | "jack", i: number): Pt {
  const list = kind === "cart" ? world.cartPark : world.jackPark;
  return list.length > 0 ? list[i % list.length] : world.stockDoor;
}

// ---------------------------------------------------------------------------

function buildFrames(layout: Layout): DoorFrame[] {
  const D = layout.spec.depthFt;
  return layout.doors.map((d, index) => {
    const entrance = d.kind === "entrance";
    // An entrance is on the storefront and faces into the shop; a goods door is
    // on the back wall and faces the other way.
    const inward: Pt = entrance ? [0, 1] : [0, -1];
    return {
      door: d.id,
      kind: d.kind,
      index,
      origin: [d.x, entrance ? 0 : D] as Pt,
      inward,
      tangent: [1, 0] as Pt,
      widthFt: d.widthFt,
    };
  });
}

function buildLanes(frames: DoorFrame[]): Lane[] {
  return frames
    .filter((f) => f.kind !== "entrance")
    .map((f) => {
      const slots: Pt[] = [];
      // Two columns of four, eight feet inside the door at a five-foot pitch.
      for (let r = 0; r < LANE_SLOTS / 2; r++) {
        for (const side of [-1, 1]) {
          const along = 8 + r * 5;
          slots.push([f.origin[0] + f.tangent[0] * side * 3 + f.inward[0] * along, f.origin[1] + f.tangent[1] * side * 3 + f.inward[1] * along]);
        }
      }
      return { door: f.door, slots };
    });
}

function buildPosts(layout: Layout): ServicePost[] {
  const W = layout.spec.widthFt;
  return layout.service.map((s) => {
    // Customers stand on the side of the counter that looks into the shop.
    const toward = s.x > W / 2 ? -1 : 1;
    const head: Pt = [s.x + toward * 3.5, s.y];
    // A register's line backs toward the storefront; a counter's runs along
    // the glass, deeper into the shop, because that is where the floor is.
    const back: Pt = s.kind === "register" ? [0, -1] : [0, 1];
    const queue: Pt[] = [];
    for (let i = 1; i <= QUEUE_DEPTH; i++) {
      queue.push([head[0] + back[0] * QUEUE_PITCH * i, head[1] + back[1] * QUEUE_PITCH * i]);
    }
    return { id: s.id, kind: s.kind, worker: [s.x + -toward * 2, s.y] as Pt, head, queue, facing: s.facing };
  });
}

function buildLot(layout: Layout): World["lot"] {
  const W = layout.spec.widthFt;
  const p = layout.spec.parking;
  const entranceX = layout.entry.x;
  const driveY = -(WALK_FT + DRIVE_FT / 2);

  const wanted = p.stalls + p.accessibleStalls + p.curbsideStalls;
  const cols = Math.max(1, Math.floor(W / STALL_W));
  const rowY: number[] = [];
  // Rows march away from the shop, each with its own drive aisle behind it.
  for (let y = WALK_FT + DRIVE_FT + STALL_D; y <= p.depthFt + STALL_D; y += STALL_D + DRIVE_FT) rowY.push(-y);

  const spots: Array<{ pt: Pt; d: number }> = [];
  for (const y of rowY) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * STALL_W;
      spots.push({ pt: [x, y + STALL_D / 2], d: Math.abs(x - entranceX) + Math.abs(y) });
    }
  }
  // Nearest the door first, so the curbside and accessible bays land there.
  spots.sort((a, b) => a.d - b.d || a.pt[0] - b.pt[0]);

  const stalls: Stall[] = [];
  for (let i = 0; i < Math.min(wanted, spots.length); i++) {
    const kind: Stall["kind"] = i < p.curbsideStalls ? "curbside" : i < p.curbsideStalls + p.accessibleStalls ? "accessible" : "standard";
    stalls.push({ index: i, pt: spots[i].pt, kind, heading: Math.PI / 2 });
  }

  // The van stands by the kerb at the far end from the entrance.
  const vanBays: Pt[] = [
    [Math.min(W - 6, entranceX + 24), -(WALK_FT / 2)],
    [Math.max(6, entranceX - 24), -(WALK_FT / 2)],
  ];

  return {
    driveY,
    stalls,
    vanBays,
    spawnLeft: [-SPAWN_MARGIN_FT, driveY],
    spawnRight: [W + SPAWN_MARGIN_FT, driveY],
  };
}

function buildService(layout: Layout, frames: DoorFrame[]): World["service"] {
  const W = layout.spec.widthFt;
  const D = layout.spec.depthFt;
  const roadY = D + SERVICE_ROAD_FT;
  const queue: Record<number, Pt[]> = {};
  for (const f of frames) {
    if (f.kind === "entrance") continue;
    queue[f.index] = Array.from({ length: QUEUE_SPOTS }, (_, i) => [f.origin[0], D + QUEUE_FIRST_FT + QUEUE_PITCH_FT * (i + 1)] as Pt);
  }
  return { roadY, queue, spawnLeft: [-SPAWN_MARGIN_FT, roadY], spawnRight: [W + SPAWN_MARGIN_FT, roadY] };
}

export function buildWorld(layout: Layout, workers: WorkerInfo[]): World {
  const W = layout.spec.widthFt;
  const D = layout.spec.depthFt;
  const frames = buildFrames(layout);
  const lanes = buildLanes(frames);
  const posts = buildPosts(layout);
  const lot = buildLot(layout);
  const service = buildService(layout, frames);

  const shelfHeights: Record<string, number[]> = {};
  for (const run of layout.spec.fixtures) {
    const total = FIXTURE_HEIGHT[run.kind] ?? 6;
    const usable = Math.max(0.5, total - TOE_KICK_FT);
    const pitch = usable / run.shelves;
    shelfHeights[run.id] = Array.from({ length: run.shelves }, (_, i) => TOE_KICK_FT + i * pitch);
  }
  for (const run of layout.spec.storage) {
    const pitch = STORAGE_LEVEL_FT[run.kind];
    shelfHeights[run.id] = Array.from({ length: run.levels }, (_, i) => i * pitch);
  }

  const apron = Math.max(layout.spec.backroomY + 2, D - 10);
  const cartPark: Pt[] = Array.from({ length: 4 }, (_, i) => [Math.max(3, layout.stockDoor.x - 6 + i * 3), layout.spec.backroomY + 4] as Pt);
  const jackPark: Pt[] = Array.from({ length: 3 }, (_, i) => [Math.min(W - 3, layout.staging.x + 8 + i * 4), apron] as Pt);

  const entranceFrame = frames.find((f) => f.kind === "entrance");
  const goodsFrame = frames.find((f) => f.kind !== "entrance");
  const registerPost = posts.find((p) => p.kind === "register");
  const counterPost = posts.find((p) => p.kind === "counter");
  const wrapPost = posts.find((p) => p.kind === "wrap");

  // Where somebody with nothing to do stands. A cashier waits at the till, a
  // stocker by the stockroom door, a receiver on the apron.
  const homes = {} as Record<Skill, Pt>;
  for (const k of SKILLS) {
    homes[k] =
      k === "register"
        ? (registerPost?.worker ?? [layout.entry.x, layout.entry.y])
        : k === "counter"
          ? (counterPost?.worker ?? wrapPost?.worker ?? [layout.entry.x, layout.entry.y])
          : k === "stock"
            ? [layout.stockDoor.x, layout.stockDoor.y - 4]
            : k === "pick"
              ? [layout.bench.x, layout.bench.y]
              : k === "drive"
                ? lot.vanBays[0]
                : goodsFrame
                  ? thresholdPoint(goodsFrame)
                  : [layout.staging.x, layout.staging.y];
  }
  void entranceFrame;
  void workers;

  return {
    bbox: { w: W, d: D },
    frames,
    lanes,
    posts,
    entry: [layout.entry.x, layout.entry.y],
    bench: [layout.bench.x, layout.bench.y],
    cartPark,
    jackPark,
    stockDoor: [layout.stockDoor.x, layout.stockDoor.y],
    breakArea: [Math.max(4, W - 12), Math.min(D - 4, apron - 6)],
    lot,
    service,
    corridors: {
      front: Math.max(layout.salesFrontY - 3, layout.salesFrontY / 2),
      back: layout.salesBackY + 3,
      backroomFront: layout.spec.backroomY + 3,
      apron,
    },
    shelfHeights,
    homes,
  };
}

/** Unit direction from a to b, for headings. */
export function heading(a: Pt, b: Pt): number {
  const d = norm([b[0] - a[0], b[1] - a[1]]);
  return Math.atan2(d[1], d[0]);
}
