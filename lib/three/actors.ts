/**
 * Everything that moves, and the two different ways of drawing it.
 *
 * Staff, stock carts, pallet jacks and vehicles are pooled `Group`s, because
 * each one carries its own tint, a state ring, a carried box or pallet, and
 * for a vehicle a pair of rear lights that strobe when a departure is late; a
 * shop never has more than a dozen of them moving at once, so the draw calls
 * fit easily.
 *
 * Customers and their cars are `InstancedMesh` pools. This is the one place
 * the store model pushes harder than the warehouse did: a Saturday afternoon
 * puts dozens of shoppers on a seventy-foot sales floor and a car in every
 * stall, and a Group each would cost more draw calls than the whole rest of
 * the building. A pool is sized once from the busiest minute of the run and
 * live entities are assigned into its slots each frame; an instance carries a
 * matrix and a colour, so a shopper's state is expressed by tinting rather
 * than by a ring.
 *
 * Materials are shared per colour through `MaterialCache`, so forty actors in
 * six roles cost six materials, and geometries are built once per pool and
 * shared by every actor of the kind.
 */

import { Color, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, Quaternion, Vector3 } from "three";
import type { BufferGeometry } from "three";
import type { EntityDef, EntityKind } from "../trace/types";
import {
  carGeometry,
  clerkParts,
  jackParts,
  palletGeometry,
  PERSON_SCALE,
  ResourceTracker,
  ringGeometry,
  shopperGeometry,
  stockCartGeometry,
  unitBoxGeometry,
  vehicleParts,
  VEHICLE_SIZE,
  type BuiltVehicle,
} from "./geometry";
import { STATE_COLORS, SURFACES, type ThemeName } from "./palette";

/** The kinds drawn as pooled Groups. Customers and cars are instanced instead. */
export type ActorKind = "worker" | "cart" | "jack" | BuiltVehicle;

export const RING_INNER = 1.5;
export const RING_OUTER = 2.2;

/**
 * Which pooled kind an entity is, or null when it is drawn some other way.
 * A `truck` entity is either the overnight trailer from the distribution
 * center or a vendor's box truck calling through the day; the compiler says
 * which in `meta.mode`, and they are different vehicles on the drive.
 */
export function actorKindOf(kind: EntityKind, meta?: EntityDef["meta"]): ActorKind | null {
  switch (kind) {
    case "worker":
      return "worker";
    case "cart":
      return "cart";
    case "jack":
      return "jack";
    case "van":
      return "van";
    case "truck":
      return meta?.mode === "direct" ? "boxTruck" : "truck";
    default:
      return null;
  }
}

/** Overall length of what is being followed, for the follow camera and the selection ring. */
export function actorLength(kind: ActorKind): number {
  switch (kind) {
    case "worker":
      return 2;
    case "cart":
      return 3.4;
    case "jack":
      return 6.4;
    default:
      return VEHICLE_SIZE[kind].lengthFt;
  }
}

/** One material per colour, so a crowd in six roles costs six materials. */
export class MaterialCache {
  private readonly lamberts = new Map<number, MeshLambertMaterial>();
  private readonly basics = new Map<number, MeshBasicMaterial>();
  readonly ghost: MeshLambertMaterial;

  constructor(readonly tracker: ResourceTracker) {
    this.ghost = tracker.material(new MeshLambertMaterial({ color: STATE_COLORS.absent, transparent: true, opacity: 0.35, depthWrite: false }));
  }

  lambert(hex: number): MeshLambertMaterial {
    let m = this.lamberts.get(hex);
    if (!m) {
      m = this.tracker.material(new MeshLambertMaterial({ color: hex }));
      this.lamberts.set(hex, m);
    }
    return m;
  }

  basic(hex: number): MeshBasicMaterial {
    let m = this.basics.get(hex);
    if (!m) {
      m = this.tracker.material(new MeshBasicMaterial({ color: hex }));
      this.basics.set(hex, m);
    }
    return m;
  }
}

export interface Actor {
  kind: ActorKind;
  entity: number;
  group: Group;
  /** The part that carries the role or kind tint: an apron, a van's body. */
  tint: Mesh;
  ring: Mesh;
  /** A case in a clerk's hands, a pallet on a jack's forks, stock on a cart. */
  carried: Mesh | null;
  lights: Mesh | null;
  /** The figure that bobs while walking. */
  bob: Object3D | null;
  ghost: boolean;
  baseTint: number;
}

