/**
 * The palette's three standing promises: every fixture family and every
 * surface has a colour in both themes, every value really is a 24-bit hex
 * colour, and the fill ramp never doubles back — a fuller shelf always reads
 * greener than an emptier one.
 */

import { describe, expect, it } from "vitest";
import { Color } from "three";
import { FIXTURE_KINDS } from "../layout/spec";
import {
  CATEGORY_COLORS,
  DOOR_COLORS,
  fillColor,
  FIXTURE_COLORS,
  fixtureColor,
  heatColor,
  ROLE_COLORS,
  roleColor,
  SERVICE_COLORS,
  shopperColor,
  SHOPPER_COLORS,
  STALL_COLORS,
  STATE_COLORS,
  SURFACES,
  THEMES,
  darken,
  type ThemeName,
} from "./palette";

const THEME_NAMES: ThemeName[] = ["light", "dark"];

function isHex(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff;
}

/** How green a colour reads against red: the one axis the fill ramp moves along. */
function greenness(c: Color): number {
  return c.g - c.r;
}

describe("fixture colours", () => {
  it("gives every fixture family a colour in both themes", () => {
    for (const theme of THEME_NAMES) {
      for (const kind of FIXTURE_KINDS) {
        const hex = fixtureColor(theme, kind);
        expect(isHex(hex), `${theme}/${kind}`).toBe(true);
        expect(FIXTURE_COLORS[theme][kind]).toBe(hex);
      }
    }
  });

  it("keeps the two themes apart, so switching is visible on every family", () => {
    for (const kind of FIXTURE_KINDS) {
      expect(FIXTURE_COLORS.light[kind], kind).not.toBe(FIXTURE_COLORS.dark[kind]);
    }
  });

  it("darkens every fixture for the dark theme rather than tinting it at random", () => {
    for (const kind of FIXTURE_KINDS) {
      const light = new Color(FIXTURE_COLORS.light[kind]);
      const dark = new Color(FIXTURE_COLORS.dark[kind]);
      expect(dark.getHSL({ h: 0, s: 0, l: 0 }).l, kind).toBeLessThan(light.getHSL({ h: 0, s: 0, l: 0 }).l);
    }
  });
});

describe("surfaces and themes", () => {
  it("defines the same surface keys in both themes, all of them valid colours", () => {
    const lightKeys = Object.keys(SURFACES.light).sort();
    const darkKeys = Object.keys(SURFACES.dark).sort();
    expect(darkKeys).toEqual(lightKeys);
    for (const theme of THEME_NAMES) {
      for (const [key, value] of Object.entries(SURFACES[theme])) {
        // plateText is CSS for a canvas context, not a three colour.
        if (key === "plateText") {
          expect(value, `${theme}/${key}`).toMatch(/^#[0-9a-f]{6}$/i);
          continue;
        }
        expect(isHex(value), `${theme}/${key}`).toBe(true);
      }
    }
  });

  it("gives every theme a sky, a night sky, ground and asphalt", () => {
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      for (const hex of [t.background, t.sky.top, t.sky.horizon, t.night.top, t.night.horizon, t.dusk, t.ground, t.foliage, t.lot, t.kerb]) {
        expect(isHex(hex), theme).toBe(true);
      }
      // Night is darker than noon, or the day/night cycle would read backwards.
      expect(new Color(t.night.top).getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(new Color(t.sky.top).getHSL({ h: 0, s: 0, l: 0 }).l);
    }
  });

  it("keeps every fixed palette entry a valid colour", () => {
    const fixed = [
      ...Object.values(DOOR_COLORS),
      ...Object.values(SERVICE_COLORS),
      ...Object.values(STALL_COLORS),
      ...Object.values(STATE_COLORS).filter((v) => typeof v === "number"),
      ...ROLE_COLORS,
      ...CATEGORY_COLORS,
      ...SHOPPER_COLORS,
    ];
    for (const hex of fixed) expect(isHex(hex)).toBe(true);
  });

  it("wraps the indexed ramps rather than falling off either end", () => {
    expect(roleColor(0)).toBe(ROLE_COLORS[0]);
    expect(roleColor(ROLE_COLORS.length)).toBe(ROLE_COLORS[0]);
    expect(roleColor(-1)).toBe(ROLE_COLORS[ROLE_COLORS.length - 1]);
    expect(shopperColor(-SHOPPER_COLORS.length)).toBe(SHOPPER_COLORS[0]);
  });
});

describe("fillColor", () => {
  const cap = 240;
  const perCase = 24;

  it("runs red, then amber, then toward green as the shelf fills", () => {
    const empty = fillColor(new Color(), 0, cap, perCase);
    const oneCase = fillColor(new Color(), perCase, cap, perCase);
    const full = fillColor(new Color(), cap, cap, perCase);
    expect(greenness(empty)).toBeLessThan(greenness(oneCase));
    expect(greenness(oneCase)).toBeLessThan(greenness(full));
    // Empty is unmistakably red, full unmistakably green.
    expect(empty.r).toBeGreaterThan(empty.g);
    expect(full.g).toBeGreaterThan(full.r);
  });

  it("never doubles back: greenness is non-decreasing in units", () => {
    let last = -Infinity;
    const target = new Color();
    for (let units = 0; units <= cap; units++) {
      const g = greenness(fillColor(target, units, cap, perCase));
      expect(g, `units=${units}`).toBeGreaterThanOrEqual(last - 1e-9);
      last = g;
    }
  });

  it("holds its ends outside the range, and survives a degenerate cap", () => {
    const target = new Color();
    expect(greenness(fillColor(target, -5, cap, perCase))).toBeCloseTo(greenness(fillColor(new Color(), 0, cap, perCase)), 9);
    expect(greenness(fillColor(target, cap * 3, cap, perCase))).toBeCloseTo(greenness(fillColor(new Color(), cap, cap, perCase)), 9);
    // A facing whose cap is one case still ramps rather than dividing by zero.
    const tiny = fillColor(new Color(), 30, 24, 24);
    expect(Number.isFinite(tiny.r + tiny.g + tiny.b)).toBe(true);
  });

  it("writes into the caller's Color and allocates nothing", () => {
    const target = new Color(0x000000);
    const same = fillColor(target, 100, cap, perCase);
    expect(same).toBe(target);
  });
});

describe("heatColor", () => {
  it("darkens monotonically across the ramp and clamps outside it", () => {
    const target = new Color();
    let last = Infinity;
    for (let i = 0; i <= 20; i++) {
      const l = heatColor(target, i / 20).getHSL({ h: 0, s: 0, l: 0 }).l;
      expect(l).toBeLessThanOrEqual(last + 1e-9);
      last = l;
    }
    expect(heatColor(new Color(), -1).getHex()).toBe(heatColor(new Color(), 0).getHex());
    expect(heatColor(new Color(), 2).getHex()).toBe(heatColor(new Color(), 1).getHex());
  });
});

describe("darken", () => {
  it("scales each channel and stays a valid colour", () => {
    expect(darken(0xffffff, 0.5)).toBe(0x808080);
    expect(darken(0x2f9e44, 1)).toBe(0x2f9e44);
    expect(isHex(darken(0xe08a3c, 0.45))).toBe(true);
  });
});
