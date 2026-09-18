/**
 * The store plan as an SVG string: the customer lot, the storefront, the
 * gondola runs and the aisles the twin found between them, the bulk wall and
 * the perimeter shelving, the showcase and the service counter with the staff
 * corridor behind it, the stockroom, and the goods doors on the back wall.
 *
 * It is a pure string builder — no DOM, no Node built-ins, no clock and no
 * random source — because the same function draws the plan in three places:
 * server-rendered on the web page, as a live preview in the import workbench
 * while a drawing is still being mapped, and inside the HTML file the local
 * `render_floor` tool writes. Same input, same bytes, every time, so a test can
 * pin the output.
 *
 * Frame: feet, x across the store, y from the storefront (y = 0) toward the
 * back wall at y = depthFt, the parking lot at y < 0. The drawing keeps the
 * retail convention of parking at the bottom of the page and the docks at the
 * top, which falls out of `Y = (D - y)` — the same flip the reference DC plan
 * uses, read the other way round.
 *
 * Colour comes from CSS custom properties the SVG defines for itself, with the
 * light value repeated as the `var()` fallback. With no `theme` the tokens
 * follow `prefers-color-scheme`, so one drawing reads in both; passing a theme
 * pins it, which is what the standalone HTML file needs. A host page can still
 * override a token with any rule more specific than `.sf`.
 */

import type { DoorSpec, FixtureKind, FixtureRun, LayoutSpec, Point, ServiceSpec, StorageRun } from "../layout/spec";
import type { Layout } from "../twin/layout";

// ---------------------------------------------------------------------------
// Text, numbers, escaping
// ---------------------------------------------------------------------------

/** Everything user-controlled — a store name, a run id, a zone name — goes through this. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const f1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Thousands separators without `toLocaleString`, which depends on the runtime's
 * ICU data and would make the output environment-dependent.
 */
