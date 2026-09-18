/**
 * All colour for the 3D store.
 *
 * The vocabulary is the 2D plan's (lib/render/floor.ts), value for value:
 * gondolas blue-grey, the showcase amber, bulk warm brown, endcaps and
 * seasonal tables orange, impulse pink, wall shelving pale grey, stockroom
 * racking tan, docks green, the ground-level roll-up orange, the entrance
 * blue. Someone who has looked at the plan recognises the shop.
 *
 * Unlike the reference warehouse, a shop's own fixtures follow the UI theme.
 * A store is a small, bright, colour-led room seen mostly from inside, and
 * the plan already commits to a dark value for every fixture family; keeping
 * the 3D scene on the light values under a dark page made the interior glow
 * like a lightbox. So `SURFACES` and `FIXTURE_COLORS` are both keyed by theme,
 * and the two modules that own materials (building.ts, fixtures.ts) expose a
 * `setTheme` that re-sets the colours in place rather than rebuilding.
 *
 * What does NOT follow the theme: the fill ramp and the heat ramp. A shelf
 * that is nearly empty must read the same red whatever the page chrome is
 * doing, so those two ramps have one set of stops and are chosen to sit
 * legibly on both the light and the dark fixture values.
 *
 * Values are 0xRRGGBB for Color.setHex; the ramps write into a caller-owned
 * Color so the per-frame loops in apply.ts allocate nothing.
 */

import { Color } from "three";
import type { FixtureKind } from "../layout/spec";

export type ThemeName = "light" | "dark";

export interface Theme {
  /** Stage colour before the first frame; the page's CSS mirrors it. */
  background: number;
  /** Sky dome at noon: zenith and horizon (the horizon is also the fog colour). */
  sky: { top: number; horizon: number };
  /** Sky dome at night. */
  night: { top: number; horizon: number };
  /** Warm horizon tint blended in at sunrise and sunset. */
  dusk: number;
  /** Open ground beyond the lot. */
  ground: number;
  /** Trees and hedging along the far edge of the lot. */
  foliage: number;
  /** Asphalt: the customer lot and the service drive. */
  lot: number;
  /** Kerbs, bollards, light poles, the fence behind the shop. */
  kerb: number;
}

export const THEMES: Record<ThemeName, Theme> = {
  light: {
    background: 0xe9eef3,
    sky: { top: 0x6ea6dc, horizon: 0xdde7ee },
    night: { top: 0x0a1120, horizon: 0x243044 },
    dusk: 0xf1b57e,
    ground: 0xa4ae87,
    foliage: 0x6f8a5a,
    lot: 0x76777a,
    kerb: 0x9aa0a8,
  },
  dark: {
    background: 0x15171b,
    sky: { top: 0x1a2231, horizon: 0x3c4756 },
    night: { top: 0x05080e, horizon: 0x141a26 },
    dusk: 0x7d5238,
    ground: 0x2c3128,
    foliage: 0x2f4030,
    lot: 0x26282c,
    kerb: 0x4a5058,
  },
};

/**
 * The selling fixtures, family by family — the plan's hues exactly. `bulk` is
 * the gravity-bin wall, `impulse` the racks that flank the till, `seasonal`
 * the free-standing tables inside the door.
 */
export const FIXTURE_COLORS: Record<ThemeName, Record<FixtureKind, number>> = {
  light: {
    gondola: 0x8ba3b8,
    wall: 0xcfd0cb,
    endcap: 0xe08a3c,
    bulk: 0xa8763f,
    showcase: 0xe6b23c,
    impulse: 0xe08aa8,
    seasonal: 0xeaa963,
  },
  dark: {
    gondola: 0x5f7789,
    wall: 0x6b6e70,
    endcap: 0xb4661f,
    bulk: 0x7c5528,
    showcase: 0xb5871f,
    impulse: 0xa05d78,
    seasonal: 0xa8763a,
  },
};

export function fixtureColor(theme: ThemeName, kind: FixtureKind): number {
  return FIXTURE_COLORS[theme][kind];
}

