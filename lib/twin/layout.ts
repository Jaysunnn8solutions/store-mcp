/**
 * Store geometry: shelf facings, aisles, the service counter, the stockroom
 * and the doors — and the travel distances every labor time in the twin is
 * built from.
 *
 * Everything is built from a layout spec (lib/layout/spec.ts): the committed
 * stores convert to one with siteToSpec, and imported drawings produce one.
 * Coordinates are feet, x across the store and y from the storefront (y = 0,
 * where the customers and the lot are) toward the back wall, where the
 * stockroom and the docks are. Fixture runs and aisles run in y.
 *
 * Aisles are found, not declared: two fixture runs whose shopping faces look
 * at each other across a gap of aisle width make an aisle between them; a run
 * with open floor on its shopping side gets a single-sided aisle there. A wall
 * run, a bulk-bin wall and the showcase are shopped from one side only — the
 * side toward the middle of the store — so the corridor behind the glass stays
 * what it is, staff space, and never becomes an aisle.
 *
 * Endcaps, seasonal tables and the impulse racks at the register are reached
 * from open floor rather than from a numbered aisle, and carry aisle = -1.
 */

import { LIMITS, LimitError } from "../layout/limits";
import type { DoorSpec, FixtureKind, FixtureRun, LayoutSpec, Point, ServiceSpec, StorageRun, ZoneSpec } from "../layout/spec";
import type { Site, StorageZone } from "./types";

/** One facing: the block of one SKU a shopper sees on one shelf of one bay. */
export interface Facing {
  id: string;
  kind: FixtureKind;
  /** The fixture run this facing sits on. */
  run: string;
  /** Aisle index within the sales floor, in x order; -1 for an open-floor fixture. */
  aisle: number;
  /** Which face of the run: L looks left (toward smaller x), R looks right. */
  side: "L" | "R";
  bay: number;
  /** 1 = bottom shelf. */
  shelf: number;
  slot: number;
  /** Where a shopper or a stocker stands to reach it. */
  x: number;
  y: number;
  /** Cube of the facing, which caps how much stock it holds. */
  cubeFt: number;
  /** Behind glass: a clerk fetches it, the shopper never touches it. */
  served: boolean;
}

/** One position in the stockroom: a pallet on a rack beam, or a case shelf. */
export interface StoragePosition {
  id: string;
  kind: "rack" | "shelving";
  run: string;
  aisle: number;
  side: "L" | "R";
  bay: number;
  level: number;
  x: number;
  y: number;
  cubeFt: number;
}

export interface Aisle {
  zone: "sales" | "backroom";
  x: number;
  y0: number;
  y1: number;
  /** Runs on each side, if any; the shopper walking the aisle faces both. */
  left: { id: string; kind: string } | null;
  right: { id: string; kind: string } | null;
}

export interface Layout {
  site: Site;
  spec: LayoutSpec;
  facings: Facing[];
  storage: StoragePosition[];
  service: ServiceSpec[];
  doors: DoorSpec[];
  salesAisles: Aisle[];
  backroomAisles: Aisle[];
  /** Just inside the customer entrance. */
  entry: { x: number; y: number };
  /** The stockroom door onto the sales floor, where a restock cart comes out. */
  stockDoor: { x: number; y: number };
  /** The pick-and-pack bench in the stockroom. */
  bench: { x: number; y: number };
  /** Where pallets land when a truck is unloaded. */
  staging: { x: number; y: number };
  /** Front and back cross aisles of the sales floor. */
  salesFrontY: number;
  salesBackY: number;
  /** Length walked through one sales aisle end to end. */
  salesAisleLength: number;
  /** Median facing cube. */
  facingCubeFt: number;
  sellingSqFt: number;
  backroomSqFt: number;
  /** Head of the queue at each service point, by service point id. */
  queueHeads: Record<string, { x: number; y: number }>;
}

