/**
 * A fixture or planogram export (CSV). For a shop this is usually the most
 * precise input there is: a space-planning system (JDA/Blue Yonder Space
 * Planning, Nielsen Spaceman, Relex, or a hand-kept spreadsheet) already knows
 * every fixture, its sections, its shelves and how many facings fit on one, so
 * there is no geometry to classify and nothing to guess about the vertical.
 *
 * Header names are matched loosely, case-insensitively, after spaces and
 * hyphens are folded to underscores:
 *   fixture | fixture_id | run | id         the run a row belongs to
 *   aisle                                   used instead of fixture, if that is how the file groups
 *   section | bay | segment | position      REQUIRED
 *   shelf | level | tier                    default: the family's usual shelf count
 *   facing | slot | position_on_shelf       default: the family's usual facing count
 *   type | fixture_type | use | kind        gondola, wall, bulk, showcase, endcap, seasonal,
 *                                           impulse, rack, shelving, register, counter, wrap,
 *                                           entrance, dock, ground — free text, read the same
 *                                           way a drawing layer is, so roleMap works here too
 *   department | dept | category | zone     extra words for that reading
 *   side | face                             L or R
 *   x, y                                    optional coordinates, in units of `unitsFt`
 *   width | length, depth                   optional, feet
 *
 * With coordinates each group becomes a run where it really stands. Without
 * them the runs are laid out in the shape of an ordinary shop — wall shelving
 * and bulk bins down one side, gondolas through the middle, the showcase on the
 * far side, back stock behind — which is wrong in detail and right in kind, and
 * says so in the report.
 */

import { ImportError, roleOf, specFromParts, FACINGS_OF, FIXTURE_ROLE_OF, SECTION_FT, SHELVES_OF, STORAGE_BAY_FT, STORAGE_LEVELS, type AssembleOptions, type ImportReport, type Role } from "./assemble";
import { LIMITS } from "./limits";
import type { DoorSpec, FixtureKind, FixtureRun, LayoutSpec, ServiceSpec, StorageRun } from "./spec";

/** RFC4180-ish: quote aware, BOM stripping, blank rows dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  fixture: ["fixture", "fixture_id", "fixtureid", "run", "run_id", "id", "fixture_name"],
  aisle: ["aisle", "aisle_id", "aisleid"],
  section: ["section", "bay", "segment", "position", "section_id", "bay_id", "module"],
  shelf: ["shelf", "level", "tier", "shelf_no", "lvl"],
  facing: ["facing", "facing_no", "facings", "slot", "position_on_shelf", "sub"],
  type: ["type", "fixture_type", "use", "kind", "class", "fixture_class"],
  department: ["department", "dept", "category", "zone", "area", "planogram"],
  side: ["side", "face"],
  x: ["x", "x_ft", "xft", "x_m", "easting", "coord_x"],
  y: ["y", "y_ft", "yft", "y_m", "northing", "coord_y"],
  width: ["width", "width_ft", "length", "length_ft", "door_width"],
  depth: ["depth", "depth_ft", "fixture_depth"],
};

function columns(header: string[]): Record<string, number> {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const out: Record<string, number> = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) out[key] = i;
  }
  return out;
}

/** Sorts "A2" before "A10", so a file always lays out in the same order. */
const naturalKey = (s: string) => s.replace(/\d+/g, (d) => d.padStart(8, "0"));

interface Row {
  role: Role;
  source: string;
  group: string;
  section: string;
  shelf: number;
  facing: string;
  side: string;
  x: number;
  y: number;
  width: number;
  depth: number;
}