export interface Surfaces {
  /** Sales-floor tile. */
  salesFloor: number;
  /** Sealed concrete behind the stockroom line. */
  backroomFloor: number;
  /** The receiving apron inside the goods doors. */
  apron: number;
  /** The queue zone at the till and the staff corridor behind the counter. */
  queueZone: number;
  corridor: number;
  grid: number;
  wall: number;
  /** The storefront glazing, and the showcase glass. */
  glass: number;
  /** Mullions, door leaves, the awning's frame. */
  mullion: number;
  /** The fascia band the store name sits on. */
  fascia: number;
  sign: number;
  aisle: number;
  /** Painted floor markings: stall stripes, lane marks, the dock hatch. */
  paint: number;
  roadMark: number;
  /** Rubber dock bumpers. */
  bumper: number;
  /** The service counter's body and the wrap bench. */
  counter: number;
  register: number;
  wrap: number;
  /** Door number plate and its lettering. */
  plate: number;
  plateText: string;
  /** Stockroom pallet racking and case shelving. */
  rack: number;
  shelving: number;
  /** Shelf decks and the shelf edge strips on the sales floor. */
  deck: number;
  /** Cases on the stockroom shelves. */
  case: number;
  bench: number;
  /** Ceiling strips and the pendants over the showcase. */
  ceilingStrip: number;
  steel: number;
  skin: number;
  body: number;
  /** Hemisphere ground bounce inside the shop. */
  bounce: number;
}

export const SURFACES: Record<ThemeName, Surfaces> = {
  light: {
    salesFloor: 0xf1efe8,
    backroomFloor: 0xc8c4ba,
    apron: 0xd8cec3,
    queueZone: 0xe8d6ad,
    corridor: 0xe3d7bd,
    grid: 0xb8b4aa,
    wall: 0xdedace,
    glass: 0xbcd7e4,
    mullion: 0x6b7178,
    fascia: 0x2c3a44,
    sign: 0xf6efe0,
    aisle: 0x8f98a3,
    paint: 0xe0b20c,
    roadMark: 0xf1f0ea,
    bumper: 0x2a2a2a,
    counter: 0x37474f,
    register: 0x2a3940,
    wrap: 0xc2557c,
    plate: 0xf6f4ee,
    plateText: "#1f2328",
    rack: 0xc8ad82,
    shelving: 0xddcda9,
    deck: 0xd6dae0,
    case: 0xb98f5f,
    bench: 0xb9ae97,
    ceilingStrip: 0xf4f2ea,
    steel: 0x6f7883,
    skin: 0xe8c4a0,
    body: 0x3b4252,
    bounce: 0x7a746a,
  },
  dark: {
    salesFloor: 0x2a2d31,
    backroomFloor: 0x212427,
    apron: 0x2d2a26,
    queueZone: 0x40371f,
    corridor: 0x3a331f,
    grid: 0x3d4146,
    wall: 0x33373b,
    glass: 0x30485a,
    mullion: 0x555c63,
    fascia: 0x1b242b,
    sign: 0xe4dcc9,
    aisle: 0x6b767f,
    paint: 0xb08c0a,
    roadMark: 0x9a9a94,
    bumper: 0x1a1a1a,
    counter: 0x27343a,
    register: 0x9fb0ba,
    wrap: 0xa2476a,
    plate: 0xcdcbc4,
    plateText: "#14171a",
    rack: 0x8f7b53,
    shelving: 0xa08d68,
    deck: 0x545c64,
    case: 0x7d6240,
    bench: 0x7d745f,
    ceilingStrip: 0xdad6c8,
    steel: 0x565e68,
    skin: 0xb8906e,
    body: 0x2a303c,
    bounce: 0x2b2924,
  },
};

/** Goods and customer doors, the same three colours the plan uses. */
export const DOOR_COLORS = { entrance: 0x1c7ed6, dock: 0x2f9e44, ground: 0xd9480f } as const;

/** Service points: registers dark, showcase stations amber, gift wrap pink. */
export const SERVICE_COLORS = { register: 0x37474f, counter: 0xa9761b, wrap: 0xc2557c } as const;

/** Parking stalls: standard unpainted, accessible blue, curbside pickup green. */
export const STALL_COLORS = { standard: 0xb4b5ae, accessible: 0x4c9be8, curbside: 0x2f9e44 } as const;

