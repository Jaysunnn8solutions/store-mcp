/**
 * The `Viewer` (lib/three/api.ts) the React page drives.
 *
 * It owns the WebGLRenderer, the scene and every three.js resource; the page
 * owns the requestAnimationFrame loop, the clock and the DOM label pills. The
 * whole scene is built once, in the constructor, from the `WorldPayload` and
 * the `Playback` the page hands over — a store is a fixed building for the
 * length of a run, so there is no `setWorld`.
 *
 * The frame order is fixed and worth stating, because several of the steps
 * only work in this order: sample the cursor, apply that one sample, light the
 * scene for the simulated minute, move the camera, move the selection ring,
 * re-centre the sky on the camera, render, and only then project the labels —
 * which is why `labels()` has to be read in the same tick as `frame()`.
 *
 * Time moves forward by stepping the cursor, which is amortised O(1) per
 * track. Two things force a full re-read instead: any step backwards, because
 * the dirty rows a backward step reports carry the values on the far side of
 * them, and any forward jump longer than SEEK_JUMP_MIN, because walking a
 * whole day's dirty list one row at a time costs more than binary-searching
 * every timeline once. The page's scrubbing therefore stays cheap without the
 * page having to know any of this.
 *
 * Wall-clock time reaches exactly two things: the follow camera's spring and
 * walk mode's movement, neither of which is part of what a frame at minute t
 * shows. Everything visible is a function of t, so the same seed at the same
 * minute renders the same pixels.
 */

import { Color, Mesh, MeshBasicMaterial, PCFSoftShadowMap, Scene, WebGLRenderer } from "three";
import { PlaybackCursor, POSE_STRIDE } from "../trace/cursor";
import { LANE_SLOTS, type Playback, type WorldPayload } from "../trace/types";
import { ActorPool, actorLength, buildCarPool, buildPalletPool, buildShopperPool, MaterialCache, type InstancedActors } from "./actors";
import type { CameraPreset, PickResult, Viewer, ViewerOptions, ViewerStats, ViewMode } from "./api";
import { applyFrame, bindScene, peakConcurrent, POSE, recolorFacings, releaseScene, type StoreScene } from "./apply";
import { buildBuilding, DOOR_HEIGHT, GLASS_TOP, WALL_HEIGHT, type Building } from "./building";
import { CameraRig, type FollowPose } from "./cameras";
import { buildEnvironment, type Environment } from "./environment";
import { buildFixtures, type Fixtures } from "./fixtures";
import { ResourceTracker, ringGeometry, VEHICLE_SIZE } from "./geometry";
import { LabelProjector, MAX_LABELS, type LabelAnchor, type LabelOccluder } from "./labels";
import { ALL_ZONES_ON, createLighting, lightZones, scheduleFromPlayback, type Lighting, type LightSchedule } from "./lighting";
import { STATE_COLORS, THEMES, type ThemeName } from "./palette";
import { Picker } from "./picking";
import { fixtureColliders, vehicleCollider, WalkController, wallColliders, type Aabb } from "./walk";

/** Past this many facings plus storage positions, pallets drop to their eight-triangle form and shadows go off. */
export const AUTO_QUALITY_INSTANCES = 20_000;
/** A forward jump longer than this is cheaper as a seek than as a walk of the dirty list. */
export const SEEK_JUMP_MIN = 60;
/** Pointer movement and dwell that still counts as a click rather than a drag. */
const CLICK_SLOP_PX = 6;
const CLICK_MS = 600;

class StoreViewer implements Viewer {
  private readonly canvas: HTMLCanvasElement;
  private readonly playback: Playback;
  private readonly payload: WorldPayload;
  private readonly onPick: ((p: PickResult | null) => void) | undefined;

  private readonly scene = new Scene();
  private readonly rig = new CameraRig();
  private readonly walk: WalkController;
  private readonly lighting: Lighting;
  private readonly picker = new Picker();
  private readonly projector = new LabelProjector();
  private readonly tracker = new ResourceTracker();
  private readonly materials: MaterialCache;
  private readonly building: Building;
  private readonly fixtures: Fixtures;
  private readonly env: Environment;
  private readonly pool: ActorPool;
  private readonly shoppers: InstancedActors;
  private readonly cars: InstancedActors;
  private readonly pallets: InstancedActors;
  private readonly selectionRing: Mesh;
  private readonly cursor: PlaybackCursor;
  /** Entity index to its slot in Playback.tracks, so following an instanced shopper is O(1). */
  private readonly trackOf: Int32Array;
  private readonly schedule: LightSchedule;
  private readonly twin: StoreScene;
  private readonly occluder: LabelOccluder;
  private readonly staticColliders: Aabb[];
  private readonly quality: "high" | "low";

