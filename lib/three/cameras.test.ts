/**
 * A fitted preset frames what it names, on every committed shop and at every
 * aspect: each box's corners land inside the requested fill, in front of the
 * camera, and the camera itself sits somewhere sane — above the ground, inside
 * the site rather than a mile out over the motorway, and looking at the
 * building rather than away from it.
 *
 * The five shops differ by nearly a factor of two in floor area and one of
 * them has a single dock instead of two, so running every assertion over all
 * five is the point: a preset that only works on Midtown is a preset that does
 * not work.
 */

import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import sitesJson from "../../data/sites.json";
import { buildWorld } from "../trace/world";
import type { World } from "../trace/types";
import { buildLayout, siteToSpec } from "../twin/layout";
import type { LayoutSpec } from "../layout/spec";
import type { Site } from "../twin/types";
import { CAMERA_PRESETS, type CameraPreset } from "./api";
import { CameraRig, fitDistance, fitView, PRESET_FILL, presetSpecs, WALL_TOP, type PresetSpec, type PresetView, type StageBox } from "./cameras";
import { toWorld } from "./geometry";

interface Shop {
  id: string;
  spec: LayoutSpec;
  world: World;
}

const shops: Shop[] = (sitesJson as Site[]).map((site) => {
  const spec = siteToSpec(site);
  const layout = buildLayout(spec, site);
  return { id: site.id, spec, world: buildWorld(layout, []) };
});

/** The largest |ndc| over a box's corners for a camera placed at the fitted view. */
function extent(box: StageBox, view: PresetView, fov: number, aspect: number): { max: number; behind: boolean } {
  const cam = new PerspectiveCamera(fov, aspect, 0.4, 5000);
  cam.position.copy(view.pos);
  cam.lookAt(view.target);
  cam.updateMatrixWorld();
  let max = 0;
  let behind = false;
  const v = new Vector3();
  for (const x of [box.x0, box.x1]) {
    for (const y of [box.y0, box.y1]) {
      for (const z of [box.z0, box.z1]) {
        toWorld(x, y, z, v).project(cam);
        if (v.z > 1 || v.z < -1) behind = true;
        max = Math.max(max, Math.abs(v.x), Math.abs(v.y));
      }
    }
  }
  return { max, behind };
}

describe("fitDistance", () => {
  it("puts a unit cube seen head-on at twice its half-size for a 90° square frustum", () => {
    const box: StageBox = { x0: -1, x1: 1, y0: -1, y1: 1, z0: -1, z1: 1 };
    expect(fitDistance(box, [0, -1, 0], 90, 1, 1)).toBeCloseTo(2, 6);
    // Half the fill needs twice the lateral room: the near face is 1 in front, so 1 / 0.5 + 1.
    expect(fitDistance(box, [0, -1, 0], 90, 1, 0.5)).toBeCloseTo(3, 6);
    // A wide aspect does not change the vertical limit; a narrow one binds on width.
    expect(fitDistance(box, [0, -1, 0], 90, 2, 1)).toBeCloseTo(2, 6);
    expect(fitDistance(box, [0, -1, 0], 90, 0.5, 1)).toBeCloseTo(3, 6);
  });
});

