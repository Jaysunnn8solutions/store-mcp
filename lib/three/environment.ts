/**
 * Everything outside the shop: the sky, the ground it stands on, the customer
 * lot in front of it and the street beyond that.
 *
 * A gradient sky dome follows the camera and the fog takes its colour from the
 * dome's horizon, so the ground plane — which ends well inside the dome —
 * dissolves into it without a seam. The asphalt is one slab covering the
 * parking, the building's surround and the service drive behind, because in a
 * real retail site it is one pour; on top of it go the painted stall stripes,
 * the blue accessible bays with their symbol, the green curbside pickup bays,
 * the drive lane's dashes, the kerb and walkway along the storefront, and four
 * light poles whose heads come on at dusk.
 *
 * The stalls are one InstancedMesh indexed exactly like `World.lot.stalls`, so
 * the playback's stall timeline addresses an instance with no lookup and a ray
 * hit resolves to a stall number by instanceId alone.
 *
 * Everything here follows the theme and the clock; the shop itself is in
 * building.ts and fixtures.ts.
 */

import {
  BackSide,
  BufferGeometry,
  Camera,
  Color,
  Float32BufferAttribute,
  Fog,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
} from "three";
import type { LayoutSpec } from "../layout/spec";
import type { World } from "../trace/types";
import { accessibleSymbol, BoxBatch, LineBatch, padGeometry, ResourceTracker } from "./geometry";
import { lightLevels, skyAt } from "./lighting";
import { darken, STALL_COLORS, SURFACES, THEMES, type ThemeName } from "./palette";

/** Inside the camera's far plane wherever the orbit limits let it go. */
export const SKY_RADIUS = 2000;
const GROUND_SIZE = 8000;
const STREET_HALF_WIDTH = 18;
/** Stall geometry, matching lib/trace/world.ts. */
const STALL_W = 9;
const STALL_D = 18;
/** The walkway along the storefront, where the curbside handoff happens. */
const WALK_FT = 8;
const POLE_HEIGHT = 20;
const TREE_HEIGHT = 22;

export interface EnvironmentOptions {
  theme: ThemeName;
  tracker: ResourceTracker;
}

export interface Environment {
  group: Group;
  sky: Mesh;
  fog: Fog;
  /** One instance per World.lot.stalls entry; the pick target for a stall. */
  stalls: InstancedMesh;
  /** The asphalt rectangle in engine feet, for framing and for the ground shadow. */
  lot: { x0: number; x1: number; y0: number; y1: number };
  /** Dim a stall's paint while a car is on it, so a full lot reads as a full lot. */
  setStallTaken(index: number, taken: boolean): void;
  setTheme(theme: ThemeName): void;
  /** Recolour the sky, the fog and the asphalt for a minute of day (null = noon), and switch the lot lamps. */
  setTime(minuteOfDay: number | null, lotLamps: boolean): void;
  /** Keep the dome centred on the camera; call before rendering. */
  follow(camera: Camera): void;
  dispose(): void;
}

const SKY_VERTEX = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = `
uniform vec3 top;
uniform vec3 horizon;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, 0.0, 1.0);
  gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);
  #include <colorspace_fragment>
}`;

const _m = new Matrix4();
const _hidden = new Matrix4().makeScale(0, 0, 0);

