/**
 * The shop's shell: the floors room by room, the walls, the glazed storefront
 * with its awning and fascia, the doors — customer, dock and roll-up, each
 * with its own hardware and each able to open — the ceiling fittings, the
 * receiving apron and the service drive out the back.
 *
 * Three things here are different from the reference warehouse, and all three
 * matter to whether the model reads as a shop.
 *
 * **The front wall is glass.** A shopfront is the whole point of a shopfront:
 * from the lot you see the seasonal tables, the aisles and the queue at the
 * till. So the storefront is a bulkhead, a run of glazing to eleven feet with
 * mullions, then a fascia band carrying the store name — not a wall with a
 * hole in it.
 *
 * **Rooms are not one room.** A store has a sales floor, a checkout zone, a
 * staff corridor behind the counter, a stockroom and a receiving apron, and
 * they read differently: tile at the front, sealed concrete at the back, the
 * ten-foot grid only where a pallet jack goes. The ceiling follows: troffers
 * on a close grid at twelve feet over the sales floor, strips at sixteen over
 * the stockroom, pendants over the showcase. They light as three separate
 * zones, because at seven in the morning the back of the shop is working and
 * the front of it is dark, and that is exactly what the twin exists to show.
 *
 * **Doors open.** `setDoorOpen` slides the storefront's leaves apart and lifts
 * the roll-up's curtain, driven from the same timeline as the door lamps.
 *
 * Pure Object3D graphs: no renderer, no DOM except the door-plate canvas,
 * which returns null under Node and leaves the plates blank.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
} from "three";
import type { DoorSpec, LayoutSpec, Point } from "../layout/spec";
import type { DoorFrame, Pt, World } from "../trace/types";
import type { PickResult } from "./api";
import { BoxBatch, LineBatch, ResourceTracker, VEHICLE_SIZE } from "./geometry";
import type { LightZones } from "./lighting";
import { darken, DOOR_COLORS, STATE_COLORS, SURFACES, type ThemeName } from "./palette";

export const WALL_HEIGHT = 18;
export const WALL_THICKNESS = 0.8;
/** Head heights by door kind: a shop door, a dock door, a roll-up. */
export const DOOR_HEIGHT = { entrance: 8, dock: 10, ground: 12 } as const;
/** The storefront glazing runs from a low bulkhead to here. */
export const GLASS_BOTTOM = 1;
export const GLASS_TOP = 11;
/** The fascia band above the glass, where the store's name goes. */
export const FASCIA_BOTTOM = GLASS_TOP;
export const FASCIA_TOP = 16;
/** Ceiling heights: a dropped grid over the sales floor, open structure at the back. */
export const CEILING_SALES = 12;
export const CEILING_BACK = 16;
/** Height of a door's number plate above the floor. */
export const PLATE_HEIGHT = 13.5;
export const PLATE_W = 6;
export const PLATE_H = 2.4;

export type DoorState = "free" | "busy" | "outage";

export interface BuildingOptions {
  tracker: ResourceTracker;
  theme: ThemeName;
}

export interface Building {
  group: Group;
  /** The sales-floor slab, which doubles as the ray target for floor picks. */
  floor: Mesh;
  /** One pad per door, in spec.doors order; the pick target and the state colour. */
  doorPads: Mesh[];
  doorLamps: Mesh[];
  setDoor(index: number, state: DoorState): void;
  /** 0 shut, 1 fully open: the storefront's leaves slide, a roll-up's curtain lifts. */
  setDoorOpen(index: number, fraction: number): void;
  /** Which lighting zones are lit, and the exterior light level 0 (night) .. 1 (day). */
  setLight(zones: LightZones, daylight: number): void;
  setTheme(theme: ThemeName): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Painted floor bands: thin boxes just above the slab, so they scale with distance unlike one-pixel lines. */
const PAINT_Y = 0.035;
const PAINT_T = 0.02;

function outlineRing(spec: LayoutSpec): Point[] {
  if (spec.outline.length >= 3) return spec.outline;
  return [
    [0, 0],
    [spec.widthFt, 0],
    [spec.widthFt, spec.depthFt],
    [0, spec.depthFt],
  ];
}

function shapeGeometry(ring: Point[], height: number): ShapeGeometry {
  const shape = new Shape(ring.map(([x, y]) => new Vector2(x, y)));
  return new ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, height, 0);
}