interface KindGeometries {
  person?: ReturnType<typeof clerkParts> & { box: BufferGeometry };
  cart?: BufferGeometry;
  jack?: ReturnType<typeof jackParts> & { pallet: BufferGeometry };
  vehicles: Partial<Record<BuiltVehicle, ReturnType<typeof vehicleParts>["parts"] & { ringAt: number }>>;
  ring?: BufferGeometry;
}

export class ActorPool {
  readonly root = new Group();
  readonly active = new Map<number, Actor>();
  private readonly free: Record<ActorKind, Actor[]> = { worker: [], cart: [], jack: [], van: [], boxTruck: [], truck: [] };
  private readonly geoms: KindGeometries = { vehicles: {} };
  private readonly bodyMat: MeshLambertMaterial;
  private readonly skinMat: MeshLambertMaterial;
  private readonly steelMat: MeshLambertMaterial;
  private readonly shellMat: MeshLambertMaterial;
  private readonly wheelMat: MeshLambertMaterial;
  private readonly lightsOff: MeshBasicMaterial;
  private disposed = false;

  constructor(
    readonly tracker: ResourceTracker,
    readonly materials: MaterialCache,
    theme: ThemeName,
    private readonly quality: "high" | "low" = "high"
  ) {
    this.root.name = "actors";
    const s = SURFACES[theme];
    this.bodyMat = tracker.material(new MeshLambertMaterial({ color: s.body }));
    this.skinMat = tracker.material(new MeshLambertMaterial({ color: s.skin }));
    this.steelMat = tracker.material(new MeshLambertMaterial({ color: s.steel }));
    this.shellMat = tracker.material(new MeshLambertMaterial({ color: s.deck }));
    this.wheelMat = tracker.material(new MeshLambertMaterial({ color: 0x2b2b2b }));
    this.lightsOff = materials.basic(0x5c1010);
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** The group for an entity, reusing a released one of the same kind. */
  acquire(entity: number, kind: ActorKind): Actor {
    const existing = this.active.get(entity);
    if (existing) return existing;
    const actor = this.free[kind].pop() ?? this.build(kind);
    actor.entity = entity;
    actor.ghost = false;
    actor.group.visible = true;
    actor.group.traverse((o) => {
      o.userData.entity = entity;
    });
    if (actor.carried) actor.carried.visible = false;
    if (actor.lights) actor.lights.material = this.lightsOff;
    actor.ring.visible = false;
    this.active.set(entity, actor);
    return actor;
  }

  release(entity: number): void {
    const actor = this.active.get(entity);
    if (!actor) return;
    this.active.delete(entity);
    actor.group.visible = false;
    actor.entity = -1;
    this.free[actor.kind].push(actor);
  }

  releaseAll(): void {
    for (const entity of [...this.active.keys()]) this.release(entity);
  }

  setTint(actor: Actor, hex: number): void {
    actor.baseTint = hex;
    actor.tint.material = actor.ghost ? this.materials.ghost : this.materials.lambert(hex);
  }

  setGhost(actor: Actor, ghost: boolean): void {
    if (actor.ghost === ghost) return;
    actor.ghost = ghost;
    actor.tint.material = ghost ? this.materials.ghost : this.materials.lambert(actor.baseTint);
    if (actor.bob) {
      for (const child of actor.bob.children) {
        if (child === actor.tint || !(child instanceof Mesh)) continue;
        child.material = ghost ? this.materials.ghost : (child.userData.baseMaterial as MeshLambertMaterial);
      }
    }
  }

  setRing(actor: Actor, hex: number | null): void {
    if (hex === null) {
      actor.ring.visible = false;
      return;
    }
    actor.ring.visible = true;
    actor.ring.material = this.materials.basic(hex);
  }

  setLights(actor: Actor, on: boolean): void {
    if (!actor.lights) return;
    actor.lights.material = on ? this.materials.basic(STATE_COLORS.late) : this.lightsOff;
  }

  private ringGeom(): BufferGeometry {
    const held = this.geoms.ring;
    if (held) return held;
    return (this.geoms.ring = this.tracker.geometry(ringGeometry(RING_INNER, RING_OUTER)));
  }

  private personGeoms(): NonNullable<KindGeometries["person"]> {
    const held = this.geoms.person;
    if (held) return held;
    const p = clerkParts();
    return (this.geoms.person = {
      body: this.tracker.geometry(p.body),
      head: this.tracker.geometry(p.head),
      garment: this.tracker.geometry(p.garment),
      box: this.tracker.geometry(unitBoxGeometry()),
    });
  }

  private jackGeoms(): NonNullable<KindGeometries["jack"]> {
    const held = this.geoms.jack;
    if (held) return held;
    const p = jackParts();
    return (this.geoms.jack = { body: this.tracker.geometry(p.body), carry: p.carry, pallet: this.tracker.geometry(palletGeometry(this.quality)) });
  }

  private vehicleGeoms(kind: BuiltVehicle): NonNullable<KindGeometries["vehicles"][BuiltVehicle]> {
    const held = this.geoms.vehicles[kind];
    if (held) return held;
    const { parts, ringAt } = vehicleParts(kind);
    return (this.geoms.vehicles[kind] = {
      body: this.tracker.geometry(parts.body),
      shell: this.tracker.geometry(parts.shell),
      wheels: this.tracker.geometry(parts.wheels),
      lights: this.tracker.geometry(parts.lights),
      ringAt,
    });
  }

  private build(kind: ActorKind): Actor {
    const group = new Group();
    group.name = kind;
    this.root.add(group);
    const ring = new Mesh(this.ringGeom(), this.materials.basic(STATE_COLORS.queue));
    ring.visible = false;
    group.add(ring);
    const base: Omit<Actor, "tint"> = { kind, entity: -1, group, ring, carried: null, lights: null, bob: null, ghost: false, baseTint: 0xffffff };
    const shadow = (m: Mesh) => {
      m.castShadow = true;
      return m;
    };

    if (kind === "worker") {
      const g = this.personGeoms();
      const figure = new Group();
      // Only the body casts: the shadow pass is a second draw per caster and
      // one silhouette per person is plenty at this scale.
      const body = shadow(new Mesh(g.body, this.bodyMat));
      body.userData.baseMaterial = this.bodyMat;
      const head = new Mesh(g.head, this.skinMat);
      head.userData.baseMaterial = this.skinMat;
      const apron = new Mesh(g.garment, this.materials.lambert(0xffffff));
      figure.add(body, head, apron);
      figure.scale.setScalar(PERSON_SCALE);
      group.add(figure);
      const carried = new Mesh(g.box, this.materials.lambert(0x8b5e3c));
      carried.scale.set(1.3, 1.0, 1.3);
      carried.position.set(0.85, 2.3, 0);
      carried.visible = false;
      group.add(carried);
      return { ...base, tint: apron, carried, bob: figure };
    }

    if (kind === "cart") {
      const cartGeom = this.geoms.cart ?? (this.geoms.cart = this.tracker.geometry(stockCartGeometry()));
      const body = shadow(new Mesh(cartGeom, this.steelMat));
      const load = new Mesh(this.personGeoms().box, this.materials.lambert(0x8b5e3c));
      load.scale.set(2.8, 1.2, 1.5);
      load.position.set(0, 2.15, 0);
      load.visible = false;
      group.add(body, load);
      return { ...base, tint: body, carried: load };
    }

    if (kind === "jack") {
      const g = this.jackGeoms();
      const body = shadow(new Mesh(g.body, this.materials.lambert(0x1c7ed6)));
      const carried = new Mesh(g.pallet, this.materials.lambert(0x8b5e3c));
      carried.position.copy(g.carry);
      carried.visible = false;
      group.add(body, carried);
      return { ...base, tint: body, carried };
    }

    const g = this.vehicleGeoms(kind);
    const body = shadow(new Mesh(g.body, this.materials.lambert(0xffffff)));
    const shell = new Mesh(g.shell, this.shellMat);
    const wheels = new Mesh(g.wheels, this.wheelMat);
    const lights = new Mesh(g.lights, this.lightsOff);
    ring.scale.set(2.4, 1, 2.4);
    ring.position.set(g.ringAt, 0, 0);
    group.add(body, shell, wheels, lights);
    return { ...base, tint: body, lights };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAll();
    this.root.removeFromParent();
    this.root.clear();
    for (const k of Object.keys(this.free) as ActorKind[]) this.free[k].length = 0;
  }
}

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);
const _hidden = new Matrix4().makeScale(0, 0, 0);

