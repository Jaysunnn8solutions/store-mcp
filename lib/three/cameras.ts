/**
 * The camera rig: an orbit camera with seven fitted presets, and a
 * spring-damped follow camera that sits behind and above whatever it chases,
 * at a distance set by how big that thing is.
 *
 * Presets are fitted, not hard-coded. Each names a box in engine feet — the
 * building and its lot, the doorway, one gondola aisle, the showcase, the
 * stockroom racking, the goods doors from the service drive, the parking —
 * and a direction to look from, and `fitView` finds the distance at which
 * every corner of that box lands inside `fill` of the frustum at the camera's
 * fov and current aspect. The same preset therefore frames the subject on a
 * phone and on a wide monitor, and on all five committed shops, which differ
 * by nearly a factor of two in floor area. A resize re-fits the preset the
 * camera is still on; the first drag, wheel or pinch releases it.
 *
 * OrbitControls is only created in `attach()`, so the rig builds and computes
 * every preset under Node, which is what makes cameras.test.ts possible.
 */

import { PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LayoutSpec } from "../layout/spec";
import type { World } from "../trace/types";
import { FIXTURE_HEIGHT, STORAGE_LEVEL_FT } from "../trace/world";
import type { CameraPreset, ViewMode } from "./api";
import { toWorld } from "./geometry";

export interface FollowPose {
  /** Engine feet. */
  x: number;
  y: number;
  /** Heading, radians, 0 = +x. */
  h: number;
  /** Overall length of the thing being followed, so a trailer is framed like a trailer and a shopper like a shopper. */
  lengthFt: number;
}

/** An axis-aligned box in engine feet (x across, y from the storefront inward, z up). */
export interface StageBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** What a preset frames: the box, the unit direction from the box towards the camera, and the share of the viewport the box fills. */
export interface PresetSpec {
  box: StageBox;
  /** Engine frame, unit length. */
  back: [number, number, number];
  fill?: number;
  /** Lowest camera height in feet, so a low angle still clears the parked cars. */
  minHeight?: number;
}

export interface PresetView {
  pos: Vector3;
  target: Vector3;
}

/** The share of the frustum a fitted subject occupies. */
export const PRESET_FILL = 0.85;
/** Top of the shop's walls, feet; the fascia band sits just above it. */
export const WALL_TOP = 18;
const FOLLOW_STIFFNESS = 30;

const _desired = new Vector3();
const _look = new Vector3();
const _acc = new Vector3();
const _back = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _corner = new Vector3();
const _centre = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);

function unit(v: [number, number, number]): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Corner support along the four frustum side-plane normals. */
interface Support {
  right: number;
  left: number;
  top: number;
  bottom: number;
}

function eachCorner(box: StageBox, fn: (c: Vector3) => void): void {
  for (const x of [box.x0, box.x1]) {
    for (const y of [box.y0, box.y1]) {
      for (const z of [box.z0, box.z1]) fn(toWorld(x, y, z, _corner));
    }
  }
}

/** Camera basis for a view direction: forward = −back, right = forward × up, up = right × forward. Writes _back, _fwd, _right, _up. */
function basis(back: [number, number, number]): void {
  toWorld(back[0], back[1], back[2], _back);
  _fwd.copy(_back).negate();
  _right.crossVectors(_fwd, WORLD_UP);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  _up.crossVectors(_right, _fwd).normalize();
}

/**
 * The camera offset along `axis` at which the box's screen extent along that
 * axis is centred, given the camera's forward offset `fp`: a corner's screen
 * coordinate is (axis·c − a) / ((fwd·c − fp) k), linear and decreasing in a,
 * so the sum of the extreme coordinates has one root, found by bisection.
 */
function centreAlong(box: StageBox, axis: Vector3, fp: number, k: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  eachCorner(box, (c) => {
    const s = c.dot(axis);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  });
  for (let i = 0; i < 48; i++) {
    const a = (lo + hi) / 2;
    let min = Infinity;
    let max = -Infinity;
    eachCorner(box, (c) => {
      const s = (c.dot(axis) - a) / (Math.max(1e-6, c.dot(_fwd) - fp) * k);
      min = Math.min(min, s);
      max = Math.max(max, s);
    });
    if (max + min > 0) lo = a;
    else hi = a;
  }
  return (lo + hi) / 2;
}

/**
 * The distance from the camera to a box's centre after fitting, for a frustum
 * with vertical `fovDeg` and `aspect`: the same fit as fitView, exposed for
 * callers that only want a number.
 */
