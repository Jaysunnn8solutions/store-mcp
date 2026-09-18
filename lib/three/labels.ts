/**
 * DOM label anchors. The renderer never draws text: each frame it collects the
 * things worth naming (staff and vehicles on the move, a queue chip over each
 * service post, a badge on a facing that has run out), projects them with the
 * camera, drops the ones the walls hide, keeps the best MAX_LABELS and nudges
 * overlapping anchors apart. The React layer owns the pill elements, which is
 * why this whole module is testable under Node and why label styling is CSS.
 *
 * `entity` carries three kinds of anchor through one number, so the DOM needs
 * only a `data-entity` attribute and the page decodes it back on click: an
 * actor is its entity index, a queue chip is `-1 - postIndex`, and a facing
 * badge is `-100 - facingIndex`.
 *
 * The occlusion test is where a shop differs from a warehouse. A warehouse
 * wall is opaque and the only exceptions are the dock openings; a shopfront is
 * glass, and the whole point of it is that you can see the sales floor from
 * the car park. So `LabelOccluder` carries glazed spans as well as doorways,
 * and a sightline that crosses one below its head height is not hidden.
 */

import { Camera, Vector3 } from "three";
import { toWorld } from "./geometry";

export const MAX_LABELS = 24;
/** Pill metrics that must match the page's CSS: 11 px text, 6 px side padding. */
export const LABEL_CHAR_PX = 6.4;
export const LABEL_PAD_PX = 14;
export const LABEL_HEIGHT_PX = 17;
export const LABEL_GAP_PX = 2;
const MAX_HOPS = 6;

/** What the page draws: a screen position, the text and enough to style and decode it. */
export interface LabelAnchor {
  x: number;
  y: number;
  text: string;
  /** "staff", "customer", "vehicle", "queue" or "short" — the page's CSS class. */
  kind: string;
  entity: number;
}

export interface LabelPos extends LabelAnchor {
  /** Camera distance in feet, for sorting and fading. */
  depth: number;
}

export interface LabelSource {
  entity: number;
  text: string;
  kind: string;
  /** Engine frame. */
  x: number;
  y: number;
  z: number;
  /** Higher wins when more than MAX_LABELS are on screen. */
  priority: number;
  /** Dropped when the walls stand between the camera and the anchor. */
  occludable?: boolean;
}

/** An opening in a wall: its centre, the wall's tangent, half its width and how high it reaches. */
export interface LabelSpan {
  x: number;
  y: number;
  tx: number;
  ty: number;
  halfWidth: number;
  heightFt: number;
}

/** The shop's footprint, wall height and the openings a sightline can pass through. */
export interface LabelOccluder {
  /** Engine feet: the building spans 0..w across and 0..d from the storefront. */
  w: number;
  d: number;
  wallHeight: number;
  /** Doorways: goods doors and the customer entrance. */
  doors?: LabelSpan[];
  /** Glazed spans, chiefly the storefront; seen through from anywhere. */
  glass?: LabelSpan[];
}

const OCCLUDE_MARGIN_FT = 0.5;
/** How far off the wall line a crossing may be and still count as passing through an opening on it. */
const OPENING_DEPTH_FT = 1.5;

/** Where a ray from p along dp enters the slab [0, hi]: −Infinity when already inside it, Infinity when it never does. */
function slabEntry(p: number, dp: number, hi: number): number {
  if (Math.abs(dp) < 1e-9) return p >= 0 && p <= hi ? -Infinity : Infinity;
  return Math.min(-p / dp, (hi - p) / dp);
}

function throughSpan(px: number, py: number, height: number, spans: readonly LabelSpan[] | undefined): boolean {
  if (!spans) return false;
  for (const s of spans) {
    if (height >= s.heightFt) continue;
    const rx = px - s.x;
    const ry = py - s.y;
    const along = rx * s.tx + ry * s.ty;
    const off = Math.abs(rx * -s.ty + ry * s.tx);
    if (Math.abs(along) <= s.halfWidth && off <= OPENING_DEPTH_FT) return true;
  }
  return false;
}

/**
 * Whether the walls stand between the camera and an anchor inside the shop, so
 * a pill would float on a blank wall: the camera is outside the footprint and
 * the sightline is below the wall top where it crosses the footprint's edge,
 * and does not pass through a doorway or a glazed span there. The model is
 * roofless, so a sightline that clears the wall sees inside; a camera a little
 * above the wall top still loses a low anchor deep inside, which is what the
 * dock preset needs, while a shopper seen through the storefront keeps a name.
 */
