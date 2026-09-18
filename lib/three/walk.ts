/**
 * First-person walking, and the collision it slides against.
 *
 * Click the canvas for pointer lock, mouse to look, WASD or the arrows to
 * move, Shift to run, E to inspect whatever the crosshair is on. The eye is
 * 5.5 ft up and the body is a 1.2 ft circle — narrower than the warehouse's,
 * because a candy shop's aisle is five and a half feet wide and a 1.5 ft
 * walker cannot pass a stock cart in one.
 *
 * Collision is in the engine frame: a circle slides against axis-aligned
 * boxes, one axis at a time against every box grown by the radius, then a
 * final push-out guarantees the centre is never left inside one, whatever
 * corner or seam the two axis moves ran into. The boxes are exactly the
 * footprints `segmentHitsFixture` in lib/trace/paths.ts tests — every fixture
 * run and every storage run — plus the service counter, the wall segments
 * split at the door openings, and whatever vehicle is parked outside right
 * now. Using the same footprints as the path router is the point: a person
 * walking the model cannot reach anywhere a simulated shopper could not.
 *
 * Key events are taken in the capture phase on window and stopped only while
 * walking, so the page's own shortcuts (the arrows scrub time) keep working
 * the rest of the time.
 */

import { PerspectiveCamera } from "three";
import type { LayoutSpec, Point } from "../layout/spec";
import type { DoorFrame } from "../trace/types";

export const EYE_HEIGHT = 5.5;
export const WALK_RADIUS = 1.2;
export const WALK_SPEED = 5;
export const RUN_SPEED = 10;

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

export interface Aabb {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EPS = 1e-3;

function inside(x: number, y: number, r: number, b: Aabb): boolean {
  return x > b.x0 - r && x < b.x1 + r && y > b.y0 - r && y < b.y1 + r;
}

/** True when a circle of radius r at (x, y) overlaps any box. */
export function overlapsAny(x: number, y: number, r: number, boxes: readonly Aabb[]): boolean {
  for (const b of boxes) if (inside(x, y, r, b)) return true;
  return false;
}

/** Moves the centre out of every box it overlaps, through the nearest face each time. */
export function pushOut(x: number, y: number, r: number, boxes: readonly Aabb[]): { x: number; y: number } {
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (const b of boxes) {
      if (!inside(x, y, r, b)) continue;
      const left = x - (b.x0 - r);
      const right = b.x1 + r - x;
      const down = y - (b.y0 - r);
      const up = b.y1 + r - y;
      const m = Math.min(left, right, down, up);
      if (m === left) x = b.x0 - r - EPS;
      else if (m === right) x = b.x1 + r + EPS;
      else if (m === down) y = b.y0 - r - EPS;
      else y = b.y1 + r + EPS;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y };
}

function moveAxis(px: number, py: number, d: number, r: number, boxes: readonly Aabb[], axis: 0 | 1): number {
  let p = (axis === 0 ? px : py) + d;
  for (let iter = 0; iter < 6; iter++) {
    let hit = false;
    for (const b of boxes) {
      const ox = axis === 0 ? p : px;
      const oy = axis === 0 ? py : p;
      if (!inside(ox, oy, r, b)) continue;
      const lo = (axis === 0 ? b.x0 : b.y0) - r - EPS;
      const hi = (axis === 0 ? b.x1 : b.y1) + r + EPS;
      if (d > 0) p = lo;
      else if (d < 0) p = hi;
      else p = p - lo < hi - p ? lo : hi;
      hit = true;
    }
    if (!hit) break;
  }
  return p;
}

/** Slide a circle from (x, y) by (dx, dy); the result is never inside a box grown by r. */
export function slideCircle(x: number, y: number, dx: number, dy: number, r: number, boxes: readonly Aabb[]): { x: number; y: number } {
  const start = overlapsAny(x, y, r, boxes) ? pushOut(x, y, r, boxes) : { x, y };
  const nx = moveAxis(start.x, start.y, dx, r, boxes, 0);
  const ny = moveAxis(nx, start.y, dy, r, boxes, 1);
  return overlapsAny(nx, ny, r, boxes) ? pushOut(nx, ny, r, boxes) : { x: nx, y: ny };
}

function ringBounds(ring: Point[]): Aabb | null {
  if (ring.length < 3) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Everything solid on the floor: the selling fixtures, the stockroom runs and
 * the service counter. The first two are the same footprints the path router
 * refuses to walk through; the counter comes from the spec's queue zone, which
 * is the rectangle the registers and the glass stand in.
 */
export function fixtureColliders(spec: LayoutSpec): Aabb[] {
  const out: Aabb[] = [];
  for (const r of [...spec.fixtures, ...spec.storage]) {
    out.push({ x0: r.x - r.depthFt / 2, y0: Math.min(r.y0, r.y1), x1: r.x + r.depthFt / 2, y1: Math.max(r.y0, r.y1) });
  }
  for (const z of spec.zones) {
    if (z.kind !== "queue") continue;
    const b = ringBounds(z.ring);
    if (b) out.push(b);
  }
  return out;
}

function segmentBoxes(a: Point, b: Point, thickness: number, out: Aabb[]): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-6) return;
  const axisAligned = Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6;
  // A diagonal wall from an imported drawing is chopped into short pieces and
  // each piece boxed: slightly conservative, and always safe.
  const pieces = axisAligned ? 1 : Math.max(1, Math.ceil(len / 4));
  for (let i = 0; i < pieces; i++) {
    const p: Point = [a[0] + ((b[0] - a[0]) * i) / pieces, a[1] + ((b[1] - a[1]) * i) / pieces];
    const q: Point = [a[0] + ((b[0] - a[0]) * (i + 1)) / pieces, a[1] + ((b[1] - a[1]) * (i + 1)) / pieces];
    out.push({
      x0: Math.min(p[0], q[0]) - thickness / 2,
      y0: Math.min(p[1], q[1]) - thickness / 2,
      x1: Math.max(p[0], q[0]) + thickness / 2,
      y1: Math.max(p[1], q[1]) + thickness / 2,
    });
  }
}

