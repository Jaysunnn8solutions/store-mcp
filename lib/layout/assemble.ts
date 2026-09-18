/**
 * From classified drawing shapes to a store layout spec. Every geometric
 * importer (DXF, GeoJSON/IMDF, IFC) reduces its format to RawFeatures — shapes
 * in feet carrying whatever the file called them, a layer, a block name, an
 * IMDF category, an IFC type — and hands them here. This module decides what
 * each one is, turns the plan the right way round, merges footprints into runs,
 * sorts the doors, finds the stockroom line and writes the report.
 *
 * Orientation is the one thing a shop does differently from a warehouse. A
 * warehouse points its racks away from the dock wall. A shop has a STOREFRONT:
 * the wall the customers and the parking are on, and that wall is y = 0. It is
 * found, in order, from the customer entrance doors, the glazing run, the goods
 * doors on the opposite wall, the longest wall with the most openings, the
 * checkout and seasonal fixtures that always sit near the door, and finally the
 * deeper of the two clear aprons in front of the first fixture. Whichever rule
 * fires is named in `report.orientedBy`, because a plan turned the wrong way
 * round is the one import mistake that looks fine and simulates nonsense.
 *
 * Fixture runs are rotated to run in y first, so a shopper walks an aisle away
 * from the door; the storefront choice is then only which end of y is 0. When a
 * drawing puts the storefront on a wall parallel to the runs, the runs win and
 * the report warns, because `buildLayout` finds aisles from gaps in x and a
 * plan whose runs lie across x has no aisles at all.
 */

import { bbox, convexHull, dominantAngle, orientedBox, pointInRing, ringArea, rotate, simplify, type OrientedBox } from "./geometry";
import { LIMITS } from "./limits";
import { compactSpec, type DoorSpec, type FixtureKind, type FixtureRun, type LayoutSpec, type ParkingSpec, type Point, type ServiceSpec, type StorageRun, type ZoneSpec } from "./spec";

/**
 * What a layer, block, category or feature in the source file is. `wall` is
 * wall shelving a shopper buys from; `wall-line` is the building fabric.
 */
export type Role =
  | "gondola"
  | "wall"
  | "bulk"
  | "showcase"
  | "endcap"
  | "seasonal"
  | "impulse"
  | "rack"
  | "shelving"
  | "register"
  | "counter"
  | "wrap"
  | "entrance"
  | "dock"
  | "ground"
  | "parking"
  | "wall-line"
  | "outline"
  | "backroom"
  | "office"
  | "ignore";

/** The order the roles are offered in, on the web page and in the MCP enum. */
export const ROLES: Role[] = [
  "gondola",
  "wall",
  "bulk",
  "showcase",
  "endcap",
  "seasonal",
  "impulse",
  "rack",
  "shelving",
  "register",
  "counter",
  "wrap",
  "entrance",
  "dock",
  "ground",
  "parking",
  "wall-line",
  "outline",
  "backroom",
  "office",
  "ignore",
];

export interface RawFeature {
  /** What the file calls it: a layer, block, category, or a type and name. */
  source: string;
  kind: "ring" | "line" | "point";
  /** Already in feet, still in the source's own frame. */
  points: Point[];
  /** The importer's own reading (an IMDF category, an IFC type), used when no pattern matches. */
  hint?: Role;
  /** Doors only: an explicit width, otherwise it comes from the shape. */
  widthFt?: number;
}

export interface AssembleOptions {
  name: string;
  format: LayoutSpec["source"]["format"];
  file?: string;
  /** Pattern → role. A pattern is a case-insensitive substring, or /regex/. Checked before the defaults. */
  roleMap?: Record<string, Role>;
  /** Selling shelves per bay, when the drawing cannot say (per-fixture defaults otherwise). */
  shelves?: number;
  facingsPerBay?: number;
  aisleWidthFt?: number;
  shelfHeightFt?: number;
  /** Where the unit came from, for the report ("$INSUNITS: millimeters"). */
  unitsFrom?: string;
  assumptions?: string[];
  warnings?: string[];
}

/** The file could not be read, or holds nothing a store is made of. */
export class ImportError extends Error {}