  private renderer: WebGLRenderer | null;
  private theme: ThemeName;
  private dayNight: boolean;
  private shadows: boolean;
  private showLabels = true;
  private mode: ViewMode = "orbit";
  private lastPreset: CameraPreset = "overview";
  private selection: PickResult | null = null;
  private labelPos: LabelAnchor[] = [];
  private size = { width: 1, height: 1 };
  private frameMs = 0;
  private colliders: Aabb[];
  private t = 0;
  private appliedT = -1;
  private pendingSeek = true;
  private lastReal = -1;
  private lightKey = "";
  private disposed = false;
  private pointerDown: { x: number; y: number; at: number } | null = null;

  constructor(opts: ViewerOptions) {
    this.canvas = opts.canvas;
    this.playback = opts.playback;
    this.payload = opts.world;
    this.onPick = opts.onPick;
    this.theme = opts.theme ?? "light";
    this.dayNight = opts.dayNight ?? true;
    this.shadows = opts.shadows ?? true;

    const spec = this.payload.spec;
    const world = this.playback.world;
    const instances = this.payload.facings.length + this.payload.storage.length;
    this.quality = instances > AUTO_QUALITY_INSTANCES ? "low" : "high";

    this.scene.background = new Color(THEMES[this.theme].background);
    this.lighting = createLighting(this.theme);
    this.scene.add(this.lighting.group);

    this.materials = new MaterialCache(this.tracker);
    this.building = buildBuilding(spec, world, { tracker: this.tracker, theme: this.theme });
    this.fixtures = buildFixtures(spec, this.payload, world, { tracker: this.tracker, theme: this.theme });
    this.env = buildEnvironment(spec, world, { theme: this.theme, tracker: this.tracker });
    this.pool = new ActorPool(this.tracker, this.materials, this.theme, this.quality);

    // The instanced pools are sized from the busiest minute of this run, not
    // from the number of entities in it: a week puts thousands of customers
    // through the door and tens of them inside at once.
    this.shoppers = buildShopperPool(this.tracker, Math.max(8, peakConcurrent(this.playback, "customer") + 4));
    this.cars = buildCarPool(this.tracker, Math.max(4, peakConcurrent(this.playback, "car") + 2));
    // Loose pallets only ever stand in a goods-door lane or on the bench, so
    // the lanes bound them exactly; the slack is for a second tier.
    this.pallets = buildPalletPool(this.tracker, world.lanes.length * LANE_SLOTS * 2 + 8, this.quality);

    this.selectionRing = new Mesh(
      this.tracker.geometry(ringGeometry(2.0, 2.8)),
      this.tracker.material(new MeshBasicMaterial({ color: STATE_COLORS.selection, depthTest: false }))
    );
    this.selectionRing.renderOrder = 10;
    this.selectionRing.visible = false;

    this.scene.add(this.env.group, this.building.group, this.fixtures.group, this.pool.root, this.shoppers.mesh, this.cars.mesh, this.pallets.mesh, this.selectionRing);
    this.scene.fog = this.env.fog;

    // What hides a pill from a camera outside: the walls, less the doorways
    // and less the storefront, which is glass and is meant to be seen through.
    this.occluder = {
      w: world.bbox.w,
      d: world.bbox.d,
      wallHeight: WALL_HEIGHT,
      doors: world.frames.map((f) => ({ x: f.origin[0], y: f.origin[1], tx: f.tangent[0], ty: f.tangent[1], halfWidth: f.widthFt / 2, heightFt: DOOR_HEIGHT[f.kind] })),
      glass: [{ x: spec.widthFt / 2, y: 0, tx: 1, ty: 0, halfWidth: spec.widthFt / 2, heightFt: GLASS_TOP }],
    };

    this.staticColliders = [...fixtureColliders(spec), ...wallColliders(spec, world.frames)];
    this.colliders = this.staticColliders;

    this.twin = bindScene(
      { building: this.building, fixtures: this.fixtures, env: this.env, actors: this.pool, shoppers: this.shoppers, cars: this.cars, pallets: this.pallets },
      this.payload,
      this.playback
    );
    this.cursor = new PlaybackCursor(this.playback);
    this.trackOf = new Int32Array(this.playback.entities.length).fill(-1);
    this.playback.tracks.forEach((tr, i) => {
      if (tr && tr.entity >= 0 && tr.entity < this.trackOf.length) this.trackOf[tr.entity] = i;
    });
    this.schedule = scheduleFromPlayback(this.playback);

    this.lighting.fit(spec.widthFt, spec.depthFt, spec.parking.depthFt);
    this.lighting.setShadows(this.effectiveShadows());

    const renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
    renderer.shadowMap.enabled = this.effectiveShadows();
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer = renderer;

    this.walk = new WalkController(this.rig.camera, { onInspect: () => this.report(this.pickAt(this.size.width / 2, this.size.height / 2, true)), colliders: () => this.colliders });
    this.rig.setWorld(spec, world);
    this.rig.attach(this.canvas);
    this.walk.attach(this.canvas);
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.resize(this.canvas.clientWidth || this.canvas.width || 1, this.canvas.clientHeight || this.canvas.height || 1);
  }