const MIN_AISLE_FT = 2.5;
const MAX_AISLE_FT = 22;
const BACK_TO_BACK_FT = 1.5;
/** A cross aisle at each end of the sales floor, so a shopper can change aisle. */
const CROSS_AISLE_FT = 5;
/** Depth of the goods-door apron kept clear inside the back wall. */
const APRON_FT = 8;
/** Clear height of one selling shelf in a built-in store, feet. */
const SHELF_HEIGHT_FT = 1.25;

// ---------------------------------------------------------------------------
// Merchandising quality: where a facing sits changes what it sells and what it
// costs to fill.
// ---------------------------------------------------------------------------

/** Shelves at waist-to-eye height, where a stocker needs no bend or stretch. */
export function isGoldenShelf(shelf: number, shelves: number): boolean {
  const r = shelf / shelves;
  return r > 0.35 && r <= 0.8;
}

/**
 * Eye level is buy level. A shelf's share of a run's sales, relative to an
 * evenly merchandised run: the floor shelf and the top shelf lose customers to
 * the ones in between.
 */
export function shelfAppeal(shelf: number, shelves: number): number {
  if (shelves <= 1) return 1;
  const r = (shelf - 0.5) / shelves;
  if (r < 0.25) return 0.78;
  if (r < 0.45) return 1.0;
  if (r < 0.75) return 1.18;
  return 0.88;
}

/** What a fixture family does to a SKU's sales, before the shelf it sits on. */
export const FIXTURE_APPEAL: Record<FixtureKind, number> = {
  gondola: 1,
  wall: 0.9,
  endcap: 1.65,
  bulk: 1.15,
  showcase: 1,
  impulse: 1.35,
  seasonal: 1.45,
};

// ---------------------------------------------------------------------------
// Committed sites as specs
// ---------------------------------------------------------------------------

/**
 * Goods doors along the back wall. Raised docks take the right of the wall,
 * where a trailer can swing in off the service drive; the ground-level roll-up
 * sits just inboard of them, for a box truck or the store's own van.
 */
export function goodsDoors(widthFt: number, depthFt: number, docks: number, ground: number): DoorSpec[] {
  const doors: DoorSpec[] = [];
  const n = Math.max(1, docks + ground);
  const x0 = widthFt * 0.45;
  const span = widthFt - 3 - x0;
  let i = 0;
  for (let g = 0; g < ground; g++, i++) doors.push({ id: `GRND-${g + 1}`, kind: "ground", x: x0 + ((i + 0.5) / n) * span, y: depthFt, widthFt: 12 });
  for (let d = 0; d < docks; d++, i++) doors.push({ id: `DOCK-${d + 1}`, kind: "dock", x: x0 + ((i + 0.5) / n) * span, y: depthFt, widthFt: 10 });
  return doors;
}

/** Customer entrances across the storefront, centred and evenly spread. */
export function entranceDoors(widthFt: number, entrances: number): DoorSpec[] {
  const n = Math.max(1, entrances);
  const span = widthFt * (n === 1 ? 0 : 0.22);
  const start = widthFt / 2 - span / 2;
  return Array.from({ length: n }, (_, i) => ({
    id: `ENT-${i + 1}`,
    kind: "entrance" as const,
    x: n === 1 ? widthFt / 2 : start + (i / (n - 1)) * span,
    y: 0,
    widthFt: 8,
  }));
}

function storageRuns(z: StorageZone, index: number): StorageRun[] {
  const runs: StorageRun[] = [];
  const pitch = z.aisleWidthFt + 2 * z.depthFt;
  const y1 = z.originY + z.baysPerSide * z.bayWidthFt;
  const prefix = z.kind === "rack" ? "K" : "H";
  for (let a = 0; a < z.aisles; a++) {
    const left = z.originX + a * pitch + z.depthFt / 2;
    const right = z.originX + a * pitch + z.depthFt + z.aisleWidthFt + z.depthFt / 2;
    for (const [x, side] of [[left, "L"], [right, "R"]] as const) {
      runs.push({ id: `${prefix}${index}${a + 1}${side}`, kind: z.kind, x, y0: z.originY, y1, depthFt: z.depthFt, bays: z.baysPerSide, levels: z.levels });
    }
  }
  return runs;
}