function frameAngle(f: DoorFrame): number {
  return Math.atan2(f.tangent[1], f.tangent[0]);
}

/** Is this outline edge the storefront — the one the customer doors are in? */
function isStorefront(a: Point, b: Point): boolean {
  return Math.abs(a[1]) < 0.5 && Math.abs(b[1]) < 0.5;
}

interface Span {
  s0: number;
  s1: number;
  height: number;
}

/**
 * Outline walls as boxes along each edge, split at the doors on that edge with
 * a header over every opening, so a wall still reads as one surface. The
 * storefront edge is skipped: it is built as glazing instead.
 */
function outlineWalls(spec: LayoutSpec, frames: readonly DoorFrame[]): BoxBatch {
  const batch = new BoxBatch();
  const ring = outlineRing(spec);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (isStorefront(a, b)) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.1) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const angle = Math.atan2(uy, ux);
    const spans: Span[] = [];
    for (const f of frames) {
      const px = f.origin[0] - a[0];
      const py = f.origin[1] - a[1];
      const s = px * ux + py * uy;
      const dist = Math.abs(px * uy - py * ux);
      if (s < -0.5 || s > len + 0.5 || dist > 1.5) continue;
      spans.push({ s0: Math.max(0, s - f.widthFt / 2), s1: Math.min(len, s + f.widthFt / 2), height: DOOR_HEIGHT[f.kind] });
    }
    spans.sort((p, q) => p.s0 - q.s0);
    const piece = (s0: number, s1: number, y0: number, y1: number) => {
      const L = s1 - s0;
      if (L < 0.1 || y1 - y0 < 0.1) return;
      const mid = s0 + L / 2;
      batch.add(L, y1 - y0, WALL_THICKNESS, a[0] + ux * mid, (y0 + y1) / 2, -(a[1] + uy * mid), angle);
    };
    let cursor = 0;
    for (const sp of spans) {
      if (sp.s0 < cursor) continue;
      piece(cursor, sp.s0, 0, WALL_HEIGHT);
      piece(sp.s0, sp.s1, sp.height, WALL_HEIGHT);
      cursor = sp.s1;
    }
    piece(cursor, len, 0, WALL_HEIGHT);
  }
  return batch;
}

// ---------------------------------------------------------------------------
// Door number plates: one quad per door face, lettered from a canvas atlas
// ---------------------------------------------------------------------------

const ATLAS_COLS = 8;
const CELL_W = 160;
/** The same aspect as the plate, so the lettering is not stretched. */
const CELL_H = 64;