export function readCsv(text: string, opts: AssembleOptions & { unitsFt?: number }): { spec: LayoutSpec; report: ImportReport } {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportError("The CSV needs a header row and at least one fixture row.");
  if (rows.length > 500_000) throw new ImportError("The CSV has over half a million rows.");
  const col = columns(rows[0]);
  if (col.section === undefined || (col.fixture === undefined && col.aisle === undefined)) {
    throw new ImportError(
      `The CSV needs a section (or bay) column and a fixture (or aisle) column; found: ${rows[0].join(", ")}. ` +
        `Accepted names: fixture, run or id; aisle; section, bay or segment; shelf, level or tier; facing or slot; type or fixture_type; x and y.`
    );
  }
  const scale = opts.unitsFt ?? 1;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new ImportError(`unitsFt must be the number of feet in one coordinate unit; got ${opts.unitsFt}.`);
  const get = (r: string[], k: string) => (col[k] === undefined ? "" : (r[col[k]] ?? "").trim());
  const hasXY = col.x !== undefined && col.y !== undefined;
  const typed = col.type !== undefined || col.department !== undefined;
  const assumptions = [...(opts.assumptions ?? [])];
  const warnings = [...(opts.warnings ?? [])];

  // Every row is read the way a drawing layer is, so roleMap works here too.
  const bySource = new Map<string, { role: Role; count: number }>();
  const parsed: Row[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const source = [get(r, "type"), get(r, "department")].filter(Boolean).join(" ").trim();
    const role = typed && source ? roleOf({ source, kind: "point", points: [] }, opts.roleMap) : "gondola";
    const tally = bySource.get(source || "(untyped)") ?? { role, count: 0 };
    tally.count++;
    bySource.set(source || "(untyped)", tally);
    if (role === "ignore") {
      skipped++;
      continue;
    }
    const x = hasXY ? Number.parseFloat(get(r, "x")) * scale : Number.NaN;
    const y = hasXY ? Number.parseFloat(get(r, "y")) * scale : Number.NaN;
    const shelf = Number.parseInt(get(r, "shelf") || "1", 10);
    const group = (get(r, "fixture") || get(r, "aisle")).trim();
    const section = get(r, "section");
    parsed.push({
      role,
      source: source || "(untyped)",
      group,
      section,
      shelf: Number.isFinite(shelf) && shelf > 0 ? shelf : 1,
      facing: get(r, "facing"),
      side: get(r, "side").toUpperCase().slice(0, 1),
      x,
      y,
      width: Number.parseFloat(get(r, "width")) * scale,
      depth: Number.parseFloat(get(r, "depth")) * scale,
    });
  }
  if (skipped) assumptions.push(`${skipped} row(s) of a kind the twin does not model were left out.`);

  // Doors and service points are single rows; they need coordinates to place.
  const doors: Array<{ kind?: DoorSpec["kind"]; x: number; y: number; widthFt?: number }> = [];
  const service: ServiceSpec[] = [];
  const runRows: Row[] = [];
  let noCoords = 0;
  for (const p of parsed) {
    if (p.role === "entrance" || p.role === "dock" || p.role === "ground") {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        noCoords++;
        continue;
      }
      doors.push({ kind: p.role, x: p.x, y: p.y, widthFt: Number.isFinite(p.width) && p.width > 0 ? p.width : undefined });
    } else if (p.role === "register" || p.role === "counter" || p.role === "wrap") {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || service.length >= LIMITS.maxServicePoints) {
        noCoords++;
        continue;
      }
      const n = service.filter((s) => s.kind === p.role).length + 1;
      service.push({ id: `${p.role === "register" ? "REG" : p.role === "counter" ? "CTR" : "WRAP"}-${n}`, kind: p.role, x: p.x, y: p.y, facing: 90 });
    } else if (!p.group || !p.section) {
      noCoords++;
    } else if (hasXY && (!Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      noCoords++;
    } else {
      runRows.push(p);
    }
  }
  if (noCoords) assumptions.push(`${noCoords} row(s) without a fixture, a section or usable coordinates were skipped.`);
  if (runRows.length === 0) throw new ImportError("No usable fixture rows: every row was missing a fixture id, a section, or both.");

  // One group per run face.
  const groups = new Map<string, Row[]>();
  for (const p of runRows) {
    const key = `${p.group}|${p.side === "L" || p.side === "R" ? p.side : ""}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()].sort((a, b) => naturalKey(a[0]).localeCompare(naturalKey(b[0])));
  if (ordered.length > LIMITS.maxFixtureRuns) throw new ImportError(`The CSV describes ${ordered.length} runs; the limit is ${LIMITS.maxFixtureRuns}.`);

  /** A group's shape: sections along it, shelves up it, facings across one shelf. */
  const shapeOf = (g: Row[]) => {
    const bays = new Set(g.map((p) => p.section)).size;
    const shelves = Math.max(...g.map((p) => p.shelf));
    const perShelf = new Map<string, Set<string>>();
    for (const p of g) {
      const k = `${p.section}|${p.shelf}`;
      const set = perShelf.get(k) ?? new Set<string>();
      set.add(p.facing);
      perShelf.set(k, set);
    }
    const facings = Math.max(...[...perShelf.values()].map((v) => v.size));
    return { bays: Math.min(200, Math.max(1, bays)), shelves: Math.min(10, Math.max(1, shelves)), facings: Math.min(20, Math.max(1, facings)) };
  };
  const hasShelfCol = col.shelf !== undefined;
  const hasFacingCol = col.facing !== undefined;
  if (!hasShelfCol) assumptions.push("The file has no shelf column; each fixture family's usual shelf count was used.");
  if (!hasFacingCol) assumptions.push("The file has no facing column; each fixture family's usual facing count was used.");

  const fixtures: FixtureRun[] = [];
  const storage: StorageRun[] = [];
  const depthDefault = (kind: FixtureKind | StorageRun["kind"]) =>
    kind === "gondola" ? 4 : kind === "rack" ? 4 : kind === "showcase" ? 3 : kind === "bulk" ? 2.5 : kind === "impulse" ? 1.5 : kind === "seasonal" ? 4 : 2;

  const emit = (g: Row[], x: number, y0: number, y1: number) => {
    const role = g[0].role;
    const shape = shapeOf(g);
    const depths = g.map((p) => p.depth).filter((d) => Number.isFinite(d) && d > 0);
    const storageKind = role === "rack" || role === "shelving" ? role : null;
    const depth = depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : depthDefault(storageKind ?? (FIXTURE_ROLE_OF[role] ?? "gondola"));
    if (storageKind) {
      storage.push({ id: `S${storage.length + 1}`, kind: storageKind, x, y0, y1, depthFt: Math.min(20, depth), bays: shape.bays, levels: hasShelfCol ? shape.shelves : STORAGE_LEVELS[storageKind] });
      return;
    }
    const kind = FIXTURE_ROLE_OF[role] ?? "gondola";
    fixtures.push({
      id: `F${fixtures.length + 1}`,
      kind,
      x,
      y0,
      y1,
      depthFt: Math.min(20, depth),
      shelves: opts.shelves ?? (hasShelfCol ? shape.shelves : SHELVES_OF[kind]),
      bays: shape.bays,
      facingsPerBay: opts.facingsPerBay ?? (hasFacingCol ? shape.facings : FACINGS_OF[kind]),
      doubleSided: kind === "gondola" && depth >= 3,
    });
  };

  if (hasXY) {
    // Which way the runs lie: the axis a group spreads along is its length.
    let alongY = 0;
    let alongX = 0;
    for (const [, g] of ordered) {
      const sx = Math.max(...g.map((p) => p.x)) - Math.min(...g.map((p) => p.x));
      const sy = Math.max(...g.map((p) => p.y)) - Math.min(...g.map((p) => p.y));
      if (sy >= sx) alongY += g.length;
      else alongX += g.length;
    }
    const swap = alongX > alongY;
    if (swap) assumptions.push("The runs lie along x in the file; the plan was turned so they go front to back from the storefront.");
    for (const [, g] of ordered) {
      const along = g.map((p) => (swap ? p.x : p.y));
      const across = g.map((p) => (swap ? p.y : p.x));
      const shape = shapeOf(g);
      const span = Math.max(...along) - Math.min(...along);
      const kind = FIXTURE_ROLE_OF[g[0].role];
      const pitch = shape.bays > 1 ? span / (shape.bays - 1) : kind ? SECTION_FT[kind] : STORAGE_BAY_FT[g[0].role === "rack" ? "rack" : "shelving"];
      emit(g, across.reduce((a, b) => a + b, 0) / across.length, Math.min(...along) - pitch / 2, Math.max(...along) + pitch / 2);
    }
    if (swap) for (const d of doors) [d.x, d.y] = [d.y, d.x];
    if (swap) for (const s of service) [s.x, s.y] = [s.y, s.x];
  } else {
    assumptions.push(
      "The file has no coordinates, so the shop was laid out in the ordinary shape: wall shelving and bulk bins down the left, gondolas through the middle at 5.5 ft aisles, the showcase on the right, back stock behind. Pass a file with x and y to place them where they really are."
    );
    // A fixed family order, so the same file always lays out the same shop.
    const FAMILY: Role[] = ["wall", "bulk", "gondola", "endcap", "seasonal", "impulse", "showcase"];
    const rank = (r: Role) => {
      const i = FAMILY.indexOf(r);
      return i < 0 ? FAMILY.length : i;
    };
    const sales = ordered.filter(([, g]) => g[0].role !== "rack" && g[0].role !== "shelving").sort((a, b) => rank(a[1][0].role) - rank(b[1][0].role) || naturalKey(a[0]).localeCompare(naturalKey(b[0])));
    const back = ordered.filter(([, g]) => g[0].role === "rack" || g[0].role === "shelving");
    const FRONT_Y = 18;
    let x = 2;
    let deepest = FRONT_Y;
    for (const [, g] of sales) {
      const kind = FIXTURE_ROLE_OF[g[0].role] ?? "gondola";
      const shape = shapeOf(g);
      const depth = depthDefault(kind);
      const len = shape.bays * SECTION_FT[kind];
      emit(g, x + depth / 2, FRONT_Y, FRONT_Y + len);
      deepest = Math.max(deepest, FRONT_Y + len);
      x += depth + 5.5;
    }
    let bx = 2;
    const backY = deepest + 8;
    for (const [, g] of back) {
      const kind: StorageRun["kind"] = g[0].role === "rack" ? "rack" : "shelving";
      const shape = shapeOf(g);
      const depth = depthDefault(kind);
      emit(g, bx + depth / 2, backY, backY + shape.bays * STORAGE_BAY_FT[kind]);
      bx += depth + 4;
    }
  }

  const layers = [...bySource.entries()].map(([layer, v]) => ({ layer, role: v.role, count: v.count })).sort((a, b) => b.count - a.count || a.layer.localeCompare(b.layer));
  const out = specFromParts({ fixtures, storage, service, doors }, { ...opts, assumptions, warnings });
  return { spec: out.spec, report: { ...out.report, layers } };
}
