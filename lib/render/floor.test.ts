import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLayout, siteToSpec, type Layout } from "../twin/layout";
import type { Site } from "../twin/types";
import { floorTransform, renderFloorHtml, renderFloorSvg } from "./floor";
import { appealByFacing, storeFloorHtml, storeFloorSvg } from "./store-floor";

// The renderer must not read the filesystem, so the test does it instead: this
// is the Node side of the line, and it keeps the suite independent of whatever
// the data registry looks like when it lands.
const sites: Site[] = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "..", "data", "sites.json"), "utf8")) as Site[];

const layouts: Array<[string, Layout]> = sites.map((site) => [site.name, buildLayout(siteToSpec(site), site)]);

/**
 * Well-formedness by tag balance: every element opens and closes in order, and
 * nothing is left hanging. Enough to catch an unescaped string or a `<title>`
 * that never closed, which is what actually goes wrong in a string builder.
 */
function tagBalance(svg: string): string[] {
  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = tag.exec(svg)) !== null) {
    consumed += m[0].length;
    if (m[1] === "/") {
      const open = stack.pop();
      if (open !== m[2]) throw new Error(`</${m[2]}> closes <${open ?? "nothing"}>`);
    } else if (m[4] !== "/") {
      stack.push(m[2]);
    }
  }
  // Everything outside a tag must be text with no stray markup delimiters.
  const text = svg.replace(tag, "");
  if (/[<>]/.test(text)) throw new Error(`stray angle bracket in text: ${text.slice(0, 80)}`);
  if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text)) throw new Error("bare ampersand in text");
  expect(consumed).toBeGreaterThan(0);
  return stack;
}

describe("renderFloorSvg", () => {
  it("draws every committed store without throwing, as balanced markup", () => {
    for (const [name, layout] of layouts) {
      const svg = renderFloorSvg(layout);
      expect(svg.startsWith("<svg"), name).toBe(true);
      expect(svg.endsWith("</svg>"), name).toBe(true);
      expect(tagBalance(svg), name).toEqual([]);
    }
  });

  it("names every fixture run, stockroom run, service point and door", () => {
    for (const [name, layout] of layouts) {
      const svg = renderFloorSvg(layout);
      const ids = [
        ...layout.spec.fixtures.map((f) => f.id),
        ...layout.spec.storage.map((s) => s.id),
        ...layout.spec.service.map((s) => s.id),
        ...layout.spec.doors.map((d) => d.id),
      ];
      expect(ids.length).toBeGreaterThan(10);
      for (const id of ids) expect(svg, `${name}: ${id}`).toContain(id);
    }
  });

  it("covers the lot and the building in the viewBox", () => {
    for (const [name, layout] of layouts) {
      const spec = layout.spec;
      const svg = renderFloorSvg(layout);
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
      expect(vb, name).not.toBeNull();
      const w = Number(vb![1]);
      const h = Number(vb![2]);
      const tf = floorTransform(spec);
      expect(tf.width, name).toBeCloseTo(w, 6);
      expect(tf.height, name).toBeCloseTo(h, 6);
      // The far edge of the lot, the storefront, the back wall and both side
      // walls all land inside the drawing, with room left over for the margin.
      for (const [px, py] of [
        [tf.X(0), tf.Y(-spec.parking.depthFt)],
        [tf.X(spec.widthFt), tf.Y(0)],
        [tf.X(spec.widthFt / 2), tf.Y(spec.depthFt)],
      ]) {
        expect(px, name).toBeGreaterThan(0);
        expect(px, name).toBeLessThan(w);
        expect(py, name).toBeGreaterThan(tf.headerHeight);
        expect(py, name).toBeLessThan(h - tf.legendHeight);
      }
      expect(tf.yMinFt, name).toBe(-spec.parking.depthFt);
    }
  });

  it("drops the lot from the frame when parking is off", () => {
    const [, layout] = layouts[0];
    const withLot = floorTransform(layout.spec);
    const without = floorTransform(layout.spec, { showParking: false });
    expect(without.yMinFt).toBe(0);
    expect(without.height).toBeLessThan(withLot.height);
    expect(renderFloorSvg(layout, { showParking: false })).not.toContain("Customer lot");
  });

  it("round-trips feet through the transform", () => {
    const [, layout] = layouts[3];
    const tf = floorTransform(layout.spec, { width: 900 });
    // X and Y round to a tenth of an SVG unit, so the inverse is only ever off
    // by half of that in feet. An overlay drawn through the transform lands on
    // the same pixel; that is all it has to do.
    const slack = 0.05 / tf.scale + 1e-9;
    for (const [x, y] of [
      [0, 0],
      [layout.spec.widthFt, layout.spec.depthFt],
      [layout.bench.x, layout.bench.y],
      [12, -30],
    ]) {
      const [bx, by] = tf.toFeet(tf.X(x), tf.Y(y));
      expect(Math.abs(bx - x)).toBeLessThan(slack);
      expect(Math.abs(by - y)).toBeLessThan(slack);
    }
  });

  it("is deterministic and free of dates", () => {
    const [, layout] = layouts[1];
    expect(renderFloorSvg(layout)).toBe(renderFloorSvg(layout));
    expect(renderFloorSvg(layout)).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
  });

  it("escapes a hostile store name instead of emitting markup", () => {
    const [, base] = layouts[0];
    const layout: Layout = { ...base, spec: { ...base.spec, name: `</svg><script>alert("x")</script> & co` } };
    const svg = renderFloorSvg(layout);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;/svg&gt;");
    expect(tagBalance(svg)).toEqual([]);
  });

  it("shades bays only where the caller gave values, and stays balanced", () => {
    const [, layout] = layouts[0];
    const plain = renderFloorSvg(layout);
    const values = appealByFacing(layout);
    expect(values.size).toBe(layout.facings.length);
    for (const shadeBy of ["sales", "restocks", "appeal"] as const) {
      const shaded = renderFloorSvg(layout, { shadeBy, values });
      expect(shaded.length).toBeGreaterThan(plain.length);
      expect(tagBalance(shaded)).toEqual([]);
    }
    // No values means no shading, whatever shadeBy says.
    expect(renderFloorSvg(layout, { shadeBy: "sales", values: new Map() })).toBe(plain);
  });

  it("answers to both themes and to the aisle switch", () => {
    const [, layout] = layouts[2];
    const auto = renderFloorSvg(layout);
    const light = renderFloorSvg(layout, { theme: "light" });
    const dark = renderFloorSvg(layout, { theme: "dark" });
    expect(auto).toContain("prefers-color-scheme");
    expect(light).not.toContain("prefers-color-scheme");
    expect(dark).toContain("--sf-floor:#1b1d20");
    expect(light).not.toBe(dark);
    expect(renderFloorSvg(layout, { showAisles: false })).not.toContain(">A1<");
    expect(renderFloorSvg(layout)).toContain(">A1<");
  });
});

