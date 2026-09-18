/**
 * Ray-casting into the scene and naming what was hit in the page's vocabulary.
 *
 * Instanced meshes resolve through `instanceId` and nothing else: the facings
 * and the storage positions are indexed exactly like the arrays the page
 * already holds, the fixture carcasses like `spec.fixtures`, the stalls like
 * `World.lot.stalls`, and the three actor pools carry an entity table. Doors
 * and service posts hang a ready-made `PickResult` on `userData.pick`. Pooled
 * actors are Groups, so a hit on any child walks up to the first ancestor with
 * a `userData.entity`.
 *
 * A zero-scaled instance — how this renderer hides a facing with nothing
 * merchandised in it — produces no ray hit at all, so nothing extra is needed
 * to keep empty slots unpickable; a mesh that is `visible = false` is skipped
 * explicitly, because three still intersects it.
 */

import { Camera, InstancedMesh, Mesh, Object3D, Raycaster, Vector2 } from "three";
import type { LayoutSpec } from "../layout/spec";
import type { EntityDef, World, WorldPayload } from "../trace/types";
import type { PickResult } from "./api";

export interface PickTargets {
  /** Root of the pooled Group actors. */
  actors: Object3D;
  facings: InstancedMesh;
  storage: InstancedMesh;
  carcass: InstancedMesh;
  posts: Mesh[];
  doorPads: Mesh[];
  doorLamps: Mesh[];
  stalls: InstancedMesh;
  /** Instanced pools and their entity tables, in the order to test them. */
  pools: Array<{ mesh: InstancedMesh; entityAt: Int32Array }>;
  spec: LayoutSpec;
  world: World;
  payload: Pick<WorldPayload, "facings" | "storage">;
  entities: EntityDef[];
}

const _ndc = new Vector2();

function entityResult(entities: EntityDef[], entity: number): PickResult {
  const def = entities[entity];
  return { kind: "entity", index: entity, id: def?.id ?? `#${entity}`, label: def?.label ?? `Entity ${entity}` };
}

export class Picker {
  private readonly ray = new Raycaster();

  pick(ndcX: number, ndcY: number, camera: Camera, targets: PickTargets): PickResult | null {
    _ndc.set(ndcX, ndcY);
    this.ray.setFromCamera(_ndc, camera);
    const objects: Object3D[] = [
      targets.actors,
      ...targets.pools.map((p) => p.mesh),
      targets.facings,
      targets.storage,
      ...targets.posts,
      ...targets.doorPads,
      ...targets.doorLamps,
      targets.carcass,
      targets.stalls,
    ];
    const hits = this.ray.intersectObjects(objects, true);
    for (const hit of hits) {
      const o = hit.object;
      if (!o.visible) continue;
      const id = hit.instanceId;

      if (o === targets.facings && id !== undefined) {
        const f = targets.payload.facings[id];
        if (!f) continue;
        return { kind: "facing", index: id, id: f.id, label: `${f.id} — ${f.kind} facing, shelf ${f.shelf}` };
      }
      if (o === targets.storage && id !== undefined) {
        const s = targets.payload.storage[id];
        if (!s) continue;
        return { kind: "storage", index: id, id: s.id, label: `${s.id} — ${s.kind}, level ${s.level}` };
      }
      if (o === targets.carcass && id !== undefined) {
        const run = targets.spec.fixtures[id];
        if (!run) continue;
        const count = run.bays * run.shelves * run.facingsPerBay * (run.doubleSided ? 2 : 1);
        return { kind: "fixture", index: id, id: run.id, label: `${run.id} — ${run.kind}, ${run.bays} bays × ${run.shelves} shelves = ${count} facings` };
      }
      if (o === targets.stalls && id !== undefined) {
        const stall = targets.world.lot.stalls[id];
        if (!stall) continue;
        const what = stall.kind === "accessible" ? "accessible stall" : stall.kind === "curbside" ? "curbside pickup bay" : "stall";
        return { kind: "stall", index: id, id: `STALL-${id + 1}`, label: `${what} ${id + 1}` };
      }
      if (id !== undefined) {
        const pool = targets.pools.find((p) => p.mesh === o);
        if (pool) {
          const entity = pool.entityAt[id];
          if (entity >= 0) return entityResult(targets.entities, entity);
          continue;
        }
      }

      const ready = o.userData.pick as PickResult | undefined;
      if (ready) return ready;

      let node: Object3D | null = o;
      while (node) {
        const entity = node.userData.entity;
        if (typeof entity === "number" && entity >= 0) return entityResult(targets.entities, entity);
        node = node.parent;
      }
    }
    return null;
  }
}
