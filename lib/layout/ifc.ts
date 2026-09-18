/**
 * IFC (BIM) floor plans, read straight out of the STEP text.
 *
 * Why not web-ifc: the whole import pipeline is synchronous and isomorphic — a
 * pure function of bytes and options, callable from a tool handler, a test, a
 * route and a browser worker without an await or a WebAssembly boot. Meshing
 * every solid would buy exact footprints for arbitrary geometry; what a store
 * plan actually needs is the plan footprint of the walls, doors, spaces and
 * furniture, and in every export worth importing those are extruded area solids
 * over a rectangle or a closed polyline. So this reads the placements and the
 * swept profiles directly, and counts whatever it could not read into a warning
 * so nobody is left wondering where their fixtures went.
 *
 * IFC is Z-up in the file's own length unit; the plan point of a vertex is
 * (x, y) after the placement chain is composed, scaled to feet. Only the ground
 * floor is kept: elements whose base sits more than 8 ft above the lowest
 * fixture (or the lowest element of any kind) are dropped, because the twin
 * models one floor.
 */

import { assemble, ImportError, type AssembleOptions, type ImportReport, type RawFeature, type Role } from "./assemble";
import { convexHull } from "./geometry";
import type { LayoutSpec, Point } from "./spec";

/** Names a store planner gives the things that hold stock. */
const FIXTURE_NAME = /(gondola|shelv|shelf|rack|case|counter|bin|display|fixture|bay|stock|table|wrap|register|checkout|pos)/i;

/** What an IFC type is, before its name is looked at. "fixture" and "space" are decided by name. */
const TYPE_ROLE: Record<string, Role | "fixture" | "space"> = {
  IFCWALL: "wall-line",
  IFCWALLSTANDARDCASE: "wall-line",
  IFCCURTAINWALL: "wall-line",
  IFCCOLUMN: "wall-line",
  IFCDOOR: "entrance",
  IFCSLAB: "outline",
  IFCFURNISHINGELEMENT: "fixture",
  IFCFURNITURE: "fixture",
  IFCSYSTEMFURNITUREELEMENT: "fixture",
  IFCBUILDINGELEMENTPROXY: "fixture",
  IFCSPACE: "space",
};

interface Record_ {
  type: string;
  args: string[];
}

/**
 * Split the DATA section into `#id = TYPE(args);` records. Written as a
 * character scan because a STEP statement can wrap over any number of lines and
 * a quoted name can contain anything, semicolons included.
 */
function parseStep(text: string): Map<number, Record_> {
  const start = text.indexOf("DATA;");
  const body = start >= 0 ? text.slice(start + 5) : text;
  const out = new Map<number, Record_>();
  let stmt = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      stmt += ch;
      if (ch === "'") {
        if (body[i + 1] === "'") {
          stmt += body[++i];
        } else quoted = false;
      }
      continue;
    }
    if (ch === "'") {
      quoted = true;
      stmt += ch;
      continue;
    }
    if (ch === ";") {
      const m = stmt.match(/^\s*#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(([\s\S]*)\)\s*$/);
      if (m) out.set(Number.parseInt(m[1], 10), { type: m[2].toUpperCase(), args: splitArgs(m[3]) });
      stmt = "";
      continue;
    }
    stmt += ch;
  }
  return out;
}

/** Split a STEP argument list on top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      cur += ch;
      if (ch === "'") {
        if (s[i + 1] === "'") cur += s[++i];
        else quoted = false;
      }
      continue;
    }
    if (ch === "'") {
      quoted = true;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const refOf = (a: string | undefined): number | null => {
  const m = a?.match(/^#(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : null;
};
const refsOf = (a: string | undefined): number[] => [...(a ?? "").matchAll(/#(\d+)/g)].map((m) => Number.parseInt(m[1], 10));
const numsOf = (a: string | undefined): number[] =>
  (a ?? "")
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((v) => Number.parseFloat(v))
    .filter((v) => Number.isFinite(v));
const numOf = (a: string | undefined): number => {
  const v = Number.parseFloat(a ?? "");
  return Number.isFinite(v) ? v : 0;
};
const strOf = (a: string | undefined): string => (a && a.startsWith("'") ? a.slice(1, -1).replace(/''/g, "'") : "");

/** A placement reduced to what a plan needs: an origin, a height and a turn. */
interface Place {
  x: number;
  y: number;
  z: number;
  rot: number;
}
const IDENTITY: Place = { x: 0, y: 0, z: 0, rot: 0 };

function compose(parent: Place, child: Place): Place {
  const c = Math.cos(parent.rot);
  const s = Math.sin(parent.rot);
  return { x: parent.x + child.x * c - child.y * s, y: parent.y + child.x * s + child.y * c, z: parent.z + child.z, rot: parent.rot + child.rot };
}

