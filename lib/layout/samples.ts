/**
 * One sample candy shop written in every format the importers read, for the
 * round-trip test and for the web page's "try a sample" files. The same shop
 * each time, drawn the way that format's users draw it:
 *
 * - DXF in millimeters, turned 90° (the runs lie along the drawing's x), the
 *   gondolas inserted bay by bay as blocks, doors as door blocks on named
 *   layers, and annotation layers that have to be ignored;
 * - a fixture/planogram CSV in feet, one row per facing, with door and
 *   checkout rows;
 * - an IMDF archive in lon/lat near Midtown Atlanta, fixtures as equipment;
 * - ArcGIS Indoors Units and Details in Web Mercator with a crs member;
 * - IFC4 in meters, every fixture an extruded rectangle.
 *
 * The shop: 70 × 110 ft, storefront on the south with one 8 ft entrance and a
 * 15-stall lot beyond it. Four double-sided gondola runs of nine 4 ft sections
 * with an endcap at each end, a bulk-bin wall down the left, a front wall bay,
 * two seasonal tables inside the door, a 24 ft showcase with two serving
 * stations behind the glass, two registers with an impulse rack beside the
 * queue, and a gift-wrap station. The stockroom starts 74 ft in: two rows of
 * pallet rack, two runs of back-stock shelving, and three goods doors on the
 * back wall — a ground-level roll-up and two raised docks.
 */

import { zipSync, strToU8 } from "fflate";
import { FACINGS_OF, SHELVES_OF, STORAGE_LEVELS } from "./assemble";
import type { FixtureKind, Point, StorageRun } from "./spec";

type SampleRole = FixtureKind | StorageRun["kind"];

export interface SampleRun {
  id: string;
  role: SampleRole;
  /** Center of the footprint across its depth. */
  x: number;
  y0: number;
  y1: number;
  depth: number;
  bays: number;
}

const gondolaXs = [14, 24, 34, 44];

/** The shop, in the canonical frame: feet, x across, y from the storefront. */
export const SAMPLE = {
  widthFt: 70,
  depthFt: 110,
  backroomY: 74,
  entrance: { x: 35, widthFt: 8 },
  goods: [
    { x: 42, kind: "ground" as const, widthFt: 12, name: "Roll-up door" },
    { x: 52, kind: "dock" as const, widthFt: 10, name: "Dock door 1" },
    { x: 62, kind: "dock" as const, widthFt: 10, name: "Dock door 2" },
  ],
  service: [
    { id: "REG-1", kind: "register" as const, x: 58, y: 8 },
    { id: "REG-2", kind: "register" as const, x: 58, y: 15 },
    { id: "CTR-1", kind: "counter" as const, x: 62, y: 30 },
    { id: "CTR-2", kind: "counter" as const, x: 62, y: 42 },
    { id: "WRAP-1", kind: "wrap" as const, x: 58, y: 52 },
  ],
  office: [[56, 96], [70, 96], [70, 110], [56, 110]] as Point[],
  parking: [[0, -72], [70, -72], [70, -2], [0, -2]] as Point[],
  runs: [
    { id: "BULK", role: "bulk", x: 1.5, y0: 22, y1: 58, depth: 3, bays: 12 },
    { id: "WALL", role: "wall", x: 1.5, y0: 5, y1: 17, depth: 3, bays: 3 },
    ...gondolaXs.map((x, i) => ({ id: `G${i + 1}`, role: "gondola" as const, x, y0: 22, y1: 58, depth: 4, bays: 9 })),
    ...gondolaXs.flatMap((x, i) => [
      { id: `G${i + 1}-EF`, role: "endcap" as const, x, y0: 19.5, y1: 22, depth: 4, bays: 1 },
      { id: `G${i + 1}-EB`, role: "endcap" as const, x, y0: 58, y1: 60.5, depth: 4, bays: 1 },
    ]),
    { id: "CASE", role: "showcase", x: 58, y0: 24, y1: 48, depth: 3, bays: 6 },
    { id: "IMP", role: "impulse", x: 55.4, y0: 6, y1: 18, depth: 1.2, bays: 5 },
    { id: "SEAS-1", role: "seasonal", x: 30, y0: 6, y1: 15, depth: 4, bays: 1 },
    { id: "SEAS-2", role: "seasonal", x: 40, y0: 6, y1: 15, depth: 4, bays: 1 },
    { id: "RACK-1", role: "rack", x: 4, y0: 80, y1: 100, depth: 4, bays: 5 },
    { id: "RACK-2", role: "rack", x: 16, y0: 80, y1: 100, depth: 4, bays: 5 },
    { id: "SHELF-1", role: "shelving", x: 30, y0: 80, y1: 98, depth: 2, bays: 6 },
    { id: "SHELF-2", role: "shelving", x: 38, y0: 80, y1: 98, depth: 2, bays: 6 },
  ] as SampleRun[],
};

