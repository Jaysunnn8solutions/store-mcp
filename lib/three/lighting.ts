/**
 * Lights, the sky model and the shop's own lighting clock.
 *
 * The building is modelled roofless, because the camera looks into it, so its
 * interior is lit by three things: an "interior" hemisphere light standing in
 * for the ceiling fittings, a sky hemisphere light, and one directional sun
 * with a shadow map fitted to the building plus its lot.
 *
 * A shop lights in zones, and that is the point of the schedule here. The
 * stockroom comes on when the first person clocks in, hours before the doors
 * open, because the overnight trailer is being put away and the delivery and
 * pickup orders are being picked and packed; the sales floor comes on about an
 * hour before opening, while the shelves are being filled; the showcase and
 * its pendants come on at opening and go off at close. That is what makes the
 * 06:00–10:00 block read correctly on screen — the front of the shop dark and
 * the back of it working — instead of a building that is simply "on".
 *
 * While the fittings are on, the interior level is solved each frame so the
 * light landing on the floor stays near FLOOR_LIGHT_TARGET whatever the sun is
 * doing, which is what keeps a 06:30 start as readable as noon.
 *
 * `lightLevels`, `skyAt`, `scheduleFromPlayback` and `lightZones` are pure and
 * tested under Node; only `createLighting` touches three.
 */

import { Color, DirectionalLight, Group, HemisphereLight, Vector3 } from "three";
import { ActorState, type Playback } from "../trace/types";
import { SURFACES, THEMES, type ThemeName } from "./palette";

const SUNRISE = 6 * 60;
const SUNSET = 20 * 60;
const NOON = 12 * 60;
const DAY_SKY_LIGHT = new Color(0xcfe3ff);
const NIGHT_SKY_LIGHT = new Color(0x2b3550);
const SUN_NOON = new Color(0xfff6e8);
const SUN_LOW = new Color(0xffb070);
/** Shop fittings are warmer than a warehouse's: this is a confectioner, not a dock. */
const LAMP_WARM = new Color(0xfff0d0);

/** The stockroom lights come on a quarter hour before the first person on the clock. */
export const BACKROOM_LEAD_MIN = 15;
/** ... and go off this long after the last one leaves. */
export const BACKROOM_TRAIL_MIN = 30;
/** The sales floor is lit an hour before the doors open, while the shelves are filled. */
export const SALES_LEAD_MIN = 60;
export const SALES_TRAIL_MIN = 30;
/** The showcase and its pendants follow trading hours almost exactly. */
export const SHOWCASE_LEAD_MIN = 10;

/** A day with nothing on record: the crew's window and the trading window a shop of this kind keeps. */
export const DEFAULT_CREW: [number, number] = [5 * 60 + 30, 21 * 60 + 30];
export const DEFAULT_TRADING: [number, number] = [10 * 60, 20 * 60];

/** Light the fittings hold on an up-facing surface (interior, plus the sky's and the sun's share). */
export const FLOOR_LIGHT_TARGET = 1.05;
/**
 * three r155+ feeds a light's bare intensity to the shader and Lambert's BRDF
 * divides by π, so intensity 1 lights an up-facing surface to only 1/π of its
 * albedo. `lightLevels` works in floor units (1 = the surface shows its full
 * colour); the three lights get the levels times this.
 */
export const LIGHT_SCALE = Math.PI;
/** The least the fittings give while on, so a noon floor is a little brighter than a 06:30 one rather than identical. */
export const LAMPS_MIN = 0.3;

/** Minute-of-day windows per simulated day; -1 where nothing is known. */
export interface LightSchedule {
  crewOn: number[];
  crewOff: number[];
  tradeOn: number[];
  tradeOff: number[];
}

function widen(list: number[], day: number, fill: number): void {
  while (list.length <= day) list.push(fill);
}

/**
 * The crew's window and the trading window per day, read from the tracks
 * alone: any worker keyframe that is not Off is the crew at work, and any
 * customer keyframe at all is the shop trading. Reading the tracks rather than
 * the event stream matters because a playback compiled with `keepEvents:
 * false` carries no events, and the lighting must not then decide the shop is
 * shut all week.
 */