function readIfcModel(step: Map<number, Record_>) {
  const placeCache = new Map<number, Place>();

  /** IfcAxis2Placement2D / 3D → an origin and the turn of its x axis. */
  const axisPlacement = (id: number | null): Place => {
    if (id === null) return IDENTITY;
    const r = step.get(id);
    if (!r) return IDENTITY;
    const loc = numsOf(step.get(refOf(r.args[0]) ?? -1)?.args[0]);
    // 3D carries (Location, Axis, RefDirection); 2D carries (Location, RefDirection).
    const dirArg = r.type === "IFCAXIS2PLACEMENT2D" ? r.args[1] : r.args[2];
    const dir = numsOf(step.get(refOf(dirArg) ?? -1)?.args[0]);
    const rot = dir.length >= 2 ? Math.atan2(dir[1], dir[0]) : 0;
    return { x: loc[0] ?? 0, y: loc[1] ?? 0, z: loc[2] ?? 0, rot };
  };

  /** Walk an IfcLocalPlacement chain up to the world. */
  const placementOf = (id: number | null, depth = 0): Place => {
    if (id === null || depth > 16) return IDENTITY;
    const cached = placeCache.get(id);
    if (cached) return cached;
    const r = step.get(id);
    if (!r) return IDENTITY;
    if (r.type !== "IFCLOCALPLACEMENT") return axisPlacement(id);
    const parent = placementOf(refOf(r.args[0]), depth + 1);
    const here = compose(parent, axisPlacement(refOf(r.args[1])));
    placeCache.set(id, here);
    return here;
  };

  /** A closed profile's points, in the profile's own 2D frame. */
  const profilePoints = (id: number | null): Point[] => {
    if (id === null) return [];
    const r = step.get(id);
    if (!r) return [];
    if (r.type === "IFCRECTANGLEPROFILEDEF" || r.type === "IFCROUNDEDRECTANGLEPROFILEDEF") {
      const p = axisPlacement(refOf(r.args[2]));
      const hx = numOf(r.args[3]) / 2;
      const hy = numOf(r.args[4]) / 2;
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      return (
        [
          [-hx, -hy],
          [hx, -hy],
          [hx, hy],
          [-hx, hy],
        ] as Point[]
      ).map(([x, y]) => [p.x + x * c - y * s, p.y + x * s + y * c] as Point);
    }
    if (r.type === "IFCCIRCLEPROFILEDEF") {
      const p = axisPlacement(refOf(r.args[2]));
      const rad = numOf(r.args[3]);
      return Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * 2 * Math.PI;
        return [p.x + rad * Math.cos(a), p.y + rad * Math.sin(a)] as Point;
      });
    }
    if (r.type === "IFCARBITRARYCLOSEDPROFILEDEF" || r.type === "IFCARBITRARYPROFILEDEFWITHVOIDS") {
      const curve = step.get(refOf(r.args[2]) ?? -1);
      if (!curve) return [];
      if (curve.type === "IFCPOLYLINE") {
        return refsOf(curve.args[0]).map((pid) => {
          const c = numsOf(step.get(pid)?.args[0]);
          return [c[0] ?? 0, c[1] ?? 0] as Point;
        });
      }
      return [];
    }
    return [];
  };

  /** Plan footprint of one shape representation, in the element's own frame. */
  const solidPoints = (itemId: number, depth = 0): { pts: Point[]; readable: boolean } => {
    const r = step.get(itemId);
    if (!r || depth > 4) return { pts: [], readable: false };
    if (r.type === "IFCEXTRUDEDAREASOLID") {
      const place = axisPlacement(refOf(r.args[1]));
      const prof = profilePoints(refOf(r.args[0]));
      if (prof.length === 0) return { pts: [], readable: false };
      const c = Math.cos(place.rot);
      const s = Math.sin(place.rot);
      return { pts: prof.map(([x, y]) => [place.x + x * c - y * s, place.y + x * s + y * c] as Point), readable: true };
    }
    if (r.type === "IFCMAPPEDITEM") {
      const source = step.get(refOf(r.args[0]) ?? -1);
      if (!source) return { pts: [], readable: false };
      const out: Point[] = [];
      let readable = false;
      for (const inner of refsOf(source.args[1])) {
        const g = solidPoints(inner, depth + 1);
        if (g.readable) readable = true;
        out.push(...g.pts);
      }
      return { pts: out, readable };
    }
    return { pts: [], readable: false };
  };

  return { placementOf, solidPoints };
}