export function siteToSpec(site: Site): LayoutSpec {
  const W = site.building.widthFt;
  const D = site.building.depthFt;
  const fixtures: FixtureRun[] = [];
  const service: ServiceSpec[] = [];
  const zones: ZoneSpec[] = [];

  // Gondolas down the middle of the sales floor, with their endcaps.
  const g = site.gondolas;
  const pitch = g.depthFt + g.aisleWidthFt;
  const gy1 = g.originY + g.baysPerRun * g.bayWidthFt;
  for (let r = 0; r < g.runs; r++) {
    const x = g.originX + r * pitch;
    fixtures.push({ id: `G${r + 1}`, kind: "gondola", x, y0: g.originY, y1: gy1, depthFt: g.depthFt, shelves: g.shelves, bays: g.baysPerRun, facingsPerBay: g.facingsPerBay, doubleSided: true });
    if (g.endcapShelves > 0) {
      fixtures.push({ id: `G${r + 1}-EF`, kind: "endcap", x, y0: g.originY - 2.5, y1: g.originY, depthFt: g.depthFt, shelves: g.endcapShelves, bays: 1, facingsPerBay: g.facingsPerBay, doubleSided: false });
      fixtures.push({ id: `G${r + 1}-EB`, kind: "endcap", x, y0: gy1, y1: gy1 + 2.5, depthFt: g.depthFt, shelves: g.endcapShelves, bays: 1, facingsPerBay: g.facingsPerBay, doubleSided: false });
    }
  }

  // Perimeter shelving and the bulk-bin wall.
  for (const w of site.walls) {
    const x = w.side === "left" ? w.depthFt / 2 : W - w.depthFt / 2;
    fixtures.push({ id: w.id, kind: w.kind, x, y0: w.y0, y1: w.y1, depthFt: w.depthFt, shelves: w.shelves, bays: w.bays, facingsPerBay: w.facingsPerBay, doubleSided: false });
  }

  // Seasonal tables inside the door.
  const s = site.seasonal;
  for (let t = 0; t < s.tables; t++) {
    fixtures.push({
      id: `SEAS-${t + 1}`,
      kind: "seasonal",
      x: s.originX + t * s.pitchFt,
      y0: s.originY,
      y1: s.originY + s.lengthFt,
      depthFt: s.widthFt,
      shelves: s.shelves,
      bays: 1,
      facingsPerBay: s.facingsPerBay,
      doubleSided: false,
    });
  }

  // The service counter: registers at the front, the glass behind them, staff
  // in the corridor between the counter and the wall.
  const c = site.checkout;
  const counterY1 = c.y + c.registers * c.pitchFt;
  for (let i = 0; i < c.registers; i++) {
    service.push({ id: `REG-${i + 1}`, kind: "register", x: c.x, y: c.y + (i + 0.5) * c.pitchFt, facing: c.x > W / 2 ? 270 : 90 });
  }
  if (c.wrap) service.push({ id: "WRAP-1", kind: "wrap", x: c.x, y: counterY1 + 1.5, facing: c.x > W / 2 ? 270 : 90 });
  if (c.impulseBays > 0) {
    const shopSign = c.x > W / 2 ? -1 : 1;
    fixtures.push({
      id: "IMP-1",
      kind: "impulse",
      x: c.x + shopSign * (c.depthFt / 2 + 0.75),
      y0: c.y,
      y1: counterY1,
      depthFt: 1.5,
      shelves: c.shelves,
      bays: c.impulseBays,
      facingsPerBay: c.facingsPerBay,
      doubleSided: false,
    });
  }
  zones.push({ kind: "queue", name: "Checkout counter", ring: rect(c.x - c.depthFt / 2, c.y, c.x + c.depthFt / 2, counterY1) });

  // The showcase, and a serving station behind the glass for each clerk.
  const sc = site.showcase;
  if (sc) {
    fixtures.push({ id: "CASE-1", kind: "showcase", x: sc.x, y0: sc.y0, y1: sc.y1, depthFt: sc.depthFt, shelves: sc.shelves, bays: sc.bays, facingsPerBay: sc.facingsPerBay, doubleSided: false });
    const behind = sc.x > W / 2 ? sc.x + sc.depthFt / 2 + 1.5 : sc.x - sc.depthFt / 2 - 1.5;
    for (let i = 0; i < sc.stations; i++) {
      service.push({ id: `CTR-${i + 1}`, kind: "counter", x: behind, y: sc.y0 + ((i + 0.5) / sc.stations) * (sc.y1 - sc.y0), facing: sc.x > W / 2 ? 270 : 90 });
    }
    zones.push({ kind: "other", name: "Back bar", ring: rect(Math.min(behind, sc.x), sc.y0, Math.max(behind, sc.x) + (sc.x > W / 2 ? sc.backCorridorFt - 1.5 : 0), sc.y1) });
  }

  // The stockroom.
  const storage: StorageRun[] = site.backroom.flatMap((z, i) => storageRuns(z, i + 1));

  zones.push({ kind: "sales", name: "Sales floor", ring: rect(0, 0, W, site.backroomY) });
  zones.push({ kind: "backroom", name: "Stockroom", ring: rect(0, site.backroomY, W, D) });
  zones.push({ kind: "staging", name: "Receiving apron", ring: rect(W * 0.45, D - APRON_FT, W, D) });

  return {
    version: 1,
    name: site.name,
    source: { format: "builtin", notes: [] },
    widthFt: W,
    depthFt: D,
    outline: [
      [0, 0],
      [W, 0],
      [W, D],
      [0, D],
    ],
    walls: [],
    zones,
    fixtures,
    storage,
    service,
    doors: [...entranceDoors(W, site.doors.entrances), ...goodsDoors(W, D, site.doors.docks, site.doors.ground)],
    parking: site.parking,
    backroomY: site.backroomY,
    aisleWidthFt: g.aisleWidthFt,
    shelfHeightFt: SHELF_HEIGHT_FT,
  };
}

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Change a spec's register and showcase-station counts. Service points are
 * added past the last one of that kind along the counter, or removed from the
 * end, so an imported drawing keeps the positions it really has.
 */
