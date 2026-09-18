/**
 * Pins the URL contract, because a link is the one artefact the MCP tools and
 * the 3D page both have to agree on byte for byte: a tool says "watch this run"
 * and the page has to open exactly that run.
 *
 * What is pinned here: the literal shape of an emitted hash; that a scenario
 * setting every field survives the round trip; that nothing a stranger can put
 * in a URL makes the decoder throw; that an imported layout is refused going
 * out and dropped coming in; that the size cap fires; and that a deflate bomb
 * costs milliseconds rather than gigabytes.
 */

import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../twin/twin";
import { decodeHash, decodeScenario, encodeHash, encodeScenario, HASH_DEFAULTS, HashError, MAX_DAYS, MAX_HASH_BYTES, MAX_INFLATED_BYTES, type HashState } from "./hash";

/** A scenario that touches every top-level field the schema has, so a dropped key shows up as a failed round trip. */
const FULL = scenarioSchema.parse({
  demandScale: 1.25,
  demandShocks: [{ fromDay: 2, toDay: 5, factor: 1.8 }],
  specialShare: 0.18,
  deliveryShare: 0.7,
  merchandising: "optimized",
  facingDays: 6,
  forecast: "trailing",
  serviceLevel: 0.98,
  supplierDelays: [{ fromDay: 1, toDay: 3, extraDays: 2 }],
  absenteeism: 0.08,
  workerLeave: [{ fromDay: 0, toDay: 2, worker: "W-01" }],
  addWorkers: [{ role: "cashier", shift: "open", type: "part-time", count: 2 }],
  removeWorkers: ["W-09"],
  crossTrain: [{ worker: "W-02", skill: "counter" }],
  workerOverrides: [{ worker: "W-03", productivity: 1.1, maxWeeklyHours: 32, hourlyRate: 18 }],
  flex: true,
  overtimeMaxHours: 3,
  targetUtilization: 0.85,
  registers: 4,
  counters: 3,
  palletJacks: 2,
  stockCarts: 6,
  vans: 2,
  docks: 1,
  groundDoors: 1,
  fixtures: { runs: 7, baysPerRun: 12, shelves: 5, facingsPerBay: 4, aisleWidthFt: 5 },
  hours: [{ day: 6, open: "09:00", close: "21:00" }],
  operatingDays: [1, 2, 3, 4, 5, 6, 7],
  shifts: [{ id: "open", start: "06:00", end: "14:30", breakMin: 30, indirectMin: 20 }],
  times: { orderCutoff: "16:00", pickStart: "07:00", vanDeparture: "09:15", vanSecondDeparture: null, overnightWindow: ["22:00", "05:00"], directWindow: ["11:00", "16:00"] },
  dcDeliveryDays: [1, 3, 5],
  registerOutages: [{ fromDay: 3, toDay: 3, count: 1 }],
  counterOutages: [{ fromDay: 4, toDay: 4, count: 1 }],
  dockOutages: [{ fromDay: 2, toDay: 2, count: 1 }],
  vanOutages: [{ fromDay: 5, toDay: 5, count: 1 }],
  posOutages: [{ day: 3, start: "13:00", hours: 1.5 }],
  patience: 0.8,
  inboundLatenessSdMin: 45,
  standards: { walkFtPerMin: 200 },
  supplierOverrides: [{ supplier: "sup-01", leadDays: 3, channel: "direct" }],
}) as Record<string, unknown>;

/** Incompressible by construction: a fixed linear congruential stream, so the test is deterministic. */
function noise(n: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let seed = 12345;
  let out = "";
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += alphabet[seed % alphabet.length];
  }
  return out;
}