function num(n: number): string {
  const neg = n < 0;
  const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${s}` : s;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * The plan's colour tokens. The fixture hues are the ones the 3D scene uses, so
 * a reader moving between the plan and the model recognises the same store:
 * gondolas blue-grey, the showcase amber, bulk warm brown, endcaps and seasonal
 * tables orange, impulse pink, wall shelving pale grey, stockroom racking tan,
 * docks green, the ground-level roll-up orange and the entrance blue.
 */
const LIGHT = {
  page: "#ffffff",
  floor: "#fbfaf7",
  line: "#3a3a38",
  hair: "#a9a9a2",
  text: "#242422",
  muted: "#6d6d66",
  zone: "rgba(120,120,110,0.06)",
  back: "rgba(120,120,110,0.12)",
  staging: "rgba(47,158,68,0.10)",
  corridor: "rgba(217,145,32,0.16)",
  aisle: "#8f9aa6",
  gondola: "#8ba3b8",
  wall: "#cfd0cb",
  endcap: "#e08a3c",
  seasonal: "#eaa963",
  bulk: "#a8763f",
  showcase: "#e6b23c",
  impulse: "#e08aa8",
  rack: "#c8ad82",
  shelving: "#ddcda9",
  bench: "#b9ae97",
  dock: "#2f9e44",
  ground: "#d9480f",
  entrance: "#1c7ed6",
  register: "#37474f",
  counter: "#a9761b",
  wrap: "#c2557c",
  lot: "#ececea",
  stripe: "#b4b5ae",
  drive: "#e3e3df",
  ada: "#4c9be8",
  curb: "#2f9e44",
} as const;

const DARK: Record<keyof typeof LIGHT, string> = {
  page: "#101214",
  floor: "#1b1d20",
  line: "#8d949b",
  hair: "#565c62",
  text: "#e7e9eb",
  muted: "#9aa1a8",
  zone: "rgba(180,190,200,0.05)",
  back: "rgba(180,190,200,0.10)",
  staging: "rgba(47,158,68,0.16)",
  corridor: "rgba(230,178,60,0.16)",
  aisle: "#6b767f",
  gondola: "#5f7789",
  wall: "#6b6e70",
  endcap: "#b4661f",
  seasonal: "#a8763a",
  bulk: "#7c5528",
  showcase: "#b5871f",
  impulse: "#a05d78",
  rack: "#8f7b53",
  shelving: "#a08d68",
  bench: "#7d745f",
  dock: "#2b8a3e",
  ground: "#b8400e",
  entrance: "#1971c2",
  register: "#9fb0ba",
  counter: "#c9962f",
  wrap: "#c2557c",
  lot: "#232629",
  stripe: "#4b5054",
  drive: "#1d2023",
  ada: "#2f74b5",
  curb: "#2b8a3e",
};

type Token = keyof typeof LIGHT;

/** `var(--sf-x, <light value>)`: themed when the style block survives, readable when it does not. */
function c(t: Token): string {
  return `var(--sf-${t}, ${LIGHT[t]})`;
}

/** Which token fills each fixture family. */
const FIXTURE_TOKEN: Record<FixtureKind, Token> = {
  gondola: "gondola",
  wall: "wall",
  endcap: "endcap",
  bulk: "bulk",
  showcase: "showcase",
  impulse: "impulse",
  seasonal: "seasonal",
};

/**
 * The shading ramp, pale cream through orange to a deep brown-red. It is
 * deliberately not one of the structural hues, and its pale end still reads as
 * "nearly nothing" against a dark floor, so one ramp serves both themes.
 */
function ramp(t: number): string {
  const stops = [
    [255, 247, 232],
    [253, 212, 158],
    [253, 141, 60],
    [217, 72, 15],
    [127, 39, 4],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const v = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
  return `rgb(${v[0]},${v[1]},${v[2]})`;
}

// ---------------------------------------------------------------------------
// Options and the feet-to-pixels transform
// ---------------------------------------------------------------------------

export interface FloorOptions {
  /** Drawing width in SVG units; the height follows from the building. */
  width?: number;
  /**
   * Shade the fixture runs bay by bay. "sales" takes dollars, "restocks" takes
   * how often the bay has to be filled, "appeal" takes the merchandising value
   * of its shelves.
   */
  shadeBy?: "none" | "sales" | "restocks" | "appeal";
  /**
   * The values behind `shadeBy`, **keyed by facing id** (`Facing.id`). They are
   * summed per bay for "sales" and "restocks" and averaged per bay for
   * "appeal", which is an intensity rather than a total. A double-sided gondola
   * bay gathers both of its faces, because on the plan it is one rectangle.
   */
  values?: Map<string, number>;
  /** Heading above the plan; the store's own name when omitted. */
  title?: string;
  showAisles?: boolean;
  showParking?: boolean;
  theme?: "light" | "dark";
}

/**
 * Feet to SVG units for a plan drawn `width` wide, exported so an overlay —
 * live actor dots on the 3D page's minimap, a click target in the workbench —
 * can share the renderer's frame exactly and invert it with `toFeet`.
 */
export interface FloorTransform {
  X: (x: number) => number;
  Y: (y: number) => number;
  toFeet: (px: number, py: number) => [x: number, y: number];
  /** Margin around the drawn extent, in feet. */
  pad: number;
  /** SVG units per foot. */
  scale: number;
  /** viewBox width and height, header and legend strips included. */
  width: number;
  height: number;
  /** Smallest y drawn: the far edge of the lot, or 0 when parking is off. */
  yMinFt: number;
  /** Height of the title strip above the plan. */
  headerHeight: number;
  /** Height of the legend and scale-bar strip below it. */
  legendHeight: number;
}

const HEADER_H = 38;
const LEGEND_ROW_H = 14;
const SCALE_ROW_H = 24;
const LEGEND_INSET = 8;

function parkingDepth(spec: LayoutSpec, opts: FloorOptions): number {
  if (opts.showParking === false) return 0;
  return Math.max(0, spec.parking.depthFt);
}

export function floorTransform(spec: LayoutSpec, opts: FloorOptions = {}): FloorTransform {
  const W = spec.widthFt;
  const D = spec.depthFt;
  const lotFt = parkingDepth(spec, opts);
  const yMinFt = lotFt > 0 ? -lotFt : 0;
  const drawnDepth = D - yMinFt;
  const pad = Math.max(10, Math.max(W, drawnDepth) * 0.03);
  const width = opts.width ?? 640;
  const scale = width / (W + 2 * pad);
  const legendHeight = legendRows(legendChips(spec, opts), width) * LEGEND_ROW_H + SCALE_ROW_H;
  const X = (x: number) => f1((x + pad) * scale);
  const Y = (y: number) => f1(HEADER_H + (D - y + pad) * scale);
  const toFeet = (px: number, py: number): [number, number] => [px / scale - pad, D - ((py - HEADER_H) / scale - pad)];
  return {
    X,
    Y,
    toFeet,
    pad,
    scale,
    width: f1(width),
    height: f1(HEADER_H + (drawnDepth + 2 * pad) * scale + legendHeight),
    yMinFt,
    headerHeight: HEADER_H,
    legendHeight,
  };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A rectangle given in feet, with a minimum on-screen size so a thin run stays visible. */
function box(tf: FloorTransform, x0: number, y0: number, x1: number, y1: number, attrs: string, title?: string): string {
  const px = Math.min(tf.X(x0), tf.X(x1));
  const py = Math.min(tf.Y(y0), tf.Y(y1));
  const w = Math.max(0.8, Math.abs(tf.X(x1) - tf.X(x0)));
  const h = Math.max(0.8, Math.abs(tf.Y(y1) - tf.Y(y0)));
  return `<rect x="${f1(px)}" y="${f1(py)}" width="${f1(w)}" height="${f1(h)}" ${attrs}>${title === undefined ? "" : `<title>${esc(title)}</title>`}</rect>`;
}

function seg(tf: FloorTransform, x0: number, y0: number, x1: number, y1: number, attrs: string): string {
  return `<line x1="${tf.X(x0)}" y1="${tf.Y(y0)}" x2="${tf.X(x1)}" y2="${tf.Y(y1)}" ${attrs}/>`;
}

function label(px: number, py: number, cls: string, s: string, anchor: "start" | "middle" | "end" = "start"): string {
  const a = anchor === "start" ? "" : ` text-anchor="${anchor}"`;
  return `<text x="${f1(px)}" y="${f1(py)}" class="${cls}"${a}>${esc(s)}</text>`;
}

function poly(tf: FloorTransform, pts: Point[], attrs: string, title?: string): string {
  const d = pts.map(([x, y]) => `${tf.X(x)},${tf.Y(y)}`).join(" ");
  return `<polygon points="${d}" ${attrs}>${title === undefined ? "" : `<title>${esc(title)}</title>`}</polygon>`;
}

// ---------------------------------------------------------------------------
// The parking lot
// ---------------------------------------------------------------------------

interface Stall {
  index: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  kind: "standard" | "accessible" | "curbside";
}

interface Lot {
  /** Walkway between the storefront and the first drive. */
  apronFt: number;
  stalls: Stall[];
  /** Centre line of each drive lane, for the drawing. */
  drives: Array<{ y: number; depthFt: number }>;
}

/**
 * Lay the lot out from the storefront outward: a walkway, then repeated bays of
 * one drive lane and the two rows of head-in stalls it serves, back to back
 * with the next bay's rows.
 *
 * The committed shops carry more stalls than a lot that depth and that width
 * would really hold — they are demand inputs, not a striping plan — so the row
 * count grows until the stalls fit across the frontage and the whole lot is
 * then scaled to the depth the site gives. The drawing stays honest about how
 * many stalls there are and where the marked ones sit, which is what the plan
 * is for.
 */
function lotLayout(spec: LayoutSpec, entranceX: number, depthFt: number): Lot | null {
  const total = spec.parking.stalls;
  const W = spec.widthFt;
  if (depthFt < 14 || total <= 0) return null;
  const apronFt = Math.min(6, depthFt * 0.12);
  const lotDepth = depthFt - apronFt;

  let rows = 1;
  while (rows < 8 && Math.ceil(total / rows) * 7.5 > W) rows++;
  const perRow = Math.ceil(total / rows);
  const stallW = W / perRow;
  const bays = Math.ceil(rows / 2);
  const shrink = Math.min(1, lotDepth / (bays * 22 + rows * 18));
  const driveFt = 22 * shrink;
  const rowFt = 18 * shrink;

  const stalls: Stall[] = [];
  const drives: Array<{ y: number; depthFt: number }> = [];
  let y = -apronFt;
  let index = 0;
  for (let b = 0; b < bays; b++) {
    drives.push({ y: y - driveFt / 2, depthFt: driveFt });
    y -= driveFt;
    for (let r = 0; r < 2 && b * 2 + r < rows; r++) {
      const yTop = y;
      const yBot = y - rowFt;
      for (let i = 0; i < perRow && index < total; i++, index++) {
        stalls.push({ index, x0: i * stallW, x1: (i + 1) * stallW, y0: yBot, y1: yTop, kind: "standard" });
      }
      y = yBot;
    }
  }

  // Curbside pickup takes the spots nearest the door, then the accessible
  // stalls take the next nearest: the same order a store would stripe them.
  const near = [...stalls].sort((a, b) => {
    const da = Math.abs((a.x0 + a.x1) / 2 - entranceX) - Math.abs((b.x0 + b.x1) / 2 - entranceX);
    return a.y1 !== b.y1 ? b.y1 - a.y1 : da !== 0 ? da : a.index - b.index;
  });
  const curb = Math.max(0, Math.min(spec.parking.curbsideStalls, near.length));
  const ada = Math.max(0, Math.min(spec.parking.accessibleStalls, near.length - curb));
  for (let i = 0; i < curb; i++) near[i].kind = "curbside";
  for (let i = curb; i < curb + ada; i++) near[i].kind = "accessible";

  return { apronFt, stalls, drives };
}

function drawParking(tf: FloorTransform, spec: LayoutSpec, lot: Lot, depthFt: number, entranceX: number): string {
  const W = spec.widthFt;
  const parts: string[] = [];
  parts.push(box(tf, 0, -depthFt, W, 0, `fill="${c("lot")}" stroke="${c("hair")}" stroke-width="0.8"`, `Customer lot: ${num(spec.parking.stalls)} stalls`));
  for (const d of lot.drives) {
    parts.push(box(tf, 0, d.y - d.depthFt / 2, W, d.y + d.depthFt / 2, `fill="${c("drive")}" stroke="none"`, "Drive lane"));
    parts.push(seg(tf, 1, d.y, W - 1, d.y, `stroke="${c("stripe")}" stroke-width="0.8" stroke-dasharray="6 6"`));
  }
  // The walkway along the storefront, where the curbside handoff happens.
  parts.push(box(tf, 0, -lot.apronFt, W, 0, `fill="${c("drive")}" stroke="none"`, "Storefront walkway"));
  for (const s of lot.stalls) {
    const fill = s.kind === "accessible" ? c("ada") : s.kind === "curbside" ? c("curb") : "none";
    const op = s.kind === "standard" ? "" : ` fill-opacity="0.55"`;
    const name = s.kind === "accessible" ? "Accessible stall" : s.kind === "curbside" ? "Curbside pickup" : "Stall";
    parts.push(box(tf, s.x0, s.y0, s.x1, s.y1, `fill="${fill}"${op} stroke="${c("stripe")}" stroke-width="0.7"`, `${name} ${s.index + 1}`));
  }
  // One letter per marked stall; the legend spells them out.
  const stallPx = lot.stalls.length > 0 ? Math.abs(tf.X(lot.stalls[0].x1) - tf.X(lot.stalls[0].x0)) : 0;
  if (stallPx >= 11) {
    for (const s of lot.stalls) {
      if (s.kind === "standard") continue;
      parts.push(label(tf.X((s.x0 + s.x1) / 2), tf.Y((s.y0 + s.y1) / 2) + 3, "sf-id", s.kind === "accessible" ? "A" : "C", "middle"));
    }
  }
  parts.push(label(tf.X(1), tf.Y(-depthFt) - 4, "sf-s", `Customer lot · ${num(spec.parking.stalls)} stalls`));
  parts.push(seg(tf, entranceX, -lot.apronFt, entranceX, 0, `stroke="${c("entrance")}" stroke-width="1.2" stroke-dasharray="2 2"`));
  return parts.join("");
}

// ---------------------------------------------------------------------------
// The staff corridor behind the counter
// ---------------------------------------------------------------------------

/**
 * The strip between the back of the counter and the side wall, where the clerks
 * work. It is derived rather than read from the spec, because an imported
 * drawing rarely carries a zone for it: the counter line is the far face of the
 * showcase and of any queue zone, and the corridor is everything between that
 * line and the wall the counter runs down.
 */
function staffCorridor(spec: LayoutSpec): { x0: number; y0: number; x1: number; y1: number } | null {
  if (spec.service.length === 0) return null;
  const W = spec.widthFt;
  const xs = spec.service.map((s) => s.x);
  const right = xs.reduce((a, b) => a + b, 0) / xs.length > W / 2;
  const cases = spec.fixtures.filter((f) => f.kind === "showcase");
  const queues = spec.zones.filter((z) => z.kind === "queue" && z.ring.length >= 3);
  const edges: number[] = [
    ...cases.map((f) => (right ? f.x + f.depthFt / 2 : f.x - f.depthFt / 2)),
    ...queues.map((z) => (right ? Math.max(...z.ring.map((p) => p[0])) : Math.min(...z.ring.map((p) => p[0])))),
  ];
  if (edges.length === 0) edges.push(...xs);
  const inner = right ? Math.max(...edges) : Math.min(...edges);
  const ys = [...spec.service.map((s) => s.y), ...cases.flatMap((f) => [f.y0, f.y1]), ...queues.flatMap((z) => z.ring.map((p) => p[1]))];
  const y0 = Math.max(0, Math.min(...ys) - 3);
  const y1 = Math.min(spec.backroomY, Math.max(...ys) + 3);
  const x0 = right ? inner : 0;
  const x1 = right ? W : inner;
  if (x1 - x0 < 1.5 || y1 - y0 < 1.5) return null;
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

interface BayValue {
  run: FixtureRun;
  bay: number;
  value: number;
}

/**
 * Roll the caller's per-facing values up to the bay rectangles the plan draws.
 * Facings are read from the layout's array, never by iterating the values Map,
 * so the drawing order is the layout's order and does not depend on how the
 * caller built its map.
 */
function bayValues(layout: Layout, opts: FloorOptions): BayValue[] {
  const mode = opts.shadeBy ?? "none";
  const values = opts.values;
  if (mode === "none" || !values || values.size === 0) return [];
  const mean = mode === "appeal";
  const sums = new Map<string, { sum: number; n: number }>();
  for (const f of layout.facings) {
    const v = values.get(f.id);
    if (v === undefined) continue;
    const key = `${f.run}|${f.bay}`;
    const acc = sums.get(key) ?? { sum: 0, n: 0 };
    acc.sum += v;
    acc.n += 1;
    sums.set(key, acc);
  }
  const out: BayValue[] = [];
  for (const run of layout.spec.fixtures) {
    for (let b = 0; b < run.bays; b++) {
      const acc = sums.get(`${run.id}|${b}`);
      if (!acc || acc.n === 0) continue;
      out.push({ run, bay: b, value: mean ? acc.sum / acc.n : acc.sum });
    }
  }
  return out;
}

const SHADE_LABEL: Record<Exclude<NonNullable<FloorOptions["shadeBy"]>, "none">, string> = {
  sales: "dollars a bay",
  restocks: "restocks a bay",
  appeal: "merchandising appeal",
};

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

interface Chip {
  token: Token;
  text: string;
  shape: "swatch" | "dash" | "dot";
}

function legendChips(spec: LayoutSpec, opts: FloorOptions): Chip[] {
  const kinds = new Set(spec.fixtures.map((f) => f.kind));
  const chips: Chip[] = [];
  const add = (present: boolean, token: Token, text: string, shape: Chip["shape"] = "swatch") => {
    if (present) chips.push({ token, text, shape });
  };
  add(kinds.has("gondola"), "gondola", "Gondola");
  add(kinds.has("endcap"), "endcap", "Endcap");
  add(kinds.has("bulk"), "bulk", "Bulk bins");
  add(kinds.has("wall"), "wall", "Wall shelf");
  add(kinds.has("showcase"), "showcase", "Showcase");
  add(kinds.has("seasonal"), "seasonal", "Seasonal");
  add(kinds.has("impulse"), "impulse", "Impulse");
  add(spec.service.some((s) => s.kind === "register"), "register", "Register", "dot");
  add(spec.service.some((s) => s.kind === "counter"), "counter", "Counter station", "dot");
  add(spec.service.some((s) => s.kind === "wrap"), "wrap", "Gift wrap", "dot");
  add(spec.storage.some((s) => s.kind === "rack"), "rack", "Pallet rack");
  add(spec.storage.some((s) => s.kind === "shelving"), "shelving", "Case shelving");
  add(true, "bench", "Pick and pack");
  add(spec.doors.some((d) => d.kind === "entrance"), "entrance", "Entrance");
  add(spec.doors.some((d) => d.kind === "dock"), "dock", "Dock");
  add(spec.doors.some((d) => d.kind === "ground"), "ground", "Roll-up");
  add(opts.showAisles !== false, "aisle", "Aisle", "dash");
  add(parkingDepth(spec, opts) > 0 && spec.parking.stalls > 0, "ada", "A accessible");
  add(parkingDepth(spec, opts) > 0 && spec.parking.curbsideStalls > 0, "curb", "C curbside");
  return chips;
}

const chipWidth = (ch: Chip) => 12 + 4 + ch.text.length * 5.3 + 14;

function legendRows(chips: Chip[], width: number): number {
  const avail = Math.max(80, width - 2 * LEGEND_INSET);
  let rows = 1;
  let x = 0;
  for (const ch of chips) {
    const w = chipWidth(ch);
    if (x > 0 && x + w > avail) {
      rows++;
      x = 0;
    }
    x += w;
  }
  return rows;
}

function drawLegend(tf: FloorTransform, chips: Chip[], opts: FloorOptions): string {
  const parts: string[] = [];
  const top = tf.height - tf.legendHeight;
  const avail = Math.max(80, tf.width - 2 * LEGEND_INSET);
  let x = LEGEND_INSET;
  let row = 0;
  for (const ch of chips) {
    const w = chipWidth(ch);
    if (x > LEGEND_INSET && x - LEGEND_INSET + w > avail) {
      row++;
      x = LEGEND_INSET;
    }
    const y = top + 10 + row * LEGEND_ROW_H;
    if (ch.shape === "swatch") parts.push(`<rect x="${f1(x)}" y="${f1(y - 7)}" width="11" height="9" rx="1.5" fill="${c(ch.token)}" stroke="${c("hair")}" stroke-width="0.6"/>`);
    else if (ch.shape === "dot") parts.push(`<circle cx="${f1(x + 5.5)}" cy="${f1(y - 2.5)}" r="4" fill="${c(ch.token)}" stroke="${c("hair")}" stroke-width="0.6"/>`);
    else parts.push(`<line x1="${f1(x)}" y1="${f1(y - 2.5)}" x2="${f1(x + 11)}" y2="${f1(y - 2.5)}" stroke="${c(ch.token)}" stroke-width="1.4" stroke-dasharray="3 3"/>`);
    parts.push(label(x + 16, y, "sf-s", ch.text));
    x += w;
  }

  // Scale bar: the largest round number of feet that fits a quarter of the plan.
  const y = top + tf.legendHeight - 8;
  const choices = [5, 10, 20, 25, 50, 100, 200];
  let ft = choices[0];
  for (const ch of choices) if (ch * tf.scale <= tf.width * 0.26) ft = ch;
  const px = ft * tf.scale;
  const x0 = LEGEND_INSET;
  parts.push(`<line x1="${f1(x0)}" y1="${f1(y - 4)}" x2="${f1(x0 + px)}" y2="${f1(y - 4)}" stroke="${c("text")}" stroke-width="1.2"/>`);
  parts.push(`<line x1="${f1(x0)}" y1="${f1(y - 8)}" x2="${f1(x0)}" y2="${f1(y)}" stroke="${c("text")}" stroke-width="1.2"/>`);
  parts.push(`<line x1="${f1(x0 + px)}" y1="${f1(y - 8)}" x2="${f1(x0 + px)}" y2="${f1(y)}" stroke="${c("text")}" stroke-width="1.2"/>`);
  parts.push(label(x0 + px + 6, y, "sf-s", `${ft} ft`));

  const mode = opts.shadeBy ?? "none";
  if (mode !== "none" && opts.values && opts.values.size > 0) {
    const bx = x0 + px + 6 + `${ft} ft`.length * 5.3 + 22;
    const bw = Math.min(96, Math.max(40, tf.width - bx - 150));
    for (let i = 0; i < 24; i++) {
      parts.push(`<rect x="${f1(bx + (i * bw) / 24)}" y="${f1(y - 9)}" width="${f1(bw / 24 + 0.4)}" height="9" fill="${ramp(i / 23)}"/>`);
    }
    parts.push(`<rect x="${f1(bx)}" y="${f1(y - 9)}" width="${f1(bw)}" height="9" fill="none" stroke="${c("hair")}" stroke-width="0.6"/>`);
    parts.push(label(bx + bw + 6, y, "sf-s", `low to high ${SHADE_LABEL[mode]}`));
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function drawFixture(tf: FloorTransform, run: FixtureRun, W: number): string {
  const parts: string[] = [];
  const x0 = run.x - run.depthFt / 2;
  const x1 = run.x + run.depthFt / 2;
  const facings = run.bays * run.shelves * run.facingsPerBay * (run.doubleSided ? 2 : 1);
  const title = `${run.id} — ${run.kind}, ${run.bays} bay${run.bays === 1 ? "" : "s"} × ${run.shelves} shelves × ${run.facingsPerBay} facing${run.facingsPerBay === 1 ? "" : "s"} = ${num(facings)} facings`;
  parts.push(box(tf, x0, run.y0, x1, run.y1, `fill="${c(FIXTURE_TOKEN[run.kind])}" stroke="${c("line")}" stroke-width="0.6"`, title));
  if (run.doubleSided) {
    // The spine a double-sided gondola is built either side of.
    parts.push(seg(tf, run.x, run.y0, run.x, run.y1, `stroke="${c("line")}" stroke-width="0.7" stroke-opacity="0.55"`));
  } else {
    // A single-sided run gets a heavier line on the face a shopper reaches.
    const face = run.x < W / 2 ? x1 : x0;
    parts.push(seg(tf, face, run.y0, face, run.y1, `stroke="${c("line")}" stroke-width="1.4"`));
  }
  const bayPx = (Math.abs(tf.Y(run.y1) - tf.Y(run.y0)) || 0) / Math.max(1, run.bays);
  if (bayPx >= 5) {
    const step = (run.y1 - run.y0) / run.bays;
    for (let b = 1; b < run.bays; b++) parts.push(seg(tf, x0, run.y0 + b * step, x1, run.y0 + b * step, `stroke="${c("line")}" stroke-width="0.4" stroke-opacity="0.35"`));
  }
  return parts.join("");
}

function drawStorage(tf: FloorTransform, run: StorageRun): string {
  const parts: string[] = [];
  const x0 = run.x - run.depthFt / 2;
  const x1 = run.x + run.depthFt / 2;
  const token: Token = run.kind === "rack" ? "rack" : "shelving";
  const what = run.kind === "rack" ? "pallet rack" : "case shelving";
  parts.push(
    box(tf, x0, run.y0, x1, run.y1, `fill="${c(token)}" stroke="${c("line")}" stroke-width="0.6"`, `${run.id} — ${what}, ${run.bays} bays × ${run.levels} levels = ${num(run.bays * run.levels)} positions`)
  );
  const bayPx = Math.abs(tf.Y(run.y1) - tf.Y(run.y0)) / Math.max(1, run.bays);
  if (bayPx >= 5) {
    const step = (run.y1 - run.y0) / run.bays;
    for (let b = 1; b < run.bays; b++) parts.push(seg(tf, x0, run.y0 + b * step, x1, run.y0 + b * step, `stroke="${c("line")}" stroke-width="0.4" stroke-opacity="0.4"`));
  }
  return parts.join("");
}

function drawService(tf: FloorTransform, sp: ServiceSpec, withLabel: boolean): string {
  const px = tf.X(sp.x);
  const py = tf.Y(sp.y);
  const r = Math.max(3, 1.1 * tf.scale);
  const token: Token = sp.kind === "register" ? "register" : sp.kind === "counter" ? "counter" : "wrap";
  const what = sp.kind === "register" ? "register" : sp.kind === "counter" ? "showcase station" : "gift-wrap station";
  const body =
    sp.kind === "register"
      ? `<rect x="${f1(px - r)}" y="${f1(py - r)}" width="${f1(2 * r)}" height="${f1(2 * r)}" rx="1" fill="${c(token)}" stroke="${c("floor")}" stroke-width="0.8"><title>${esc(`${sp.id} — ${what}`)}</title></rect>`
      : sp.kind === "counter"
        ? `<circle cx="${f1(px)}" cy="${f1(py)}" r="${f1(r)}" fill="${c(token)}" stroke="${c("floor")}" stroke-width="0.8"><title>${esc(`${sp.id} — ${what}`)}</title></circle>`
        : `<polygon points="${f1(px)},${f1(py - r * 1.2)} ${f1(px + r * 1.2)},${f1(py)} ${f1(px)},${f1(py + r * 1.2)} ${f1(px - r * 1.2)},${f1(py)}" fill="${c(token)}" stroke="${c("floor")}" stroke-width="0.8"><title>${esc(`${sp.id} — ${what}`)}</title></polygon>`;
  if (!withLabel) return body;
  // The label goes outboard, toward the wall the counter runs down: the staff
  // corridor is empty and the sales floor beside it is not.
  const anchor = sp.facing === 90 ? "end" : "start";
  const dx = anchor === "start" ? r + 3 : -(r + 3);
  return `${body}${label(px + dx, py + 3, "sf-id", sp.id, anchor)}`;
}

function drawDoor(tf: FloorTransform, door: DoorSpec, withLabel: boolean): string {
  const token: Token = door.kind === "entrance" ? "entrance" : door.kind === "dock" ? "dock" : "ground";
  const what = door.kind === "entrance" ? "customer entrance" : door.kind === "dock" ? "raised dock" : "ground-level roll-up";
  const half = Math.max(2, door.widthFt / 2);
  // Doors sit on the wall and are drawn just outside it, so they read against
  // the building rather than on top of whatever is inside.
  const out = door.kind === "entrance" ? -2.2 : 2.2;
  const parts = [box(tf, door.x - half, door.y, door.x + half, door.y + out, `fill="${c(token)}" stroke="${c("line")}" stroke-width="0.5"`, `${door.id} — ${what}, ${f1(door.widthFt)} ft`)];
  if (withLabel) parts.push(label(tf.X(door.x), tf.Y(door.y) + (door.kind === "entrance" ? 17 : -8), "sf-id", door.id, "middle"));
  return parts.join("");
}

/** The plan as an SVG string. */
export function renderFloorSvg(layout: Layout, opts: FloorOptions = {}): string {
  const spec = layout.spec;
  const W = spec.widthFt;
  const D = spec.depthFt;
  const tf = floorTransform(spec, opts);
  const showAisles = opts.showAisles !== false;
  const lotDepth = parkingDepth(spec, opts);
  const parts: string[] = [];

  parts.push(`<rect x="0" y="0" width="${tf.width}" height="${tf.height}" fill="${c("page")}"/>`);

  // The lot, under everything, so the storefront and its doors sit on top.
  const entrance = spec.doors.find((d) => d.kind === "entrance");
  const entranceX = entrance ? entrance.x : W / 2;
  if (lotDepth > 0) {
    const lot = lotLayout(spec, entranceX, lotDepth);
    if (lot) parts.push(drawParking(tf, spec, lot, lotDepth, entranceX));
    else parts.push(box(tf, 0, -lotDepth, W, 0, `fill="${c("lot")}" stroke="${c("hair")}" stroke-width="0.8"`, "Customer lot"));
  }

  // The building.
  if (spec.outline.length >= 3) parts.push(poly(tf, spec.outline, `fill="${c("floor")}" stroke="${c("line")}" stroke-width="1.6"`, spec.name));
  else parts.push(box(tf, 0, 0, W, D, `fill="${c("floor")}" stroke="${c("line")}" stroke-width="1.6"`, spec.name));

  for (const z of spec.zones) {
    if (z.ring.length < 3) continue;
    const fill = z.kind === "backroom" ? c("back") : z.kind === "staging" ? c("staging") : z.kind === "sales" ? c("zone") : "none";
    parts.push(poly(tf, z.ring, `fill="${fill}" stroke="none"`, z.name));
  }

  const corridor = staffCorridor(spec);
  if (corridor) parts.push(box(tf, corridor.x0, corridor.y0, corridor.x1, corridor.y1, `fill="${c("corridor")}" stroke="none"`, "Staff corridor behind the counter"));

  for (const w of spec.walls) {
    if (w.length < 2) continue;
    parts.push(`<polyline points="${w.map(([x, y]) => `${tf.X(x)},${tf.Y(y)}`).join(" ")}" fill="none" stroke="${c("line")}" stroke-width="1"/>`);
  }

  // The back wall the goods doors are in, and the line the stockroom starts at.
  parts.push(seg(tf, 0, D, W, D, `stroke="${c("line")}" stroke-width="2.4"`));
  parts.push(seg(tf, 0, spec.backroomY, W, spec.backroomY, `stroke="${c("line")}" stroke-width="1.1" stroke-dasharray="7 4"`));
  parts.push(label(tf.X(1.5), tf.Y(spec.backroomY) - 4, "sf-s", "Stockroom"));

  if (showAisles) {
    const draw = (a: { x: number; y0: number; y1: number }, name: string) => {
      parts.push(seg(tf, a.x, a.y0, a.x, a.y1, `stroke="${c("aisle")}" stroke-width="0.8" stroke-dasharray="4 4"`));
      parts.push(label(tf.X(a.x), tf.Y(a.y0) + 10, "sf-id", name, "middle"));
    };
    layout.salesAisles.forEach((a, i) => draw(a, `A${i + 1}`));
    layout.backroomAisles.forEach((a, i) => draw(a, `B${i + 1}`));
  }

  for (const run of spec.fixtures) parts.push(drawFixture(tf, run, W));
  for (const run of spec.storage) parts.push(drawStorage(tf, run));

  // Shading sits over the runs so the fixture outline still reads through it.
  const mode = opts.shadeBy ?? "none";
  const bays = bayValues(layout, opts);
  if (mode !== "none" && bays.length > 0) {
    const max = Math.max(1e-9, ...bays.map((b) => b.value));
    // A total is heavy-tailed, so its ramp is square-rooted to keep the middle
    // of the store from collapsing to one colour; appeal is already a bounded
    // index and reads straight.
    const linear = mode === "appeal";
    const unit = SHADE_LABEL[mode].replace(" a bay", "");
    for (const b of bays) {
      const step = (b.run.y1 - b.run.y0) / b.run.bays;
      const y0 = b.run.y0 + b.bay * step;
      const t = linear ? b.value / max : Math.sqrt(b.value / max);
      // Inset, so a rim of the fixture's own colour survives the shading and
      // the plan still says what kind of fixture is running hot.
      const dx = b.run.depthFt * 0.2;
      const dy = Math.min(step * 0.14, 0.4);
      parts.push(
        box(
          tf,
          b.run.x - b.run.depthFt / 2 + dx,
          y0 + dy,
          b.run.x + b.run.depthFt / 2 - dx,
          y0 + step - dy,
          `fill="${ramp(t)}" stroke="${c("line")}" stroke-width="0.3"`,
          `${b.run.id} bay ${b.bay + 1}: ${b.value >= 100 ? num(b.value) : f1(b.value)} ${unit}`
        )
      );
    }
  }

  // Everything a worker or a shopper aims at.
  const bench = layout.bench;
  parts.push(box(tf, bench.x - 3, bench.y - 1.25, bench.x + 3, bench.y + 1.25, `fill="${c("bench")}" stroke="${c("line")}" stroke-width="0.7"`, "Pick-and-pack bench"));
  parts.push(label(tf.X(bench.x), tf.Y(bench.y) - 6, "sf-id", "Bench", "middle"));
  parts.push(`<circle cx="${tf.X(layout.staging.x)}" cy="${tf.Y(layout.staging.y)}" r="${f1(Math.max(2.5, tf.scale))}" fill="none" stroke="${c("dock")}" stroke-width="1.2" stroke-dasharray="3 2"><title>Receiving apron</title></circle>`);
  parts.push(`<circle cx="${tf.X(layout.entry.x)}" cy="${tf.Y(layout.entry.y)}" r="${f1(Math.max(2.5, tf.scale))}" fill="${c("entrance")}" fill-opacity="0.5" stroke="${c("entrance")}" stroke-width="1"><title>Just inside the entrance</title></circle>`);
  parts.push(seg(tf, layout.stockDoor.x - 2.5, layout.stockDoor.y, layout.stockDoor.x + 2.5, layout.stockDoor.y, `stroke="${c("floor")}" stroke-width="3.5"`));
  parts.push(label(tf.X(layout.stockDoor.x), tf.Y(layout.stockDoor.y) + 10, "sf-id", "Stock door", "middle"));

  const serviceLabels = spec.service.length <= 12;
  for (const sp of spec.service) parts.push(drawService(tf, sp, serviceLabels));
  const doorLabels = spec.doors.length <= 12;
  for (const door of spec.doors) parts.push(drawDoor(tf, door, doorLabels));

  // Run ids, once the drawing is not crowded by them.
  if (spec.fixtures.length + spec.storage.length <= 28) {
    for (const run of spec.fixtures) parts.push(label(tf.X(run.x), tf.Y(run.y1) - 3, "sf-id", run.id, "middle"));
    for (const run of spec.storage) parts.push(label(tf.X(run.x), tf.Y(run.y1) - 3, "sf-id", run.id, "middle"));
  }

  // Header and legend.
  const title = opts.title ?? spec.name;
  parts.push(label(LEGEND_INSET, 17, "sf-t", title));
  parts.push(label(LEGEND_INSET, 31, "sf-m", summaryLine(layout, opts)));
  parts.push(drawLegend(tf, legendChips(spec, opts), opts));

  const style = styleBlock(opts.theme);
  return (
    `<svg class="sf" viewBox="0 0 ${tf.width} ${tf.height}" width="100%" role="img" ` +
    `aria-label="${esc(`Store plan of ${title}`)}" xmlns="http://www.w3.org/2000/svg">` +
    `${style}${parts.join("")}</svg>`
  );
}

/** The one-line description under the title, and the same line in the HTML page. */
function summaryLine(layout: Layout, opts: FloorOptions): string {
  const spec = layout.spec;
  const bits = [
    `${f1(spec.widthFt)} × ${f1(spec.depthFt)} ft`,
    `${num(layout.sellingSqFt)} sq ft selling`,
    `${num(layout.backroomSqFt)} sq ft stockroom`,
    `${num(layout.facings.length)} facings`,
    `${num(layout.storage.length)} stockroom positions`,
    `${layout.salesAisles.length} aisle${layout.salesAisles.length === 1 ? "" : "s"}`,
  ];
  if (parkingDepth(spec, opts) > 0 && spec.parking.stalls > 0) {
    bits.push(`${num(spec.parking.stalls)} stalls (${spec.parking.accessibleStalls} accessible, ${spec.parking.curbsideStalls} curbside)`);
  }
  const mode = opts.shadeBy ?? "none";
  if (mode !== "none" && opts.values && opts.values.size > 0) bits.push(`shaded by ${SHADE_LABEL[mode]}`);
  return bits.join(" · ");
}

function tokenBlock(sel: string, theme: Record<Token, string>): string {
  const keys = Object.keys(LIGHT) as Token[];
  return `${sel}{${keys.map((k) => `--sf-${k}:${theme[k]}`).join(";")}}`;
}

function styleBlock(theme: FloorOptions["theme"]): string {
  const fonts =
    `.sf text{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}` +
    `.sf-t{font-size:15px;font-weight:600;fill:${c("text")}}` +
    `.sf-m{font-size:11px;fill:${c("muted")}}` +
    `.sf-s{font-size:10px;fill:${c("muted")}}` +
    `.sf-id{font-size:9px;fill:${c("muted")}}`;
  if (theme === "dark") return `<style>${tokenBlock(".sf", DARK)}${fonts}</style>`;
  if (theme === "light") return `<style>${tokenBlock(".sf", LIGHT)}${fonts}</style>`;
  return `<style>${tokenBlock(".sf", LIGHT)}@media (prefers-color-scheme:dark){${tokenBlock(".sf", DARK)}}${fonts}</style>`;
}

// ---------------------------------------------------------------------------
// The standalone page
// ---------------------------------------------------------------------------

/**
 * A self-contained HTML page around the SVG, for the local `render_floor` tool.
 * No scripts, no fonts, no stylesheets and no images from anywhere else: the
 * file opens from disk with nothing running.
 *
 * The drawing already carries the store's name and its numbers, so the page's
 * own heading is there for the document outline and for a screen reader — which
 * reads the SVG as one image and never sees inside it — and is hidden from the
 * eye rather than printed twice.
 */
export function renderFloorHtml(layout: Layout, opts: FloorOptions = {}): string {
  const title = opts.title ?? layout.spec.name;
  const svg = renderFloorSvg(layout, { width: 1040, ...opts });
  const dark = opts.theme === "dark";
  const page = dark ? "#101214" : "#ffffff";
  const ink = dark ? "#e7e9eb" : "#242422";
  const autoBlock = opts.theme === undefined ? `@media (prefers-color-scheme:dark){body{background:#101214;color:#e7e9eb}}` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)} — store plan</title>` +
    `<style>body{font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:16px;max-width:1120px;background:${page};color:${ink}}` +
    `h1{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}${autoBlock}</style></head>` +
    `<body><h1>${esc(title)} — ${esc(summaryLine(layout, opts))}</h1>${svg}</body></html>`
  );
}