export function withServiceCounts(spec: LayoutSpec, registers: number, counters: number): LayoutSpec {
  const out: ServiceSpec[] = [];
  for (const kind of ["register", "counter"] as const) {
    const have = spec.service.filter((s) => s.kind === kind);
    const want = kind === "register" ? registers : counters;
    if (have.length === 0 && want > 0) continue;
    const kept = have.slice(0, want);
    const last = kept[kept.length - 1] ?? have[0];
    const pitch = have.length > 1 ? Math.abs(have[1].y - have[0].y) : 6;
    for (let i = kept.length; i < want; i++) {
      kept.push({ id: `${kind === "register" ? "REG" : "CTR"}-X${i + 1}`, kind, x: last.x, y: last.y + pitch * (i - have.length + 1), facing: last.facing });
    }
    out.push(...kept);
  }
  out.push(...spec.service.filter((s) => s.kind === "wrap"));
  return { ...spec, service: out };
}

/** Change a spec's goods-door counts, keeping an imported drawing's real doors. */
export function withDoorCounts(spec: LayoutSpec, docks: number, ground: number): LayoutSpec {
  const entrances = spec.doors.filter((d) => d.kind === "entrance");
  if (spec.source.format === "builtin") {
    return { ...spec, doors: [...entrances, ...goodsDoors(spec.widthFt, spec.depthFt, docks, ground)] };
  }
  const doors: DoorSpec[] = [...entrances];
  for (const kind of ["ground", "dock"] as const) {
    const have = spec.doors.filter((d) => d.kind === kind);
    const want = kind === "dock" ? docks : ground;
    const kept = have.slice(0, want);
    const last = kept[kept.length - 1] ?? { x: spec.widthFt * (kind === "dock" ? 0.75 : 0.55), y: spec.depthFt, widthFt: kind === "dock" ? 10 : 12 };
    for (let i = kept.length; i < want; i++) {
      const x = Math.min(spec.widthFt - 6, last.x + 14 * (i - kept.length + 1));
      kept.push({ id: `${kind === "dock" ? "DOCK" : "GRND"}-X${i + 1}`, kind, x, y: last.y, widthFt: last.widthFt });
    }
    doors.push(...kept);
  }
  return { ...spec, doors };
}