const isStorage = (r: SampleRun): r is SampleRun & { role: StorageRun["kind"] } => r.role === "rack" || r.role === "shelving";

/** The name a planner would give this run's layer, category or use type. */
const LAYER: Record<SampleRole, string> = {
  gondola: "FIXTURE-GONDOLA",
  endcap: "FIXTURE-ENDCAP",
  bulk: "FIXTURE-BULK-BIN",
  wall: "FIXTURE-WALL-SHELF",
  showcase: "A-CASE-SHOWCASE",
  seasonal: "FIXTURE-SEASONAL",
  impulse: "FIXTURE-IMPULSE",
  rack: "STOCKROOM-PALLET-RACK",
  shelving: "STOCKROOM-BACK-STOCK-SHELF",
};

const NICE: Record<SampleRole, string> = {
  gondola: "Gondola run",
  endcap: "Endcap",
  bulk: "Bulk bin wall",
  wall: "Wall shelving",
  showcase: "Showcase",
  seasonal: "Seasonal table",
  impulse: "Impulse rack",
  rack: "Pallet rack",
  shelving: "Back stock shelving",
};

const SERVICE_LAYER = { register: "POS-CHECKOUT", counter: "SERVICE-STATION", wrap: "GIFT-WRAP" };
const SERVICE_NICE = { register: "Checkout register", counter: "Service station", wrap: "Gift wrap station" };

const runRect = (r: SampleRun): Point[] => [
  [r.x - r.depth / 2, r.y0],
  [r.x + r.depth / 2, r.y0],
  [r.x + r.depth / 2, r.y1],
  [r.x - r.depth / 2, r.y1],
];

const boxAt = (cx: number, cy: number, w: number, d: number): Point[] => [
  [cx - w / 2, cy - d / 2],
  [cx + w / 2, cy - d / 2],
  [cx + w / 2, cy + d / 2],
  [cx - w / 2, cy + d / 2],
];

// ---------------------------------------------------------------------------
// DXF: millimeters, turned 90° so canonical (x, y) → drawing (y, −x)
// ---------------------------------------------------------------------------