/**
 * An entity-addressed pool of instances: shoppers on the floor, cars in the
 * lot, pallets on the ground. `place` claims a free slot the first time it
 * sees an entity and keeps it until `release`, so an instance never jumps
 * between two entities within a frame and the colour buffer stays stable.
 *
 * `capacity` is sized from the busiest minute of the run, not from the number
 * of entities in it: a week puts thousands of customers through the door but
 * only tens of them are inside at once.
 */
export class InstancedActors {
  readonly mesh: InstancedMesh;
  readonly entityAt: Int32Array;
  private readonly slotOf = new Map<number, number>();
  private nextFree = 0;
  private disposed = false;
  /** Entities that asked for a slot when none was free; reported so a scene can size up next time. */
  overflow = 0;

  constructor(
    readonly tracker: ResourceTracker,
    geometry: BufferGeometry,
    material: MeshLambertMaterial,
    readonly capacity: number,
    name: string,
    castShadow = true
  ) {
    this.mesh = new InstancedMesh(geometry, material, Math.max(1, capacity));
    this.mesh.name = name;
    // three computes an InstancedMesh's bounding sphere from the geometry
    // alone, and these instances are spread over the whole site.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.entityAt = new Int32Array(Math.max(1, capacity)).fill(-1);
    const white = new Color(0xffffff);
    for (let i = 0; i < this.mesh.count; i++) {
      this.mesh.setMatrixAt(i, _hidden);
      this.mesh.setColorAt(i, white);
    }
    this.commit();
  }

