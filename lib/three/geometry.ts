/**
 * The frame mapping, the resource tracker, the box batcher and every
 * procedural low-poly part the store is built from.
 *
 * Frame: the engine is feet, x across the store, y from the storefront
 * (y = 0, the lot at y < 0) toward the back wall, z up. three.js is y-up, so
 * `toWorld(x, y, z) = (X = x, Y = z, Z = -y)` and one world unit is one foot.
 * Actors are modelled facing +X and standing on Y = 0, so `rotation.y = h`
 * turns an engine heading (radians, 0 = +x) into the right direction:
 * rotating +X about Y by h gives (cos h, 0, -sin h) = engine (cos h, sin h).
 *
 * Every actor part stays under 300 triangles, because a busy Saturday puts
 * forty people on a 70 ft sales floor and each one is a draw call's worth of
 * work. Shelving, stall stripes, fence and paint go through `BoxBatch`, which
 * writes boxes straight into one BufferGeometry rather than merging thousands
 * of BoxGeometry objects.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Material,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  Texture,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export function toWorld(x: number, y: number, z: number, target: Vector3 = new Vector3()): Vector3 {
  return target.set(x, z, -y);
}

/** Inverse of toWorld: a world point back to engine (x, y, z). */
export function toEngine(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: -v.z, z: v.y };
}

// ---------------------------------------------------------------------------
// Resource tracking
// ---------------------------------------------------------------------------

/**
 * Everything a scene allocates registers here, so dispose() is one call and a
 * test can assert created === disposed. Registering the same object twice
 * counts once.
 */
export class ResourceTracker {
  readonly geometries = new Set<BufferGeometry>();
  readonly materials = new Set<Material>();
  readonly textures = new Set<Texture>();
  created = 0;
  disposed = 0;
  materialsCreated = 0;
  materialsDisposed = 0;

  geometry<T extends BufferGeometry>(g: T): T {
    if (!this.geometries.has(g)) {
      this.geometries.add(g);
      this.created++;
    }
    return g;
  }

  material<T extends Material>(m: T): T {
    if (!this.materials.has(m)) {
      this.materials.add(m);
      this.materialsCreated++;
    }
    return m;
  }

  texture<T extends Texture>(t: T): T {
    this.textures.add(t);
    return t;
  }

  /** Dispose one geometry early (a rebuilt fixture set, a pool shrink). */
  release(g: BufferGeometry): void {
    if (this.geometries.delete(g)) {
      g.dispose();
      this.disposed++;
    }
  }

  disposeAll(): void {
    for (const g of this.geometries) {
      g.dispose();
      this.disposed++;
    }
    this.geometries.clear();
    for (const m of this.materials) {
      m.dispose();
      this.materialsDisposed++;
    }
    this.materials.clear();
    for (const t of this.textures) t.dispose();
    this.textures.clear();
  }
}

export function triangleCount(g: BufferGeometry): number {
  const index = g.getIndex();
  if (index) return index.count / 3;
  const pos = g.getAttribute("position");
  return pos ? pos.count / 3 : 0;
}

// ---------------------------------------------------------------------------
// Box batching
// ---------------------------------------------------------------------------

