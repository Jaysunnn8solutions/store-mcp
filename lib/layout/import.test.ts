/**
 * Every importer reads the same sample candy shop, drawn the way that format's
 * users draw it, and has to recover the same shop: the storefront at y = 0 with
 * the customer entrance on it, the goods doors on the back wall, eighteen
 * fixture runs, four back-stock runs and the same facings in the same aisles.
 *
 * The assertions are invariants and agreement between the readers rather than
 * numbers anyone typed in: the point of five parsers is that they see one
 * building, so the shared expectation is what proves them, and the per-format
 * tests only cover what that format alone can get wrong.
 */

import { describe, expect, it } from "vitest";
import { runOperations } from "../twin/operations";
import { buildTwin, operationsOptions } from "../twin/twin";
import { ImportError } from "./assemble";
import { readDxf } from "./dxf";
import { describeImport, importLayout, layoutStats, type ImportResult } from "./import";
import { LIMITS, LimitError } from "./limits";
import { sampleCsv, sampleDxf, sampleGeoJson, sampleIfc, sampleImdf, sampleIndoors, sampleStore, SAMPLE } from "./samples";
import { layoutSpecSchema, type LayoutSpec } from "./spec";

/** What all five readers must agree the sample shop is. */
const EXPECTED = { fixtures: 18, storage: 4, facings: 1441, service: 5, doors: 4, aisles: 6 };

function expectSampleStore(r: ImportResult) {
  expect(r.report.counts).toEqual(EXPECTED);

  // The storefront is y = 0 and the customer entrance is on it; the goods doors
  // are on the back wall. This is the one thing a warehouse importer gets
  // backwards, so it is asserted for every format.
  const entrances = r.spec.doors.filter((d) => d.kind === "entrance");
  const goods = r.spec.doors.filter((d) => d.kind === "dock" || d.kind === "ground");
  expect(entrances.length).toBe(1);
  expect(goods.length).toBe(3);
  for (const d of entrances) expect(d.y).toBe(0);
  for (const d of goods) expect(d.y).toBe(r.spec.depthFt);
  expect(goods.filter((d) => d.kind === "ground").length).toBe(1);
  // Whatever decided it, the report says so — a plan turned the wrong way round
  // is the one import mistake that looks fine and simulates nonsense.
  expect(r.report.orientedBy.length).toBeGreaterThan(0);

  // The sales floor is in front of the stockroom, and both fit in the building.
  expect(r.spec.backroomY).toBeGreaterThan(Math.max(...r.spec.fixtures.map((f) => f.y1)) - 1);
  expect(r.spec.backroomY).toBeLessThan(Math.min(...r.spec.storage.map((s) => s.y0)) + 1);
  expect(r.spec.depthFt).toBeGreaterThan(Math.max(...r.spec.storage.map((s) => s.y1)));
  for (const f of [...r.spec.fixtures, ...r.spec.storage]) {
    expect(f.y1).toBeGreaterThan(f.y0);
    expect(f.x - f.depthFt / 2).toBeGreaterThanOrEqual(-0.05);
    expect(f.x + f.depthFt / 2).toBeLessThanOrEqual(r.spec.widthFt + 0.05);
  }

  // A shop this size, whichever way it was drawn.
  expect(r.spec.widthFt).toBeGreaterThan(60);
  expect(r.spec.widthFt).toBeLessThan(80);
  expect(r.spec.depthFt).toBeGreaterThan(100);
  expect(r.spec.depthFt).toBeLessThan(125);

  // Every facing belongs to a run, and a run is shopped from at most two sides.
  const perRun = r.spec.fixtures.reduce((a, f) => a + f.bays * f.shelves * f.facingsPerBay, 0);
  expect(r.report.counts.facings).toBeGreaterThanOrEqual(perRun);
  expect(r.report.counts.facings).toBeLessThanOrEqual(2 * perRun);

  // Valid tool input, and small enough to travel in one.
  expect(() => layoutSpecSchema.parse(r.spec)).not.toThrow();
  expect(JSON.stringify(r.spec).length).toBeLessThan(20_000);
  expect(r.report.warnings).toEqual([]);
  // Assumptions travel with the spec, so whoever reads it later sees them.
  for (const a of r.report.assumptions) expect(r.spec.source.notes).toContain(a);
}