export function buildEnvironment(spec: LayoutSpec, world: World, opts: EnvironmentOptions): Environment {
  const { tracker } = opts;
  let themeName = opts.theme;
  const group = new Group();
  group.name = "environment";
  const W = spec.widthFt;
  const D = spec.depthFt;
  const lotDepth = Math.max(30, spec.parking.depthFt);

  // Sky dome.
  const skyMat = tracker.material(
    new ShaderMaterial({
      uniforms: { top: { value: new Color(0x6ea6dc) }, horizon: { value: new Color(0xdde7ee) } },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
    })
  );
  const sky = new Mesh(tracker.geometry(new SphereGeometry(SKY_RADIUS, 24, 12)), skyMat);
  sky.name = "sky";
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  group.add(sky);

  // Open ground far beyond the site.
  const groundMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].ground }));
  const ground = new Mesh(tracker.geometry(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2).translate(W / 2, -0.14, -D / 2)), groundMat);
  ground.name = "ground";
  ground.receiveShadow = true;
  group.add(ground);

  // One asphalt pour: the parking in front, the surround, and the service
  // drive behind. Cars spawn off both ends of the drive lane, so it has to
  // reach past those spawn points or a car appears on the grass.
  const lot = {
    x0: Math.min(world.lot.spawnLeft[0], world.service.spawnLeft[0], 0) - 30,
    x1: Math.max(world.lot.spawnRight[0], world.service.spawnRight[0], W) + 30,
    y0: -(lotDepth + 18),
    y1: world.service.roadY + 28,
  };
  const lotMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].lot }));
  const lotMesh = new Mesh(
    tracker.geometry(
      new PlaneGeometry(lot.x1 - lot.x0, lot.y1 - lot.y0)
        .rotateX(-Math.PI / 2)
        .translate((lot.x0 + lot.x1) / 2, -0.09, -(lot.y0 + lot.y1) / 2)
    ),
    lotMat
  );
  lotMesh.name = "asphalt";
  lotMesh.receiveShadow = true;
  group.add(lotMesh);

  // The walkway along the storefront, raised a kerb above the asphalt.
  const kerbMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].kerb }));
  const kerb = new BoxBatch();
  kerb.addEngine(lot.x1 - lot.x0, WALK_FT, 0.45, (lot.x0 + lot.x1) / 2, -WALK_FT / 2, 0);
  // Bollards either side of the entrance, which is also what stops the
  // curbside bays reading as a drive-through.
  const entrance = spec.doors.find((d) => d.kind === "entrance");
  if (entrance) {
    for (const side of [-1, 1]) kerb.addEngine(0.8, 0.8, 3.2, entrance.x + side * (entrance.widthFt / 2 + 2.5), -2, 0.45);
  }
  const kerbMesh = new Mesh(tracker.geometry(kerb.build()), kerbMat);
  kerbMesh.name = "kerb";
  kerbMesh.receiveShadow = true;
  kerbMesh.castShadow = true;
  group.add(kerbMesh);

  // Stall stripes, the drive lane's dashes and the curbside outlines, all as
  // painted lines; the marked bays get a coloured pad of their own below.
  const paintMat = tracker.material(new LineBasicMaterial({ color: STALL_COLORS.standard }));
  const stripes = new LineBatch();
  for (const stall of world.lot.stalls) {
    const [cx, cy] = stall.pt;
    // Head-in stalls: a stripe down each side and a wheel stop at the head.
    for (const side of [-1, 1]) stripes.addEngine(cx + (side * STALL_W) / 2, cy - STALL_D / 2, cx + (side * STALL_W) / 2, cy + STALL_D / 2, 0.02);
    stripes.addEngine(cx - STALL_W / 2 + 0.8, cy + STALL_D / 2 - 1.6, cx + STALL_W / 2 - 0.8, cy + STALL_D / 2 - 1.6, 0.02);
  }
  for (let x = lot.x0 + 6; x < lot.x1 - 6; x += 14) stripes.addEngine(x, world.lot.driveY, x + 7, world.lot.driveY, 0.02);
  const stripeMesh = new LineSegments(tracker.geometry(stripes.build()), paintMat);
  stripeMesh.name = "stallStripes";
  group.add(stripeMesh);

  // The stalls themselves: one instance each, coloured by kind, indexed
  // exactly like World.lot.stalls so a ray hit names a stall by instanceId.
  const stallGeom = tracker.geometry(padGeometry(STALL_W - 0.6, STALL_D - 0.6).translate(0, 0.015, 0));
  const stallMat = tracker.material(new MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }));
  const n = Math.max(1, world.lot.stalls.length);
  const stalls = new InstancedMesh(stallGeom, stallMat, n);
  stalls.name = "stalls";
  stalls.frustumCulled = false;
  const tint = new Color();
  for (let i = 0; i < n; i++) {
    const stall = world.lot.stalls[i];
    if (!stall) {
      stalls.setMatrixAt(i, _hidden);
      stalls.setColorAt(i, tint.setHex(STALL_COLORS.standard));
      continue;
    }
    _m.makeTranslation(stall.pt[0], 0, -stall.pt[1]);
    stalls.setMatrixAt(i, _m);
    stalls.setColorAt(i, tint.setHex(STALL_COLORS[stall.kind]));
  }
  stalls.instanceMatrix.needsUpdate = true;
  if (stalls.instanceColor) stalls.instanceColor.needsUpdate = true;
  group.add(stalls);

  // The accessible symbol, painted once per accessible bay.
  const symbolMat = tracker.material(new MeshBasicMaterial({ color: SURFACES[themeName].roadMark }));
  const ada = world.lot.stalls.filter((s) => s.kind === "accessible");
  const symbolGeom = accessibleSymbol();
  const adaMesh = new InstancedMesh(tracker.geometry(symbolGeom), symbolMat, Math.max(1, ada.length));
  adaMesh.name = "accessibleSymbols";
  adaMesh.frustumCulled = false;
  for (let i = 0; i < Math.max(1, ada.length); i++) {
    const s = ada[i];
    if (!s) {
      adaMesh.setMatrixAt(i, _hidden);
      continue;
    }
    _m.makeTranslation(s.pt[0], 0.03, -s.pt[1]);
    adaMesh.setMatrixAt(i, _m);
  }
  adaMesh.instanceMatrix.needsUpdate = true;
  group.add(adaMesh);

  // The public street beyond the lot, and the treeline along the far edge.
  const streetY = lot.y0 - 26;
  const streetMat = tracker.material(new MeshLambertMaterial({ color: darken(THEMES[themeName].lot, 0.82) }));
  const street = new Mesh(
    tracker.geometry(new PlaneGeometry(GROUND_SIZE, STREET_HALF_WIDTH * 2).rotateX(-Math.PI / 2).translate(W / 2, -0.07, -streetY)),
    streetMat
  );
  street.name = "street";
  street.receiveShadow = true;
  group.add(street);
  const dashes: number[] = [];
  for (let x = W / 2 - GROUND_SIZE / 2; x < W / 2 + GROUND_SIZE / 2; x += 16) dashes.push(x, -0.05, -streetY, x + 8, -0.05, -streetY);
  const dashGeom = new BufferGeometry();
  dashGeom.setAttribute("position", new Float32BufferAttribute(dashes, 3));
  dashGeom.computeBoundingSphere();
  const markMat = tracker.material(new LineBasicMaterial({ color: SURFACES[themeName].roadMark }));
  const streetMarks = new LineSegments(tracker.geometry(dashGeom), markMat);
  streetMarks.name = "streetDashes";
  group.add(streetMarks);

  // A hedge and trees screening the sides and the back of the site: cheap
  // boxes, but they stop the shop reading as a model floating on tarmac.
  const foliage = new BoxBatch();
  const treeRow = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const count = Math.max(2, Math.round(len / 30));
    for (let i = 0; i <= count; i++) {
      const s = i / count;
      const x = ax + (bx - ax) * s;
      const y = ay + (by - ay) * s;
      foliage.addEngine(10, 10, TREE_HEIGHT - 6, x, y, 6);
      foliage.addEngine(1.4, 1.4, 6, x, y, 0);
    }
  };
  treeRow(lot.x0 - 8, lot.y0, lot.x0 - 8, lot.y1);
  treeRow(lot.x1 + 8, lot.y0, lot.x1 + 8, lot.y1);
  treeRow(lot.x0 - 8, lot.y1 + 8, lot.x1 + 8, lot.y1 + 8);
  const foliageMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].foliage }));
  const trees = new Mesh(tracker.geometry(foliage.build()), foliageMat);
  trees.name = "treeline";
  trees.castShadow = true;
  group.add(trees);

  // Light poles: masts in the kerb colour, heads that come on at dusk.
  const poles = new BoxBatch();
  const heads = new BoxBatch();
  const poleAt: Array<[number, number]> = [
    [Math.min(W * 0.25, W - 8), -(lotDepth * 0.5)],
    [Math.max(W * 0.75, 8), -(lotDepth * 0.5)],
    [W * 0.5, -(lotDepth * 0.92)],
    [W * 0.5, world.service.roadY - 14],
  ];
  for (const [px, py] of poleAt) {
    poles.addEngine(0.8, 0.8, POLE_HEIGHT, px, py, 0);
    heads.addEngine(4.5, 1.6, 0.7, px, py, POLE_HEIGHT);
  }
  const poleMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].kerb }));
  const poleMesh = new Mesh(tracker.geometry(poles.build()), poleMat);
  poleMesh.name = "lightPoles";
  poleMesh.castShadow = true;
  group.add(poleMesh);
  const headMat = tracker.material(new MeshLambertMaterial({ color: 0x4c4f52, emissive: 0x000000 }));
  const headMesh = new Mesh(tracker.geometry(heads.build()), headMat);
  headMesh.name = "lotLamps";
  group.add(headMesh);

  const size = Math.max(W, D + lotDepth);
  const fog = new Fog(0xdde7ee, size * 2.2, size * 9);
  const colors = { top: new Color(), horizon: new Color() };
  const base = new Color();
  const tint2 = (mat: MeshLambertMaterial | LineBasicMaterial | MeshBasicMaterial, hex: number, k: number) => mat.color.copy(base.setHex(hex)).multiplyScalar(k);
  let lastLamps: boolean | null = null;

  const setTime = (minute: number | null, lotLamps: boolean) => {
    const t = THEMES[themeName];
    const s = SURFACES[themeName];
    skyAt(themeName, minute, colors);
    (skyMat.uniforms.top.value as Color).copy(colors.top);
    (skyMat.uniforms.horizon.value as Color).copy(colors.horizon);
    fog.color.copy(colors.horizon);
    // Outside, the shop's own lights do not reach: the ground follows the sky.
    const k = 0.3 + 0.7 * lightLevels(minute, true).daylight;
    tint2(groundMat, t.ground, k);
    tint2(foliageMat, t.foliage, k);
    tint2(lotMat, t.lot, k);
    tint2(streetMat, darken(t.lot, 0.82), k);
    tint2(kerbMat, t.kerb, k);
    tint2(poleMat, t.kerb, k);
    tint2(markMat, s.roadMark, 0.5 + 0.5 * k);
    tint2(paintMat, STALL_COLORS.standard, 0.5 + 0.5 * k);
    tint2(symbolMat, s.roadMark, 0.6 + 0.4 * k);
    if (lotLamps !== lastLamps) {
      lastLamps = lotLamps;
      headMat.emissive.setHex(lotLamps ? 0xffe9b0 : 0x000000);
      headMat.emissiveIntensity = lotLamps ? 1 : 0;
    }
  };
  setTime(null, false);

  const taken = new Uint8Array(n);
  const stallTint = new Color();

  let disposed = false;
  return {
    group,
    sky,
    fog,
    stalls,
    lot,
    setStallTaken(index, isTaken) {
      const stall = world.lot.stalls[index];
      if (!stall) return;
      const flag = isTaken ? 1 : 0;
      if (taken[index] === flag) return;
      taken[index] = flag;
      stallTint.setHex(STALL_COLORS[stall.kind]);
      if (isTaken) stallTint.multiplyScalar(0.45);
      stalls.setColorAt(index, stallTint);
      if (stalls.instanceColor) stalls.instanceColor.needsUpdate = true;
    },
    setTheme(name) {
      themeName = name;
      lastLamps = null;
    },
    setTime,
    follow(camera) {
      sky.position.copy(camera.position);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stalls.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