export function sampleDxf(): string {
  const MM = 304.8;
  const tr = ([x, y]: Point): Point => [y * MM, -x * MM];
  const out: string[] = [];
  const pair = (c: number, v: string | number) => out.push(String(c), String(v));
  const lw = (layer: string, pts: Point[], closed: boolean) => {
    pair(0, "LWPOLYLINE");
    pair(8, layer);
    pair(90, pts.length);
    pair(70, closed ? 1 : 0);
    for (const [x, y] of pts) {
      pair(10, x.toFixed(1));
      pair(20, y.toFixed(1));
    }
  };

  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$INSUNITS");
  pair(70, 4);
  pair(0, "ENDSEC");

  // Blocks: one gondola section, and a door leaf per goods-door width.
  pair(0, "SECTION");
  pair(2, "BLOCKS");
  pair(0, "BLOCK");
  pair(8, "0");
  pair(2, "GONDOLA_BAY");
  pair(70, 0);
  pair(10, 0);
  pair(20, 0);
  lw("0", [[0, 0], [4 * MM, 0], [4 * MM, 4 * MM], [0, 4 * MM]], true);
  pair(0, "ENDBLK");
  for (const w of [8, 10, 12]) {
    pair(0, "BLOCK");
    pair(8, "0");
    pair(2, `DOOR_${w}FT`);
    pair(70, 0);
    pair(10, 0);
    pair(20, 0);
    // The leaf alone, with no jamb ticks: a door sits in the wall, and anything
    // drawn to one side of it would push the building's extent out with it.
    const h = (w / 2) * MM;
    pair(0, "LINE");
    pair(8, "0");
    pair(10, -h);
    pair(20, 0);
    pair(11, h);
    pair(21, 0);
    pair(0, "ENDBLK");
  }
  pair(0, "ENDSEC");

  pair(0, "SECTION");
  pair(2, "ENTITIES");
  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  lw("A-FLOR-OTLN", ([[0, 0], [W, 0], [W, D], [0, D]] as Point[]).map(tr), true);
  // The shell as loose LINEs, to exercise chaining.
  const shell: Point[] = [[0, 0], [W, 0], [W, D], [0, D], [0, 0]];
  for (let i = 0; i < shell.length - 1; i++) {
    const a = tr(shell[i]);
    const b = tr(shell[i + 1]);
    pair(0, "LINE");
    pair(8, "A-WALL");
    pair(10, a[0]);
    pair(20, a[1]);
    pair(11, b[0]);
    pair(21, b[1]);
  }
  // The glazing across the storefront, which is what orients the plan when the
  // entrance block is missing.
  lw("A-GLAZ", ([[6, 0], [64, 0]] as Point[]).map(tr), false);
  lw("A-AREA-STOCKROOM", ([[0, SAMPLE.backroomY], [W, SAMPLE.backroomY], [W, D], [0, D]] as Point[]).map(tr), true);
  lw("A-AREA-OFFICE", SAMPLE.office.map(tr), true);
  lw("C-PARKING-STALL", SAMPLE.parking.map(tr), true);

  for (const r of SAMPLE.runs) {
    if (r.role === "gondola") {
      // Drawn section by section, the way a fixture plan is.
      const len = (r.y1 - r.y0) / r.bays;
      for (let b = 0; b < r.bays; b++) {
        const [ix, iy] = tr([r.x + r.depth / 2, r.y0 + b * len]);
        pair(0, "INSERT");
        pair(8, LAYER.gondola);
        pair(2, "GONDOLA_BAY");
        pair(10, ix);
        pair(20, iy);
        pair(50, 0);
      }
    } else {
      lw(LAYER[r.role], runRect(r).map(tr), true);
    }
  }
  for (const s of SAMPLE.service) lw(SERVICE_LAYER[s.kind], boxAt(s.x, s.y, 3, 2).map(tr), true);

  // Doors. The block runs along its own +x; canonical +x is the drawing's −y,
  // so every door is inserted turned −90°.
  const door = (layer: string, x: number, y: number, widthFt: number) => {
    const [ix, iy] = tr([x, y]);
    pair(0, "INSERT");
    pair(8, layer);
    pair(2, `DOOR_${widthFt}FT`);
    pair(10, ix);
    pair(20, iy);
    pair(50, -90);
  };
  door("A-DOOR-ENTRANCE", SAMPLE.entrance.x, 0, SAMPLE.entrance.widthFt);
  for (const g of SAMPLE.goods) door(g.kind === "ground" ? "A-DOOR-ROLLUP" : "A-DOOR-DOCK", g.x, D, g.widthFt);

  // Annotation that must be ignored.
  pair(0, "TEXT");
  pair(8, "A-ANNO-TEXT");
  pair(10, 0);
  pair(20, 0);
  pair(40, 300);
  pair(1, "SAMPLE CANDY SHOP");
  lw("A-ANNO-DIMS", [tr([0, -4]), tr([W, -4])], false);
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CSV: a fixture export in feet, one row per facing
// ---------------------------------------------------------------------------

/**
 * Section centres are emitted at `y0 + (b − 0.5) · bayLength`, which is exactly
 * what the reader inverts, so the CSV and the drawings describe the same runs.
 */
export function sampleCsv(): string {
  const rows = ["fixture,type,department,section,shelf,facing,x,y,depth,width"];
  for (const r of SAMPLE.runs) {
    const shelves = r.role === "rack" || r.role === "shelving" ? STORAGE_LEVELS[r.role] : SHELVES_OF[r.role];
    const facings = r.role === "rack" || r.role === "shelving" ? 1 : FACINGS_OF[r.role];
    const len = (r.y1 - r.y0) / r.bays;
    for (let b = 1; b <= r.bays; b++) {
      const y = (r.y0 + (b - 0.5) * len).toFixed(2);
      for (let sh = 1; sh <= shelves; sh++) {
        for (let f = 1; f <= facings; f++) rows.push(`${r.id},${NICE[r.role]},${isStorage(r) ? "Stockroom" : "Sales floor"},${b},${sh},${f},${r.x},${y},${r.depth},`);
      }
    }
  }
  rows.push(`ENT-1,Customer entrance,Storefront,1,,,${SAMPLE.entrance.x},0,,${SAMPLE.entrance.widthFt}`);
  for (const [i, g] of SAMPLE.goods.entries()) rows.push(`GOODS-${i + 1},${g.name},Back wall,1,,,${g.x},${SAMPLE.depthFt},,${g.widthFt}`);
  for (const s of SAMPLE.service) rows.push(`${s.id},${SERVICE_NICE[s.kind]},Counter,1,,,${s.x},${s.y},,`);
  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// GeoJSON: IMDF (lon/lat) and ArcGIS Indoors (Web Mercator)
// ---------------------------------------------------------------------------

const ORIGIN: Point = [-84.385, 33.782];
/** A slight turn (20°), because no real building sits square to the meridian. */
function toLonLat([x, y]: Point): Point {
  const ftPerDegLat = 364_000;
  const ftPerDegLon = ftPerDegLat * Math.cos((ORIGIN[1] * Math.PI) / 180);
  const a = (20 * Math.PI) / 180;
  const rx = x * Math.cos(a) - y * Math.sin(a);
  const ry = x * Math.sin(a) + y * Math.cos(a);
  return [ORIGIN[0] + rx / ftPerDegLon, ORIGIN[1] + ry / ftPerDegLat];
}

function toMercator(p: Point): Point {
  const [lon, lat] = toLonLat(p);
  const R = 6378137;
  return [((lon * Math.PI) / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R];
}

const ring = (pts: Point[], f: (p: Point) => Point) => {
  const c = pts.map(f);
  return [...c, c[0]];
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function sampleImdf(): Uint8Array {
  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  const levelId = uuid(2);
  let n = 100;
  const fc = (features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features });
  const building: Point[] = [[0, 0], [W, 0], [W, D], [0, D]];
  const fixture = (coords: Point[], category: string, name: string) => ({
    type: "Feature",
    id: uuid(n++),
    feature_type: "fixture",
    geometry: { type: "Polygon", coordinates: [ring(coords, toLonLat)] },
    properties: { category, name: { en: name }, level_id: levelId, alt_name: null, anchor_id: null, display_point: null },
  });
  const opening = (x: number, y: number, widthFt: number, category: string, name: string) => ({
    type: "Feature",
    id: uuid(n++),
    feature_type: "opening",
    geometry: { type: "LineString", coordinates: [toLonLat([x - widthFt / 2, y]), toLonLat([x + widthFt / 2, y])] },
    properties: { category, name: { en: name }, level_id: levelId, door: { type: category === "pedestrian" ? "swinging" : "shutter", automatic: category === "pedestrian", material: "metal" } },
  });
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify({ version: "1.0.0", created: "2026-09-15T00:00:00Z", language: "en-US", generated_by: "store_mcp sample" })),
    "venue.geojson": strToU8(
      fc([
        {
          type: "Feature",
          id: uuid(1),
          feature_type: "venue",
          geometry: { type: "Polygon", coordinates: [ring(building, toLonLat)] },
          properties: { category: "retailstore", name: { en: "Sample Candy Shop" }, display_point: { type: "Point", coordinates: toLonLat([W / 2, D / 2]) }, address_id: uuid(9) },
        },
      ])
    ),
    "level.geojson": strToU8(
      fc([
        {
          type: "Feature",
          id: levelId,
          feature_type: "level",
          geometry: { type: "Polygon", coordinates: [ring(building, toLonLat)] },
          properties: { category: "unspecified", outdoor: false, ordinal: 0, name: { en: "Ground" }, short_name: { en: "G" } },
        },
      ])
    ),
    "footprint.geojson": strToU8(
      fc([{ type: "Feature", id: uuid(3), feature_type: "footprint", geometry: { type: "Polygon", coordinates: [ring(building, toLonLat)] }, properties: { category: "ground", name: null, building_ids: [uuid(4)] } }])
    ),
    "unit.geojson": strToU8(
      fc([
        { type: "Feature", id: uuid(5), feature_type: "unit", geometry: { type: "Polygon", coordinates: [ring([[0, 0], [W, 0], [W, SAMPLE.backroomY], [0, SAMPLE.backroomY]], toLonLat)] }, properties: { category: "retail", name: { en: "Sales floor" }, level_id: levelId } },
        {
          type: "Feature",
          id: uuid(6),
          feature_type: "unit",
          geometry: { type: "Polygon", coordinates: [ring([[0, SAMPLE.backroomY], [W, SAMPLE.backroomY], [W, D], [0, D]], toLonLat)] },
          properties: { category: "storage", name: { en: "Stockroom" }, level_id: levelId },
        },
        { type: "Feature", id: uuid(7), feature_type: "unit", geometry: { type: "Polygon", coordinates: [ring(SAMPLE.office, toLonLat)] }, properties: { category: "office", name: { en: "Office" }, level_id: levelId } },
        { type: "Feature", id: uuid(8), feature_type: "unit", geometry: { type: "Polygon", coordinates: [ring(SAMPLE.parking, toLonLat)] }, properties: { category: "parking", name: { en: "Customer parking" }, level_id: levelId } },
      ])
    ),
    "fixture.geojson": strToU8(
      fc([
        ...SAMPLE.runs.map((r) => fixture(runRect(r), isStorage(r) ? "equipment" : "furniture", `${NICE[r.role]} ${r.id}`)),
        ...SAMPLE.service.map((s) => fixture(boxAt(s.x, s.y, 3, 2), "furniture", `${SERVICE_NICE[s.kind]} ${s.id}`)),
      ])
    ),
    "opening.geojson": strToU8(
      fc([
        opening(SAMPLE.entrance.x, 0, SAMPLE.entrance.widthFt, "pedestrian", "Customer entrance"),
        ...SAMPLE.goods.map((g) => opening(g.x, D, g.widthFt, "service", g.name)),
      ])
    ),
  };
  return zipSync(files);
}

/** ArcGIS Indoors: Units, Details and Levels, in Web Mercator. */
export function sampleIndoors(): Record<string, string> {
  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  const crs = { type: "name", properties: { name: "EPSG:3857" } };
  let id = 1;
  const unit = (pts: Point[], use: string, name: string) => ({
    type: "Feature",
    id: id++,
    geometry: { type: "Polygon", coordinates: [ring(pts, toMercator)] },
    properties: { UNIT_ID: `U${id}`, LEVEL_ID: "L1", USE_TYPE: use, NAME: name },
  });
  const detail = (coords: Point[], use: string) => ({
    type: "Feature",
    id: id++,
    geometry: { type: "LineString", coordinates: coords.map(toMercator) },
    properties: { DETAIL_ID: `D${id}`, LEVEL_ID: "L1", USE_TYPE: use },
  });
  const units = [
    ...SAMPLE.runs.map((r) => unit(runRect(r), NICE[r.role], `${NICE[r.role]} ${r.id}`)),
    ...SAMPLE.service.map((s) => unit(boxAt(s.x, s.y, 3, 2), SERVICE_NICE[s.kind], s.id)),
    unit([[0, SAMPLE.backroomY], [W, SAMPLE.backroomY], [W, D], [0, D]], "Stockroom", "Back of house"),
    unit(SAMPLE.office, "Office", "Manager office"),
    unit(SAMPLE.parking, "Parking", "Customer parking"),
  ];
  const details = [
    detail([[0, 0], [W, 0], [W, D], [0, D], [0, 0]], "Wall"),
    detail([[6, 0], [64, 0]], "Glazing"),
    detail([[SAMPLE.entrance.x - SAMPLE.entrance.widthFt / 2, 0], [SAMPLE.entrance.x + SAMPLE.entrance.widthFt / 2, 0]], "Door - Entrance"),
    ...SAMPLE.goods.map((g) => detail([[g.x - g.widthFt / 2, D], [g.x + g.widthFt / 2, D]], g.kind === "ground" ? "Door - Roll-Up" : "Door - Dock")),
  ];
  const levels = [
    {
      type: "Feature",
      id: id++,
      geometry: { type: "Polygon", coordinates: [ring([[0, 0], [W, 0], [W, D], [0, D]], toMercator)] },
      properties: { LEVEL_ID: "L1", FACILITY_ID: "F1", NAME: "Ground", LEVEL_NUMBER: 1, VERTICAL_ORDER: 0 },
    },
  ];
  return {
    "Units.geojson": JSON.stringify({ type: "FeatureCollection", crs, features: units }),
    "Details.geojson": JSON.stringify({ type: "FeatureCollection", crs, features: details }),
    "Levels.geojson": JSON.stringify({ type: "FeatureCollection", crs, features: levels }),
  };
}

/** The same Indoors export flattened into one file, for a single-file upload. */
export function sampleGeoJson(): string {
  const cols = sampleIndoors();
  const features = Object.values(cols).flatMap((t) => (JSON.parse(t) as { features: unknown[] }).features);
  return JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "EPSG:3857" } }, features });
}