export function fitDistance(box: StageBox, back: [number, number, number], fovDeg: number, aspect: number, fill = PRESET_FILL): number {
  const v = fitView({ box, back, fill }, fovDeg, aspect);
  toWorld((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2, _centre);
  return v.pos.distanceTo(_centre);
}

/**
 * Camera position and orbit target for a preset at the given fov and aspect.
 *
 * An exact frustum fit with the view direction fixed: each side plane of the
 * `fill`-scaled frustum passes through the camera with normal r − kH·f
 * (right), −r − kH·f (left), u − kV·f (top), −u − kV·f (bottom), and the box
 * is inside when the plane's support of the box equals its value at the
 * camera. The left/right pair fixes the camera's forward offset once, the
 * top/bottom pair fixes it again; the smaller (farther back) wins, that pair
 * is then tight on both sides, so the box touches the fill and is centred on
 * that axis, and the other axis is centred by `centreAlong`. Bounding the
 * corners about the box centre instead would leave the top of an elevated
 * three-quarter view empty, because the near corners project far below the
 * centre and the far ones bunch up near it. `minHeight` pushes the camera back
 * along `back` when the fitted position would sit too low; the orbit target is
 * the point on the view ray nearest the box centre.
 */
export function fitView(spec: PresetSpec, fovDeg: number, aspect: number): PresetView {
  const back = unit(spec.back);
  const box = spec.box;
  const fill = spec.fill ?? PRESET_FILL;
  basis(back);
  const kV = Math.tan((fovDeg * Math.PI) / 360) * fill;
  const kH = kV * Math.max(0.05, aspect);
  const m: Support = { right: -Infinity, left: -Infinity, top: -Infinity, bottom: -Infinity };
  eachCorner(box, (c) => {
    const r = c.dot(_right);
    const u = c.dot(_up);
    const f = c.dot(_fwd);
    m.right = Math.max(m.right, r - kH * f);
    m.left = Math.max(m.left, -r - kH * f);
    m.top = Math.max(m.top, u - kV * f);
    m.bottom = Math.max(m.bottom, -u - kV * f);
  });
  const fpH = -(m.right + m.left) / (2 * kH);
  const fpV = -(m.top + m.bottom) / (2 * kV);
  const fp = Math.min(fpH, fpV);
  let rp: number;
  let up: number;
  if (fpH <= fpV) {
    rp = (m.right - m.left) / 2;
    up = centreAlong(box, _up, fp, kV);
  } else {
    up = (m.top - m.bottom) / 2;
    rp = centreAlong(box, _right, fp, kH);
  }
  const pos = new Vector3().addScaledVector(_right, rp).addScaledVector(_up, up).addScaledVector(_fwd, fp);
  if (spec.minHeight !== undefined && _back.y > 1e-6 && pos.y < spec.minHeight) pos.addScaledVector(_back, (spec.minHeight - pos.y) / _back.y);
  toWorld((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2, _centre);
  const target = pos.clone().addScaledVector(_fwd, Math.max(1, _centre.sub(pos).dot(_fwd)));
  return { pos, target };
}

// ---------------------------------------------------------------------------
// The seven presets
// ---------------------------------------------------------------------------

interface Extent {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  top: number;
}

function extentOf(runs: Array<{ x: number; y0: number; y1: number; depthFt: number; top: number }>): Extent | null {
  if (runs.length === 0) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let top = 0;
  for (const r of runs) {
    x0 = Math.min(x0, r.x - r.depthFt / 2);
    x1 = Math.max(x1, r.x + r.depthFt / 2);
    y0 = Math.min(y0, Math.min(r.y0, r.y1));
    y1 = Math.max(y1, Math.max(r.y0, r.y1));
    top = Math.max(top, r.top);
  }
  return { x0, x1, y0, y1, top };
}

/**
 * The seven preset boxes for a shop, from its spec and its synthesized world.
 * Nothing here reads a `Layout`: the renderer only ever receives a
 * `WorldPayload`, which carries the spec and the facings but not the aisles
 * the twin found, so the aisle preset re-derives the gap between two gondola
 * runs from the runs themselves.
 */
export function presetSpecs(spec: LayoutSpec, world: World): Record<CameraPreset, PresetSpec> {
  const W = spec.widthFt;
  const D = spec.depthFt;
  const lotDepth = Math.max(30, spec.parking.depthFt);
  const entrance = spec.doors.find((d) => d.kind === "entrance");
  const entranceX = entrance ? entrance.x : W / 2;

  const selling = spec.fixtures.map((f) => ({ x: f.x, y0: f.y0, y1: f.y1, depthFt: f.depthFt, top: FIXTURE_HEIGHT[f.kind] ?? 6 }));
  const gondolas = spec.fixtures.filter((f) => f.kind === "gondola");
  const gond = extentOf(gondolas.map((f) => ({ x: f.x, y0: f.y0, y1: f.y1, depthFt: f.depthFt, top: FIXTURE_HEIGHT.gondola })));
  const floor = extentOf(selling) ?? { x0: 0, x1: W, y0: 0, y1: spec.backroomY, top: 7 };
  const storage = extentOf(spec.storage.map((s) => ({ x: s.x, y0: s.y0, y1: s.y1, depthFt: s.depthFt, top: s.levels * STORAGE_LEVEL_FT[s.kind] })));
  const back = storage ?? { x0: 0, x1: W, y0: spec.backroomY, y1: D, top: 12 };

  // The aisle preset looks down the widest gap between two neighbouring
  // gondola runs, which is the aisle a shopper would actually walk. With one
  // run (or none) it falls back to the sales floor's own centreline.
  let aisleX = (floor.x0 + floor.x1) / 2;
  let aisleHalf = Math.max(3, spec.aisleWidthFt / 2);
  if (gondolas.length >= 2) {
    const byX = [...gondolas].sort((a, b) => a.x - b.x);
    let bestGap = -Infinity;
    for (let i = 0; i + 1 < byX.length; i++) {
      const gap = byX[i + 1].x - byX[i + 1].depthFt / 2 - (byX[i].x + byX[i].depthFt / 2);
      if (gap > bestGap) {
        bestGap = gap;
        aisleX = (byX[i].x + byX[i].depthFt / 2 + byX[i + 1].x - byX[i + 1].depthFt / 2) / 2;
        aisleHalf = Math.max(2.5, gap / 2);
      }
    }
  }
  const aisleY0 = gond ? gond.y0 : floor.y0;
  const aisleY1 = gond ? gond.y1 : floor.y1;

  // The showcase, seen from the customer's side of the glass: whichever side
  // of it looks into the shop rather than into the staff corridor.
  const cases = spec.fixtures.filter((f) => f.kind === "showcase");
  const showcase = extentOf(cases.map((f) => ({ x: f.x, y0: f.y0, y1: f.y1, depthFt: f.depthFt, top: FIXTURE_HEIGHT.showcase })));
  const registers = spec.service.filter((s) => s.kind === "register");
  const counterX = showcase ? (showcase.x0 + showcase.x1) / 2 : registers.length ? registers[0].x : W - 8;
  const counterSign = counterX > W / 2 ? -1 : 1;
  const counterY0 = showcase ? showcase.y0 : Math.min(...registers.map((s) => s.y), 4) - 4;
  const counterY1 = showcase ? showcase.y1 : Math.max(...registers.map((s) => s.y), 12) + 4;

  // The goods doors and the drive behind them.
  const goods = world.frames.filter((f) => f.kind !== "entrance");
  const goodsX0 = goods.length ? Math.min(...goods.map((f) => f.origin[0])) - 22 : W / 2 - 25;
  const goodsX1 = goods.length ? Math.max(...goods.map((f) => f.origin[0])) + 22 : W / 2 + 25;
  let driveY = world.service.roadY;
  for (const spots of Object.values(world.service.queue)) for (const s of spots) driveY = Math.max(driveY, s[1]);

  return {
    // Three-quarter aerial from over the lot: the whole shop, its parking and
    // the service drive behind it. A ~35° elevation keeps the projection wider
    // than it is tall, so a landscape viewport is filled by the building
    // rather than by empty sky above it.
    overview: { box: { x0: -12, x1: W + 12, y0: -lotDepth, y1: D + 24, z0: 0, z1: WALL_TOP }, back: [-0.34, -0.7, 0.63], fill: 0.9 },
    // Eye level on the walkway outside the entrance, looking in through the
    // glass: the shopfront, the doors and the first of the sales floor.
    front: { box: { x0: entranceX - 22, x1: entranceX + 22, y0: -14, y1: Math.max(14, floor.y0 + 6), z0: 0, z1: 15 }, back: [0, -0.94, 0.34], fill: 0.88, minHeight: 5.6 },
    // Down one gondola aisle from its front end, at a stocker's height.
    aisle: { box: { x0: aisleX - aisleHalf, x1: aisleX + aisleHalf, y0: aisleY0 - 2, y1: aisleY1 + 2, z0: 0, z1: 7.5 }, back: [0, -0.9, 0.44], minHeight: 5.5 },
    // Standing at the showcase glass on the shopper's side, close in: this is
    // the one preset that is meant to feel like a person rather than a plan.
    counter: { box: { x0: Math.min(counterX, counterX + counterSign * 13), x1: Math.max(counterX, counterX + counterSign * 13), y0: counterY0 - 3, y1: counterY1 + 3, z0: 0, z1: 8 }, back: [counterSign * 0.62, -0.62, 0.48], fill: 0.8, minHeight: 5.5 },
    // Over the stockroom racking from its sales-floor corner.
    stockroom: { box: { x0: back.x0 - 4, x1: back.x1 + 4, y0: back.y0 - 6, y1: back.y1 + 4, z0: 0, z1: Math.max(10, back.top + 3) }, back: [-0.42, -0.62, 0.66] },
    // From the service drive, with both docks, the roll-up and any waiting
    // trailer in frame; high enough to see over a backed-on trailer.
    dock: { box: { x0: goodsX0, x1: goodsX1, y0: D - 4, y1: driveY + 24, z0: 0, z1: WALL_TOP }, back: [0.2, 0.78, 0.59], fill: 0.9, minHeight: 18 },
    // Over the customer parking, looking back at the shopfront.
    lot: { box: { x0: -8, x1: W + 8, y0: -lotDepth - 12, y1: 10, z0: 0, z1: WALL_TOP }, back: [0.08, -0.79, 0.61], fill: 0.9 },
  };
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(55, 1, 0.4, 5000);
  controls: OrbitControls | null = null;
  mode: ViewMode = "orbit";
  followTarget = -1;
  /** The preset the orbit camera is still framing, or null once the user has moved it. */
  activePreset: CameraPreset | null = null;
  private followFactor = 1;
  private readonly followPos = new Vector3();
  private readonly followVel = new Vector3();
  private readonly followLook = new Vector3();
  private followInit = false;
  private specs: Record<CameraPreset, PresetSpec>;
  private element: HTMLElement | null = null;
  private readonly onWheel = (e: WheelEvent) => {
    if (this.mode !== "follow") return;
    e.preventDefault();
    this.followFactor = Math.min(4, Math.max(0.4, this.followFactor * Math.exp(e.deltaY * 0.0012)));
  };
  private readonly onUserStart = () => {
    this.activePreset = null;
  };

  constructor() {
    this.specs = CameraRig.defaultSpecs();
    this.preset("overview");
  }

  /** A plausible 70 × 90 ft shop, so the rig is usable before setWorld. */
  private static defaultSpecs(): Record<CameraPreset, PresetSpec> {
    const b: StageBox = { x0: 0, x1: 70, y0: -75, y1: 90, z0: 0, z1: WALL_TOP };
    return {
      overview: { box: b, back: [-0.34, -0.7, 0.63], fill: 0.9 },
      front: { box: { x0: 13, x1: 57, y0: -14, y1: 20, z0: 0, z1: 15 }, back: [0, -0.94, 0.34], fill: 0.88, minHeight: 5.6 },
      aisle: { box: { x0: 30, x1: 36, y0: 18, y1: 56, z0: 0, z1: 7.5 }, back: [0, -0.9, 0.44], minHeight: 5.5 },
      counter: { box: { x0: 45, x1: 58, y0: 19, y1: 53, z0: 0, z1: 8 }, back: [-0.62, -0.62, 0.48], fill: 0.8, minHeight: 5.5 },
      stockroom: { box: { x0: 0, x1: 70, y0: 62, y1: 90, z0: 0, z1: 16 }, back: [-0.42, -0.62, 0.66] },
      dock: { box: { x0: 20, x1: 70, y0: 86, y1: 170, z0: 0, z1: WALL_TOP }, back: [0.2, 0.78, 0.59], fill: 0.9, minHeight: 18 },
      lot: { box: { ...b, y0: -87, y1: 10 }, back: [0.08, -0.79, 0.61], fill: 0.9 },
    };
  }

  attach(element: HTMLElement): void {
    if (this.controls) return;
    this.element = element;
    const c = new OrbitControls(this.camera, element);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI / 2 - 0.03;
    c.minDistance = 3;
    c.maxDistance = 2000;
    c.screenSpacePanning = false;
    c.enabled = this.mode === "orbit";
    c.addEventListener("start", this.onUserStart);
    this.controls = c;
    element.addEventListener("wheel", this.onWheel, { passive: false });
    this.applyView(this.view(this.activePreset ?? "overview"));
  }

  detach(): void {
    if (this.element) this.element.removeEventListener("wheel", this.onWheel);
    this.element = null;
    this.controls?.removeEventListener("start", this.onUserStart);
    this.controls?.dispose();
    this.controls = null;
  }

  setWorld(spec: LayoutSpec, world: World): void {
    this.specs = presetSpecs(spec, world);
    if (this.mode === "orbit") this.preset("overview");
  }

  /** The viewport changed: keep the projection right and re-fit the preset the camera is still on. */
  setAspect(aspect: number): void {
    if (!(aspect > 0) || aspect === this.camera.aspect) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.mode === "orbit" && this.activePreset) this.applyView(this.view(this.activePreset));
  }

  /** The fitted view for a preset at the camera's fov and aspect. */
  view(p: CameraPreset): PresetView {
    return fitView(this.specs[p], this.camera.fov, this.camera.aspect);
  }

  private applyView(v: PresetView): void {
    this.camera.position.copy(v.pos);
    if (this.controls) {
      this.controls.target.copy(v.target);
      this.controls.update();
    } else this.camera.lookAt(v.target);
  }

  preset(p: CameraPreset): void {
    this.mode = "orbit";
    this.followTarget = -1;
    if (this.controls) this.controls.enabled = true;
    this.applyView(this.view(p));
    this.activePreset = p;
  }

  setMode(mode: ViewMode, target?: number): void {
    this.mode = mode;
    this.activePreset = null;
    if (mode === "follow") {
      this.followTarget = target ?? this.followTarget;
      this.followInit = false;
    } else if (mode === "orbit" && this.controls) {
      // Keep looking where the last mode left the camera.
      this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(_look).multiplyScalar(20));
      this.controls.update();
    }
    if (this.controls) this.controls.enabled = mode === "orbit";
  }

  /** Move the orbit target to an engine floor position, keeping the camera where it is. */
  lookAt(x: number, y: number): void {
    this.activePreset = null;
    if (this.controls) {
      this.controls.target.set(x, 0, -y);
      this.controls.update();
    } else this.camera.lookAt(x, 0, -y);
  }

  /** The orbit target on the floor, in engine feet, for entering walk mode. */
  floorTarget(): { x: number; y: number; yaw: number } {
    const t = this.controls?.target ?? this.camera.position;
    const dir = this.camera.getWorldDirection(_look);
    return { x: t.x, y: -t.z, yaw: Math.atan2(-dir.x, -dir.z) };
  }

  resetFollow(): void {
    this.followInit = false;
  }

  update(dt: number, pose: FollowPose | null): void {
    if (this.mode === "orbit") {
      this.controls?.update(dt);
      return;
    }
    if (this.mode !== "follow" || !pose) return;
    const step = Math.min(0.1, Math.max(0, dt));
    const big = pose.lengthFt > 12;
    const dist = Math.max(16, pose.lengthFt * 1.5) * this.followFactor;
    const height = Math.max(8, pose.lengthFt * 0.55) * this.followFactor;
    const hx = Math.cos(pose.h);
    const hz = -Math.sin(pose.h);
    const ahead = big ? pose.lengthFt * 0.45 : 0;
    _look.set(pose.x + hx * ahead, big ? 5 : 3, -pose.y + hz * ahead);
    _desired.set(_look.x - hx * dist, height, _look.z - hz * dist);
    if (!this.followInit) {
      this.followPos.copy(_desired);
      this.followVel.set(0, 0, 0);
      this.followLook.copy(_look);
      this.followInit = true;
    } else {
      const damping = 2 * Math.sqrt(FOLLOW_STIFFNESS);
      _acc.subVectors(_desired, this.followPos).multiplyScalar(FOLLOW_STIFFNESS).addScaledVector(this.followVel, -damping);
      this.followVel.addScaledVector(_acc, step);
      this.followPos.addScaledVector(this.followVel, step);
      this.followLook.lerp(_look, 1 - Math.exp(-step * 8));
    }
    this.camera.position.copy(this.followPos);
    this.camera.lookAt(this.followLook);
  }

  dispose(): void {
    this.detach();
  }
}