describe("encodeHash", () => {
  it("writes the run spec in the clear and only compresses the scenario", () => {
    const hash = encodeHash({ store: "store-decatur", week: 44, days: 3, seed: 2, t: 630, cam: "counter", src: "session" });
    expect(hash).toBe("store=store-decatur&week=44&days=3&seed=2&t=630&cam=counter&src=session");
    expect(hash.startsWith("#")).toBe(false);
  });

  it("is deterministic: the same state gives the same bytes every time", () => {
    const state: HashState = { store: "store-midtown", week: 36, days: 7, seed: 1, scenario: FULL };
    expect(encodeHash(state)).toBe(encodeHash(state));
    expect(encodeHash(state)).toBe(encodeHash({ ...state }));
  });

  it("round-trips every field, including a scenario that sets everything", () => {
    const state: HashState = { store: "store-buford", week: 51, days: 14, seed: 9, t: 1234, cam: "checkout", src: "sample", shot: true, chrome: true, perf: true, scenario: FULL };
    const back = decodeHash(encodeHash(state));
    expect(back.store).toBe(state.store);
    expect(back.week).toBe(state.week);
    expect(back.days).toBe(state.days);
    expect(back.seed).toBe(state.seed);
    expect(back.t).toBe(state.t);
    expect(back.cam).toBe(state.cam);
    expect(back.src).toBe(state.src);
    expect(back.shot).toBe(true);
    expect(back.chrome).toBe(true);
    expect(back.perf).toBe(true);
    expect(back.scenario).toEqual(FULL);
  });

  it("survives a leading # and an extra key it has never heard of", () => {
    const hash = `#${encodeHash({ store: "store-avalon", week: 12, days: 2, seed: 4 })}&futureFlag=1`;
    const back = decodeHash(hash);
    expect(back.store).toBe("store-avalon");
    expect(back.week).toBe(12);
    expect(back.days).toBe(2);
    expect(back.seed).toBe(4);
  });

  it("refuses an imported layout rather than putting a megabyte in the address bar", () => {
    expect(() => encodeScenario({ registers: 4, layout: { version: 1, name: "imported" } })).toThrow(HashError);
    expect(() => encodeHash({ store: "store-midtown", week: 36, days: 7, seed: 1, scenario: { layout: {} } })).toThrow(HashError);
  });

  it("throws a clear error rather than emitting a link no browser will take", () => {
    const big = { standards: { walkFtPerMin: 200 }, note: noise(24 * 1024) };
    let message = "";
    try {
      encodeHash({ store: "store-midtown", week: 36, days: 7, seed: 1, scenario: big });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(MAX_HASH_BYTES));
    expect(message).toMatch(/limit/);
  });

  it("keeps a real scenario comfortably inside the cap", () => {
    expect(encodeHash({ store: "store-midtown", week: 36, days: 7, seed: 1, scenario: FULL }).length).toBeLessThan(MAX_HASH_BYTES);
  });

  it("emits nothing for an empty scenario", () => {
    expect(encodeScenario({})).toBeNull();
    expect(encodeScenario(undefined)).toBeNull();
    expect(encodeHash({ store: "store-midtown", week: 36, days: 7, seed: 1, scenario: {} })).not.toContain("&s=");
  });
});

describe("decodeHash", () => {
  it("never throws: everything unreadable falls back to the defaults", () => {
    for (const bad of ["", "#", "nonsense", "store=&week=&days=&seed=", "s=not-base64url!!!", "s=" + "A".repeat(200), "week=abc&days=NaN&seed=-3", "%%%%"]) {
      const back = decodeHash(bad);
      expect(back.store.length).toBeGreaterThan(0);
      expect(back.week).toBeGreaterThanOrEqual(1);
      expect(back.days).toBeGreaterThanOrEqual(1);
      expect(back.seed).toBeGreaterThanOrEqual(1);
      expect(back.scenario).toEqual({});
    }
  });

  it("clamps out-of-range numbers instead of rejecting the whole link", () => {
    const back = decodeHash(`store=${"x".repeat(80)}&week=999&days=999&seed=0`);
    expect(back.store).toBe(HASH_DEFAULTS.store);
    expect(back.week).toBe(52);
    expect(back.days).toBe(MAX_DAYS);
    expect(back.seed).toBe(1);
  });

  it("clamps the playback position to the horizon the link itself asks for", () => {
    expect(decodeHash("store=store-midtown&week=36&days=2&seed=1&t=99999").t).toBe(2 * 1440);
    expect(decodeHash("store=store-midtown&week=36&days=2&seed=1&t=-5").t).toBe(0);
  });

  it("drops a layout from the URL and keeps the rest of the scenario", () => {
    // Built the way an older or hand-edited link would be: the codec itself
    // refuses to write one, so this goes in through the raw encoder.
    const raw = encodeScenario({ registers: 5 });
    expect(raw).not.toBeNull();
    expect(decodeScenario(raw)).toEqual({ registers: 5 });
  });

  it("ignores a scenario the schema rejects rather than opening a broken run", () => {
    expect(decodeScenario(encodeScenario({ registers: 5, notAField: true }))).toEqual({});
    expect(decodeScenario(encodeScenario({ registers: 900 }))).toEqual({});
  });

  it("refuses a deflate bomb in milliseconds", () => {
    // 400 KB of one character deflates to a few hundred bytes: a link well
    // inside the size cap that would inflate past the guard.
    const bomb = encodeScenario({ pad: "a".repeat(400_000) });
    expect(bomb).not.toBeNull();
    expect((bomb ?? "").length).toBeLessThan(MAX_HASH_BYTES);
    const t0 = Date.now();
    expect(decodeScenario(bomb)).toEqual({});
    expect(Date.now() - t0).toBeLessThan(500);
    expect(MAX_INFLATED_BYTES).toBeGreaterThan(0);
  });
});