/** Outline and imported walls as thin boxes, with a gap at every door so the lot and the apron are reachable. */
export function wallColliders(spec: LayoutSpec, frames: readonly DoorFrame[]): Aabb[] {
  const out: Aabb[] = [];
  const ring: Point[] =
    spec.outline.length >= 3
      ? spec.outline
      : [
          [0, 0],
          [spec.widthFt, 0],
          [spec.widthFt, spec.depthFt],
          [0, spec.depthFt],
        ];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const spans: Array<[number, number]> = [];
    for (const f of frames) {
      const s = (f.origin[0] - a[0]) * ux + (f.origin[1] - a[1]) * uy;
      const dist = Math.abs((f.origin[0] - a[0]) * uy - (f.origin[1] - a[1]) * ux);
      if (s < -0.5 || s > len + 0.5 || dist > 1.5) continue;
      spans.push([Math.max(0, s - f.widthFt / 2), Math.min(len, s + f.widthFt / 2)]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    const piece = (s0: number, s1: number) => {
      if (s1 - s0 < 0.1) return;
      segmentBoxes([a[0] + ux * s0, a[1] + uy * s0], [a[0] + ux * s1, a[1] + uy * s1], 1, out);
    };
    for (const [s0, s1] of spans) {
      if (s0 < cursor) continue;
      piece(cursor, s0);
      cursor = s1;
    }
    piece(cursor, len);
  }
  for (const line of spec.walls) for (let i = 0; i + 1 < line.length; i++) segmentBoxes(line[i], line[i + 1], 0.6, out);
  return out;
}

/**
 * The box a vehicle occupies backed onto a door: its rear at the opening, its
 * nose out along −inward. Length and width are arguments rather than constants
 * because a shop takes three sizes at the same doors — the overnight trailer,
 * a vendor's box truck and its own van.
 */
export function vehicleCollider(frame: DoorFrame, lengthFt: number, widthFt: number): Aabb {
  const [ox, oy] = frame.origin;
  const nx = ox - frame.inward[0] * lengthFt;
  const ny = oy - frame.inward[1] * lengthFt;
  const hw = widthFt / 2;
  const tx = Math.abs(frame.tangent[0]) * hw;
  const ty = Math.abs(frame.tangent[1]) * hw;
  return { x0: Math.min(ox, nx) - tx, y0: Math.min(oy, ny) - ty, x1: Math.max(ox, nx) + tx, y1: Math.max(oy, ny) + ty };
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "KeyE"]);

