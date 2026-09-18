/**
 * Everything the shop sells from, and everything it keeps stock on.
 *
 * The instancing contract is the reference's, rebuilt for retail: one
 * `InstancedMesh` whose instance *i* **is** `WorldPayload.facings[i]`, and
 * another whose instance *i* is `WorldPayload.storage[i]`. That is what lets
 * the compiler's CSR timelines address an instance with no lookup, keeps
 * fifteen hundred facings at one draw call, and makes a ray hit resolve to a
 * facing id by `instanceId` alone.
 *
 * A third instanced mesh holds one carcass per fixture run — the gondola's
 * spine, the bulk wall's back, the showcase's base cabinet, a seasonal table's
 * body — indexed like `spec.fixtures`. The carcass is inset in depth so the
 * product blocks stand proud of it, which is what makes a gondola read as
 * shelving rather than as a coloured slab, and it is the pick target for a
 * whole run.
 *
 * Which face a facing sits on is the one layout convention worth stating
 * plainly, because it is the easiest thing here to get backwards.
 * `Facing.x` is the AISLE CENTRELINE, not the fixture; the fixture is
 * `spec.fixtures` found by `Facing.run`. `side` says which face of that run
 * the facing is on — "R" looks toward larger x, "L" toward smaller — so the
 * block sits at `run.x ± depthFt / 2`, and on a double-sided gondola each side
 * gets half the depth. Getting the sign wrong merchandises the whole shop into
 * the backs of its own gondolas.
 *
 * Watch the axis swap in the scales below: a run is parallel to engine y, so
 * the run's DEPTH is the instance's X and the bay slot's WIDTH is its Z.
 */

import { BoxGeometry, Color, Group, InstancedMesh, Material, Matrix4, Mesh, MeshLambertMaterial, Vector3 } from "three";
import type { FixtureRun, LayoutSpec, ServiceSpec, StorageRun } from "../layout/spec";
import type { World, WorldPayload } from "../trace/types";
import { FIXTURE_HEIGHT, STORAGE_LEVEL_FT } from "../trace/world";
import type { PickResult } from "./api";
import { BoxBatch, ResourceTracker, unitBoxGeometry } from "./geometry";
import { darken, fixtureColor, SERVICE_COLORS, STATE_COLORS, SURFACES, type ThemeName } from "./palette";

/** Clear space left above a shelf's product, so blocks never touch the shelf over them. */
const SHELF_CLEAR = 0.14;
/** Gap between two facings side by side in a bay. */
const FACING_GAP = 0.18;
/** How much of a run's depth the carcass takes; the rest is product. */
const CARCASS_DEPTH = 0.32;
/** Where the showcase glass starts and stops, feet. */
const CASE_DECK = 2.4;

export type PostState = "idle" | "busy" | "closed";

export interface FixturesOptions {
  tracker: ResourceTracker;
  theme: ThemeName;
}

export interface Fixtures {
  group: Group;
  /** One instance per spec.fixtures run; the pick target for a whole run. */
  carcass: InstancedMesh;
  /** One instance per WorldPayload.facings entry. */
  facings: InstancedMesh;
  /** One instance per WorldPayload.storage entry. */
  storage: InstancedMesh;
  /** Registers, showcase stations and the wrap bench, in World.posts order. */
  posts: Mesh[];
  facingIndex: Map<string, number>;
  storageIndex: Map<string, number>;
  /** Fill fraction 0..1 sets the block's height; a negative fraction hides it (no SKU merchandised there). */
  setFacing(i: number, fraction: number, color: Color | null): void;
  setStorage(i: number, fraction: number, color: Color | null): void;
  setPost(i: number, state: PostState): void;
  /** Flags the instance buffers for upload; call once per frame, after all the sets. */
  commit(): void;
  facingWorld(i: number, target: Vector3): Vector3;
  storageWorld(i: number, target: Vector3): Vector3;
  setTheme(theme: ThemeName): void;
  dispose(): void;
}

const _m = new Matrix4();
const _hidden = new Matrix4().makeScale(0, 0, 0);

/** The heights the world gives a run, or the same rule recomputed when it has none. */
function shelfBases(world: World, run: FixtureRun): number[] {
  const known = world.shelfHeights[run.id];
  if (known && known.length >= run.shelves) return known;
  const total = FIXTURE_HEIGHT[run.kind] ?? 6;
  const usable = Math.max(0.5, total - 0.5);
  const pitch = usable / run.shelves;
  return Array.from({ length: run.shelves }, (_, i) => 0.5 + i * pitch);
}