// ---------------------------------------------------------------------------
// Aisles
// ---------------------------------------------------------------------------

interface Run {
  id: string;
  kind: string;
  x: number;
  y0: number;
  y1: number;
  depthFt: number;
}

/**
 * Which face of a run a shopper reaches. A gondola is shopped from both sides;
 * everything else is shopped from the side that looks into the store, so the
 * corridor behind a showcase or against a wall is never taken for an aisle.
 */
function shopFaces(run: { kind: string; x: number }, widthFt: number): { left: boolean; right: boolean } {
  if (run.kind === "gondola" || run.kind === "rack" || run.kind === "shelving") return { left: true, right: true };
  const towardRight = run.x < widthFt / 2;
  return { left: !towardRight, right: towardRight };
}

/** Fixtures reached from open floor rather than from an aisle. */
const OPEN_FLOOR: ReadonlySet<string> = new Set(["endcap", "seasonal", "impulse"]);

function overlap(a: Run, b: Run): number {
  const o = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return o / Math.max(1e-9, Math.min(a.y1 - a.y0, b.y1 - b.y0));
}

function findAisles(runs: Run[], widthFt: number, aisleWidthFt: number): Array<{ x: number; y0: number; y1: number; left: Run | null; right: Run | null }> {
  const sorted = [...runs].sort((a, b) => a.x - b.x || a.y0 - b.y0);
  const faces = new Map(sorted.map((r) => [r.id, shopFaces(r, widthFt)]));
  const rightUsed = new Set<string>();
  const leftUsed = new Set<string>();
  const pairs: Array<{ gap: number; a: Run; b: Run }> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const gap = b.x - b.depthFt / 2 - (a.x + a.depthFt / 2);
      if (gap > MAX_AISLE_FT) break;
      if (gap < -0.5 || overlap(a, b) < 0.3) continue;
      if (!faces.get(a.id)!.right || !faces.get(b.id)!.left) continue;
      pairs.push({ gap, a, b });
    }
  }
  pairs.sort((p, q) => p.gap - q.gap);
  const aisles: Array<{ x: number; y0: number; y1: number; left: Run | null; right: Run | null }> = [];
  for (const { gap, a, b } of pairs) {
    if (rightUsed.has(a.id) || leftUsed.has(b.id)) continue;
    rightUsed.add(a.id);
    leftUsed.add(b.id);
    // Back to back: the faces touch, so neither is reachable from this side.
    if (gap < BACK_TO_BACK_FT || gap < MIN_AISLE_FT) continue;
    aisles.push({ x: (a.x + a.depthFt / 2 + b.x - b.depthFt / 2) / 2, y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), left: a, right: b });
  }
  // A run whose shopping face has no aisle yet opens one onto the floor beside it.
  for (const r of sorted) {
    const f = faces.get(r.id)!;
    const hasLeft = aisles.some((a) => a.right === r);
    const hasRight = aisles.some((a) => a.left === r);
    if ((hasLeft || !f.left) && (hasRight || !f.right)) continue;
    const side = !hasRight && f.right && !rightUsed.has(r.id) ? "right" : !hasLeft && f.left && !leftUsed.has(r.id) ? "left" : null;
    if (!side) continue;
    const w = aisleWidthFt;
    if (side === "right") aisles.push({ x: r.x + r.depthFt / 2 + w / 2, y0: r.y0, y1: r.y1, left: r, right: null });
    else aisles.push({ x: r.x - r.depthFt / 2 - w / 2, y0: r.y0, y1: r.y1, left: null, right: r });
  }
  return aisles.sort((a, b) => a.x - b.x || a.y0 - b.y0);
}