const FACES: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
  { n: [1, 0, 0], c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

/**
 * Appends axis-aligned (or Y-rotated) boxes into flat arrays and builds one
 * indexed BufferGeometry with positions and normals; Lambert materials need no
 * UVs. Twelve triangles per box.
 */
export class BoxBatch {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly idx: number[] = [];
  boxes = 0;

  /** A box of size (w, h, d) centred at (cx, cy, cz) in three space, rotated `angle` radians about Y. */
  add(w: number, h: number, d: number, cx: number, cy: number, cz: number, angle = 0): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const hw = w / 2;
    const hh = h / 2;
    const hd = d / 2;
    for (const face of FACES) {
      const base = this.pos.length / 3;
      const nx = face.n[0] * c + face.n[2] * s;
      const nz = -face.n[0] * s + face.n[2] * c;
      for (const [fx, fy, fz] of face.c) {
        const lx = fx * hw;
        const ly = fy * hh;
        const lz = fz * hd;
        this.pos.push(cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c);
        this.nrm.push(nx, face.n[1], nz);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.boxes++;
  }

  /** The same box given in the engine frame: centre (cx, cy) on the floor, `h` tall from `z`. */
  addEngine(w: number, l: number, h: number, cx: number, cy: number, z: number, angle = 0): void {
    this.add(w, h, l, cx, z + h / 2, -cy, angle);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.nrm, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Positions-only line geometry (grid, aisle dashes, stall stripes, lane marks). */
export class LineBatch {
  private readonly pos: number[] = [];
  segments = 0;

  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.pos.push(x0, y0, z0, x1, y1, z1);
    this.segments++;
  }

  /** A segment in the engine frame at height z. */
  addEngine(ax: number, ay: number, bx: number, by: number, z: number): void {
    this.add(ax, z, -ay, bx, z, -by);
  }

  /** A rectangle on the floor in the engine frame, w across x and l along y. */
  rect(cx: number, cy: number, w: number, l: number, z: number): void {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const y0 = cy - l / 2;
    const y1 = cy + l / 2;
    this.addEngine(x0, y0, x1, y0, z);
    this.addEngine(x1, y0, x1, y1, z);
    this.addEngine(x1, y1, x0, y1, z);
    this.addEngine(x0, y1, x0, y0, z);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Parts (local frame: facing +X, standing on Y = 0)
// ---------------------------------------------------------------------------

function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(w, h, d).translate(x, y, z);
}

/** A wheel: a cylinder with its axle along Z, for a vehicle facing +X. */
function wheel(r: number, width: number, x: number, y: number, z: number): BufferGeometry {
  return new CylinderGeometry(r, r, width, 6).rotateX(Math.PI / 2).translate(x, y, z);
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * People are drawn a shade larger than life so a shopper still reads as a
 * person from the overview; the shop itself is only seventy feet across, so
 * nothing else needs the trick the warehouse played on its pickers.
 */
export const PERSON_SCALE = 1.1;
/** Where a name pill hangs over someone's head, feet. */
export const PERSON_LABEL_Z = 6.4;

function legsAndTorso(): BufferGeometry {
  return merge([
    new CapsuleGeometry(0.5, 1.8, 2, 6).translate(0, 2.5, 0),
    box(0.38, 1.5, 0.38, 0, 0.75, 0.26),
    box(0.38, 1.5, 0.38, 0, 0.75, -0.26),
  ]);
}

export interface PersonParts {
  body: BufferGeometry;
  head: BufferGeometry;
  /** The block that carries the tint: a clerk's apron, a stocker's polo. */
  garment: BufferGeometry;
}

/**
 * A member of staff: capsule torso on two legs, a head, and an apron that
 * takes the role tint. The apron is a slab on the +X side only, because that
 * is what tells a clerk from a customer at a glance. ~150 triangles.
 */
export function clerkParts(): PersonParts {
  return {
    body: legsAndTorso(),
    head: new SphereGeometry(0.42, 6, 4).translate(0, 4.2, 0),
    garment: merge([box(0.35, 2.3, 1.2, 0.34, 2.2, 0), box(1.15, 0.9, 1.15, 0, 3.1, 0)]),
  };
}

/**
 * One merged figure for the instanced shopper pool: no children, no tint part,
 * because an InstancedMesh gives each instance one colour and one matrix. A
 * busy minute puts dozens of these on the floor for the cost of a single draw
 * call. ~160 triangles.
 */
export function shopperGeometry(): BufferGeometry {
  return merge([legsAndTorso(), new SphereGeometry(0.42, 6, 4).translate(0, 4.2, 0), box(1.05, 1.0, 1.05, 0, 3.0, 0)]);
}

/** A hand basket, carried at hip height on the +X side. ~24 triangles. */
export function basketGeometry(): BufferGeometry {
  return merge([box(1.0, 0.7, 0.8, 0.7, 2.1, 0), box(0.1, 0.5, 0.7, 0.7, 2.6, 0)]);
}

/**
 * A stock cart — the flat U-boat a restock rides out on: two decks, an end
 * gate and four castors. ~110 triangles.
 */
export function stockCartGeometry(): BufferGeometry {
  return merge([
    box(3.4, 0.14, 1.8, 0, 0.5, 0),
    box(3.4, 0.14, 1.8, 0, 2.0, 0),
    box(0.12, 2.2, 1.8, -1.65, 1.4, 0),
    box(0.3, 0.3, 0.16, 1.4, 0.16, 0.8),
    box(0.3, 0.3, 0.16, 1.4, 0.16, -0.8),
    box(0.3, 0.3, 0.16, -1.4, 0.16, 0.8),
    box(0.3, 0.3, 0.16, -1.4, 0.16, -0.8),
  ]);
}

/** A shopping trolley: basket, frame, child seat and castors. ~130 triangles. */
export function trolleyGeometry(): BufferGeometry {
  return merge([
    box(2.4, 1.3, 1.7, 0.1, 1.5, 0),
    box(2.6, 0.14, 1.8, 0.1, 0.55, 0),
    box(0.1, 1.9, 1.6, -1.2, 1.7, 0),
    box(0.7, 0.5, 1.5, -0.9, 2.4, 0),
    box(0.28, 0.28, 0.14, 1.1, 0.14, 0.8),
    box(0.28, 0.28, 0.14, 1.1, 0.14, -0.8),
    box(0.28, 0.28, 0.14, -1.0, 0.14, 0.8),
    box(0.28, 0.28, 0.14, -1.0, 0.14, -0.8),
  ]);
}

export interface JackParts {
  body: BufferGeometry;
  /** Where a carried pallet's bottom centre sits, in the jack's frame. */
  carry: Vector3;
}

/** A hand pallet jack: body with a tiller, two forks forward. ~100 triangles. */
export function jackParts(): JackParts {
  return {
    body: merge([
      box(1.2, 1.0, 2.2, -0.2, 0.6, 0),
      box(0.15, 3.2, 0.15, -0.9, 2.2, 0),
      box(1.2, 0.12, 0.12, -1.4, 3.7, 0),
      box(4.0, 0.2, 0.5, 2.4, 0.2, 0.85),
      box(4.0, 0.2, 0.5, 2.4, 0.2, -0.85),
      wheel(0.4, 0.5, -0.4, 0.4, 0.8),
      wheel(0.4, 0.5, -0.4, 0.4, -0.8),
    ]),
    carry: new Vector3(2.4, 0.32, 0),
  };
}

/** Total height of a pallet with its load, for stacking. */
export const PALLET_HEIGHT = 3.4;
export const PALLET_FOOT = 3.3;

/**
 * A pallet with a case stack, origin at the bottom centre. "high" is a deck
 * and a load (24 triangles); "low" is the four sides of the load only
 * (8 triangles), for a layout past the instance budget.
 */
export function palletGeometry(quality: "high" | "low"): BufferGeometry {
  if (quality === "high") return merge([box(PALLET_FOOT, 0.4, PALLET_FOOT, 0, 0.2, 0), box(3.0, PALLET_HEIGHT - 0.4, 3.0, 0, 0.4 + (PALLET_HEIGHT - 0.4) / 2, 0)]);
  const hw = 1.55;
  const h = PALLET_HEIGHT;
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const sides: Array<{ n: [number, number, number]; c: Array<[number, number]> }> = [
    { n: [1, 0, 0], c: [[hw, -hw], [hw, hw]] },
    { n: [0, 0, 1], c: [[hw, hw], [-hw, hw]] },
    { n: [-1, 0, 0], c: [[-hw, hw], [-hw, -hw]] },
    { n: [0, 0, -1], c: [[-hw, -hw], [hw, -hw]] },
  ];
  for (const s of sides) {
    const base = pos.length / 3;
    const [[x0, z0], [x1, z1]] = s.c;
    pos.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, h, z0);
    for (let i = 0; i < 4; i++) nrm.push(...s.n);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A unit cube with its base at the origin: shelf product blocks, cases, bin fills. 12 triangles. */
export function unitBoxGeometry(): BufferGeometry {
  return new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

// ---------------------------------------------------------------------------
// Vehicles. Every one has its origin at the REAR, nose along +X, so backing
// onto a door, a kerb or a stall is the same operation whatever the size.
// ---------------------------------------------------------------------------

/** Footprint of each vehicle class, feet: length from the rear, overall width. */
export const VEHICLE_SIZE = {
  car: { lengthFt: 15, widthFt: 6.2 },
  van: { lengthFt: 20, widthFt: 7.4 },
  boxTruck: { lengthFt: 26, widthFt: 8 },
  truck: { lengthFt: 63, widthFt: 8.5 },
} as const;

export type VehicleClass = keyof typeof VEHICLE_SIZE;

export const TRAILER_LENGTH = 53;
export const TRAILER_WIDTH = VEHICLE_SIZE.truck.widthFt;

/**
 * A customer's car for the instanced lot pool: one merged geometry, origin at
 * the rear bumper and the nose along +X, so a stall's heading parks it
 * nose-in without a correction. ~120 triangles.
 */
export function carGeometry(): BufferGeometry {
  const L = VEHICLE_SIZE.car.lengthFt;
  const w = VEHICLE_SIZE.car.widthFt;
  return merge([
    box(L, 1.7, w, L / 2, 1.55, 0),
    box(L * 0.52, 1.25, w - 0.9, L * 0.47, 3.0, 0),
    wheel(1.05, 0.7, L * 0.22, 1.05, w / 2 - 0.3),
    wheel(1.05, 0.7, L * 0.22, 1.05, -(w / 2 - 0.3)),
    wheel(1.05, 0.7, L * 0.78, 1.05, w / 2 - 0.3),
    wheel(1.05, 0.7, L * 0.78, 1.05, -(w / 2 - 0.3)),
  ]);
}

export interface VehicleParts {
  /** The body that carries the kind tint. */
  body: BufferGeometry;
  /** Cab, box and glazing in their own colours. */
  shell: BufferGeometry;
  wheels: BufferGeometry;
  /** Rear lights, strobed while a departure is late. */
  lights: BufferGeometry;
}

/** The store's own delivery van: 20 ft, rear doors at the origin. ~200 triangles. */
export function vanParts(): VehicleParts {
  const L = VEHICLE_SIZE.van.lengthFt;
  const w = VEHICLE_SIZE.van.widthFt;
  return {
    body: merge([box(L - 4.5, 7.2, w, (L - 4.5) / 2, 4.4, 0), box(1.2, 5.6, w - 0.4, 0.2, 3.6, 0)]),
    shell: merge([box(4.8, 5.2, w - 0.3, L - 2.4, 3.4, 0), box(3.2, 1.6, w - 0.5, L - 1.4, 5.2, 0)]),
    wheels: merge([
      wheel(1.3, 0.75, 3.4, 1.3, w / 2 - 0.35),
      wheel(1.3, 0.75, 3.4, 1.3, -(w / 2 - 0.35)),
      wheel(1.3, 0.75, L - 3.4, 1.3, w / 2 - 0.35),
      wheel(1.3, 0.75, L - 3.4, 1.3, -(w / 2 - 0.35)),
    ]),
    lights: merge([box(0.3, 0.6, 0.7, 0.05, 2.6, w / 2 - 1.0), box(0.3, 0.6, 0.7, 0.05, 2.6, -(w / 2 - 1.0))]),
  };
}

/** A vendor's box truck calling through the trading day: 26 ft, rear at the origin. ~210 triangles. */
export function boxTruckParts(): VehicleParts {
  const L = VEHICLE_SIZE.boxTruck.lengthFt;
  const w = VEHICLE_SIZE.boxTruck.widthFt;
  return {
    body: merge([box(L - 8, 9, w, (L - 8) / 2, 5.4, 0), box(1.0, 6.4, w - 0.4, 0.2, 4.0, 0)]),
    shell: merge([box(7.2, 6.4, w - 0.2, L - 4, 3.9, 0), box(4.4, 1.8, w - 0.5, L - 2.6, 6.2, 0)]),
    wheels: merge([
      wheel(1.5, 0.8, 4.2, 1.5, w / 2 - 0.4),
      wheel(1.5, 0.8, 4.2, 1.5, -(w / 2 - 0.4)),
      wheel(1.5, 0.8, L - 4.6, 1.5, w / 2 - 0.4),
      wheel(1.5, 0.8, L - 4.6, 1.5, -(w / 2 - 0.4)),
    ]),
    lights: merge([box(0.3, 0.6, 0.8, 0.05, 3.2, w / 2 - 1.1), box(0.3, 0.6, 0.8, 0.05, 3.2, -(w / 2 - 1.1))]),
  };
}

/** The overnight tractor and 53 ft trailer from the distribution center, rear at the origin. ~270 triangles. */
export function truckParts(): VehicleParts {
  const w = TRAILER_WIDTH;
  return {
    body: merge([box(TRAILER_LENGTH, 9, w, TRAILER_LENGTH / 2, 8.0, 0), box(TRAILER_LENGTH - 4, 0.6, 6, TRAILER_LENGTH / 2, 3.2, 0)]),
    shell: merge([box(7, 7, w, 56.5, 5.0, 0), box(3, 3.5, w - 0.5, 61.5, 3.0, 0)]),
    wheels: merge([
      wheel(1.6, 0.8, 6, 1.6, 3.6),
      wheel(1.6, 0.8, 6, 1.6, -3.6),
      wheel(1.6, 0.8, 10, 1.6, 3.6),
      wheel(1.6, 0.8, 10, 1.6, -3.6),
      wheel(1.6, 0.8, 55, 1.6, 3.6),
      wheel(1.6, 0.8, 55, 1.6, -3.6),
      wheel(1.6, 0.8, 60.5, 1.6, 3.6),
      wheel(1.6, 0.8, 60.5, 1.6, -3.6),
    ]),
    lights: merge([box(0.3, 0.6, 0.8, 0.05, 4.0, 3.5), box(0.3, 0.6, 0.8, 0.05, 4.0, -3.5)]),
  };
}

/** The vehicle classes drawn as pooled Groups; a customer's car is instanced instead. */
export type BuiltVehicle = Exclude<VehicleClass, "car">;

/** Parts for a vehicle class, and where its state ring sits along +X. */
export function vehicleParts(kind: BuiltVehicle): { parts: VehicleParts; ringAt: number } {
  switch (kind) {
    case "van":
      return { parts: vanParts(), ringAt: VEHICLE_SIZE.van.lengthFt / 2 };
    case "boxTruck":
      return { parts: boxTruckParts(), ringAt: VEHICLE_SIZE.boxTruck.lengthFt / 2 };
    case "truck":
      return { parts: truckParts(), ringAt: TRAILER_LENGTH / 2 };
  }
}

/** A flat ring on the floor, for actor state and selection. */
export function ringGeometry(inner = 1.3, outer = 1.8): BufferGeometry {
  return new RingGeometry(inner, outer, 12).rotateX(-Math.PI / 2).translate(0, 0.06, 0);
}

/** A flat quad on the floor, for painted symbols and mats. */
export function padGeometry(w: number, l: number): BufferGeometry {
  return new PlaneGeometry(w, l).rotateX(-Math.PI / 2);
}

/** The accessible-stall symbol, drawn as flat boxes inside a 5 ft square. */
export function accessibleSymbol(): BufferGeometry {
  return merge([
    new CylinderGeometry(0.55, 0.55, 0.04, 10).translate(0.2, 0, 0),
    box(0.35, 0.04, 1.5, -0.55, 0, 0),
    box(1.5, 0.04, 0.35, -0.1, 0, -0.9),
    new CylinderGeometry(0.42, 0.42, 0.05, 8).translate(-0.1, 0.01, 1.05),
  ]);
}