  // -- options -------------------------------------------------------------

  private effectiveShadows(): boolean {
    return this.shadows && this.quality === "high";
  }

  setTheme(theme: "light" | "dark"): void {
    if (this.disposed || theme === this.theme) return;
    this.theme = theme;
    this.scene.background = new Color(THEMES[theme].background);
    this.lighting.setTheme(theme);
    this.env.setTheme(theme);
    this.building.setTheme(theme);
    this.fixtures.setTheme(theme);
    recolorFacings(this.twin);
    this.lightKey = "";
  }

  setDayNight(on: boolean): void {
    if (this.disposed || on === this.dayNight) return;
    this.dayNight = on;
    this.lightKey = "";
  }

  setShadows(on: boolean): void {
    if (this.disposed || on === this.shadows) return;
    this.shadows = on;
    const eff = this.effectiveShadows();
    this.lighting.setShadows(eff);
    if (!this.renderer) return;
    this.renderer.shadowMap.enabled = eff;
    // Every material's program depends on whether shadows are on.
    this.scene.traverse((obj) => {
      const m = (obj as Mesh).material;
      if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
      else if (m) m.needsUpdate = true;
    });
  }

  setLabels(on: boolean): void {
    this.showLabels = on;
    if (!on) this.labelPos = [];
  }

  // -- time ----------------------------------------------------------------

  setTime(t: number): void {
    if (this.disposed) return;
    if (t < this.appliedT || t - this.appliedT > SEEK_JUMP_MIN) this.pendingSeek = true;
    this.t = t;
  }

  private light(t: number): void {
    const minute = this.dayNight ? ((t % 1440) + 1440) % 1440 : null;
    const zones = this.dayNight ? lightZones(t, this.schedule) : ALL_ZONES_ON;
    const key = `${minute === null ? "noon" : Math.round(minute)}:${zones.sales ? 1 : 0}${zones.backroom ? 1 : 0}${zones.showcase ? 1 : 0}`;
    if (key === this.lightKey) return;
    this.lightKey = key;
    const state = this.lighting.setTime(minute, zones);
    this.building.setLight(zones, state.daylight);
    this.env.setTime(minute, state.lotLamps);
  }

  private followPose(): FollowPose | null {
    const entity = this.rig.followTarget;
    if (entity < 0) return null;
    const actor = this.pool.active.get(entity);
    if (actor) {
      return { x: actor.group.position.x, y: -actor.group.position.z, h: actor.group.rotation.y, lengthFt: actorLength(actor.kind) };
    }
    // A customer or a car is an instance, not a group, so its pose comes
    // straight back out of the cursor.
    const track = this.trackOf[entity] ?? -1;
    if (track < 0) return null;
    const b = track * POSE_STRIDE;
    const p = this.cursor.poses;
    const kind = this.playback.entities[entity]?.kind;
    return { x: p[b + POSE.x], y: p[b + POSE.y], h: p[b + POSE.h], lengthFt: kind === "car" ? VEHICLE_SIZE.car.lengthFt : 2 };
  }