// ---------------------------------------------------------------------------
// Building the layout
// ---------------------------------------------------------------------------

export function buildLayout(spec: LayoutSpec, site: Site): Layout {
  const W = spec.widthFt;
  const aisleRuns: Run[] = spec.fixtures.filter((f) => !OPEN_FLOOR.has(f.kind)).map((f) => ({ id: f.id, kind: f.kind, x: f.x, y0: f.y0, y1: f.y1, depthFt: f.depthFt }));
  if (aisleRuns.length === 0) throw new LimitError("The layout has no shelving on the sales floor. Mark some fixtures as gondola, wall, bulk or showcase in the import mapping.");
  const found = findAisles(aisleRuns, W, spec.aisleWidthFt);
  const byId = new Map(spec.fixtures.map((f) => [f.id, f]));

  const salesAisles: Aisle[] = found.map((a) => ({
    zone: "sales" as const,
    x: a.x,
    y0: a.y0,
    y1: a.y1,
    left: a.left ? { id: a.left.id, kind: a.left.kind } : null,
    right: a.right ? { id: a.right.id, kind: a.right.kind } : null,
  }));

  const facings: Facing[] = [];
  const pushFacings = (run: FixtureRun, aisle: number, side: "L" | "R", standX: number) => {
    const bayLen = (run.y1 - run.y0) / run.bays;
    const served = run.kind === "showcase";
    for (let b = 0; b < run.bays; b++) {
      for (let sh = 1; sh <= run.shelves; sh++) {
        for (let f = 0; f < run.facingsPerBay; f++) {
          facings.push({
            id: `${run.id}-${side}${String(b + 1).padStart(2, "0")}-${sh}${run.facingsPerBay > 1 ? String.fromCharCode(97 + f) : ""}`,
            kind: run.kind,
            run: run.id,
            aisle,
            side,
            bay: b,
            shelf: sh,
            slot: f,
            x: standX,
            y: run.y0 + (b + (f + 0.5) / run.facingsPerBay) * bayLen,
            cubeFt: (bayLen / run.facingsPerBay) * (run.doubleSided ? run.depthFt / 2 : run.depthFt) * spec.shelfHeightFt,
            served,
          });
        }
      }
    }
  };

  found.forEach((a, idx) => {
    if (a.left) {
      const run = byId.get(a.left.id);
      if (run) pushFacings(run, idx, "R", a.x);
    }
    if (a.right) {
      const run = byId.get(a.right.id);
      if (run) pushFacings(run, idx, "L", a.x);
    }
  });

  // Open-floor fixtures: the shopper stands beside them, not in an aisle.
  for (const run of spec.fixtures) {
    if (!OPEN_FLOOR.has(run.kind)) continue;
    const standX = run.x < W / 2 ? run.x + run.depthFt / 2 + 2 : run.x - run.depthFt / 2 - 2;
    pushFacings(run, -1, run.x < W / 2 ? "R" : "L", standX);
  }

  // The stockroom.
  const storage: StoragePosition[] = [];
  const backRuns: Run[] = spec.storage.map((s) => ({ id: s.id, kind: s.kind, x: s.x, y0: s.y0, y1: s.y1, depthFt: s.depthFt }));
  const backFound = findAisles(backRuns, W, 4);
  const storageById = new Map(spec.storage.map((s) => [s.id, s]));
  const backroomAisles: Aisle[] = backFound.map((a) => ({
    zone: "backroom" as const,
    x: a.x,
    y0: a.y0,
    y1: a.y1,
    left: a.left ? { id: a.left.id, kind: a.left.kind } : null,
    right: a.right ? { id: a.right.id, kind: a.right.kind } : null,
  }));
  backFound.forEach((a, idx) => {
    for (const [run, side] of [
      [a.left, "R"],
      [a.right, "L"],
    ] as const) {
      if (!run) continue;
      const s = storageById.get(run.id);
      if (!s) continue;
      const bayLen = (s.y1 - s.y0) / s.bays;
      for (let b = 0; b < s.bays; b++) {
        for (let lv = 1; lv <= s.levels; lv++) {
          storage.push({
            id: `${s.id}-${side}${String(b + 1).padStart(2, "0")}-${lv}`,
            kind: s.kind,
            run: s.id,
            aisle: idx,
            side,
            bay: b,
            level: lv,
            x: a.x,
            y: s.y0 + (b + 0.5) * bayLen,
            cubeFt: bayLen * s.depthFt * (s.kind === "rack" ? 4 : 1.5),
          });
        }
      }
    }
  });

  if (facings.length === 0) throw new LimitError("The layout has no shelf facings. Mark some fixtures as gondola, wall, bulk or showcase in the import mapping.");
  if (storage.length === 0) throw new LimitError("The layout has no stockroom positions. Mark some fixtures as rack or shelving behind the sales floor in the import mapping.");
  if (facings.length > LIMITS.maxFacings) throw new LimitError(`The layout has ${facings.length.toLocaleString("en-US")} facings; the limit is ${LIMITS.maxFacings.toLocaleString("en-US")}.`);
  if (storage.length > LIMITS.maxStoragePositions) throw new LimitError(`The layout has ${storage.length.toLocaleString("en-US")} stockroom positions; the limit is ${LIMITS.maxStoragePositions.toLocaleString("en-US")}.`);
  if (!spec.doors.some((d) => d.kind === "entrance")) throw new LimitError("The layout needs at least one customer entrance on the storefront.");
  if (!spec.doors.some((d) => d.kind === "dock" || d.kind === "ground")) throw new LimitError("The layout needs at least one goods door — a dock or a ground-level roll-up — at the back.");
  if (spec.service.filter((s) => s.kind === "register").length === 0) throw new LimitError("The layout needs at least one register.");

  const aisleFixtures = found.filter((a) => a.left || a.right);
  const salesFrontY = Math.min(...aisleFixtures.map((a) => a.y0));
  const salesBackY = Math.max(...aisleFixtures.map((a) => a.y1));
  const cubes = facings.map((f) => f.cubeFt).sort((a, b) => a - b);
  const entrance = spec.doors.find((d) => d.kind === "entrance")!;
  const goods = spec.doors.filter((d) => d.kind === "dock" || d.kind === "ground");
  const goodsX = goods.reduce((a, d) => a + d.x, 0) / goods.length;

  const queueHeads: Record<string, { x: number; y: number }> = {};
  for (const sp of spec.service) {
    const toward = sp.x > W / 2 ? -1 : 1;
    queueHeads[sp.id] = { x: sp.x + toward * 4, y: sp.y };
  }

  return {
    site,
    spec,
    facings,
    storage,
    service: spec.service,
    doors: spec.doors,
    salesAisles,
    backroomAisles,
    entry: { x: entrance.x, y: 4 },
    stockDoor: { x: Math.min(W - 4, Math.max(4, spec.widthFt * 0.2)), y: spec.backroomY },
    bench: { x: goodsX, y: spec.backroomY + 6 },
    staging: { x: goodsX, y: spec.depthFt - APRON_FT / 2 },
    salesFrontY,
    salesBackY,
    salesAisleLength: salesBackY - salesFrontY,
    facingCubeFt: cubes[Math.floor(cubes.length / 2)],
    sellingSqFt: Math.round(W * spec.backroomY),
    backroomSqFt: Math.round(W * (spec.depthFt - spec.backroomY)),
    queueHeads,
  };
}

