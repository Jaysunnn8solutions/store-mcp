/**
 * The layout spec: one compact description of a store that every importer
 * produces and every tool accepts. Fixtures are described as runs (a position,
 * a length, bays and shelves) rather than one record per facing, so a real shop
 * is a couple of kilobytes and can travel through a tool call.
 *
 * Canonical frame: feet, x across the store, y from the storefront (y = 0,
 * where the customers and the parking lot are) toward the back wall, where the
 * stockroom and the docks are. Gondola runs are parallel to y, so a shopper
 * walks the aisles away from the door. Importers rotate and translate drawings
 * into this frame.
 */

import { z } from "zod";
import { LIMITS } from "./limits";

export type Point = [number, number];

/**
 * Where a SKU merchandises. `gondola` and `wall` are ordinary shelving, `bulk`
 * is scoop bins, `showcase` is the glass counter a clerk serves from,
 * `endcap` the promotional end of a run, `seasonal` a free-standing table and
 * `impulse` the racks at the register.
 */
export type FixtureKind = "gondola" | "wall" | "endcap" | "bulk" | "showcase" | "impulse" | "seasonal";
export const FIXTURE_KINDS: FixtureKind[] = ["gondola", "wall", "endcap", "bulk", "showcase", "impulse", "seasonal"];

/** A run of selling fixtures on the sales floor. */
export interface FixtureRun {
  id: string;
  kind: FixtureKind;
  /** Center of the fixture footprint across its depth. */
  x: number;
  y0: number;
  y1: number;
  /** Footprint depth across the run; a double-sided gondola is this deep in total. */
  depthFt: number;
  /** Selling shelves per side, bottom to top. */
  shelves: number;
  /** Bays along the run. */
  bays: number;
  /** Facings side by side in one bay on one shelf. */
  facingsPerBay: number;
  /** false for a wall run, a showcase, an endcap or a table: one shopping side. */
  doubleSided: boolean;
}

/** Back-of-house storage: pallet rack, or hand-stacked case shelving. */
export interface StorageRun {
  id: string;
  kind: "rack" | "shelving";
  x: number;
  y0: number;
  y1: number;
  depthFt: number;
  bays: number;
  levels: number;
}

/** A place a worker serves a customer: behind the showcase glass, or a register. */
export interface ServiceSpec {
  id: string;
  kind: "counter" | "register" | "wrap";
  x: number;
  y: number;
  /** Which way the worker faces, in degrees; 0 looks toward the storefront. */
  facing: number;
}

export interface DoorSpec {
  id: string;
  /** Customers through the storefront; goods through the back. */
  kind: "entrance" | "dock" | "ground";
  x: number;
  y: number;
  widthFt: number;
}

export interface ZoneSpec {
  kind: "sales" | "queue" | "backroom" | "staging" | "office" | "other";
  name: string;
  ring: Point[];
}

/** The customer lot, laid out in front of the storefront (negative y). */
export interface ParkingSpec {
  depthFt: number;
  stalls: number;
  accessibleStalls: number;
  /** Marked spots by the door for order pickup. */
  curbsideStalls: number;
}

export interface LayoutSpec {
  version: 1;
  name: string;
  source: { format: "builtin" | "dxf" | "csv" | "imdf" | "indoors" | "ifc"; file?: string; notes: string[] };
  widthFt: number;
  depthFt: number;
  outline: Point[];
  walls: Point[][];
  zones: ZoneSpec[];
  fixtures: FixtureRun[];
  storage: StorageRun[];
  service: ServiceSpec[];
  doors: DoorSpec[];
  parking: ParkingSpec;
  /** Where the sales floor ends and the stockroom begins, feet from the storefront. */
  backroomY: number;
  /** Aisle width assumed for a fixture run with open space on one side only. */
  aisleWidthFt: number;
  /**
   * Clear height of one selling shelf. Lives here rather than in the labor
   * standards because it is a property of the fixtures in the building, and
   * because facing cube and the cases a facing holds both read it.
   */
  shelfHeightFt: number;
}