/** Feet per file length unit. IFC defaults to metres when it says nothing. */
function lengthScale(step: Map<number, Record_>): { ft: number; from: string } {
  const PREFIX: Record<string, number> = { ".MILLI.": 0.001, ".CENTI.": 0.01, ".DECI.": 0.1, ".KILO.": 1000, ".MICRO.": 1e-6 };
  for (const id of [...step.keys()].sort((a, b) => a - b)) {
    const r = step.get(id)!;
    if (r.type === "IFCSIUNIT" && r.args[1] === ".LENGTHUNIT.") {
      const p = PREFIX[r.args[2]] ?? 1;
      return { ft: 3.28084 * p, from: `IFCSIUNIT ${r.args[2] === "$" ? "" : r.args[2]}${r.args[3]}`.trim() };
    }
    if (r.type === "IFCCONVERSIONBASEDUNIT" && r.args[1] === ".LENGTHUNIT.") {
      const name = strOf(r.args[2]).toUpperCase();
      if (/FOOT|FEET/.test(name)) return { ft: 1, from: "IFCCONVERSIONBASEDUNIT FOOT" };
      if (/INCH/.test(name)) return { ft: 1 / 12, from: "IFCCONVERSIONBASEDUNIT INCH" };
    }
  }
  return { ft: 3.28084, from: "IFC default: metres" };
}

export function readIfc(bytes: Uint8Array | string, opts: AssembleOptions): { spec: LayoutSpec; report: ImportReport } {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  if (!/ISO-10303-21/.test(text.slice(0, 4000))) {
    throw new ImportError("This is not an IFC STEP file. Export IFC2X3, IFC4 or IFC4X3 as .ifc (not .ifczip or .ifcxml).");
  }
  const step = parseStep(text);
  if (step.size === 0) throw new ImportError("The IFC file has no DATA section this reader could parse.");
  const { ft, from } = lengthScale(step);
  const { placementOf, solidPoints } = readIfcModel(step);
  const assumptions = [...(opts.assumptions ?? [])];
  const warnings = [...(opts.warnings ?? [])];

  interface Element {
    source: string;
    hint: Role;
    points: Point[];
    z: number;
  }
  const elements: Element[] = [];
  let unreadable = 0;
  // Ids ascending, so the same file always produces the same feature order.
  for (const id of [...step.keys()].sort((a, b) => a - b)) {
    const r = step.get(id)!;
    const base = TYPE_ROLE[r.type];
    if (base === undefined) continue;
    const name = strOf(r.args[2]);
    const objectType = strOf(r.args[4]) || strOf(r.args[8]);
    const place = placementOf(refOf(r.args[5]));
    const shape = step.get(refOf(r.args[6]) ?? -1);
    if (!shape) continue;
    const pts: Point[] = [];
    let readable = false;
    for (const repId of refsOf(shape.args[2])) {
      const rep = step.get(repId);
      if (!rep || rep.type !== "IFCSHAPEREPRESENTATION") continue;
      for (const itemId of refsOf(rep.args[3])) {
        const g = solidPoints(itemId);
        if (g.readable) readable = true;
        const c = Math.cos(place.rot);
        const s = Math.sin(place.rot);
        for (const [x, y] of g.pts) pts.push([(place.x + x * c - y * s) * ft, (place.y + x * s + y * c) * ft]);
      }
    }
    if (!readable || pts.length < 3) {
      unreadable++;
      continue;
    }
    let hint: Role;
    if (base === "fixture") hint = FIXTURE_NAME.test(`${name} ${objectType}`) ? "gondola" : "ignore";
    else if (base === "space") hint = /office|restroom|toilet|break|locker/i.test(`${name} ${objectType}`) ? "office" : /stock|back.?of.?house|storage|boh/i.test(`${name} ${objectType}`) ? "backroom" : "ignore";
    else hint = base;
    elements.push({ source: `${r.type}:${name}${objectType ? `:${objectType}` : ""}`, hint, points: convexHull(pts), z: place.z * ft });
  }
  if (unreadable) {
    warnings.push(
      `${unreadable} element(s) carry geometry this reader does not handle — boundary representations, swept discs, or a mapped item it could not follow — and were left out. Extruded rectangles and polylines are read; export the fixtures as swept solids, or import the plan as DXF instead.`
    );
  }
  if (elements.length === 0) {
    throw new ImportError("The IFC model has no walls, doors, slabs, spaces or furnishing elements with readable extruded geometry. Export the plan to DXF and import that instead.");
  }

  // One floor only.
  const fixtures = elements.filter((e) => e.hint === "gondola");
  const ground = Math.min(...(fixtures.length ? fixtures : elements).map((e) => e.z));
  const kept = elements.filter((e) => e.z <= ground + 8);
  if (kept.length < elements.length) assumptions.push(`${elements.length - kept.length} element(s) above the ground floor were left out; the twin models one floor.`);

  const features: RawFeature[] = kept.map((e) => ({ source: e.source, kind: "ring", points: e.points, hint: e.hint }));
  return assemble(features, { ...opts, format: "ifc", assumptions, warnings, unitsFrom: from });
}