describe("presetSpecs", () => {
  it("names every preset in the page's list, for every shop", () => {
    for (const shop of shops) {
      const specs = presetSpecs(shop.spec, shop.world);
      expect(Object.keys(specs).sort(), shop.id).toEqual([...CAMERA_PRESETS].sort());
    }
  });

  it("gives every preset a non-degenerate box and a unit-ish view direction", () => {
    for (const shop of shops) {
      const specs = presetSpecs(shop.spec, shop.world);
      for (const p of CAMERA_PRESETS) {
        const s = specs[p];
        const where = `${shop.id}/${p}`;
        expect(s.box.x1 - s.box.x0, where).toBeGreaterThan(1);
        expect(s.box.y1 - s.box.y0, where).toBeGreaterThan(1);
        expect(s.box.z1 - s.box.z0, where).toBeGreaterThan(1);
        for (const v of [s.box.x0, s.box.x1, s.box.y0, s.box.y1, s.box.z0, s.box.z1]) expect(Number.isFinite(v), where).toBe(true);
        expect(Math.hypot(...s.back), where).toBeGreaterThan(0.5);
        // Every preset looks down at the shop, never up at it from below.
        expect(s.back[2], where).toBeGreaterThan(0);
      }
    }
  });

  it("frames what each preset is named after", () => {
    for (const shop of shops) {
      const specs = presetSpecs(shop.spec, shop.world);
      const W = shop.spec.widthFt;
      const D = shop.spec.depthFt;
      const where = shop.id;

      // The overview holds the whole building and reaches out over the lot.
      expect(specs.overview.box.x0, where).toBeLessThanOrEqual(0);
      expect(specs.overview.box.x1, where).toBeGreaterThanOrEqual(W);
      expect(specs.overview.box.y0, where).toBeLessThan(0);
      expect(specs.overview.box.y1, where).toBeGreaterThanOrEqual(D);

      // The entrance preset straddles the storefront line.
      const entrance = shop.spec.doors.find((d) => d.kind === "entrance")!;
      expect(specs.front.box.x0, where).toBeLessThan(entrance.x);
      expect(specs.front.box.x1, where).toBeGreaterThan(entrance.x);
      expect(specs.front.box.y0, where).toBeLessThan(0);

      // The aisle preset is narrow and sits between two gondola runs.
      const gondolas = shop.spec.fixtures.filter((f) => f.kind === "gondola");
      const aisleWidth = specs.aisle.box.x1 - specs.aisle.box.x0;
      expect(aisleWidth, where).toBeLessThan(W / 2);
      if (gondolas.length >= 2) {
        const mid = (specs.aisle.box.x0 + specs.aisle.box.x1) / 2;
        const left = Math.max(...gondolas.filter((g) => g.x < mid).map((g) => g.x + g.depthFt / 2));
        const right = Math.min(...gondolas.filter((g) => g.x > mid).map((g) => g.x - g.depthFt / 2));
        expect(mid, where).toBeGreaterThanOrEqual(left - 1e-6);
        expect(mid, where).toBeLessThanOrEqual(right + 1e-6);
      }

      // The counter preset covers the showcase and looks in from the shop side.
      const showcase = shop.spec.fixtures.find((f) => f.kind === "showcase");
      if (showcase) {
        expect(specs.counter.box.y0, where).toBeLessThanOrEqual(showcase.y0);
        expect(specs.counter.box.y1, where).toBeGreaterThanOrEqual(showcase.y1);
        const towardMiddle = showcase.x > W / 2 ? -1 : 1;
        expect(Math.sign(specs.counter.back[0]), where).toBe(towardMiddle);
      }

      // The stockroom preset sits behind the backroom line; the dock preset is
      // out past the back wall on the service drive.
      expect(specs.stockroom.box.y1, where).toBeGreaterThan(shop.spec.backroomY);
      expect(specs.dock.box.y1, where).toBeGreaterThan(D);
      expect(specs.dock.back[1], where).toBeGreaterThan(0);

      // The lot preset lives entirely in front of the building.
      expect(specs.lot.box.y0, where).toBeLessThan(-shop.spec.parking.depthFt);
      expect(specs.lot.box.y1, where).toBeLessThanOrEqual(12);
    }
  });
});