// ---------------------------------------------------------------------------
// IFC4 (meters): every element an extruded rectangle
// ---------------------------------------------------------------------------

export function sampleIfc(): string {
  const M = 0.3048;
  const lines: string[] = [];
  let id = 0;
  const add = (s: string) => {
    lines.push(`#${++id}=${s};`);
    return id;
  };
  // A stable pseudo-GUID: the file has to be byte-identical every time it is
  // written, so nothing here may read a clock or a random source.
  const guid = () => {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
    let s = "";
    let x = id * 2654435761;
    for (let i = 0; i < 22; i++) {
      s += chars[Math.abs(x) % 64];
      x = Math.floor(x / 7) + i * 31;
    }
    return s;
  };
  const f = (v: number) => (Number.isInteger(v) ? `${v}.` : `${v}`);
  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const zDir = add("IFCDIRECTION((0.,0.,1.))");
  const xDir = add("IFCDIRECTION((1.,0.,0.))");
  const worldPlace = add(`IFCAXIS2PLACEMENT3D(#${origin},#${zDir},#${xDir})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${worldPlace},$)`);
  const lenUnit = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
  const units = add(`IFCUNITASSIGNMENT((#${lenUnit}))`);
  const project = add(`IFCPROJECT('${guid()}',$,'Sample Candy Shop',$,$,$,$,(#${ctx}),#${units})`);
  const sitePlace = add(`IFCLOCALPLACEMENT($,#${worldPlace})`);
  const site = add(`IFCSITE('${guid()}',$,'Site',$,$,#${sitePlace},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPlace = add(`IFCLOCALPLACEMENT(#${sitePlace},#${worldPlace})`);
  const building = add(`IFCBUILDING('${guid()}',$,'Sample Candy Shop',$,$,#${bldPlace},$,$,.ELEMENT.,$,$,$)`);
  const stPlace = add(`IFCLOCALPLACEMENT(#${bldPlace},#${worldPlace})`);
  const storey = add(`IFCBUILDINGSTOREY('${guid()}',$,'Ground',$,$,#${stPlace},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${site},(#${building}))`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${building},(#${storey}))`);
  const elements: number[] = [];

  /** A box centred at (cx, cy) feet, w × d feet on plan, h meters high. */
  const box = (entity: string, name: string, objectType: string, cx: number, cy: number, w: number, d: number, h: number) => {
    const pt = add(`IFCCARTESIANPOINT((${f(cx * M)},${f(cy * M)},0.))`);
    const place = add(`IFCAXIS2PLACEMENT3D(#${pt},#${zDir},#${xDir})`);
    const lp = add(`IFCLOCALPLACEMENT(#${stPlace},#${place})`);
    const p2 = add(`IFCAXIS2PLACEMENT2D(#${add("IFCCARTESIANPOINT((0.,0.))")},$)`);
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${p2},${f(w * M)},${f(d * M)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${prof},#${worldPlace},#${zDir},${f(h)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(#${solid}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const el =
      entity === "IFCWALL"
        ? add(`IFCWALL('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,.STANDARD.)`)
        : entity === "IFCDOOR"
          ? add(`IFCDOOR('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,3.,${f(w * M)},.DOOR.,.SWINGING.,$)`)
          : entity === "IFCSLAB"
            ? add(`IFCSLAB('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,.FLOOR.)`)
            : entity === "IFCSPACE"
              ? add(`IFCSPACE('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,.ELEMENT.,.INTERNAL.,0.)`)
              : entity === "IFCFURNISHINGELEMENT"
                ? add(`IFCFURNISHINGELEMENT('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$)`)
                : add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,.ELEMENT.)`);
    elements.push(el);
  };

  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  box("IFCSLAB", "Floor slab", "Ground floor", W / 2, D / 2, W, D, 0.2);
  box("IFCWALL", "Storefront wall", "Shell", W / 2, -0.5, W, 1, 10);
  box("IFCWALL", "Back wall", "Shell", W / 2, D + 0.5, W, 1, 10);
  box("IFCWALL", "West wall", "Shell", -0.5, D / 2, 1, D, 10);
  box("IFCWALL", "East wall", "Shell", W + 0.5, D / 2, 1, D, 10);
  box("IFCSPACE", "Stockroom", "Back of house", W / 2, (SAMPLE.backroomY + D) / 2, W, D - SAMPLE.backroomY, 10);
  box("IFCSPACE", "Manager office", "Office", 63, 103, 14, 14, 9);
  for (const r of SAMPLE.runs) box("IFCBUILDINGELEMENTPROXY", `${NICE[r.role]} ${r.id}`, NICE[r.role], r.x, (r.y0 + r.y1) / 2, r.depth, r.y1 - r.y0, 6);
  for (const s of SAMPLE.service) box("IFCFURNISHINGELEMENT", `${SERVICE_NICE[s.kind]} ${s.id}`, SERVICE_NICE[s.kind], s.x, s.y, 3, 2, 3.5);
  box("IFCDOOR", "Customer entrance", "Automatic sliding door", SAMPLE.entrance.x, 0, SAMPLE.entrance.widthFt, 1, 2.4);
  for (const g of SAMPLE.goods) box("IFCDOOR", g.name, g.kind === "ground" ? "Roll-up door at grade" : "Overhead dock door", g.x, D, g.widthFt, 1, 3);
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${elements.map((e) => `#${e}`).join(",")}),#${storey})`);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('sample-store.ifc','2026-09-15T00:00:00',(''),(''),'store_mcp','store_mcp','');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

/** The sample shop in one format: the web page's "try a sample", and the test fixture. */
export function sampleStore(format: "dxf" | "csv" | "geojson" | "imdf" | "ifc"): string | Uint8Array {
  switch (format) {
    case "dxf":
      return sampleDxf();
    case "csv":
      return sampleCsv();
    case "geojson":
      return sampleGeoJson();
    case "imdf":
      return sampleImdf();
    case "ifc":
      return sampleIfc();
  }
}