  private claim(entity: number): number {
    const held = this.slotOf.get(entity);
    if (held !== undefined) return held;
    const n = this.mesh.count;
    for (let k = 0; k < n; k++) {
      const slot = (this.nextFree + k) % n;
      if (this.entityAt[slot] !== -1) continue;
      this.nextFree = (slot + 1) % n;
      this.slotOf.set(entity, slot);
      this.entityAt[slot] = entity;
      return slot;
    }
    this.overflow++;
    return -1;
  }

  /** Show `entity` at an engine position with a heading; false when every slot is taken. */
  place(entity: number, x: number, y: number, z: number, heading: number, color: Color, scale = 1): boolean {
    const slot = this.claim(entity);
    if (slot < 0) return false;
    _q.setFromAxisAngle(_up, heading);
    _s.set(scale, scale, scale);
    _m.compose(_p.set(x, z, -y), _q, _s);
    this.mesh.setMatrixAt(slot, _m);
    this.mesh.setColorAt(slot, color);
    return true;
  }

  release(entity: number): void {
    const slot = this.slotOf.get(entity);
    if (slot === undefined) return;
    this.slotOf.delete(entity);
    this.entityAt[slot] = -1;
    this.mesh.setMatrixAt(slot, _hidden);
  }

  clear(): void {
    for (const entity of [...this.slotOf.keys()]) this.release(entity);
    this.nextFree = 0;
  }

  get count(): number {
    return this.slotOf.size;
  }

  has(entity: number): boolean {
    return this.slotOf.has(entity);
  }

  commit(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}

/** The three instanced pools, built with the geometry each one needs. */
export function buildShopperPool(tracker: ResourceTracker, capacity: number): InstancedActors {
  return new InstancedActors(tracker, tracker.geometry(shopperGeometry()), tracker.material(new MeshLambertMaterial({ color: 0xffffff })), capacity, "shoppers");
}

export function buildCarPool(tracker: ResourceTracker, capacity: number): InstancedActors {
  return new InstancedActors(tracker, tracker.geometry(carGeometry()), tracker.material(new MeshLambertMaterial({ color: 0xffffff })), capacity, "cars");
}

export function buildPalletPool(tracker: ResourceTracker, capacity: number, quality: "high" | "low"): InstancedActors {
  return new InstancedActors(tracker, tracker.geometry(palletGeometry(quality)), tracker.material(new MeshLambertMaterial({ color: 0xffffff })), capacity, "loosePallets");
}