export function scheduleFromPlayback(pb: Pick<Playback, "tracks" | "entities">): LightSchedule {
  const crewOn: number[] = [];
  const crewOff: number[] = [];
  const tradeOn: number[] = [];
  const tradeOff: number[] = [];
  for (const tr of pb.tracks) {
    if (!tr) continue;
    const kind = pb.entities[tr.entity]?.kind;
    const crew = kind === "worker";
    if (!crew && kind !== "customer") continue;
    for (let i = 0; i < tr.t.length; i++) {
      if (crew && tr.s[i] === ActorState.Off) continue;
      const day = Math.floor(tr.t[i] / 1440);
      if (day < 0) continue;
      const m = tr.t[i] - day * 1440;
      const on = crew ? crewOn : tradeOn;
      const off = crew ? crewOff : tradeOff;
      widen(on, day, -1);
      widen(off, day, -1);
      on[day] = on[day] < 0 ? m : Math.min(on[day], m);
      off[day] = off[day] < 0 ? m : Math.max(off[day], m);
    }
  }
  return { crewOn, crewOff, tradeOn, tradeOff };
}

/** Which of the shop's three lighting zones are on at simulated minute t. */
export interface LightZones {
  sales: boolean;
  backroom: boolean;
  showcase: boolean;
}

export const ALL_ZONES_ON: LightZones = { sales: true, backroom: true, showcase: true };

function windowOf(on: number[] | undefined, off: number[] | undefined, day: number, fallback: [number, number]): [number, number] {
  const a = on?.[day] ?? -1;
  const b = off?.[day] ?? -1;
  return a >= 0 && b >= 0 ? [a, b] : fallback;
}

export function lightZones(t: number, schedule: LightSchedule | null): LightZones {
  const day = Math.floor(t / 1440);
  const m = t - day * 1440;
  const [crewIn, crewOut] = windowOf(schedule?.crewOn, schedule?.crewOff, day, DEFAULT_CREW);
  const [open, close] = windowOf(schedule?.tradeOn, schedule?.tradeOff, day, DEFAULT_TRADING);
  return {
    backroom: m >= crewIn - BACKROOM_LEAD_MIN && m < crewOut + BACKROOM_TRAIL_MIN,
    sales: m >= open - SALES_LEAD_MIN && m < close + SALES_TRAIL_MIN,
    showcase: m >= open - SHOWCASE_LEAD_MIN && m < close,
  };
}

export interface LightLevels {
  /** Sun elevation 0..1 (sine of its arc), 0 at night. */
  elev: number;
  /** Exterior light level 0..1: 0 at night, 1 from mid-morning to mid-afternoon. */
  daylight: number;
  /** Warm horizon glow 0..1 around sunrise and sunset. */
  dusk: number;
  night: boolean;
  sun: number;
  sky: number;
  interior: number;
  /** Unit sun direction in three's frame (x east, y up, z south). */
  dir: [number, number, number];
}

const _dir = new Vector3();

/** Light intensities for a minute of day (null = fixed noon) and whether any interior fitting is on. */
export function lightLevels(minute: number | null, lamps: boolean): LightLevels {
  const m = minute === null ? NOON : ((minute % 1440) + 1440) % 1440;
  const f = (m - SUNRISE) / (SUNSET - SUNRISE);
  const up = f > 0 && f < 1;
  const elev = up ? Math.sin(Math.PI * f) : 0;
  const night = elev < 0.05;
  const daylight = Math.min(1, elev * 2.5);
  const dusk = up ? Math.max(0, 1 - elev / 0.3) : 0;
  _dir.set(Math.cos(Math.PI * f), Math.max(0.05, elev), 0.35).normalize();
  const sun = night ? 0 : 0.5 * Math.pow(elev, 0.6);
  const sky = 0.12 + 0.38 * daylight;
  // The fittings hold an up-facing surface near FLOOR_LIGHT_TARGET by filling in what the sky and sun do not supply.
  const interior = lamps ? Math.min(1, Math.max(LAMPS_MIN, FLOOR_LIGHT_TARGET - sky * 0.85 - sun * _dir.y)) : 0.16;
  return { elev, daylight, dusk, night, sun, sky, interior, dir: [_dir.x, _dir.y, _dir.z] };
}