export interface WalkOptions {
  onInspect: () => void;
  colliders: () => readonly Aabb[];
}

export class WalkController {
  active = false;
  x = 0;
  y = 0;
  yaw = 0;
  pitch = 0;
  private locked = false;
  private canvas: HTMLCanvasElement | null = null;
  private readonly keys = new Set<string>();

  private readonly onClick = () => {
    if (!this.active || !this.canvas) return;
    this.canvas.requestPointerLock?.();
  };
  private readonly onLockChange = () => {
    this.locked = !!this.canvas && document.pointerLockElement === this.canvas;
  };
  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.active || !this.locked) return;
    this.yaw -= e.movementX * 0.0025;
    this.pitch = Math.min(1.3, Math.max(-1.3, this.pitch - e.movementY * 0.0025));
  };
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.active || !MOVE_KEYS.has(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "KeyE") {
      if (!e.repeat) this.opts.onInspect();
      return;
    }
    this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private readonly onBlur = () => {
    this.keys.clear();
  };

  constructor(
    readonly camera: PerspectiveCamera,
    readonly opts: WalkOptions
  ) {}

  get pointerLocked(): boolean {
    return this.locked;
  }

  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas) return;
    this.canvas = canvas;
    canvas.addEventListener("click", this.onClick);
    document.addEventListener("pointerlockchange", this.onLockChange);
    document.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    if (!this.canvas) return;
    this.exit();
    this.canvas.removeEventListener("click", this.onClick);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    document.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    this.canvas = null;
  }

  /** Start walking at an engine position, facing yaw (the camera's rotation.y). */
  enter(x: number, y: number, yaw: number): void {
    this.active = true;
    const p = slideCircle(x, y, 0, 0, WALK_RADIUS, this.opts.colliders());
    this.x = p.x;
    this.y = p.y;
    this.yaw = yaw;
    this.pitch = 0;
    this.place();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    if (this.locked && typeof document !== "undefined") document.exitPointerLock?.();
  }

  private place(): void {
    this.camera.position.set(this.x, EYE_HEIGHT, -this.y);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  update(dt: number): void {
    if (!this.active) return;
    const k = this.keys;
    let fwd = 0;
    let side = 0;
    if (k.has("KeyW") || k.has("ArrowUp")) fwd += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) fwd -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) side += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) side -= 1;
    if (fwd !== 0 || side !== 0) {
      const speed = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;
      const len = Math.hypot(fwd, side);
      const step = (speed * Math.min(0.1, Math.max(0, dt))) / len;
      // The camera looks along local −Z: engine forward is (−sin yaw, cos yaw), right is (cos yaw, sin yaw).
      const dx = (-Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * side) * step;
      const dy = (Math.cos(this.yaw) * fwd + Math.sin(this.yaw) * side) * step;
      const p = slideCircle(this.x, this.y, dx, dy, WALK_RADIUS, this.opts.colliders());
      this.x = p.x;
      this.y = p.y;
    }
    this.place();
  }

  dispose(): void {
    this.detach();
  }
}