/** Draws every label into one canvas; null under Node, where the plates are simply blank. */
function plateAtlas(labels: string[], theme: ThemeName): CanvasTexture | null {
  if (labels.length === 0 || typeof document === "undefined") return null;
  const rows = Math.ceil(labels.length / ATLAS_COLS);
  if (rows * CELL_H > 4096) return null;
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_COLS * CELL_W;
  canvas.height = rows * CELL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const s = SURFACES[theme];
  ctx.fillStyle = `#${s.plate.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 30px system-ui, Segoe UI, Arial, sans-serif";
  labels.forEach((label, i) => {
    const x = (i % ATLAS_COLS) * CELL_W;
    const y = Math.floor(i / ATLAS_COLS) * CELL_H;
    ctx.strokeStyle = s.plateText;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 3, y + 3, CELL_W - 6, CELL_H - 6);
    ctx.fillStyle = s.plateText;
    ctx.fillText(label, x + CELL_W / 2, y + CELL_H / 2 + 1, CELL_W - 16);
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Quads with position, normal and uv for every door: the outside face of the wall and the inside face. */
function plateGeometry(frames: readonly DoorFrame[], atlasRows: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (cx: number, cy: number, cz: number, rx: number, rz: number, nx: number, nz: number, cell: number) => {
    const base = pos.length / 3;
    const hw = PLATE_W / 2;
    const hh = PLATE_H / 2;
    const col = cell % ATLAS_COLS;
    const row = Math.floor(cell / ATLAS_COLS);
    const u0 = col / ATLAS_COLS;
    const u1 = (col + 1) / ATLAS_COLS;
    const v1 = 1 - row / Math.max(1, atlasRows);
    const v0 = 1 - (row + 1) / Math.max(1, atlasRows);
    const corners: Array<[number, number, number, number]> = [
      [-hw, -hh, u0, v0],
      [hw, -hh, u1, v0],
      [hw, hh, u1, v1],
      [-hw, hh, u0, v1],
    ];
    for (const [a, b, u, v] of corners) {
      pos.push(cx + rx * a, cy + b, cz + rz * a);
      nrm.push(nx, 0, nz);
      uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  frames.forEach((f, i) => {
    const off = WALL_THICKNESS / 2 + 0.06;
    // Outside: the viewer looks along +inward, screen right is the tangent. Inside: the opposite.
    const ox = f.origin[0] - f.inward[0] * off;
    const oy = f.origin[1] - f.inward[1] * off;
    quad(ox, PLATE_HEIGHT, -oy, f.tangent[0], -f.tangent[1], -f.inward[0], f.inward[1], i);
    const ix = f.origin[0] + f.inward[0] * off;
    const iy = f.origin[1] + f.inward[1] * off;
    quad(ix, PLATE_HEIGHT, -iy, -f.tangent[0], f.tangent[1], f.inward[0], -f.inward[1], i);
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------

function doorPick(door: DoorSpec, index: number): PickResult {
  const what = door.kind === "entrance" ? "customer entrance" : door.kind === "dock" ? "raised dock" : "ground-level roll-up";
  return { kind: "door", index, id: door.id, label: `${door.id} — ${what}` };
}

export function buildBuilding(spec: LayoutSpec, world: World, opts: BuildingOptions): Building {
  const { tracker } = opts;
  let themeName = opts.theme;
  const S = () => SURFACES[themeName];
  const group = new Group();
  group.name = "building";
  const W = spec.widthFt;
  const D = spec.depthFt;
  const backY = spec.backroomY;

  // Every material that follows the theme is registered here, so setTheme is
  // one loop rather than a list of assignments that drifts out of date.
  const themed: Array<[Material & { color: Color }, (s: typeof SURFACES.light) => number]> = [];
  const lambert = (pick: (s: typeof SURFACES.light) => number, extra: ConstructorParameters<typeof MeshLambertMaterial>[0] = {}) => {
    const m = tracker.material(new MeshLambertMaterial({ color: pick(S()), ...extra }));
    themed.push([m, pick]);
    return m;
  };
  const basic = (pick: (s: typeof SURFACES.light) => number, extra: ConstructorParameters<typeof MeshBasicMaterial>[0] = {}) => {
    const m = tracker.material(new MeshBasicMaterial({ color: pick(S()), ...extra }));
    themed.push([m, pick]);
    return m;
  };
  const line = (pick: (s: typeof SURFACES.light) => number) => {
    const m = tracker.material(new LineBasicMaterial({ color: pick(S()) }));
    themed.push([m, pick]);
    return m;
  };

  const salesMat = lambert((s) => s.salesFloor);
  const backMat = lambert((s) => s.backroomFloor);
  const apronMat = lambert((s) => s.apron);
  const queueMat = lambert((s) => s.queueZone);
  const corridorMat = lambert((s) => s.corridor);
  const wallMat = lambert((s) => s.wall);
  const mullionMat = lambert((s) => s.mullion);
  const fasciaMat = lambert((s) => s.fascia);
  const signMat = basic((s) => s.sign);
  const gridMat = line((s) => s.grid);
  const aisleMat = line((s) => s.aisle);
  const laneMat = line((s) => s.roadMark);
  const paintMat = basic((s) => s.paint);
  const bumperMat = lambert((s) => s.bumper);
  const plateFallbackMat = basic((s) => s.plate);
  // Glass is drawn last and writes no depth, so the sales floor reads through
  // the storefront from the lot instead of being z-fought away.
  const glassMat = tracker.material(new MeshLambertMaterial({ color: S().glass, transparent: true, opacity: 0.3, depthWrite: false }));
  themed.push([glassMat, (s) => s.glass]);
  // Ceiling fittings are translucent for the same reason the reference's were:
  // the camera usually sits above a roofless model and they must read as
  // fittings rather than as bars across the shelves.
  const stripOpts = { transparent: true, opacity: 0.55, depthWrite: false, emissive: 0x000000 } as const;
  const salesStripMat = lambert((s) => s.ceilingStrip, stripOpts);
  const backStripMat = lambert((s) => s.ceilingStrip, stripOpts);
  const pendantMat = lambert((s) => s.ceilingStrip, stripOpts);

  const doorMats: Record<DoorSpec["kind"], MeshLambertMaterial> = {
    entrance: tracker.material(new MeshLambertMaterial({ color: DOOR_COLORS.entrance })),
    dock: tracker.material(new MeshLambertMaterial({ color: DOOR_COLORS.dock })),
    ground: tracker.material(new MeshLambertMaterial({ color: DOOR_COLORS.ground })),
  };
  const padMats: Record<DoorSpec["kind"], MeshLambertMaterial> = {
    entrance: tracker.material(new MeshLambertMaterial({ color: darken(DOOR_COLORS.entrance, 0.85) })),
    dock: tracker.material(new MeshLambertMaterial({ color: darken(DOOR_COLORS.dock, 0.85) })),
    ground: tracker.material(new MeshLambertMaterial({ color: darken(DOOR_COLORS.ground, 0.85) })),
  };
  const padOutageMat = tracker.material(new MeshLambertMaterial({ color: STATE_COLORS.outage }));

  // --- Floors -------------------------------------------------------------
  const ring = outlineRing(spec);
  const floor = new Mesh(tracker.geometry(spec.outline.length >= 3 ? shapeGeometry(ring, 0) : new PlaneGeometry(W, D).rotateX(-Math.PI / 2).translate(W / 2, 0, -D / 2)), salesMat);
  floor.name = "floor";
  floor.receiveShadow = true;
  group.add(floor);

  const zoneMat = (kind: string) => (kind === "backroom" ? backMat : kind === "staging" ? apronMat : kind === "queue" ? queueMat : kind === "office" || kind === "other" ? corridorMat : salesMat);
  for (const z of spec.zones) {
    if (z.ring.length < 3 || z.kind === "sales") continue;
    const mesh = new Mesh(tracker.geometry(shapeGeometry(z.ring, z.kind === "staging" ? 0.03 : 0.02)), zoneMat(z.kind));
    mesh.name = `zone:${z.name}`;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // The ten-foot grid only where a pallet jack runs: the stockroom.
  const grid = new LineBatch();
  for (let x = 0; x <= W + 1e-6; x += 10) grid.addEngine(x, backY, x, D, 0.04);
  for (let y = Math.ceil(backY / 10) * 10; y <= D + 1e-6; y += 10) grid.addEngine(0, y, W, y, 0.04);
  const gridLines = new LineSegments(tracker.geometry(grid.build()), gridMat);
  gridLines.name = "grid";
  group.add(gridLines);

  // --- Walls and the storefront ------------------------------------------
  const walls = new Mesh(tracker.geometry(outlineWalls(spec, world.frames).build()), wallMat);
  walls.name = "walls";
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  const interior = spec.walls.filter((w) => w.length >= 2);
  if (interior.length) {
    const batch = new BoxBatch();
    for (const lineRing of interior) {
      for (let i = 0; i + 1 < lineRing.length; i++) {
        const a = lineRing[i];
        const b = lineRing[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.1) continue;
        batch.add(len, WALL_HEIGHT * 0.55, 0.5, (a[0] + b[0]) / 2, (WALL_HEIGHT * 0.55) / 2, -(a[1] + b[1]) / 2, Math.atan2(b[1] - a[1], b[0] - a[0]));
      }
    }
    const inner = new Mesh(tracker.geometry(batch.build()), wallMat);
    inner.name = "innerWalls";
    inner.castShadow = true;
    group.add(inner);
  }

  // The glazed front: a bulkhead, a glass plane between the mullions, the
  // fascia band above it and a sign panel on the fascia.
  const entrances = spec.doors.filter((d) => d.kind === "entrance");
  const frameBatch = new BoxBatch();
  const glassBatch = new BoxBatch();
  {
    const openings = entrances.map((d) => [d.x - d.widthFt / 2, d.x + d.widthFt / 2] as const).sort((a, b) => a[0] - b[0]);
    const bay = (x0: number, x1: number) => {
      if (x1 - x0 < 0.2) return;
      glassBatch.add(x1 - x0, GLASS_TOP - GLASS_BOTTOM, 0.12, (x0 + x1) / 2, (GLASS_BOTTOM + GLASS_TOP) / 2, 0);
      // A mullion every eight feet, which is what a storefront system runs.
      for (let x = x0; x <= x1 + 1e-6; x += 8) frameBatch.add(0.35, GLASS_TOP - GLASS_BOTTOM, 0.42, Math.min(x, x1), (GLASS_BOTTOM + GLASS_TOP) / 2, 0);
      frameBatch.add(x1 - x0, GLASS_BOTTOM, 0.55, (x0 + x1) / 2, GLASS_BOTTOM / 2, 0);
    };
    let cursor = 0;
    for (const [a, b] of openings) {
      bay(cursor, a);
      // A transom over the doorway keeps the glazing line unbroken.
      glassBatch.add(b - a, GLASS_TOP - DOOR_HEIGHT.entrance, 0.12, (a + b) / 2, (DOOR_HEIGHT.entrance + GLASS_TOP) / 2, 0);
      cursor = b;
    }
    bay(cursor, W);
    frameBatch.add(W, 0.4, 0.55, W / 2, GLASS_TOP, 0);
  }
  const storefront = new Mesh(tracker.geometry(frameBatch.build()), mullionMat);
  storefront.name = "storefront";
  storefront.castShadow = true;
  group.add(storefront);
  const glass = new Mesh(tracker.geometry(glassBatch.build()), glassMat);
  glass.name = "glazing";
  glass.renderOrder = 4;
  group.add(glass);

  // Fascia and awning: the band the store's name sits on, and the canopy that
  // shades the walkway.
  const fasciaBatch = new BoxBatch();
  fasciaBatch.add(W + 1.2, FASCIA_TOP - FASCIA_BOTTOM, 1.4, W / 2, (FASCIA_BOTTOM + FASCIA_TOP) / 2, 0.4);
  fasciaBatch.add(W + 1.2, 0.5, 1.6, W / 2, WALL_HEIGHT - 0.25, 0.3);
  fasciaBatch.add(W * 0.7, 0.3, 6, W / 2, GLASS_TOP - 0.6, 3.2);
  const fascia = new Mesh(tracker.geometry(fasciaBatch.build()), fasciaMat);
  fascia.name = "fascia";
  fascia.castShadow = true;
  group.add(fascia);
  const sign = new Mesh(tracker.geometry(new PlaneGeometry(Math.min(W * 0.55, 46), FASCIA_TOP - FASCIA_BOTTOM - 1.6).translate(W / 2, (FASCIA_BOTTOM + FASCIA_TOP) / 2, 1.16)), signMat);
  sign.name = "sign";
  group.add(sign);

  // --- Doors --------------------------------------------------------------
  const doorBatches: Record<DoorSpec["kind"], BoxBatch> = { entrance: new BoxBatch(), dock: new BoxBatch(), ground: new BoxBatch() };
  const bumpers = new BoxBatch();
  const openers: Array<(f: number) => void> = [];
  const doorPads: Mesh[] = [];
  const doorLamps: Mesh[] = [];
  const leafGroup = new Group();
  leafGroup.name = "doorLeaves";
  group.add(leafGroup);

  world.frames.forEach((f, index) => {
    const door = spec.doors[index];
    const angle = frameAngle(f);
    const at = (along: number, across: number, h: number): [number, number, number] => [
      f.origin[0] + f.inward[0] * along + f.tangent[0] * across,
      h,
      -(f.origin[1] + f.inward[1] * along + f.tangent[1] * across),
    ];
    const b = doorBatches[f.kind];
    const head = DOOR_HEIGHT[f.kind];

    if (f.kind === "entrance") {
      // Jambs and a head, then two sliding leaves that part on setDoorOpen.
      for (const side of [-1, 1]) {
        const p = at(0, side * (f.widthFt / 2 + 0.2), head / 2);
        b.add(0.45, head, 0.6, p[0], p[1], p[2], angle);
      }
      const h = at(0, 0, head + 0.25);
      b.add(f.widthFt + 1, 0.5, 0.6, h[0], h[1], h[2], angle);
      // An entrance mat just inside.
      const mat = at(3.5, 0, 0.03);
      b.add(f.widthFt, 0.06, 6, mat[0], mat[1], mat[2], angle);
      const leafGeom = tracker.geometry(new BoxGeometry(f.widthFt / 2 - 0.15, head - 0.3, 0.14));
      const leaves: Mesh[] = [];
      for (const side of [-1, 1]) {
        const leaf = new Mesh(leafGeom, glassMat);
        const p = at(0, (side * f.widthFt) / 4, (head - 0.3) / 2);
        leaf.position.set(p[0], p[1], p[2]);
        leaf.rotation.y = angle;
        leaf.renderOrder = 4;
        leaf.userData.slide = [(f.tangent[0] * side * f.widthFt) / 2, (-f.tangent[1] * side * f.widthFt) / 2];
        leaf.userData.home = [p[0], p[2]];
        leafGroup.add(leaf);
        leaves.push(leaf);
      }
      openers.push((fr) => {
        const k = Math.max(0, Math.min(1, fr)) * 0.92;
        for (const leaf of leaves) {
          const slide = leaf.userData.slide as [number, number];
          const home = leaf.userData.home as [number, number];
          leaf.position.x = home[0] + slide[0] * k;
          leaf.position.z = home[1] + slide[1] * k;
        }
      });
    } else {
      if (f.kind === "dock") {
        // A raised dock: a leveller plate inside the opening, a canopy outside,
        // two rubber bumpers and a zebra hatch painted on the drive.
        let p = at(4, 0, 0.12);
        b.add(Math.max(4, f.widthFt - 2), 0.24, 7, p[0], p[1], p[2], angle);
        for (const side of [-1, 1]) {
          p = at(-0.7, side * (f.widthFt / 2 - 0.7), 1.9);
          bumpers.add(1.0, 1.8, 1.0, p[0], p[1], p[2], angle);
        }
        p = at(-2.2, 0, head + 1.1);
        b.add(f.widthFt + 2, 0.35, 4.4, p[0], p[1], p[2], angle);
      } else {
        // A ground-level roll-up: no leveller, just a thickened threshold the
        // van and the box truck drive up to.
        const p = at(-1.2, 0, 0.06);
        b.add(f.widthFt + 1.5, 0.12, 5, p[0], p[1], p[2], angle);
      }
      // The curtain: a slat panel that lifts into the head.
      const curtainGeom = tracker.geometry(new BoxGeometry(f.widthFt - 0.3, head, 0.16).translate(0, -head / 2, 0));
      const curtain = new Mesh(curtainGeom, doorMats[f.kind]);
      const top = at(0, 0, head);
      curtain.position.set(top[0], top[1], top[2]);
      curtain.rotation.y = angle;
      curtain.castShadow = true;
      leafGroup.add(curtain);
      openers.push((fr) => {
        const k = 1 - Math.max(0, Math.min(1, fr));
        curtain.scale.y = Math.max(0.02, k);
      });
    }

    // One pad and one lamp per door: the pad is the pick target on the floor,
    // the lamp is the state anyone can read from across the site.
    const pad = new Mesh(tracker.geometry(new BoxGeometry(f.widthFt, 0.1, f.kind === "entrance" ? 6 : 8)), padMats[f.kind]);
    const padAt = at(f.kind === "entrance" ? 3.5 : 4, 0, 0.05);
    pad.position.set(padAt[0], padAt[1], padAt[2]);
    pad.rotation.y = angle;
    pad.name = `doorPad:${f.door}`;
    if (door) pad.userData.pick = doorPick(door, index);
    group.add(pad);
    doorPads.push(pad);

    const lamp = new Mesh(tracker.geometry(new BoxGeometry(1.2, 0.6, 0.5)), tracker.material(new MeshBasicMaterial({ color: darken(DOOR_COLORS[f.kind], 0.45) })));
    const lampAt = at(0.8, 0, head + 0.7);
    lamp.position.set(lampAt[0], lampAt[1], lampAt[2]);
    lamp.rotation.y = angle;
    lamp.name = `doorLamp:${f.door}`;
    if (door) lamp.userData.pick = doorPick(door, index);
    group.add(lamp);
    doorLamps.push(lamp);
  });

  for (const kind of ["entrance", "dock", "ground"] as const) {
    const mesh = new Mesh(tracker.geometry(doorBatches[kind].build()), doorMats[kind]);
    mesh.name = `doors:${kind}`;
    mesh.castShadow = true;
    group.add(mesh);
  }
  const bumperMesh = new Mesh(tracker.geometry(bumpers.build()), bumperMat);
  bumperMesh.name = "bumpers";
  group.add(bumperMesh);

  const atlas = plateAtlas(
    world.frames.map((f) => f.door),
    themeName
  );
  if (atlas) tracker.texture(atlas);
  const plateMat = atlas ? tracker.material(new MeshBasicMaterial({ map: atlas })) : plateFallbackMat;
  const doorPlates = new Mesh(tracker.geometry(plateGeometry(world.frames, Math.ceil(world.frames.length / ATLAS_COLS))), plateMat);
  doorPlates.name = "doorPlates";
  group.add(doorPlates);

  // --- Painted markings ---------------------------------------------------
  const paint = new BoxBatch();
  // The receiving apron: a hatched band inside the goods doors that nothing
  // else may stand in.
  const apronY = world.corridors.apron;
  paint.add(W * 0.5, PAINT_T, 0.4, W * 0.72, PAINT_Y, -apronY);
  for (const f of world.frames) {
    if (f.kind === "entrance") continue;
    const angle = frameAngle(f);
    const half = f.widthFt / 2 - 1.5;
    for (let across = -half; across <= half + 1e-6; across += 2.4) {
      const cx = f.origin[0] + f.inward[0] * -4 + f.tangent[0] * across;
      const cy = f.origin[1] + f.inward[1] * -4 + f.tangent[1] * across;
      paint.add(7, PAINT_T, 0.4, cx, PAINT_Y + 0.01, -cy, angle + Math.PI / 4);
    }
  }
  // Where the carts and the jacks live between jobs.
  const stall = (p: Pt, w: number, l: number) => {
    paint.add(w, PAINT_T, 0.3, p[0], PAINT_Y, -(p[1] - l / 2));
    paint.add(w, PAINT_T, 0.3, p[0], PAINT_Y, -(p[1] + l / 2));
    paint.add(0.3, PAINT_T, l, p[0] - w / 2, PAINT_Y, -p[1]);
    paint.add(0.3, PAINT_T, l, p[0] + w / 2, PAINT_Y, -p[1]);
  };
  for (const p of world.cartPark) stall(p, 2.6, 4.2);
  for (const p of world.jackPark) stall(p, 3.2, 5.4);
  const paintMesh = new Mesh(tracker.geometry(paint.build()), paintMat);
  paintMesh.name = "paint";
  group.add(paintMesh);

  // Aisle centrelines and the lane slots inside each goods door.
  const dashes = new LineBatch();
  for (const lane of world.lanes) for (const s of lane.slots) dashes.rect(s[0], s[1], 4.2, 4.2, 0.03);
  const lanes = new LineSegments(tracker.geometry(dashes.build()), laneMat);
  lanes.name = "lanes";
  group.add(lanes);

  const aisleDashes = new LineBatch();
  for (const run of spec.fixtures) {
    if (run.kind !== "gondola") continue;
    const x = run.x;
    for (let y = run.y0; y < run.y1; y += 6) aisleDashes.addEngine(x, y, x, Math.min(run.y1, y + 3), 0.03);
  }
  const aisleLines = new LineSegments(tracker.geometry(aisleDashes.build()), aisleMat);
  aisleLines.name = "aisles";
  group.add(aisleLines);

  // --- The service drive --------------------------------------------------
  const driveMarks = new LineBatch();
  const driveY = world.service.roadY;
  for (let x = world.service.spawnLeft[0]; x < world.service.spawnRight[0]; x += 16) driveMarks.addEngine(x, driveY, x + 8, driveY, 0.02);
  for (const spots of Object.values(world.service.queue)) {
    for (const s of spots) driveMarks.rect(s[0], s[1], VEHICLE_SIZE.truck.widthFt + 3, 60, 0.02);
  }
  const driveLines = new LineSegments(tracker.geometry(driveMarks.build()), laneMat);
  driveLines.name = "serviceDrive";
  group.add(driveLines);

  // --- Ceilings -----------------------------------------------------------
  const salesStrips = new BoxBatch();
  for (let y = 6; y < backY - 2; y += 9) {
    for (let k = 0; k < 2; k++) salesStrips.add(Math.max(6, W / 2 - 6), 0.2, 2, W * (k === 0 ? 0.27 : 0.73), CEILING_SALES, -y);
  }
  const salesCeiling = new Mesh(tracker.geometry(salesStrips.build()), salesStripMat);
  salesCeiling.name = "ceiling:sales";
  group.add(salesCeiling);

  const backStrips = new BoxBatch();
  for (let y = backY + 6; y < D - 3; y += 16) backStrips.add(Math.max(8, W - 8), 0.25, 0.8, W / 2, CEILING_BACK, -y);
  const backCeiling = new Mesh(tracker.geometry(backStrips.build()), backStripMat);
  backCeiling.name = "ceiling:backroom";
  group.add(backCeiling);

  // Pendants over the glass, which is how a confectioner lights a showcase.
  const pendants = new BoxBatch();
  for (const run of spec.fixtures) {
    if (run.kind !== "showcase") continue;
    const bays = Math.max(1, run.bays);
    for (let i = 0; i < bays; i++) {
      const y = run.y0 + ((i + 0.5) / bays) * (run.y1 - run.y0);
      pendants.add(1.6, 0.35, 1.6, run.x, 8.5, -y);
      pendants.add(0.1, 3.4, 0.1, run.x, 10.4, -y);
    }
  }
  const pendantMesh = new Mesh(tracker.geometry(pendants.build()), pendantMat);
  pendantMesh.name = "ceiling:showcase";
  group.add(pendantMesh);

  // --- State --------------------------------------------------------------
  const setDoor = (index: number, state: DoorState) => {
    const f = world.frames[index];
    const lamp = doorLamps[index];
    const pad = doorPads[index];
    if (!f || !lamp || !pad) return;
    const mat = lamp.material as MeshBasicMaterial;
    if (state === "outage") {
      mat.color.setHex(STATE_COLORS.outage);
      pad.material = padOutageMat;
    } else {
      mat.color.setHex(state === "busy" ? DOOR_COLORS[f.kind] : darken(DOOR_COLORS[f.kind], 0.45));
      pad.material = padMats[f.kind];
    }
  };
  for (let i = 0; i < world.frames.length; i++) {
    setDoor(i, "free");
    openers[i]?.(0);
  }

  const base = new Color();
  let lastZones = "";
  let lastDaylight = -1;
  const setLight = (zones: LightZones, daylight: number) => {
    const key = `${zones.sales ? 1 : 0}${zones.backroom ? 1 : 0}${zones.showcase ? 1 : 0}`;
    if (key !== lastZones) {
      lastZones = key;
      const glow = (m: MeshLambertMaterial, on: boolean, hex: number) => {
        m.emissive.setHex(on ? hex : 0x000000);
        m.emissiveIntensity = on ? 0.9 : 0;
      };
      glow(salesStripMat, zones.sales, 0xfff1c2);
      glow(backStripMat, zones.backroom, 0xeef2f6);
      glow(pendantMat, zones.showcase, 0xffe2a8);
    }
    // Quantised, so a paused frame recolours nothing and a moving clock
    // recolours at most once a simulated minute.
    const k = Math.round((0.35 + 0.65 * Math.min(1, Math.max(0, daylight))) * 100) / 100;
    if (k !== lastDaylight) {
      lastDaylight = k;
      apronMat.color.copy(base.setHex(S().apron)).multiplyScalar(k);
      laneMat.color.copy(base.setHex(S().roadMark)).multiplyScalar(0.5 + 0.5 * k);
    }
  };
  setLight({ sales: true, backroom: true, showcase: true }, 1);

  let disposed = false;
  return {
    group,
    floor,
    doorPads,
    doorLamps,
    setDoor,
    setDoorOpen(index, fraction) {
      openers[index]?.(fraction);
    },
    setLight,
    setTheme(name) {
      themeName = name;
      const s = S();
      for (const [mat, pick] of themed) mat.color.setHex(pick(s));
      lastZones = "";
      lastDaylight = -1;
      setLight({ sales: true, backroom: true, showcase: true }, 1);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
    },
  };
}