export function wallsHide(camX: number, camY: number, camHeight: number, ax: number, ay: number, aHeight: number, occ: LabelOccluder): boolean {
  const camOutside = camX < 0 || camX > occ.w || camY < 0 || camY > occ.d;
  if (!camOutside) return false;
  if (!(ax > OCCLUDE_MARGIN_FT && ax < occ.w - OCCLUDE_MARGIN_FT && ay > OCCLUDE_MARGIN_FT && ay < occ.d - OCCLUDE_MARGIN_FT)) return false;
  const dx = ax - camX;
  const dy = ay - camY;
  const sIn = Math.max(slabEntry(camX, dx, occ.w), slabEntry(camY, dy, occ.d));
  if (!Number.isFinite(sIn) || sIn < 0 || sIn > 1) return false;
  const hAtWall = camHeight + sIn * (aHeight - camHeight);
  if (hAtWall >= occ.wallHeight) return false;
  const px = camX + sIn * dx;
  const py = camY + sIn * dy;
  if (throughSpan(px, py, hAtWall, occ.doors)) return false;
  if (throughSpan(px, py, hAtWall, occ.glass)) return false;
  return true;
}

export function queueChipEntity(postIndex: number): number {
  return -1 - postIndex;
}

export function isQueueChip(entity: number): boolean {
  return entity < 0 && entity > -100;
}

export function queueChipIndex(entity: number): number {
  return -1 - entity;
}

export function facingBadgeEntity(facingIndex: number): number {
  return -100 - facingIndex;
}

export function facingBadgeIndex(entity: number): number {
  return -100 - entity;
}

/** Estimated pill width for a label's text. */
export function labelWidth(text: string): number {
  return LABEL_PAD_PX + text.length * LABEL_CHAR_PX;
}

interface Placed {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function overlaps(a: Placed, b: Placed): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * Moves overlapping labels up, in place. `first` says which labels are placed
 * before the rest (the queue chips), so a chip keeps its anchor against
 * everything but another chip; the rest are visited nearest first, so the
 * label a viewer is closest to keeps its anchor and the ones behind it stack
 * above rather than printing over each other.
 */
export function deoverlap(labels: LabelPos[], first: (l: LabelPos) => boolean = (l) => isQueueChip(l.entity), height = LABEL_HEIGHT_PX, gap = LABEL_GAP_PX): void {
  const placed: Placed[] = [];
  const box = (l: LabelPos): Placed => {
    const hw = labelWidth(l.text) / 2;
    return { x0: l.x - hw, x1: l.x + hw, y0: l.y - height, y1: l.y };
  };
  const order = labels
    .map((l, i) => i)
    .sort((a, b) => {
      const fa = first(labels[a]) ? 0 : 1;
      const fb = first(labels[b]) ? 0 : 1;
      return fa - fb || labels[a].depth - labels[b].depth;
    });
  for (const i of order) {
    const l = labels[i];
    let b = box(l);
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const hit = placed.find((p) => overlaps(b, p));
      if (!hit) break;
      l.y = hit.y0 - gap;
      b = box(l);
    }
    placed.push(b);
  }
}

const _v = new Vector3();
const _w = new Vector3();

export class LabelProjector {
  project(sources: readonly LabelSource[], camera: Camera, width: number, height: number, max = MAX_LABELS, occluder: LabelOccluder | null = null): LabelPos[] {
    const out: Array<LabelPos & { priority: number }> = [];
    camera.updateMatrixWorld();
    const camPos = _w.setFromMatrixPosition(camera.matrixWorld);
    // The camera in engine feet: world X is engine x, world −Z is engine y, world Y is height.
    const camX = camPos.x;
    const camY = -camPos.z;
    const camHeight = camPos.y;
    for (const s of sources) {
      if (s.occludable && occluder && wallsHide(camX, camY, camHeight, s.x, s.y, s.z, occluder)) continue;
      toWorld(s.x, s.y, s.z, _v);
      const depth = _v.distanceTo(camPos);
      _v.project(camera);
      const visible = _v.z > -1 && _v.z < 1 && _v.x >= -1.05 && _v.x <= 1.05 && _v.y >= -1.05 && _v.y <= 1.05;
      if (!visible) continue;
      out.push({ entity: s.entity, text: s.text, kind: s.kind, x: ((_v.x + 1) / 2) * width, y: ((1 - _v.y) / 2) * height, depth, priority: s.priority });
    }
    out.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    const kept = out.slice(0, max).map(({ entity, text, kind, x, y, depth }) => ({ entity, text, kind, x, y, depth }));
    deoverlap(kept);
    return kept;
  }
}