  private updateSelection(): void {
    const ring = this.selectionRing;
    const sel = this.selection;
    if (!sel) {
      ring.visible = false;
      return;
    }
    const world = this.playback.world;
    let ok = true;
    let scale = 1;
    switch (sel.kind) {
      case "facing":
        this.fixtures.facingWorld(sel.index, ring.position);
        scale = 0.6;
        break;
      case "storage":
        this.fixtures.storageWorld(sel.index, ring.position);
        break;
      case "fixture": {
        const run = this.payload.spec.fixtures[sel.index];
        if (run) ring.position.set(run.x, 0.1, -(run.y0 + run.y1) / 2);
        else ok = false;
        scale = 2;
        break;
      }
      case "door": {
        const f = world.frames[sel.index];
        if (f) ring.position.set(f.origin[0] + f.inward[0] * 4, 0.1, -(f.origin[1] + f.inward[1] * 4));
        else ok = false;
        scale = 2;
        break;
      }
      case "post": {
        const p = world.posts[sel.index];
        if (p) ring.position.set(p.worker[0], 0.1, -p.worker[1]);
        else ok = false;
        break;
      }
      case "stall": {
        const s = world.lot.stalls[sel.index];
        if (s) ring.position.set(s.pt[0], 0.1, -s.pt[1]);
        else ok = false;
        scale = 2.2;
        break;
      }
      case "entity": {
        const actor = this.pool.active.get(sel.index);
        if (actor) {
          ring.position.copy(actor.group.position);
          const len = actorLength(actor.kind);
          if (len > 12) {
            // A vehicle's origin is its rear, so the ring goes on its middle.
            ring.position.x += Math.cos(actor.group.rotation.y) * (len / 2);
            ring.position.z -= Math.sin(actor.group.rotation.y) * (len / 2);
            scale = len / 5;
          }
        } else {
          const track = this.trackOf[sel.index] ?? -1;
          if (track < 0) ok = false;
          else {
            const b = track * POSE_STRIDE;
            ring.position.set(this.cursor.poses[b + POSE.x], 0.1, -this.cursor.poses[b + POSE.y]);
          }
        }
        break;
      }
    }
    ring.visible = ok;
    ring.scale.set(scale, 1, scale);
  }

  frame(): void {
    if (this.disposed) return;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const dt = this.lastReal < 0 ? 0 : Math.min(0.1, Math.max(0, (now - this.lastReal) / 1000));
    this.lastReal = now;

    const reset = this.pendingSeek;
    const sample = reset ? this.cursor.seek(this.t) : this.cursor.advance(this.t);
    this.pendingSeek = false;
    applyFrame(this.twin, sample, this.playback, reset);
    this.appliedT = this.t;

    if (this.mode === "walk") {
      // A vehicle backed onto a door is solid only while it is there, so the
      // collider list is the static one plus whatever is on the doors now.
      const docked: Aabb[] = [];
      for (let i = 0; i < this.twin.doorValue.length; i++) {
        if (this.twin.doorValue[i] < 0) continue;
        const frame = this.playback.world.frames[this.twin.goodsFrames[i]];
        if (!frame) continue;
        const size = frame.kind === "dock" ? VEHICLE_SIZE.truck : VEHICLE_SIZE.boxTruck;
        docked.push(vehicleCollider(frame, size.lengthFt, size.widthFt));
      }
      this.colliders = docked.length ? [...this.staticColliders, ...docked] : this.staticColliders;
      this.walk.update(dt);
    } else {
      this.rig.update(dt, this.mode === "follow" ? this.followPose() : null);
    }

    this.light(this.t);
    this.updateSelection();
    this.env.follow(this.rig.camera);
    this.renderer?.render(this.scene, this.rig.camera);
    this.labelPos =
      this.showLabels && this.size.width > 0
        ? this.projector
            .project(this.twin.labels, this.rig.camera, this.size.width, this.size.height, MAX_LABELS, this.occluder)
            .map(({ x, y, text, kind, entity }) => ({ x, y, text, kind, entity }))
        : [];
    this.frameMs = (typeof performance !== "undefined" ? performance.now() : 0) - now;
  }

  // -- camera --------------------------------------------------------------