export interface ImportReport {
  format: string;
  name: string;
  /** How the drawing's unit was decided. */
  unitsFrom: string;
  /** Which rule put the storefront at y = 0, and how far the plan was turned. */
  orientedBy: string;
  layers: Array<{ layer: string; role: Role; count: number; note?: string }>;
  /** What the importer had to decide for itself. These travel with the spec. */
  assumptions: string[];
  /** What is probably wrong with the result. */
  warnings: string[];
  counts: {
    /** Runs, not facings: one gondola is one run. */
    fixtures: number;
    storage: number;
    /** Facings the twin reads, from the dry run through buildLayout. */
    facings: number;
    service: number;
    doors: number;
    /** Sales-floor aisles the twin found between the runs. */
    aisles: number;
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * First match wins. The retail vocabulary comes first because a store planner
 * writes GONDOLA, CASE, POS and CHECKOUT; the NCS layer names (A-WALL,
 * A-FLOR-OTLN, A-EQPM, A-FURN) come last, as the generic catch that they are.
 *
 * Note where this differs from a warehouse table: "bulk" and "bin" mean scoop
 * bins on the sales floor, not overstock, and "case" means a glass showcase.
 */
const DEFAULT_PATTERNS: Array<[RegExp, Role]> = [
  [/(^|[^a-z])(text|dim|dimension|anno|annotation|hatch|grid|title|border|defpoints|viewport|xref|symbol|light|elec|power|plumb|hvac|sprink|ceil|rcp|note|leader)/i, "ignore"],
  // Doors first: several of their words also appear on the fixtures beside them.
  [/(entrance|\bentry\b|vestibule|front.?door|main.?door|automatic.?door|air.?curtain)/i, "entrance"],
  [/(dock|leveler|overhead.?door|\bohd\b)/i, "dock"],
  [/(roll.?up|grade.?door|goods.?door|van.?bay|service.?door)/i, "ground"],
  // The service counter, front to back.
  [/(register|\bpos\b|check.?out|check.?stand|cash.?wrap|\btill\b|checklane)/i, "register"],
  [/(gift.?wrap|wrap.?station|\bwrap\b)/i, "wrap"],
  [/(show.?case|display.?case|case.?line|glass.?case|serve.?over|\bcase\b)/i, "showcase"],
  [/(back.?bar|service.?station|\bcounter\b)/i, "counter"],
  // Selling fixtures.
  [/(end.?cap|\bec\b)/i, "endcap"],
  [/(bulk|scoop|gravity.?bin|candy.?bin|dispenser|\bbins?\b)/i, "bulk"],
  [/(seasonal|feature.?deck|promo|\btable\b|dump.?bin)/i, "seasonal"],
  [/(impulse|queue.?rack|spinner|clip.?strip)/i, "impulse"],
  [/(gondola|\bgond\b|planogram|\bpog\b)/i, "gondola"],
  [/(wall.?bay|wall.?shelf|wall.?shelv|wall.?unit|perimeter.?shelv|slat.?wall|\bslatwall\b)/i, "wall"],
  // Stockroom.
  [/(pallet.?rack|racking|high.?bay|\bpallet\b)/i, "rack"],
  [/(case.?shelf|back.?stock|stock.?shelf|wire.?shelv|bulk.?rack)/i, "shelving"],
  // The generic fixture layers a real drawing actually uses, read as gondolas.
  [/(fixture|furn.?fixt|i.?fixt|casework|millwork|shelv|shlf|eqpm|furn)/i, "gondola"],
  // Rooms and building fabric.
  [/(stock.?room|back.?room|\bboh\b|back.?of.?house|receiving|storage.?room|store.?room)/i, "backroom"],
  [/(office|restroom|toilet|\bbreak\b|locker|staff|manager|lounge)/i, "office"],
  [/(parking|car.?park|\bstall\b|curb|drive.?aisle)/i, "parking"],
  // Deliberately narrow: bare "building" and "exterior" also appear inside IFC
  // type names and wall descriptions, where they mean anything but the outline.
  [/(outline|otln|footprint|perimeter|lease.?line|bldg.?line|building.?line)/i, "outline"],
  [/(glaz|curtain.?wall|mullion|window|storefront)/i, "wall-line"],
  [/(wall|partition|column|a-cols)/i, "wall-line"],
  // Anything still called a door is a door; which kind is decided by where it lands.
  [/(door|opening)/i, "entrance"],
];

/**
 * A door word inside a room name ("DOCK AREA", "ENTRY LOBBY SPACE") is a room,
 * not a door, unless the name also says door. Matches are then retried further
 * down the table.
 */
const ROOMY = /\b(room|area|space|zone|lobby)\b/i;
const DOORY = /(door|opening|leveler|overhead|roll.?up|ohd|vestibule)/i;

const DOOR_ROLES: ReadonlySet<Role> = new Set<Role>(["entrance", "dock", "ground"]);

function matchPattern(pattern: string, source: string): boolean {
  const m = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try {
      return new RegExp(m[1], m[2].includes("i") ? m[2] : `${m[2]}i`).test(source);
    } catch {
      return false;
    }
  }
  return source.toLowerCase().includes(pattern.toLowerCase());
}

/** A caller's roleMap first, then the built-in table, then the importer's hint. */
export function roleOf(f: RawFeature, roleMap?: Record<string, Role>): Role {
  for (const [p, r] of Object.entries(roleMap ?? {})) if (matchPattern(p, f.source)) return r;
  for (const [re, r] of DEFAULT_PATTERNS) {
    if (!re.test(f.source)) continue;
    if (DOOR_ROLES.has(r) && ROOMY.test(f.source) && !DOORY.test(f.source) && f.hint !== "entrance") continue;
    return r;
  }
  return f.hint ?? "ignore";
}

/** True when the caller named this source themselves, so its role is not a guess. */
function mappedByCaller(source: string, roleMap?: Record<string, Role>): boolean {
  return Object.keys(roleMap ?? {}).some((p) => matchPattern(p, source));
}

// ---------------------------------------------------------------------------
// What a fixture is, when the drawing does not say
// ---------------------------------------------------------------------------

/** The fixture family a role names, when it names one at all. */
export const FIXTURE_ROLE_OF: Partial<Record<Role, FixtureKind>> = {
  gondola: "gondola",
  wall: "wall",
  bulk: "bulk",
  showcase: "showcase",
  endcap: "endcap",
  seasonal: "seasonal",
  impulse: "impulse",
};
const STORAGE_OF: Partial<Record<Role, StorageRun["kind"]>> = { rack: "rack", shelving: "shelving" };
const SERVICE_OF: Partial<Record<Role, ServiceSpec["kind"]>> = { register: "register", counter: "counter", wrap: "wrap" };

/**
 * What a drawing cannot tell you: how wide a bay is, how many shelves it has
 * and how many facings fit side by side on one. A plan is a plan view, so the
 * vertical dimension is always assumed, and these are the numbers the committed
 * candy shops are built from. A fixture export that carries its own shelf and
 * facing rows overrides them row by row; `shelves` and `facingsPerBay` override
 * them wholesale.
 */
export const SECTION_FT: Record<FixtureKind, number> = { gondola: 4, wall: 4, endcap: 4, bulk: 3, showcase: 4, impulse: 2.5, seasonal: 9 };
export const SHELVES_OF: Record<FixtureKind, number> = { gondola: 5, wall: 5, endcap: 4, bulk: 4, showcase: 3, impulse: 4, seasonal: 2 };
export const FACINGS_OF: Record<FixtureKind, number> = { gondola: 3, wall: 3, endcap: 3, bulk: 2, showcase: 4, impulse: 2, seasonal: 3 };
export const STORAGE_BAY_FT: Record<StorageRun["kind"], number> = { rack: 4, shelving: 3 };
export const STORAGE_LEVELS: Record<StorageRun["kind"], number> = { rack: 3, shelving: 4 };

/** Shortest thing that can be a run, and the deepest footprint still a fixture. */
const MIN_RUN_FT = 1.2;
const MAX_DEPTH_FT = 16;
/** A gondola this deep or deeper is shopped from both sides. */
const DOUBLE_SIDED_FT = 3;
/** Default clear height of one selling shelf, matching the committed stores. */
const DEFAULT_SHELF_HEIGHT_FT = 1.25;
const DEFAULT_AISLE_FT = 5.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampInt = (v: number, lo: number, hi: number) => clamp(Math.round(v), lo, hi);

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

// ---------------------------------------------------------------------------
// The shared tail: doors, service, the stockroom line, zones, the spec
// ---------------------------------------------------------------------------

/** What a door feature said about itself, before its position is looked at. */
type DoorSense = "entrance" | "goods" | "generic";

interface DoorCand {
  x: number;
  y: number;
  widthFt: number;
  role: Role;
  sense: DoorSense;
  source: string;
}

/**
 * Everything an importer has worked out about a building, in the canonical
 * frame, before the parts a store must have are filled in. Both entries —
 * `assemble` from geometry, `specFromParts` from a structured file — build one
 * of these and hand it to `finish`.
 */
interface Draft {
  widthFt: number;
  depthFt: number;
  fixtures: FixtureRun[];
  storage: StorageRun[];
  service: ServiceSpec[];
  doors: DoorCand[];
  parking: ParkingSpec | null;
  outline: Point[] | null;
  walls: Point[][];
  /** Rooms worth drawing: offices, break rooms, restrooms. */
  rooms: ZoneSpec[];
  /** Where a drawn stockroom starts, when the file drew one. */
  backroomFromZone: number | null;
}

/** Endcaps, tables and the impulse rack are reached from open floor, not an aisle. */
const OPEN_FLOOR: ReadonlySet<FixtureKind> = new Set<FixtureKind>(["endcap", "seasonal", "impulse"]);

/**
 * The aisle width a run with open floor on one side should assume: the median
 * of the gaps the drawing already has between runs that face each other. Only
 * shelved runs that overlap along y count, which is the same test buildLayout
 * uses to pair them, so the number comes from real aisles rather than from the
 * clearance around a seasonal table.
 */
function aisleWidthOf(fixtures: FixtureRun[], given?: number): { ft: number; derived: boolean } {
  if (given !== undefined) return { ft: clamp(given, 2.5, 20), derived: false };
  const sorted = fixtures.filter((f) => !OPEN_FLOOR.has(f.kind)).sort((a, b) => a.x - b.x);
  const gaps: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (overlap < 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) continue;
    const gap = b.x - b.depthFt / 2 - (a.x + a.depthFt / 2);
    if (gap >= 2.5 && gap <= 20) gaps.push(gap);
  }
  if (gaps.length === 0) return { ft: DEFAULT_AISLE_FT, derived: false };
  gaps.sort((a, b) => a - b);
  return { ft: clamp(Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10, 2.5, 20), derived: true };
}