export interface SkyColors {
  top: Color;
  horizon: Color;
}

const _c = new Color();

/** Sky dome colours for a theme at a minute of day (null = noon); writes into `target`. */
export function skyAt(theme: ThemeName, minute: number | null, target: SkyColors): SkyColors {
  const t = THEMES[theme];
  const L = lightLevels(minute, true);
  target.top.setHex(t.night.top).lerp(_c.setHex(t.sky.top), L.daylight);
  target.horizon.setHex(t.night.horizon).lerp(_c.setHex(t.sky.horizon), L.daylight);
  if (L.dusk > 0) target.horizon.lerp(_c.setHex(t.dusk), L.dusk * 0.65);
  return target;
}

export interface LightState extends LightLevels {
  zones: LightZones;
  /** The lot and the service drive are lit after dusk, whatever the shop is doing. */
  lotLamps: boolean;
}

export interface Lighting {
  group: Group;
  hemi: HemisphereLight;
  sun: DirectionalLight;
  interior: HemisphereLight;
  /** Fit the shadow frustum to a shop of w × d feet plus its lot. */
  fit(w: number, d: number, lotDepthFt: number): void;
  /** Minute of day (0..1440) to follow the clock, or null for a fixed noon. */
  setTime(minuteOfDay: number | null, zones: LightZones): LightState;
  setShadows(on: boolean): void;
  setTheme(theme: ThemeName): void;
  dispose(): void;
}

export function createLighting(theme: ThemeName): Lighting {
  const group = new Group();
  group.name = "lighting";
  let themeName = theme;
  const hemi = new HemisphereLight(DAY_SKY_LIGHT, SURFACES[themeName].bounce, 0.5);
  hemi.name = "sky";
  const interior = new HemisphereLight(LAMP_WARM, SURFACES[themeName].bounce, 0.3);
  interior.name = "interior";
  const sun = new DirectionalLight(0xffffff, 0.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  group.add(hemi, interior, sun, sun.target);
  let centre = new Vector3(40, 0, -40);
  let radius = 150;

  const setTime = (minute: number | null, zones: LightZones): LightState => {
    const lamps = zones.sales || zones.backroom || zones.showcase;
    const L = lightLevels(minute, lamps);
    sun.position.copy(centre).addScaledVector(_dir.set(L.dir[0], L.dir[1], L.dir[2]), radius * 2);
    sun.intensity = L.sun * LIGHT_SCALE;
    sun.color.lerpColors(SUN_LOW, SUN_NOON, Math.min(1, L.elev * 1.6));
    sun.visible = !L.night;
    // A dark theme's sky is dusk-like even at noon, so its sky light is dimmer.
    hemi.intensity = L.sky * LIGHT_SCALE * (themeName === "dark" ? 0.55 : 1);
    hemi.color.lerpColors(NIGHT_SKY_LIGHT, DAY_SKY_LIGHT, L.daylight);
    hemi.groundColor.setHex(SURFACES[themeName].bounce);
    interior.intensity = L.interior * LIGHT_SCALE;
    interior.color.copy(LAMP_WARM).lerp(SUN_LOW, L.dusk * 0.2);
    interior.groundColor.setHex(SURFACES[themeName].bounce);
    return { ...L, zones, lotLamps: L.daylight < 0.35 };
  };

  const fit = (w: number, d: number, lotDepthFt: number) => {
    // The lot is in front (y < 0) and the service drive behind, so the shadow
    // volume is centred on the building and grown by the deeper of the two.
    const pad = Math.max(lotDepthFt, 60);
    centre = new Vector3(w / 2, 0, -d / 2);
    radius = Math.hypot(w, d + 2 * pad) / 2 + 20;
    const cam = sun.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = radius * 4;
    cam.updateProjectionMatrix();
    sun.target.position.copy(centre);
    sun.target.updateMatrixWorld();
    setTime(null, ALL_ZONES_ON);
  };

  fit(70, 90, 75);

  return {
    group,
    hemi,
    sun,
    interior,
    fit,
    setTime,
    setShadows(on) {
      sun.castShadow = on;
    },
    setTheme(name) {
      themeName = name;
    },
    dispose() {
      sun.dispose();
      hemi.dispose();
      interior.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