// ---------------------------------------------------------------------------
// Travel
// ---------------------------------------------------------------------------

/**
 * Walking distance on the sales floor between two points, feet. Inside one
 * aisle it is the run along it; otherwise out to the nearer cross aisle,
 * across, and back in.
 */
export function walkDistance(layout: Layout, a: { x: number; y: number }, b: { x: number; y: number }): number {
  if (Math.abs(a.x - b.x) < 0.5) return Math.abs(a.y - b.y);
  const front = layout.salesFrontY - CROSS_AISLE_FT / 2;
  const back = layout.salesBackY + CROSS_AISLE_FT / 2;
  const viaFront = Math.abs(a.y - front) + Math.abs(a.x - b.x) + Math.abs(b.y - front);
  const viaBack = Math.abs(a.y - back) + Math.abs(a.x - b.x) + Math.abs(b.y - back);
  return Math.min(viaFront, viaBack);
}

/** One-way walk from the stockroom door to a facing: what ranks a slot for merchandising. */
export function stockDistance(layout: Layout, f: Facing): number {
  return walkDistance(layout, layout.stockDoor, f);
}

/**
 * S-shape route length for an order pick: enter every aisle that holds a line
 * and walk it end to end between the front and back cross aisles, alternating
 * direction; with an odd number of aisles the last is a return trip to its
 * deepest line. Open-floor fixtures are picked up on the way past, at their own
 * x, so they widen the horizontal run without adding a pass.
 */