/**
 * Worker roles by EntityDef.colorIdx. The compiler numbers roles in roster
 * order; anything past the list wraps, so a big scenario still tints.
 */
export const ROLE_COLORS = [0x1c7ed6, 0xf08c00, 0x2f9e44, 0x9c36b5, 0xe8590c, 0x0ca678, 0xc2255c, 0x5f3dc4];

/** SKU categories by EntityDef.colorIdx, for pallets, cases and carried stock. */
export const CATEGORY_COLORS = [0x8b5e3c, 0xe64980, 0x15aabf, 0xfab005, 0x7950f2, 0x40c057, 0xf76707, 0x228be6];

/**
 * Shoppers by basket kind — the instanced pool's only expressive channel, so
 * the four kinds are far apart in hue and all of them sit clear of the staff
 * role colours and of the fixture families behind them.
 */
export const SHOPPER_COLORS = [0x495057, 0x7048e8, 0x0b7285, 0xa61e4d, 0x5c940d, 0x862e9c];

export const STATE_COLORS = {
  late: 0xe03131,
  overtime: 0xf5c518,
  /** A facing with a restock pending. */
  hot: 0xff922b,
  outage: 0x868e96,
  absent: 0xadb5bd,
  break: 0x4dabf7,
  indirect: 0x91a7ff,
  /** Waiting in a line, at the glass or at the till. */
  queue: 0x9aa5b1,
  /** Being served or rung up. */
  serving: 0x20c997,
  /** Walked out of the line. */
  abandoned: 0xe8590c,
  selection: 0xffd43b,
  lampOff: 0x343a40,
} as const;

export function roleColor(idx: number): number {
  return ROLE_COLORS[((idx % ROLE_COLORS.length) + ROLE_COLORS.length) % ROLE_COLORS.length];
}

export function categoryColor(idx: number): number {
  return CATEGORY_COLORS[((idx % CATEGORY_COLORS.length) + CATEGORY_COLORS.length) % CATEGORY_COLORS.length];
}

export function shopperColor(idx: number): number {
  return SHOPPER_COLORS[((idx % SHOPPER_COLORS.length) + SHOPPER_COLORS.length) % SHOPPER_COLORS.length];
}

const RED = new Color(0xe03131);
const AMBER = new Color(0xf59f00);
const GREEN = new Color(0x2f9e44);

/**
 * The facing fill ramp: green when the shelf is stocked, amber once it is down
 * to a case or less (a clerk will short it soon), red when it is empty. The
 * three stops move monotonically from red through amber to green in
 * green-minus-red, which is what palette.test.ts pins — the ramp must never
 * double back, or a half-empty shelf would read better than a full one.
 * Written into `target`.
 */
export function fillColor(target: Color, units: number, cap: number, unitsPerCase: number): Color {
  if (units <= 0) return target.copy(RED);
  const oneCase = Math.max(1, unitsPerCase);
  if (units <= oneCase) return target.copy(AMBER);
  const f = Math.min(1, (units - oneCase) / Math.max(1, cap - oneCase));
  return target.lerpColors(AMBER, GREEN, f);
}

const HEAT_STOPS = [
  [237, 244, 250],
  [158, 202, 225],
  [66, 146, 198],
  [8, 81, 156],
  [8, 48, 107],
];

/** A five-stop blue ramp for sales-rate shading, t in [0, 1]. Written into `target`. */
export function heatColor(target: Color, t: number): Color {
  const x = Math.max(0, Math.min(1, t)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = HEAT_STOPS[i];
  const b = HEAT_STOPS[i + 1];
  return target.setRGB((a[0] + (b[0] - a[0]) * f) / 255, (a[1] + (b[1] - a[1]) * f) / 255, (a[2] + (b[2] - a[2]) * f) / 255);
}

/** Darken a hex colour by a factor in (0, 1], for "off" lamps, idle pads and night asphalt. */
export function darken(hex: number, factor: number): number {
  const r = Math.round(((hex >> 16) & 255) * factor);
  const g = Math.round(((hex >> 8) & 255) * factor);
  const b = Math.round((hex & 255) * factor);
  return (r << 16) | (g << 8) | b;
}