describe("fitted views", () => {
  const aspects = [1.6, 1.0, 0.45];

  it.each(aspects)("fill the viewport at aspect %s without clipping the subject, on every shop", (aspect) => {
    for (const shop of shops) {
      const specs = presetSpecs(shop.spec, shop.world);
      for (const p of CAMERA_PRESETS) {
        const spec: PresetSpec = specs[p];
        const view = fitView(spec, 55, aspect);
        const { max, behind } = extent(spec.box, view, 55, aspect);
        const where = `${shop.id}/${p}`;
        expect(behind, where).toBe(false);
        expect(max, where).toBeLessThanOrEqual((spec.fill ?? PRESET_FILL) + 0.02);
        // A fitted view touches the fill on at least one side, unless a height
        // floor pushed the camera back off the exact fit.
        if (spec.minHeight === undefined) expect(max, where).toBeGreaterThan((spec.fill ?? PRESET_FILL) - 0.05);
      }
    }
  });

  it("puts every camera in a sane box: above the ground, near the site, looking at the building", () => {
    for (const shop of shops) {
      const specs = presetSpecs(shop.spec, shop.world);
      const W = shop.spec.widthFt;
      const D = shop.spec.depthFt;
      const lot = shop.spec.parking.depthFt;
      const drive = shop.world.service.roadY;
      // Generous, but it catches a sign error or an unnormalised direction: no
      // camera may end up underground, further out than the site is deep, or
      // aimed away from the shop.
      const reach = Math.max(W, D) * 4 + lot + 200;
      for (const p of CAMERA_PRESETS) {
        const spec = specs[p];
        const view = fitView(spec, 55, 1.6);
        const where = `${shop.id}/${p}`;
        expect(view.pos.y, where).toBeGreaterThan(1);
        expect(view.pos.y, where).toBeLessThan(reach);
        expect(view.pos.x, where).toBeGreaterThan(-reach);
        expect(view.pos.x, where).toBeLessThan(W + reach);
        const engineY = -view.pos.z;
        expect(engineY, where).toBeGreaterThan(-(lot + reach));
        expect(engineY, where).toBeLessThan(drive + reach);
        if (spec.minHeight !== undefined) expect(view.pos.y, where).toBeGreaterThanOrEqual(spec.minHeight - 1e-6);
        // The orbit target is in front of the camera and inside the same reach.
        const toTarget = view.target.clone().sub(view.pos);
        expect(toTarget.length(), where).toBeGreaterThan(0.5);
        expect(view.target.y, where).toBeLessThan(WALL_TOP * 6);
      }
    }
  });

  it("keeps the interior presets lower than the aerial ones", () => {
    for (const shop of shops) {
      const specs = presetSpecs(shop.spec, shop.world);
      const h = (p: CameraPreset) => fitView(specs[p], 55, 1.6).pos.y;
      expect(h("front"), shop.id).toBeLessThan(h("overview"));
      expect(h("aisle"), shop.id).toBeLessThan(h("overview"));
      expect(h("counter"), shop.id).toBeLessThan(h("overview"));
      expect(h("front"), shop.id).toBeLessThan(h("lot"));
    }
  });
});

describe("CameraRig", () => {
  it("re-fits the active preset on an aspect change and lets go once the user moves the camera", () => {
    const shop = shops[0];
    const rig = new CameraRig();
    rig.setAspect(1.6);
    rig.setWorld(shop.spec, shop.world);
    expect(rig.activePreset).toBe("overview");
    const centre = new Vector3(shop.spec.widthFt / 2, 0, -shop.spec.depthFt / 2);
    const wide = rig.camera.position.clone();
    rig.setAspect(0.6);
    // A taller, narrower viewport has to back off to hold the same box.
    expect(rig.camera.position.distanceTo(centre)).toBeGreaterThan(wide.distanceTo(centre));

    rig.preset("aisle");
    expect(rig.activePreset).toBe("aisle");
    rig.lookAt(10, 10);
    expect(rig.activePreset).toBeNull();
    const held = rig.camera.position.clone();
    rig.setAspect(1.2);
    expect(rig.camera.position.equals(held)).toBe(true);

    rig.setMode("follow", 3);
    expect(rig.activePreset).toBeNull();
    expect(rig.followTarget).toBe(3);
    rig.dispose();
  });

  it("frames every preset without a DOM, on every shop", () => {
    for (const shop of shops) {
      const rig = new CameraRig();
      rig.setAspect(1.4);
      rig.setWorld(shop.spec, shop.world);
      for (const p of CAMERA_PRESETS) {
        rig.preset(p);
        expect(Number.isFinite(rig.camera.position.x + rig.camera.position.y + rig.camera.position.z), `${shop.id}/${p}`).toBe(true);
        expect(rig.camera.position.y, `${shop.id}/${p}`).toBeGreaterThan(0);
      }
      rig.dispose();
    }
  });

  it("holds the follow camera behind and above what it chases, at a distance set by its size", () => {
    const rig = new CameraRig();
    rig.setAspect(1.6);
    rig.setMode("follow", 1);
    rig.update(0.016, { x: 20, y: 30, h: 0, lengthFt: 2 });
    const behindShopper = rig.camera.position.clone();
    rig.resetFollow();
    rig.update(0.016, { x: 20, y: 30, h: 0, lengthFt: 63 });
    const behindTrailer = rig.camera.position.clone();
    const subject = new Vector3(20, 0, -30);
    expect(behindTrailer.distanceTo(subject)).toBeGreaterThan(behindShopper.distanceTo(subject));
    expect(behindShopper.y).toBeGreaterThan(0);
    // Heading 0 is +x, so the camera sits at smaller x than its subject.
    expect(behindShopper.x).toBeLessThan(20);
    rig.dispose();
  });
});