export function sShapeDistance(layout: Layout, facings: Facing[]): number {
  if (facings.length === 0) return 0;
  const start = layout.bench;
  const byAisle = new Map<number, { x: number; deepest: number }>();
  const loose: number[] = [];
  for (const f of facings) {
    if (f.aisle < 0) {
      loose.push(f.x);
      continue;
    }
    const a = byAisle.get(f.aisle);
    const depth = f.y - layout.salesFrontY;
    if (!a) byAisle.set(f.aisle, { x: f.x, deepest: depth });
    else a.deepest = Math.max(a.deepest, depth);
  }
  const aisles = [...byAisle.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const L = layout.salesAisleLength;
  const frontGap = Math.abs(layout.salesFrontY - start.y);
  let vertical = 0;
  if (aisles.length > 0) {
    if (aisles.length % 2 === 0) vertical = aisles.length * L;
    else vertical = (aisles.length - 1) * L + 2 * aisles[aisles.length - 1].deepest;
  }
  const xs = [...aisles.map((a) => a.x), ...loose];
  if (xs.length === 0) return 2 * frontGap;
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const horizontal = Math.abs(start.x - xmin) + (xmax - xmin) + Math.abs(xmax - start.x);
  return vertical + horizontal + 2 * frontGap;
}

/** Rectilinear distance in the stockroom, between a door and a storage position. */
export function doorToStorage(door: { x: number; y: number }, pos: StoragePosition): number {
  return Math.abs(pos.x - door.x) + Math.abs(pos.y - door.y);
}

/** Distance between two stockroom positions, via the aisle head unless they share an aisle. */
export function storageToStorage(layout: Layout, a: StoragePosition, b: StoragePosition): number {
  if (a.aisle === b.aisle) return Math.abs(a.y - b.y);
  const head = Math.min(a.y, b.y, layout.spec.backroomY + 3);
  return a.y - head + Math.abs(a.x - b.x) + (b.y - head);
}