const num = z.number().finite();
const point = z.tuple([num, num]);

export const layoutSpecSchema = z
  .object({
    version: z.literal(1),
    name: z.string().max(120),
    source: z.object({ format: z.enum(["builtin", "dxf", "csv", "imdf", "indoors", "ifc"]), file: z.string().max(260).optional(), notes: z.array(z.string().max(400)).max(50) }),
    widthFt: num.positive().max(LIMITS.maxSideFt),
    depthFt: num.positive().max(LIMITS.maxSideFt),
    outline: z.array(point).max(2000),
    walls: z.array(z.array(point).max(2000)).max(5000),
    zones: z.array(z.object({ kind: z.enum(["sales", "queue", "backroom", "staging", "office", "other"]), name: z.string().max(80), ring: z.array(point).max(500) })).max(500),
    fixtures: z
      .array(
        z.object({
          id: z.string().max(40),
          kind: z.enum(["gondola", "wall", "endcap", "bulk", "showcase", "impulse", "seasonal"]),
          x: num,
          y0: num,
          y1: num,
          depthFt: num.positive().max(20),
          shelves: z.number().int().min(1).max(10),
          bays: z.number().int().min(1).max(200),
          facingsPerBay: z.number().int().min(1).max(20),
          doubleSided: z.boolean(),
        })
      )
      .min(1)
      .max(LIMITS.maxFixtureRuns),
    storage: z
      .array(
        z.object({
          id: z.string().max(40),
          kind: z.enum(["rack", "shelving"]),
          x: num,
          y0: num,
          y1: num,
          depthFt: num.positive().max(20),
          bays: z.number().int().min(1).max(200),
          levels: z.number().int().min(1).max(10),
        })
      )
      .max(LIMITS.maxFixtureRuns),
    service: z.array(z.object({ id: z.string().max(40), kind: z.enum(["counter", "register", "wrap"]), x: num, y: num, facing: num })).max(LIMITS.maxServicePoints),
    doors: z.array(z.object({ id: z.string().max(40), kind: z.enum(["entrance", "dock", "ground"]), x: num, y: num, widthFt: num.positive().max(60) })).max(LIMITS.maxDoors),
    parking: z.object({
      depthFt: num.min(0).max(400),
      stalls: z.number().int().min(0).max(500),
      accessibleStalls: z.number().int().min(0).max(50),
      curbsideStalls: z.number().int().min(0).max(20),
    }),
    backroomY: num.min(0),
    aisleWidthFt: num.min(2.5).max(20),
    shelfHeightFt: num.min(0.5).max(6),
  })
  .describe(
    "A store layout from import_layout (or the web page's import). Replaces the shop's built-in building; demand, crew and equipment still come from store."
  );

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Round coordinates to 0.1 ft so a spec stays compact. */
export function compactSpec(spec: LayoutSpec): LayoutSpec {
  const p = (pt: Point): Point => [r1(pt[0]), r1(pt[1])];
  return {
    ...spec,
    widthFt: r1(spec.widthFt),
    depthFt: r1(spec.depthFt),
    backroomY: r1(spec.backroomY),
    outline: spec.outline.map(p),
    walls: spec.walls.map((w) => w.map(p)),
    zones: spec.zones.map((z) => ({ ...z, ring: z.ring.map(p) })),
    fixtures: spec.fixtures.map((f) => ({ ...f, x: r1(f.x), y0: r1(f.y0), y1: r1(f.y1), depthFt: r1(f.depthFt) })),
    storage: spec.storage.map((s) => ({ ...s, x: r1(s.x), y0: r1(s.y0), y1: r1(s.y1), depthFt: r1(s.depthFt) })),
    service: spec.service.map((s) => ({ ...s, x: r1(s.x), y: r1(s.y), facing: r1(s.facing) })),
    doors: spec.doors.map((d) => ({ ...d, x: r1(d.x), y: r1(d.y), widthFt: r1(d.widthFt) })),
  };
}