describe("layout import", () => {
  it("reads a rotated DXF in millimeters with block fixtures, loose wall lines and door layers", () => {
    const r = importLayout({ fileName: "sample-store.dxf", content: sampleDxf() });
    expect(r.report.format).toBe("dxf");
    expect(r.spec.source.format).toBe("dxf");
    expect(r.report.unitsFrom).toMatch(/millimeters/);
    expect(r.report.orientedBy).toMatch(/entrance door\(s\); the plan was turned 90°/);
    expect(r.spec.walls.length).toBeGreaterThan(0);
    // Annotation stays out, and the 36 gondola-bay blocks merge into four runs.
    expect(r.report.layers.find((l) => l.layer === "A-ANNO-DIMS")?.role).toBe("ignore");
    const gondolas = r.spec.fixtures.filter((f) => f.kind === "gondola");
    expect(gondolas.length).toBe(4);
    for (const g of gondolas) {
      expect(g.bays).toBe(9);
      expect(g.doubleSided).toBe(true);
    }
    expectSampleStore(r);
  });

  it("reads a fixture CSV with coordinates, door rows and checkout rows", () => {
    const r = importLayout({ fileName: "fixtures.csv", content: sampleCsv() }, { surface: "inline" });
    expect(r.report.format).toBe("csv");
    expect(r.spec.source.format).toBe("csv");
    // Shelves and facings come from the rows, not from the fixture-family defaults.
    expect(r.spec.fixtures.find((f) => f.kind === "showcase")?.shelves).toBe(3);
    expectSampleStore(r);
  });

  it("reads an IMDF archive in lon/lat, turned off the meridian", () => {
    const r = importLayout({ fileName: "sample-store.zip", content: sampleImdf() });
    expect(r.report.format).toBe("imdf");
    expect(r.spec.source.format).toBe("imdf");
    expect(r.report.orientedBy).toMatch(/entrance door\(s\); the plan was turned 340°/);
    expectSampleStore(r);
  });

  it("reads an ArcGIS Indoors export in Web Mercator, as several files or one", () => {
    const many = importLayout({ files: sampleIndoors() });
    expect(many.spec.source.format).toBe("indoors");
    expect(many.report.unitsFrom).toMatch(/Web Mercator/);
    expectSampleStore(many);

    const one = importLayout({ fileName: "store.geojson", content: sampleGeoJson() });
    expect(one.report.counts).toEqual(many.report.counts);
  });

  it("reads IFC4 extruded solids in meters", () => {
    const r = importLayout({ fileName: "sample-store.ifc", content: sampleIfc() });
    expect(r.report.format).toBe("ifc");
    expect(r.spec.source.format).toBe("ifc");
    expect(r.report.unitsFrom).toMatch(/METRE/);
    expect(r.report.orientedBy).toMatch(/entrance/);
    expectSampleStore(r);
  });

  it("simulates an imported building with a committed shop's demand and crew", async () => {
    // The end the whole pipeline exists for: somebody else's drawing, this
    // shop's customers, and the walkout number that comes out of the two.
    const r = importLayout({ fileName: "sample-store.dxf", content: sampleDxf() });
    const ctx = await buildTwin("store-midtown", 36, { layout: r.spec });
    expect(ctx.layout.facings.length).toBe(EXPECTED.facings);
    expect(ctx.layout.salesAisles.length).toBe(EXPECTED.aisles);
    expect(ctx.layout.storage.length).toBeGreaterThan(0);
    const res = runOperations(ctx, operationsOptions(ctx, 3, 1));
    expect(res.sales.customers).toBeGreaterThan(0);
    expect(res.sales.salesDollars).toBeGreaterThan(0);
    expect(res.service.abandonRate).toBeGreaterThanOrEqual(0);
    expect(res.service.abandonRate).toBeLessThanOrEqual(1);
  });

  it("gives back the same bytes for the same file, every time", () => {
    // The 3D page replays an imported building, so a spec has to be a pure
    // function of the file: no clock, no random source, no map iteration order.
    for (const format of ["dxf", "csv", "geojson", "imdf", "ifc"] as const) {
      const content = sampleStore(format);
      const a = importLayout({ fileName: `s.${format}`, content }, { format });
      const b = importLayout({ fileName: `s.${format}`, content }, { format });
      expect(JSON.stringify(a.spec)).toBe(JSON.stringify(b.spec));
    }
  });

  it("follows a roleMap over the built-in guesses", () => {
    const r = importLayout({ fileName: "sample-store.dxf", content: sampleDxf() }, { roleMap: { "FIXTURE-GONDOLA": "bulk", "A-CASE-SHOWCASE": "shelving" } });
    expect(r.report.layers.find((l) => l.layer.startsWith("FIXTURE-GONDOLA"))?.role).toBe("bulk");
    // Four gondola runs plus the bulk wall are now all bulk bins…
    expect(r.spec.fixtures.filter((f) => f.kind === "bulk").length).toBe(5);
    expect(r.spec.fixtures.filter((f) => f.kind === "gondola").length).toBe(0);
    // …and the showcase has moved to the stockroom, which changes what sells.
    expect(r.spec.fixtures.filter((f) => f.kind === "showcase").length).toBe(0);
    expect(r.spec.storage.length).toBe(EXPECTED.storage + 1);
    expect(r.report.counts.facings).not.toBe(EXPECTED.facings);
    expect(r.report.counts.facings).toBeGreaterThan(0);
  });

  it("names the rule that put the storefront at y = 0, and falls through them in order", () => {
    const dxf = sampleDxf();
    const byGlazing = importLayout({ fileName: "s.dxf", content: dxf }, { roleMap: { "A-DOOR-ENTRANCE": "ignore" } });
    expect(byGlazing.report.orientedBy).toMatch(/glazing/);
    expect(byGlazing.report.assumptions.join(" ")).toMatch(/No customer entrance/);
    expect(byGlazing.spec.doors.filter((d) => d.kind === "entrance")[0].y).toBe(0);

    const byGoods = importLayout({ fileName: "s.dxf", content: dxf }, { roleMap: { "A-DOOR-ENTRANCE": "ignore", "A-GLAZ": "ignore" } });
    expect(byGoods.report.orientedBy).toMatch(/goods door/);
    // Whichever rule fired, the stockroom still ends up behind the sales floor.
    for (const r of [byGlazing, byGoods]) {
      expect(r.spec.backroomY).toBeGreaterThan(Math.max(...r.spec.fixtures.map((f) => f.y1)) - 1);
      expect(r.spec.doors.filter((d) => d.kind !== "entrance").every((d) => d.y === r.spec.depthFt)).toBe(true);
    }
  });

  it("lays out a fixture list without coordinates as an ordinary shop", () => {
    const rows = ["fixture,type,section,shelf,facing"];
    for (const a of ["G1", "G2", "G3"]) for (let b = 1; b <= 8; b++) for (let sh = 1; sh <= 5; sh++) for (let f = 1; f <= 3; f++) rows.push(`${a},Gondola,${b},${sh},${f}`);
    for (let b = 1; b <= 6; b++) for (let sh = 1; sh <= 4; sh++) for (let f = 1; f <= 2; f++) rows.push(`W1,Bulk bins,${b},${sh},${f}`);
    for (let b = 1; b <= 5; b++) for (let lv = 1; lv <= 3; lv++) rows.push(`R1,Pallet rack,${b},${lv},1`);
    const r = importLayout({ fileName: "planogram.csv", content: rows.join("\n") }, { surface: "inline" });
    expect(r.report.warnings).toEqual([]);
    expect(r.report.assumptions.join(" ")).toMatch(/no coordinates/i);
    expect(r.report.counts.fixtures).toBe(4);
    expect(r.report.counts.storage).toBe(1);
    // A register was invented, because a shop that cannot check anyone out
    // cannot be simulated at all.
    expect(r.spec.service.filter((s) => s.kind === "register").length).toBe(1);
    expect(r.report.counts.facings).toBeGreaterThan(0);
    expect(() => layoutSpecSchema.parse(r.spec)).not.toThrow();
  });

  it("guesses the unit of a small unitless drawing from its fixtures", () => {
    // A 100 ft shop drawn in inches spans 1,200 units, which is also a
    // perfectly ordinary number of feet: the fixture depth is what tells them
    // apart, and reading it as feet would make the shop 1,200 ft wide.
    const out: string[] = [];
    const pair = (c: number, v: string | number) => out.push(String(c), String(v));
    pair(0, "SECTION");
    pair(2, "ENTITIES");
    const lw = (layer: string, x0: number, y0: number, x1: number, y1: number) => {
      pair(0, "LWPOLYLINE");
      pair(8, layer);
      pair(90, 4);
      pair(70, 1);
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        pair(10, x);
        pair(20, y);
      }
    };
    lw("A-FLOR-OTLN", 0, 0, 840, 1200);
    for (const x of [120, 240, 360]) lw("FIXTURE-GONDOLA", x, 240, x + 48, 840);
    lw("STOCKROOM-PALLET-RACK", 120, 960, 168, 1140);
    pair(0, "ENDSEC");
    pair(0, "EOF");
    const dxf = readDxf(out.join("\n") + "\n");
    expect(dxf.unitsFrom).toMatch(/inches/);
    expect(dxf.unitsToFt).toBeCloseTo(1 / 12, 6);
    // And with the unit given, the guess is not consulted at all.
    expect(readDxf(out.join("\n") + "\n", { unitsFt: 1 }).unitsFrom).toMatch(/given/);
  });

  it("says why a layout will not simulate, rather than refusing it", () => {
    // No stockroom: a structurally valid spec the twin cannot run.
    const noBackroom = layoutStats({
      version: 1,
      name: "x",
      source: { format: "csv", notes: [] },
      widthFt: 40,
      depthFt: 60,
      outline: [],
      walls: [],
      zones: [],
      fixtures: [{ id: "F1", kind: "gondola", x: 10, y0: 10, y1: 30, depthFt: 4, shelves: 4, bays: 5, facingsPerBay: 2, doubleSided: true }],
      storage: [],
      service: [{ id: "REG-1", kind: "register", x: 30, y: 6, facing: 270 }],
      doors: [
        { id: "ENT-1", kind: "entrance", x: 20, y: 0, widthFt: 8 },
        { id: "DOCK-1", kind: "dock", x: 30, y: 60, widthFt: 10 },
      ],
      parking: { depthFt: 40, stalls: 10, accessibleStalls: 1, curbsideStalls: 1 },
      backroomY: 40,
      aisleWidthFt: 5,
      shelfHeightFt: 1.25,
    } satisfies LayoutSpec);
    expect(noBackroom.error).toMatch(/stockroom/i);
    expect(noBackroom.facings).toBe(0);

    // The same thing through the front door: the spec still comes back, with
    // the reason in the report, so the next attempt can fix it with roleMap.
    const r = importLayout({ fileName: "s.dxf", content: sampleDxf() }, { roleMap: { STOCKROOM: "ignore" } });
    expect(r.spec.fixtures.length).toBeGreaterThan(0);
    expect(r.report.counts.facings).toBe(0);
    expect(r.report.warnings.join(" ")).toMatch(/will not simulate/);
    expect(describeImport(r)).toMatch(/will not simulate/);
  });

  it("rejects what it should, with the reason and where to go instead", () => {
    expect(() => importLayout({ fileName: "plan.dwg", content: new Uint8Array([65, 67, 49, 48, 51, 50]) })).toThrow(/DXF/);
    expect(() => importLayout({ fileName: "big.dxf", content: "x".repeat(LIMITS.inline.text + 1) }, { surface: "inline" })).toThrow(LimitError);
    expect(() => importLayout({ fileName: "big.dxf", content: "x".repeat(LIMITS.inline.text + 1) }, { surface: "inline" })).toThrow(/web page|local server/);
    expect(() => importLayout({ fileName: "huge.ifc", content: sampleIfc() }, { surface: "inline" })).toThrow(/not accepted by the hosted/);
    expect(() => importLayout({ fileName: "empty.csv", content: "fixture,section\n" }, { surface: "inline" })).toThrow(/at least one fixture row/);
    expect(() => readDxf("AutoCAD Binary DXF\r\n")).toThrow(/binary DXF/);
    // A drawing with nothing a shop is made of says which layers it saw.
    expect(() => importLayout({ fileName: "empty.dxf", content: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n" })).toThrow(ImportError);
  });

  it("writes the same shop in every format", () => {
    expect(typeof sampleStore("dxf")).toBe("string");
    expect(sampleStore("imdf")).toBeInstanceOf(Uint8Array);
    expect(SAMPLE.runs.filter((r) => r.role === "gondola").length).toBe(4);
    const report = describeImport(importLayout({ fileName: "s.dxf", content: sampleDxf() }), 1234);
    expect(report).toMatch(/1,441 facings in 6 aisle/);
    expect(report).toMatch(/How each layer, block or category was read/);
  });
});