  setCamera(preset: CameraPreset): void {
    if (this.disposed) return;
    this.walk.exit();
    this.mode = "orbit";
    this.lastPreset = preset;
    this.rig.preset(preset);
  }

  setMode(mode: ViewMode): void {
    if (this.disposed || mode === this.mode) return;
    this.mode = mode;
    if (mode === "walk") {
      this.rig.setMode("walk");
      const p = this.rig.floorTarget();
      this.walk.enter(p.x, p.y, p.yaw);
    } else {
      this.walk.exit();
      this.rig.setMode(mode);
      if (mode === "orbit") this.rig.preset(this.lastPreset);
    }
  }

  follow(entity: number | null): void {
    if (this.disposed) return;
    if (entity === null) {
      this.setMode("orbit");
      return;
    }
    this.walk.exit();
    this.mode = "follow";
    this.rig.setMode("follow", entity);
    this.rig.resetFollow();
  }

  resize(w: number, h: number): void {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    this.size = { width, height };
    this.rig.setAspect(width / height);
    if (!this.renderer) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    // A phone-width canvas is capped lower: a shop fills the frame and the
    // fill rate, not the geometry, is what costs there.
    const cap = width < 1000 ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(cap, Math.max(0.5, dpr)));
    this.renderer.setSize(width, height, false);
  }

  // -- picking -------------------------------------------------------------

  private readonly handlePointerDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY, at: typeof performance !== "undefined" ? performance.now() : 0 };
  };

  private readonly handlePointerUp = (e: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || this.mode === "walk") return;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    // An orbit drag ends in a pointerup too; only a short, still one is a click.
    if (Math.abs(e.clientX - down.x) > CLICK_SLOP_PX || Math.abs(e.clientY - down.y) > CLICK_SLOP_PX || now - down.at > CLICK_MS) return;
    this.report(this.pickAt(e.clientX, e.clientY));
  };

  private report(hit: PickResult | null): void {
    this.selection = hit;
    this.onPick?.(hit);
  }

  pickAt(clientX: number, clientY: number, canvasSpace = false): PickResult | null {
    if (this.disposed) return null;
    let px = clientX;
    let py = clientY;
    if (!canvasSpace) {
      const rect = this.canvas.getBoundingClientRect();
      px = clientX - rect.left;
      py = clientY - rect.top;
      if (rect.width > 0 && rect.height > 0) {
        px *= this.size.width / rect.width;
        py *= this.size.height / rect.height;
      }
    }
    const ndcX = (px / Math.max(1, this.size.width)) * 2 - 1;
    const ndcY = -((py / Math.max(1, this.size.height)) * 2 - 1);
    return this.picker.pick(ndcX, ndcY, this.rig.camera, {
      actors: this.pool.root,
      facings: this.fixtures.facings,
      storage: this.fixtures.storage,
      carcass: this.fixtures.carcass,
      posts: this.fixtures.posts,
      doorPads: this.building.doorPads,
      doorLamps: this.building.doorLamps,
      stalls: this.env.stalls,
      pools: [
        { mesh: this.shoppers.mesh, entityAt: this.shoppers.entityAt },
        { mesh: this.cars.mesh, entityAt: this.cars.entityAt },
        { mesh: this.pallets.mesh, entityAt: this.pallets.entityAt },
      ],
      spec: this.payload.spec,
      world: this.playback.world,
      payload: this.payload,
      entities: this.playback.entities,
    });
  }

  // -- output --------------------------------------------------------------

  labels(): LabelAnchor[] {
    return this.labelPos;
  }

  stats(): ViewerStats {
    const info = this.renderer?.info.render;
    return { frameMs: this.frameMs, drawCalls: info?.calls ?? 0, triangles: info?.triangles ?? 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.walk.dispose();
    this.rig.dispose();
    releaseScene(this.twin);
    this.building.dispose();
    this.fixtures.dispose();
    this.env.dispose();
    this.pool.dispose();
    this.shoppers.dispose();
    this.cars.dispose();
    this.pallets.dispose();
    this.lighting.dispose();
    this.scene.fog = null;
    this.selectionRing.removeFromParent();
    this.tracker.disposeAll();
    this.scene.clear();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.labelPos = [];
  }
}

export function createViewer(opts: ViewerOptions): Viewer {
  return new StoreViewer(opts);
}