describe("renderFloorHtml", () => {
  it("wraps the SVG in a page with nothing loaded from anywhere else", () => {
    for (const [name, layout] of layouts) {
      const html = renderFloorHtml(layout, { title: "Plan & preview" });
      const svg = renderFloorSvg(layout, { width: 1040, title: "Plan & preview" });
      expect(html, name).toContain(svg);
      expect(html.startsWith("<!doctype html>"), name).toBe(true);
      expect(html.endsWith("</html>"), name).toBe(true);
      expect(html, name).toContain("Plan &amp; preview");
      expect(html, name).not.toContain("<script");
      // The SVG namespace URI is a name, not a fetch; everything else that
      // looks like a URL would be something the file loads from the network.
      const body = html.split(`xmlns="http://www.w3.org/2000/svg"`).join("");
      for (const pattern of [/https?:\/\//, /\ssrc=/, /<link\b/, /url\(/, /@import/]) {
        expect(pattern.test(body), `${name}: ${pattern}`).toBe(false);
      }
    }
  });
});

describe("storeFloorSvg", () => {
  it("leaves the plan unshaded until the caller has numbers", () => {
    const [, layout] = layouts[4];
    const plain = storeFloorSvg({ layout });
    expect(plain).not.toContain("shaded by");
    expect(plain).toBe(renderFloorSvg(layout, { title: layout.spec.name }));
    expect(tagBalance(plain)).toEqual([]);
  });

  it("computes the appeal map for a caller who asks for it", () => {
    const [, layout] = layouts[4];
    const svg = storeFloorSvg({ layout }, { shadeBy: "appeal" });
    expect(svg).toContain("merchandising appeal");
    expect(svg).toBe(renderFloorSvg(layout, { title: layout.spec.name, shadeBy: "appeal", values: appealByFacing(layout) }));
    expect(tagBalance(svg)).toEqual([]);
  });

  it("prefers sales over restocks", () => {
    const [, layout] = layouts[0];
    const sales = new Map(layout.facings.map((f, i) => [f.id, (i % 7) + 1]));
    const restocks = new Map(layout.facings.map((f, i) => [f.id, (i % 3) + 1]));
    expect(storeFloorSvg({ layout, salesByFacing: sales, restocksByFacing: restocks })).toContain("dollars a bay");
    expect(storeFloorSvg({ layout, restocksByFacing: restocks })).toContain("restocks a bay");
    expect(storeFloorSvg({ layout, salesByFacing: new Map() })).not.toContain("shaded by");
  });

  it("hands the tool a page around the same drawing", () => {
    const [, layout] = layouts[1];
    const html = storeFloorHtml({ layout, title: "Decatur" });
    expect(html).toContain(storeFloorSvg({ layout, title: "Decatur" }, { width: 1040 }));
  });
});