function finish(draft: Draft, opts: AssembleOptions, report: { unitsFrom: string; orientedBy: string; layers: ImportReport["layers"] }): { spec: LayoutSpec; report: ImportReport } {
  const assumptions = [...(opts.assumptions ?? [])];
  const warnings = [...(opts.warnings ?? [])];
  const W = Math.max(draft.widthFt, 1);
  const D = Math.max(draft.depthFt, 1);
  const fixtures = draft.fixtures;
  const storage = draft.storage;
  if (fixtures.length === 0) throw new ImportError("Nothing on the sales floor. Map the fixture layers with roleMap, e.g. {\"A-FURN-FIXT\": \"gondola\", \"CASE\": \"showcase\"}.");
  if (fixtures.length + storage.length > LIMITS.maxFixtureRuns) {
    throw new ImportError(`The plan has ${fixtures.length + storage.length} runs; the limit is ${LIMITS.maxFixtureRuns}. Map the fixture layers more narrowly with roleMap.`);
  }

  // Doors. A labelled door keeps its family and is put on its own wall; an
  // unlabelled one is read from where it sits, and one stranded in the middle
  // of the building is a personnel door the twin does not model.
  const band = Math.max(12, D * 0.12);
  const dropped = new Map<string, number>();
  const doors: DoorSpec[] = [];
  for (const d of draft.doors) {
    const atFront = d.y <= band;
    const atBack = d.y >= D - band;
    let kind: DoorSpec["kind"] | null = null;
    if (d.sense === "entrance") kind = "entrance";
    else if (d.sense === "goods") kind = d.role === "ground" ? "ground" : "dock";
    else if (atFront) kind = "entrance";
    else if (atBack) kind = "dock";
    if (!kind) {
      dropped.set(d.source, (dropped.get(d.source) ?? 0) + 1);
      continue;
    }
    doors.push({ id: "", kind, x: clamp(d.x, 0, W), y: kind === "entrance" ? 0 : D, widthFt: clamp(d.widthFt >= 2.5 ? d.widthFt : kind === "entrance" ? 8 : 10, 2.5, 60) });
  }
  if (dropped.size) {
    const total = [...dropped.values()].reduce((a, b) => a + b, 0);
    warnings.push(`${total} door(s) away from the storefront and the back wall were read as personnel doors and left out.`);
    // Sorted so the same drawing always annotates the same rows in the same order.
    for (const source of [...dropped.keys()].sort()) {
      const row = report.layers.find((l) => l.layer === source);
      if (row) row.note = `${dropped.get(source)} read as a personnel door and left out`;
    }
  }
  if (!doors.some((d) => d.kind === "entrance")) {
    doors.push({ id: "", kind: "entrance", x: W / 2, y: 0, widthFt: 8 });
    assumptions.push("No customer entrance was found; one 8 ft entrance was put in the middle of the storefront.");
  }
  if (!doors.some((d) => d.kind === "dock" || d.kind === "ground")) {
    doors.push({ id: "", kind: "dock", x: W * 0.72, y: D, widthFt: 10 });
    assumptions.push("No goods door was found; one dock door was put on the back wall, three quarters of the way across.");
  }
  const goods = doors.filter((d) => d.kind !== "entrance");
  if (goods.length > 1 && !draft.doors.some((d) => d.role === "ground")) {
    // A back wall of unlabelled doors: the inboard one is the roll-up at grade,
    // the rest are raised docks, which is how the committed stores are built.
    goods.sort((a, b) => a.x - b.x)[0].kind = "ground";
    assumptions.push("The goods doors are not labelled: the one nearest the middle of the back wall is taken as a ground-level roll-up and the rest as raised docks.");
  }
  if (doors.length > LIMITS.maxDoors) {
    // Capped per family rather than overall, so a wall of wide dock doors can
    // never crowd out the entrance the twin refuses to open without.
    const widest = (list: DoorSpec[], n: number) => [...list].sort((a, b) => b.widthFt - a.widthFt || a.x - b.x).slice(0, Math.max(1, n));
    const ent = doors.filter((d) => d.kind === "entrance");
    const entN = Math.min(ent.length, Math.max(1, Math.round((LIMITS.maxDoors * ent.length) / doors.length)));
    const kept = [...widest(ent, entN), ...widest(doors.filter((d) => d.kind !== "entrance"), LIMITS.maxDoors - entN)];
    warnings.push(`${doors.length} doors were found; the widest ${kept.length} were kept.`);
    doors.length = 0;
    doors.push(...kept);
  }
  doors.sort((a, b) => a.kind.localeCompare(b.kind) || a.x - b.x);
  const seq = { entrance: 0, dock: 0, ground: 0 };
  for (const d of doors) d.id = d.kind === "entrance" ? `ENT-${++seq.entrance}` : d.kind === "dock" ? `DOCK-${++seq.dock}` : `GRND-${++seq.ground}`;

  // The service counter. A store that does not check anyone out cannot be
  // simulated, so a missing register is invented rather than refused.
  const service = draft.service.slice(0, LIMITS.maxServicePoints);
  const glass = fixtures.filter((f) => f.kind === "showcase").sort((a, b) => a.y0 - b.y0)[0] ?? null;
  const counterX = glass ? glass.x : W * 0.85;
  const facingOf = (x: number) => (x > W / 2 ? 270 : 90);
  if (!service.some((s) => s.kind === "register")) {
    service.push({ id: "REG-1", kind: "register", x: counterX, y: glass ? Math.max(4, glass.y0 - 8) : 6, facing: facingOf(counterX) });
    assumptions.push(`No checkout was found; one register was put ${glass ? "at the front of the showcase line" : "inside the door on the deep side of the store"}.`);
  }
  if (glass && !service.some((s) => s.kind === "counter")) {
    const behind = clamp(glass.x > W / 2 ? glass.x + glass.depthFt / 2 + 1.5 : glass.x - glass.depthFt / 2 - 1.5, 0, W);
    service.push({ id: "CTR-1", kind: "counter", x: behind, y: (glass.y0 + glass.y1) / 2, facing: facingOf(glass.x) });
    assumptions.push("A showcase with nobody behind it: one serving station was put in the corridor behind the glass.");
  }

  // Where the sales floor ends.
  const maxFixY1 = Math.max(...fixtures.map((f) => f.y1));
  let backroomY: number;
  if (draft.backroomFromZone !== null) {
    backroomY = clamp(draft.backroomFromZone, 0, D);
    assumptions.push(`The stockroom starts ${Math.round(backroomY)} ft in, where the drawing puts it.`);
  } else if (storage.length) {
    const minStorageY0 = Math.min(...storage.map((s) => s.y0));
    backroomY = clamp(minStorageY0 - 2 < maxFixY1 ? Math.min(minStorageY0, maxFixY1 + 0.5) : minStorageY0 - 2, 0, D);
    assumptions.push(`The stockroom starts ${Math.round(backroomY)} ft in, just in front of the first back-stock run.`);
  } else {
    backroomY = clamp(maxFixY1 + 4, 0, D);
    warnings.push("Nothing behind the sales floor is back stock, so the twin has nowhere to hold a delivery. Map the stockroom shelving with roleMap as rack or shelving.");
  }

  const zones: ZoneSpec[] = [
    ...draft.rooms.slice(0, 480),
    { kind: "sales", name: "Sales floor", ring: rect(0, 0, W, backroomY) },
    { kind: "backroom", name: "Stockroom", ring: rect(0, backroomY, W, D) },
  ];

  const aisle = aisleWidthOf(fixtures, opts.aisleWidthFt);
  if (aisle.derived) assumptions.push(`Aisles are ${aisle.ft} ft wide, the median gap between the runs in the drawing.`);

  const parking = draft.parking ?? { depthFt: 60, stalls: 20, accessibleStalls: 2, curbsideStalls: 2 };
  if (!draft.parking) assumptions.push("No parking was drawn; a 60 ft lot of 20 stalls, 2 of them accessible and 2 curbside, is assumed in front of the storefront.");

  const notes = [...assumptions, ...warnings];
  const spec = compactSpec({
    version: 1,
    name: opts.name.slice(0, 120),
    source: { format: opts.format, file: opts.file?.slice(0, 260), notes: notes.slice(0, 50).map((n) => n.slice(0, 400)) },
    widthFt: W,
    depthFt: D,
    outline: draft.outline ?? rect(0, 0, W, D),
    walls: draft.walls,
    zones,
    fixtures,
    storage,
    service,
    doors,
    parking,
    backroomY,
    aisleWidthFt: aisle.ft,
    shelfHeightFt: clamp(opts.shelfHeightFt ?? DEFAULT_SHELF_HEIGHT_FT, 0.5, 6),
  });
  return {
    spec,
    report: {
      format: opts.format,
      name: spec.name,
      unitsFrom: report.unitsFrom,
      orientedBy: report.orientedBy,
      layers: report.layers,
      assumptions,
      warnings,
      // facings and aisles need the twin's own geometry pass; importLayout fills them in.
      counts: { fixtures: spec.fixtures.length, storage: spec.storage.length, facings: 0, service: spec.service.length, doors: spec.doors.length, aisles: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// The geometric pipeline
// ---------------------------------------------------------------------------

type Side = "bottom" | "top" | "left" | "right";
const SIDES: Side[] = ["bottom", "top", "left", "right"];

function sideNearest(p: Point, b: { minX: number; minY: number; maxX: number; maxY: number }): Side {
  const dist: Record<Side, number> = { bottom: p[1] - b.minY, top: b.maxY - p[1], left: p[0] - b.minX, right: b.maxX - p[0] };
  return SIDES.reduce((a, k) => (dist[k] < dist[a] ? k : a), "bottom");
}

/** Majority side, with the fixed SIDES order breaking ties so a file always votes the same way. */
function vote(centres: Point[], b: { minX: number; minY: number; maxX: number; maxY: number }): Side | null {
  if (centres.length === 0) return null;
  const tally: Record<Side, number> = { bottom: 0, top: 0, left: 0, right: 0 };
  for (const c of centres) tally[sideNearest(c, b)]++;
  return SIDES.reduce((a, k) => (tally[k] > tally[a] ? k : a), "bottom");
}

function centreOf(points: Point[]): Point {
  const b = bbox(points);
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

const GLAZING = /(glaz|curtain.?wall|window|store.?front|shopfront)/i;

export function assemble(features: RawFeature[], opts: AssembleOptions): { spec: LayoutSpec; report: ImportReport } {
  if (features.length > LIMITS.maxEntities) {
    throw new ImportError(`The file has ${features.length.toLocaleString("en-US")} shapes; the limit is ${LIMITS.maxEntities.toLocaleString("en-US")}. Delete the annotation, ceiling and furniture layers before exporting.`);
  }
  const assumptions = [...(opts.assumptions ?? [])];
  const warnings = [...(opts.warnings ?? [])];

  // 1. Classify. The role recorded against a source is the first one seen for
  // it, which is stable because roleOf reads nothing but the source and hint.
  const bySource = new Map<string, { role: Role; count: number; note?: string }>();
  const classified = features.map((f) => {
    const role = roleOf(f, opts.roleMap);
    const s = bySource.get(f.source) ?? { role, count: 0 };
    s.count++;
    bySource.set(f.source, s);
    return { f, role };
  });

  // 2. Footprints worth calling a run.
  const tooSmall = new Map<string, number>();
  const kept: Array<{ f: RawFeature; role: Role; box: OrientedBox }> = [];
  for (const c of classified) {
    if ((FIXTURE_ROLE_OF[c.role] === undefined && STORAGE_OF[c.role] === undefined) || c.f.points.length < 2) continue;
    const box = orientedBox(c.f.points);
    if (box && box.length >= MIN_RUN_FT && box.width >= 0.25 && box.width <= MAX_DEPTH_FT) kept.push({ ...c, box });
    else tooSmall.set(c.f.source, (tooSmall.get(c.f.source) ?? 0) + 1);
  }
  if (kept.length === 0) {
    const seen = [...bySource.entries()]
      .slice(0, 25)
      .map(([s, v]) => `${s} → ${v.role}`)
      .join("; ");
    throw new ImportError(
      `No shelving or racking was found. Sources and how they were read: ${seen || "none"}. Pass roleMap to say which layers or categories are fixtures, e.g. {"A-FURN-FIXT": "gondola", "BULK": "bulk", "STOCKROOM": "shelving"}.`
    );
  }

  // 3. Turn the runs to +y.
  const axisRoles: ReadonlySet<Role> = new Set<Role>(["gondola", "wall", "bulk", "showcase", "rack", "shelving"]);
  const axis = kept.filter((c) => axisRoles.has(c.role));
  let theta = Math.PI / 2 - dominantAngle((axis.length ? axis : kept).map((c) => ({ angle: c.box.angle, weight: c.box.length })));

  // The building's extent leaves the parking out: the lot lies in front of the
  // storefront, at negative y, and must not shift the store off y = 0.
  const framePoints = classified.filter((c) => c.role !== "ignore" && c.role !== "parking").flatMap((c) => c.f.points);
  const turn0 = (p: Point): Point => rotate(p, theta);
  const bb0 = bbox(framePoints.map(turn0));

  // 4. Which wall is the storefront.
  const doorFeatures = classified.filter((c) => DOOR_ROLES.has(c.role));
  const senseOf = (source: string, role: Role): DoorSense => {
    if (mappedByCaller(source, opts.roleMap)) return role === "entrance" ? "entrance" : "goods";
    if (/(entrance|\bentry\b|vestibule|front.?door|main.?door|automatic.?door|air.?curtain)/i.test(source)) return "entrance";
    if (/(dock|leveler|overhead.?door|ohd|roll.?up|grade.?door|goods.?door|van.?bay|service.?door|receiv)/i.test(source)) return "goods";
    return "generic";
  };
  const doorSense = doorFeatures.map((c) => ({ c, sense: senseOf(c.f.source, c.role), centre: centreOf(c.f.points.map(turn0)) }));
  const entranceCentres = doorSense.filter((d) => d.sense === "entrance").map((d) => d.centre);
  const goodsCentres = doorSense.filter((d) => d.sense === "goods").map((d) => d.centre);
  const glazeCentres = classified.filter((c) => c.role === "wall-line" && GLAZING.test(c.f.source) && c.f.points.length >= 2).map((c) => centreOf(c.f.points.map(turn0)));
  const frontish = classified.filter((c) => c.role === "register" || c.role === "seasonal" || c.role === "impulse" || c.role === "wrap").map((c) => centreOf(c.f.points.map(turn0)));

  const opposite: Record<Side, Side> = { bottom: "top", top: "bottom", left: "right", right: "left" };
  let front: Side | null = vote(entranceCentres, bb0);
  let orientedBy = front ? `the ${entranceCentres.length} customer entrance door(s)` : "";
  if (!front && glazeCentres.length) {
    front = vote(glazeCentres, bb0);
    orientedBy = "the glazing run, which is the storefront";
  }
  if (!front && goodsCentres.length) {
    const back = vote(goodsCentres, bb0);
    if (back) {
      front = opposite[back];
      orientedBy = `the ${goodsCentres.length} goods door(s), taking the opposite wall as the storefront`;
    }
  }
  if (!front && doorSense.length) {
    // The longest wall with the most openings in it. Openings outrank length,
    // which only breaks the tie, because a blank long wall is not a storefront.
    const wallPoints = classified.filter((c) => c.role === "wall-line" || c.role === "outline").flatMap((c) => c.f.points.map(turn0));
    const wallB = wallPoints.length ? bbox(wallPoints) : bb0;
    const openings: Record<Side, number> = { bottom: 0, top: 0, left: 0, right: 0 };
    for (const d of doorSense) openings[sideNearest(d.centre, bb0)]++;
    const lengthOf: Record<Side, number> = { bottom: wallB.maxX - wallB.minX, top: wallB.maxX - wallB.minX, left: wallB.maxY - wallB.minY, right: wallB.maxY - wallB.minY };
    front = SIDES.reduce((a, k) => (openings[k] * 1e4 + lengthOf[k] > openings[a] * 1e4 + lengthOf[a] ? k : a), "bottom");
    orientedBy = "the longest wall with the most openings";
  }
  if (!front && frontish.length) {
    front = vote(frontish, bb0);
    orientedBy = "the checkout and seasonal fixtures, which stand near the door";
  }
  if (!front) {
    // Last resort: a shop leaves an entry apron in front of its first fixture
    // and crams the back wall. The deeper clear end is the storefront.
    const runPoints = kept.flatMap((c) => c.f.points.map(turn0));
    const rb = bbox(runPoints);
    front = rb.minY - bb0.minY >= bb0.maxY - rb.maxY ? "bottom" : "top";
    orientedBy = "the deeper clear apron in front of the first fixture run, with nothing else to go on";
    warnings.push("The drawing has no entrance, glazing or goods door to place the storefront by; check that the plan came out the right way round and pass roleMap if it did not.");
  }
  if (front === "top") theta += Math.PI;
  if (front === "left" || front === "right") {
    warnings.push("The storefront is on a wall parallel to the fixture runs. The plan was kept with the runs front to back, so the aisles are real but the walk in from the door is approximate.");
  }

  // 5. Settle the frame.
  const T0 = (p: Point): Point => rotate(p, theta);
  const bb = bbox(framePoints.map(T0));
  const T = (p: Point): Point => {
    const r = rotate(p, theta);
    return [r[0] - bb.minX, r[1] - bb.minY];
  };
  const W = bb.maxX - bb.minX;
  const D = bb.maxY - bb.minY;
  if (W > LIMITS.maxSideFt || D > LIMITS.maxSideFt) {
    throw new ImportError(`The drawing is ${Math.round(W)}×${Math.round(D)} ft, over the ${LIMITS.maxSideFt} ft limit on a side. Check the units (pass unitsFt), or delete the site-plan geometry around the shop.`);
  }
  const deg = Math.round(((((theta * 180) / Math.PI) % 360) + 360) % 360);
  if (deg) orientedBy += `; the plan was turned ${deg}° so the runs go front to back`;

  // 6. Footprints → runs. Everything is axis aligned by now, so a run is just
  // the box: its x span is the depth and its y span the length.
  interface Placed {
    role: Role;
    source: string;
    x: number;
    y0: number;
    y1: number;
    depth: number;
  }
  const placed: Placed[] = kept.map((c) => {
    const b = bbox(c.f.points.map(T));
    return { role: c.role, source: c.f.source, x: (b.minX + b.maxX) / 2, y0: b.minY, y1: b.maxY, depth: Math.max(0.5, b.maxX - b.minX) };
  });
  placed.sort((a, b) => a.x - b.x || a.y0 - b.y0 || a.source.localeCompare(b.source));

  interface Group extends Placed {
    count: number;
    longest: number;
  }
  const groups: Group[] = [];
  for (const p of placed) {
    // Drawn bay by bay: collinear, same depth, same family, touching in y.
    const g = groups.find((q) => Math.abs(q.x - p.x) < 0.75 && Math.abs(q.depth - p.depth) < 1 && q.role === p.role && p.y0 - q.y1 <= 1.5 && p.y0 >= q.y0 - 0.5);
    if (g) {
      g.y1 = Math.max(g.y1, p.y1);
      g.count++;
      g.longest = Math.max(g.longest, p.y1 - p.y0);
    } else {
      groups.push({ ...p, count: 1, longest: p.y1 - p.y0 });
    }
  }

  // 7. The stockroom line, provisionally, so a fixture drawn behind it can be
  // read as back stock. A drawn room wins; failing that the back-stock runs
  // themselves; failing both, the back quarter of a plan that has neither.
  const backroomRings = classified.filter((c) => c.role === "backroom" && c.f.points.length >= 3).map((c) => c.f.points.map(T));
  let backroomFromZone: number | null = null;
  if (backroomRings.length) backroomFromZone = Math.min(...backroomRings.map((r) => bbox(r).minY));
  const storageGroups = groups.filter((g) => STORAGE_OF[g.role] !== undefined);
  let line: number;
  if (backroomFromZone !== null) line = backroomFromZone;
  else if (storageGroups.length) line = Math.min(...storageGroups.map((g) => g.y0)) - 0.5;
  else {
    line = D * 0.75;
    const behind = groups.filter((g) => g.y0 >= line);
    if (behind.length) assumptions.push("Nothing says where the stockroom is, so the runs in the back quarter of the plan were read as back stock.");
    else line = D + 1;
  }
  const inBackroom = (g: Group): boolean => {
    if (backroomRings.length) return backroomRings.some((r) => pointInRing([g.x, (g.y0 + g.y1) / 2], r));
    return g.y0 >= line;
  };

  const fixtures: FixtureRun[] = [];
  const storage: StorageRun[] = [];
  let moved = 0;
  for (const g of groups) {
    const back = inBackroom(g);
    const storageKind = STORAGE_OF[g.role];
    if (storageKind !== undefined || back) {
      const kind: StorageRun["kind"] = storageKind ?? (g.depth >= 3.5 ? "rack" : "shelving");
      if (storageKind === undefined) moved++;
      const len = g.y1 - g.y0;
      const bays = g.count > 1 && g.longest <= 6 ? g.count : Math.max(1, Math.round(len / STORAGE_BAY_FT[kind]));
      storage.push({ id: `S${storage.length + 1}`, kind, x: g.x, y0: g.y0, y1: g.y1, depthFt: clamp(g.depth, 0.5, 20), bays: clampInt(bays, 1, 200), levels: clampInt(STORAGE_LEVELS[kind], 1, 10) });
      continue;
    }
    const kind = FIXTURE_ROLE_OF[g.role]!;
    const len = g.y1 - g.y0;
    const bays = g.count > 1 && g.longest <= 6 ? g.count : Math.max(1, Math.round(len / SECTION_FT[kind]));
    fixtures.push({
      id: `F${fixtures.length + 1}`,
      kind,
      x: g.x,
      y0: g.y0,
      y1: g.y1,
      depthFt: clamp(g.depth, 0.5, 20),
      shelves: clampInt(opts.shelves ?? SHELVES_OF[kind], 1, 10),
      bays: clampInt(bays, 1, 200),
      facingsPerBay: clampInt(opts.facingsPerBay ?? FACINGS_OF[kind], 1, 20),
      doubleSided: kind === "gondola" && g.depth >= DOUBLE_SIDED_FT,
    });
  }
  if (moved) assumptions.push(`${moved} run(s) behind the sales floor were read as back stock rather than selling shelves.`);

  // 8. Doors, service points, parking, rooms, walls, outline.
  const doors: DoorCand[] = doorSense.map(({ c, sense }) => {
    const b = bbox(c.f.points.map(T));
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, widthFt: c.f.widthFt ?? Math.max(b.maxX - b.minX, b.maxY - b.minY, 0), role: c.role, sense, source: c.f.source };
  });
  const service: ServiceSpec[] = [];
  for (const c of classified) {
    const kind = SERVICE_OF[c.role];
    if (kind === undefined || c.f.points.length === 0 || service.length >= LIMITS.maxServicePoints) continue;
    const [x, y] = centreOf(c.f.points.map(T));
    service.push({ id: `${kind === "register" ? "REG" : kind === "counter" ? "CTR" : "WRAP"}-${service.filter((s) => s.kind === kind).length + 1}`, kind, x, y, facing: x > W / 2 ? 270 : 90 });
  }

  // Parking sits in front of the storefront, so only its depth and area matter.
  const parkPoints = classified.filter((c) => c.role === "parking").flatMap((c) => c.f.points.map(T0));
  let parking: ParkingSpec | null = null;
  if (parkPoints.length >= 3) {
    const pb = bbox(parkPoints);
    const depthFt = Math.round(clamp(Math.max(bb.minY - pb.minY, pb.maxY - bb.maxY, pb.maxY - pb.minY), 0, 400) * 10) / 10;
    const stalls = clampInt(((pb.maxX - pb.minX) * (pb.maxY - pb.minY)) / 320, 0, 500);
    parking = { depthFt, stalls, accessibleStalls: clampInt(Math.max(1, stalls / 25), 0, 50), curbsideStalls: clampInt(clamp(stalls * 0.06, 1, 4), 0, 20) };
    assumptions.push(`The lot was measured from the drawing: ${stalls} stalls at 320 sq ft each, ${parking.accessibleStalls} of them accessible.`);
  }

  const rooms: ZoneSpec[] = [];
  for (const c of classified) {
    if (c.role !== "office" || c.f.points.length < 3 || rooms.length >= 400) continue;
    rooms.push({ kind: "office", name: c.f.source.slice(0, 80), ring: simplify(convexHull(c.f.points.map(T)), 0.5).slice(0, 500) });
  }

  let wallPoints = 0;
  const walls: Point[][] = [];
  for (const c of classified) {
    if (c.role !== "wall-line" || c.f.points.length < 2) continue;
    const w = simplify(c.f.points.map(T), 0.5);
    wallPoints += w.length;
    if (wallPoints > 20_000) {
      warnings.push("Wall geometry was truncated at 20,000 points; walls are only drawn, so the simulation is unaffected.");
      break;
    }
    walls.push(c.f.kind === "ring" ? [...w, w[0]] : w);
  }
  const outlines = classified.filter((c) => c.role === "outline" && c.f.points.length >= 3).map((c) => c.f.points.map(T));
  let outline: Point[] | null = null;
  if (outlines.length) outline = simplify(outlines.sort((a, b) => ringArea(b) - ringArea(a))[0], 0.5);
  else assumptions.push("No building outline was drawn; the outline is the extent of the plan.");

  if (tooSmall.size) {
    for (const source of [...tooSmall.keys()].sort()) {
      const row = bySource.get(source);
      if (row) row.note = `${tooSmall.get(source)} shape(s) too small or too deep to be a run were skipped`;
    }
  }
  // Sorted by count and then by name: a Map's own order would tie the report to
  // the order the parser happened to emit shapes in.
  const layers = [...bySource.entries()].map(([layer, v]) => ({ layer, role: v.role, count: v.count, note: v.note })).sort((a, b) => b.count - a.count || a.layer.localeCompare(b.layer));

  return finish(
    { widthFt: W, depthFt: D, fixtures, storage, service, doors, parking, outline, walls, rooms, backroomFromZone },
    { ...opts, assumptions, warnings },
    { unitsFrom: opts.unitsFrom ?? "feet", orientedBy, layers }
  );
}

// ---------------------------------------------------------------------------
// The structured path
// ---------------------------------------------------------------------------

export interface PartsInput {
  fixtures: FixtureRun[];
  storage: StorageRun[];
  service: ServiceSpec[];
  doors: Array<{ kind?: DoorSpec["kind"]; x: number; y: number; widthFt?: number }>;
  parking?: ParkingSpec;
}

/**
 * Build a spec from runs already in the canonical frame — the path a fixture
 * or planogram export takes, because that file already knows its aisles, bays
 * and shelves and has no geometry to classify. The frame is shifted so nothing
 * is negative, with a margin at the sides and an entry apron at the front.
 */
export function specFromParts(parts: PartsInput, opts: AssembleOptions & { marginFt?: number }): { spec: LayoutSpec; report: ImportReport } {
  const runs = [...parts.fixtures, ...parts.storage];
  if (runs.length === 0) throw new ImportError("No fixtures in the file.");
  const margin = opts.marginFt ?? 3;
  const apron = 6;
  // The building is what the fixtures and the counter span, plus a margin and
  // an entry apron. Doors are left out of it: a door is on a wall by
  // definition, and `finish` puts each one on the wall its family belongs to,
  // so letting a door row set the extent would only stretch the shop around it.
  const xs = [...runs.map((r) => r.x - r.depthFt / 2), ...runs.map((r) => r.x + r.depthFt / 2), ...parts.service.map((s) => s.x)];
  const ys = [...runs.map((r) => r.y0), ...runs.map((r) => r.y1), ...parts.service.map((s) => s.y)];
  const minX = Math.min(...xs) - margin;
  const maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - apron;
  const maxY = Math.max(...ys) + apron;
  const W = maxX - minX;
  const D = maxY - minY;
  if (W > LIMITS.maxSideFt || D > LIMITS.maxSideFt) {
    throw new ImportError(`The fixtures span ${Math.round(W)}×${Math.round(D)} ft, over the ${LIMITS.maxSideFt} ft limit on a side; check the coordinate units.`);
  }
  const shiftRun = <T extends { x: number; y0: number; y1: number }>(r: T): T => ({ ...r, x: r.x - minX, y0: r.y0 - minY, y1: r.y1 - minY });
  return finish(
    {
      widthFt: W,
      depthFt: D,
      fixtures: parts.fixtures.map(shiftRun),
      storage: parts.storage.map(shiftRun),
      service: parts.service.map((s) => ({ ...s, x: s.x - minX, y: s.y - minY, facing: s.x - minX > W / 2 ? 270 : 90 })),
      doors: parts.doors.map((d, i) => ({
        x: d.x - minX,
        y: d.y - minY,
        widthFt: d.widthFt ?? 0,
        role: (d.kind ?? "entrance") as Role,
        sense: d.kind === undefined ? "generic" : d.kind === "entrance" ? "entrance" : "goods",
        source: `row ${i + 1}`,
      })),
      parking: parts.parking ?? null,
      outline: null,
      walls: [],
      rooms: [],
      backroomFromZone: null,
    },
    opts,
    { unitsFrom: opts.unitsFrom ?? "feet", orientedBy: "the file itself, which already says which end is the storefront", layers: [] }
  );
}