function levelBases(world: World, run: StorageRun): number[] {
  const known = world.shelfHeights[run.id];
  if (known && known.length >= run.levels) return known;
  const pitch = STORAGE_LEVEL_FT[run.kind];
  return Array.from({ length: run.levels }, (_, i) => i * pitch);
}

/** How deep a facing's product block is, and where its inner edge sits, for one side of a run. */
function blockDepth(run: FixtureRun): number {
  const usable = run.doubleSided ? run.depthFt / 2 : run.depthFt;
  return Math.max(0.35, usable - CARCASS_DEPTH / (run.doubleSided ? 2 : 1));
}

/** The x of a facing's block centre: out on the side it is shopped from. */
function blockX(run: FixtureRun, side: "L" | "R"): number {
  const d = blockDepth(run);
  const outer = run.x + (side === "R" ? 1 : -1) * (run.depthFt / 2);
  return outer - (side === "R" ? 1 : -1) * (d / 2);
}

function postPick(sp: ServiceSpec, index: number): PickResult {
  const what = sp.kind === "register" ? "register" : sp.kind === "counter" ? "showcase station" : "gift-wrap station";
  return { kind: "post", index, id: sp.id, label: `${sp.id} — ${what}` };
}

export function buildFixtures(spec: LayoutSpec, payload: Pick<WorldPayload, "facings" | "storage">, world: World, opts: FixturesOptions): Fixtures {
  const { tracker } = opts;
  let themeName = opts.theme;
  const S = () => SURFACES[themeName];
  const group = new Group();
  group.name = "fixtures";
  const runById = new Map(spec.fixtures.map((r) => [r.id, r]));
  const storeById = new Map(spec.storage.map((r) => [r.id, r]));

  const themed: Array<[Material & { color: Color }, () => number]> = [];
  const lambert = (pick: () => number, extra: ConstructorParameters<typeof MeshLambertMaterial>[0] = {}) => {
    const m = tracker.material(new MeshLambertMaterial({ color: pick(), ...extra }));
    themed.push([m, pick]);
    return m;
  };

  // ---- Carcasses: one instance per run, coloured by family ---------------
  const unit = tracker.geometry(unitBoxGeometry());
  const carcassMat = tracker.material(new MeshLambertMaterial({ color: 0xffffff }));
  const nRuns = Math.max(1, spec.fixtures.length);
  const carcass = new InstancedMesh(unit, carcassMat, nRuns);
  carcass.name = "carcass";
  carcass.frustumCulled = false;
  carcass.castShadow = true;
  carcass.receiveShadow = true;
  const tint = new Color();
  for (let i = 0; i < nRuns; i++) {
    const run = spec.fixtures[i];
    if (!run) {
      carcass.setMatrixAt(i, _hidden);
      carcass.setColorAt(i, tint.setHex(0xffffff));
      continue;
    }
    const len = Math.abs(run.y1 - run.y0);
    const top = run.kind === "showcase" ? CASE_DECK : (FIXTURE_HEIGHT[run.kind] ?? 6);
    // A showcase and a seasonal table are solid bodies; everything else is a
    // spine or a back panel the product stands off from.
    const solid = run.kind === "showcase" || run.kind === "seasonal";
    const d = solid ? run.depthFt : Math.max(0.3, run.doubleSided ? CARCASS_DEPTH : run.depthFt * 0.3);
    // A single-sided run's back panel goes against whatever it stands against:
    // the wall it is on, or the counter behind it.
    const away = run.x < spec.widthFt / 2 ? -1 : 1;
    const cx = solid || run.doubleSided ? run.x : run.x + away * (run.depthFt / 2 - d / 2);
    _m.makeScale(d, top, len).setPosition(cx, top / 2, -(run.y0 + run.y1) / 2);
    carcass.setMatrixAt(i, _m);
    carcass.setColorAt(i, tint.setHex(fixtureColor(themeName, run.kind)));
  }
  carcass.instanceMatrix.needsUpdate = true;
  if (carcass.instanceColor) carcass.instanceColor.needsUpdate = true;
  group.add(carcass);

  // ---- Shelf decks and uprights, merged per family ------------------------
  const deckMat = lambert(() => S().deck);
  const decks = new BoxBatch();
  for (const run of spec.fixtures) {
    const bases = shelfBases(world, run);
    const len = Math.abs(run.y1 - run.y0);
    const sides: Array<"L" | "R"> = run.doubleSided ? ["L", "R"] : [run.x < spec.widthFt / 2 ? "R" : "L"];
    for (const side of sides) {
      const d = blockDepth(run);
      const x = blockX(run, side);
      for (const base of bases) {
        decks.add(d, 0.12, len, x, base - 0.06, -(run.y0 + run.y1) / 2);
      }
      // A lip on the bulk bins and a shelf-edge strip everywhere else.
      const lip = run.kind === "bulk" ? 0.5 : 0.18;
      const edge = x + (side === "R" ? 1 : -1) * (d / 2 - 0.06);
      for (const base of bases) decks.add(0.12, lip, len, edge, base + lip / 2, -(run.y0 + run.y1) / 2);
    }
    // Uprights every bay end, so a long gondola does not read as one extrusion.
    const bayLen = len / Math.max(1, run.bays);
    for (let b = 0; b <= run.bays; b++) {
      decks.add(run.depthFt, FIXTURE_HEIGHT[run.kind] ?? 6, 0.18, run.x, (FIXTURE_HEIGHT[run.kind] ?? 6) / 2, -(run.y0 + b * bayLen));
    }
  }
  const deckMesh = new Mesh(tracker.geometry(decks.build()), deckMat);
  deckMesh.name = "shelves";
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  // ---- The facings themselves -------------------------------------------
  const nFacings = Math.max(1, payload.facings.length);
  const facingMat = tracker.material(new MeshLambertMaterial({ color: 0xffffff }));
  const facings = new InstancedMesh(unit, facingMat, nFacings);
  facings.name = "facings";
  facings.frustumCulled = false;
  // Facings do not cast: at a thousand-odd instances the shadow pass doubles
  // the frame cost and the blocks are inside the fixture's own shadow anyway.
  facings.castShadow = false;
  // x, z, −y of the block's base, then its depth, its full height and its width.
  const facingBase = new Float64Array(nFacings * 6);
  const facingIndex = new Map<string, number>();
  for (let i = 0; i < nFacings; i++) {
    const f = payload.facings[i];
    const run = f ? runById.get(f.run) : undefined;
    if (!f || !run) {
      facings.setMatrixAt(i, _hidden);
      facings.setColorAt(i, tint.setHex(0xffffff));
      continue;
    }
    facingIndex.set(f.id, i);
    const bases = shelfBases(world, run);
    const base = bases[Math.min(bases.length, Math.max(1, f.shelf)) - 1] ?? 0;
    const next = bases[f.shelf] ?? FIXTURE_HEIGHT[run.kind] ?? 6;
    const hMax = Math.max(0.25, next - base - SHELF_CLEAR);
    const bayLen = Math.abs(run.y1 - run.y0) / Math.max(1, run.bays);
    const wid = Math.max(0.25, bayLen / Math.max(1, run.facingsPerBay) - FACING_GAP);
    const d = Math.max(0.25, blockDepth(run) - 0.2);
    const b = i * 6;
    facingBase[b] = blockX(run, f.side);
    facingBase[b + 1] = base + 0.06;
    facingBase[b + 2] = -f.y;
    facingBase[b + 3] = d;
    facingBase[b + 4] = hMax;
    facingBase[b + 5] = wid;
    // The run's depth is the instance's X; the bay slot's width is its Z.
    _m.makeScale(d, hMax, wid).setPosition(facingBase[b], facingBase[b + 1], facingBase[b + 2]);
    facings.setMatrixAt(i, _m);
    facings.setColorAt(i, tint.setHex(fixtureColor(themeName, run.kind)));
  }
  group.add(facings);

  // ---- The showcase glass ------------------------------------------------
  const glassMat = tracker.material(new MeshLambertMaterial({ color: S().glass, transparent: true, opacity: 0.26, depthWrite: false }));
  themed.push([glassMat, () => S().glass]);
  const glassBatch = new BoxBatch();
  for (const run of spec.fixtures) {
    if (run.kind !== "showcase") continue;
    const len = Math.abs(run.y1 - run.y0);
    const top = FIXTURE_HEIGHT.showcase;
    glassBatch.add(run.depthFt, top - CASE_DECK, len, run.x, (CASE_DECK + top) / 2, -(run.y0 + run.y1) / 2);
  }
  const glass = new Mesh(tracker.geometry(glassBatch.build()), glassMat);
  glass.name = "showcaseGlass";
  glass.renderOrder = 3;
  group.add(glass);

  // ---- The service counter, the registers and the wrap station ------------
  const counterMat = lambert(() => S().counter);
  const counterBatch = new BoxBatch();
  for (const z of spec.zones) {
    if (z.kind !== "queue" || z.ring.length < 3) continue;
    const xs = z.ring.map((p) => p[0]);
    const ys = z.ring.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    counterBatch.add(x1 - x0, 3.2, y1 - y0, (x0 + x1) / 2, 1.6, -(y0 + y1) / 2);
  }
  // The pick-and-pack bench in the stockroom.
  counterBatch.add(8, 3, 3.2, world.bench[0], 1.5, -world.bench[1]);
  const counter = new Mesh(tracker.geometry(counterBatch.build()), counterMat);
  counter.name = "counter";
  counter.castShadow = true;
  counter.receiveShadow = true;
  group.add(counter);

  const postMats: Record<PostState, MeshLambertMaterial> = {
    idle: tracker.material(new MeshLambertMaterial({ color: darken(SERVICE_COLORS.register, 0.75) })),
    busy: tracker.material(new MeshLambertMaterial({ color: SERVICE_COLORS.counter, emissive: SERVICE_COLORS.counter, emissiveIntensity: 0.3 })),
    closed: tracker.material(new MeshLambertMaterial({ color: STATE_COLORS.outage })),
  };
  const postGeom = tracker.geometry(new BoxGeometry(1.8, 1.1, 1.4).translate(0, 3.6, 0));
  const terminalGeom = tracker.geometry(new BoxGeometry(0.16, 1.1, 1.3).translate(0, 4.4, 0));
  const posts: Mesh[] = world.posts.map((p, index) => {
    const sp = spec.service[index];
    const m = new Mesh(postGeom, postMats.idle);
    m.position.set(p.worker[0], 0, -p.worker[1]);
    m.rotation.y = ((sp?.facing ?? 90) * Math.PI) / 180;
    m.castShadow = true;
    m.name = `post:${p.id}`;
    if (sp) m.userData.pick = postPick(sp, index);
    const terminal = new Mesh(terminalGeom, tracker.material(new MeshLambertMaterial({ color: S().register })));
    terminal.name = "terminal";
    m.add(terminal);
    group.add(m);
    return m;
  });

  // ---- The stockroom -----------------------------------------------------
  const rackMats: Record<StorageRun["kind"], MeshLambertMaterial> = {
    rack: lambert(() => S().rack),
    shelving: lambert(() => S().shelving),
  };
  const steel: Record<StorageRun["kind"], BoxBatch> = { rack: new BoxBatch(), shelving: new BoxBatch() };
  for (const run of spec.storage) {
    const bases = levelBases(world, run);
    const top = bases[bases.length - 1] + STORAGE_LEVEL_FT[run.kind];
    const len = Math.abs(run.y1 - run.y0);
    const bayLen = len / Math.max(1, run.bays);
    const s = steel[run.kind];
    for (let b = 0; b <= run.bays; b++) s.add(run.depthFt, top, 0.28, run.x, top / 2, -(run.y0 + b * bayLen));
    for (const base of bases) {
      for (const side of [-1, 1]) s.add(0.24, 0.34, len, run.x + side * (run.depthFt / 2 - 0.14), base + 0.17, -(run.y0 + run.y1) / 2);
      if (run.kind === "shelving") s.add(run.depthFt - 0.2, 0.1, len, run.x, base + 0.3, -(run.y0 + run.y1) / 2);
    }
  }
  for (const kind of ["rack", "shelving"] as const) {
    if (!steel[kind].boxes) continue;
    const mesh = new Mesh(tracker.geometry(steel[kind].build()), rackMats[kind]);
    mesh.name = `racking:${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const nStorage = Math.max(1, payload.storage.length);
  const caseMat = tracker.material(new MeshLambertMaterial({ color: 0xffffff }));
  const storage = new InstancedMesh(unit, caseMat, nStorage);
  storage.name = "storage";
  storage.frustumCulled = false;
  storage.castShadow = true;
  const storageBase = new Float64Array(nStorage * 6);
  const storageIndex = new Map<string, number>();
  for (let i = 0; i < nStorage; i++) {
    const p = payload.storage[i];
    const run = p ? storeById.get(p.run) : undefined;
    if (!p || !run) {
      storage.setMatrixAt(i, _hidden);
      storage.setColorAt(i, tint.setHex(S().case));
      continue;
    }
    storageIndex.set(p.id, i);
    const bases = levelBases(world, run);
    const base = bases[Math.min(bases.length, Math.max(1, p.level)) - 1] ?? 0;
    const hMax = Math.max(0.5, STORAGE_LEVEL_FT[run.kind] - 0.5);
    const bayLen = Math.abs(run.y1 - run.y0) / Math.max(1, run.bays);
    const wid = Math.max(0.5, bayLen - 0.4);
    const d = Math.max(0.5, run.depthFt - 0.35);
    const b = i * 6;
    storageBase[b] = run.x;
    storageBase[b + 1] = base + 0.36;
    storageBase[b + 2] = -p.y;
    storageBase[b + 3] = d;
    storageBase[b + 4] = hMax;
    storageBase[b + 5] = wid;
    storage.setMatrixAt(i, _hidden);
    storage.setColorAt(i, tint.setHex(S().case));
  }
  group.add(storage);

  // ---- Mutators ----------------------------------------------------------
  const setFacing = (i: number, fraction: number, color: Color | null) => {
    if (i < 0 || i >= nFacings) return;
    const b = i * 6;
    if (fraction < 0 || facingBase[b + 4] === 0) {
      facings.setMatrixAt(i, _hidden);
    } else {
      const h = Math.max(0.06, Math.min(1, fraction)) * facingBase[b + 4];
      _m.makeScale(facingBase[b + 3], h, facingBase[b + 5]).setPosition(facingBase[b], facingBase[b + 1], facingBase[b + 2]);
      facings.setMatrixAt(i, _m);
    }
    if (color) facings.setColorAt(i, color);
  };

  const setStorage = (i: number, fraction: number, color: Color | null) => {
    if (i < 0 || i >= nStorage) return;
    const b = i * 6;
    if (fraction <= 0 || storageBase[b + 4] === 0) {
      storage.setMatrixAt(i, _hidden);
    } else {
      const h = Math.max(0.2, Math.min(1, fraction)) * storageBase[b + 4];
      _m.makeScale(storageBase[b + 3], h, storageBase[b + 5]).setPosition(storageBase[b], storageBase[b + 1], storageBase[b + 2]);
      storage.setMatrixAt(i, _m);
    }
    if (color) storage.setColorAt(i, color);
  };

  const commit = () => {
    facings.instanceMatrix.needsUpdate = true;
    storage.instanceMatrix.needsUpdate = true;
    if (facings.instanceColor) facings.instanceColor.needsUpdate = true;
    if (storage.instanceColor) storage.instanceColor.needsUpdate = true;
  };
  commit();

  let disposed = false;
  return {
    group,
    carcass,
    facings,
    storage,
    posts,
    facingIndex,
    storageIndex,
    setFacing,
    setStorage,
    setPost(i, state) {
      const m = posts[i];
      if (m) m.material = postMats[state];
    },
    commit,
    facingWorld(i, target) {
      const b = i * 6;
      return target.set(facingBase[b], facingBase[b + 1] + facingBase[b + 4] / 2, facingBase[b + 2]);
    },
    storageWorld(i, target) {
      const b = i * 6;
      return target.set(storageBase[b], storageBase[b + 1] + storageBase[b + 4] / 2, storageBase[b + 2]);
    },
    setTheme(name) {
      themeName = name;
      for (const [mat, pick] of themed) mat.color.setHex(pick());
      // Instanced colours are per-instance, not per-material, so the carcasses
      // have to be rewritten one by one; the facings are recoloured by
      // apply.ts's next pass, which owns their fill colours.
      for (let i = 0; i < spec.fixtures.length; i++) carcass.setColorAt(i, tint.setHex(fixtureColor(name, spec.fixtures[i].kind)));
      if (carcass.instanceColor) carcass.instanceColor.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      carcass.dispose();
      facings.dispose();
      storage.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
