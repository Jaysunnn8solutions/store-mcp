/**
 * The pure parts of the 3D workbench: the run row's clamping rule, the round
 * trip a shareable link makes through the panel state, the speed ladder the
 * transport and the , / . keys walk, and the jump over a stretch with nobody in
 * the shop.
 *
 * Nothing here renders: there is no DOM and no WebGL under vitest, and the
 * React in components/store is a thin shell over exactly these functions. What
 * is worth testing is that a link written by the page decodes back to the same
 * run, which is the contract the MCP tools' "watch this run" links depend on.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SPEED, SPEEDS, stepSpeed } from "../../lib/store-ui/clock";
import { decodeHash, encodeHash, HASH_DEFAULTS, MAX_DAYS } from "../../lib/store-ui/hash";
import type { Interval } from "../../lib/trace/types";
import { clampInt, keepFocus, MAX_SEED, runFromText, skipAhead, textFromRun } from "./focus";
import { emptyForm, formToScenario, scenarioToForm, tabCounts } from "./ScenarioPanel";

const interval = (spans: Array<[number, number]>): Interval => ({ t0: Float64Array.from(spans, (s) => s[0]), t1: Float64Array.from(spans, (s) => s[1]) });

describe("keepFocus", () => {
  it("prevents the default so a click never parks focus on the button", () => {
    let called = 0;
    keepFocus({ preventDefault: () => (called += 1) });
    expect(called).toBe(1);
  });
});

describe("the run row", () => {
  it("clamps into the hash codec's own ranges", () => {
    const r = runFromText({ store: "store-avalon", week: "99", days: "400", seed: "0" });
    expect(r).toEqual({ store: "store-avalon", week: 52, days: MAX_DAYS, seed: 1 });
  });

  it("falls back for a blank or unreadable field rather than producing NaN", () => {
    const r = runFromText({ store: "store-midtown", week: "", days: "  ", seed: "eight" });
    expect(r).toEqual({ store: "store-midtown", week: HASH_DEFAULTS.week, days: HASH_DEFAULTS.days, seed: HASH_DEFAULTS.seed });
  });

  it("rounds rather than truncates, so 6.7 days is a week", () => {
    expect(clampInt("6.7", 1, 1, 28)).toBe(7);
    expect(clampInt("-3", 1, 1, 28)).toBe(1);
    expect(clampInt("400", 1, 1, 28)).toBe(28);
    // An infinity is not a number anybody meant to type, so it takes the fallback rather than the ceiling.
    expect(clampInt("1e999", 9, 1, 28)).toBe(9);
  });

  it("keeps a seed inside the stream's own range, so a link never carries one the codec would change", () => {
    expect(runFromText({ store: "store-midtown", week: "36", days: "7", seed: String(MAX_SEED + 1000) }).seed).toBe(MAX_SEED);
    const r = { store: "store-midtown", week: 36, days: 7, seed: MAX_SEED };
    const back = decodeHash(encodeHash(r));
    expect(back.seed).toBe(MAX_SEED);
  });

  it("round-trips through its text form", () => {
    const r = { store: "store-decatur", week: 44, days: 14, seed: 7 };
    expect(runFromText(textFromRun(r))).toEqual(r);
  });
});

describe("the link a run writes", () => {
  it("decodes back to the same run row", () => {
    const r = runFromText({ store: "store-buford", week: "44", days: "7", seed: "3" });
    const back = decodeHash(encodeHash({ store: r.store, week: r.week, days: r.days, seed: r.seed }));
    expect({ store: back.store, week: back.week, days: back.days, seed: back.seed }).toEqual(r);
  });

  it("carries the panel's scenario there and back unchanged", () => {
    const form = emptyForm();
    form.demandScale = "2.1";
    form.registers = "4";
    form.merchandising = "optimized";
    form.facingDays = "4";
    form.patience = "0.6";
    form.operatingDays = [1, 2, 3, 4, 5, 6, 7];
    form.pickStart = "05:00";
    form.demandShocks = [{ fromDay: "0", toDay: "6", factor: "1.4", category: "chocolate" }];
    form.registerOutages = [{ fromDay: "2", toDay: "2", count: "1" }];
    form.removeWorkers = [{ worker: "w-004" }];
    const parsed = formToScenario(form);
    expect(parsed.errors).toEqual({});
    expect(parsed.scenario).toBeDefined();

    const hash = encodeHash({ store: "store-avalon", week: 44, days: 7, seed: 1, t: 630, cam: "counter", scenario: parsed.scenario });
    const back = decodeHash(hash);
    expect(back.t).toBe(630);
    expect(back.cam).toBe("counter");
    expect(back.scenario).toEqual(parsed.scenario);
    // And back into the fields a reader edits, which is what a pasted link has to do.
    expect(formToScenario(scenarioToForm(back.scenario)).scenario).toEqual(parsed.scenario);
  });

  it("leaves an empty form as the baseline, not as a wall of zeroes", () => {
    const parsed = formToScenario(emptyForm());
    expect(parsed.scenario).toEqual({});
    expect(tabCounts(parsed.scenario)).toEqual({ trade: 0, people: 0, stock: 0, floor: 0, disruptions: 0 });
  });

  it("counts the fields each tab has set", () => {
    const form = emptyForm();
    form.demandScale = "1.5";
    form.patience = "0.5";
    form.registers = "3";
    const parsed = formToScenario(form);
    expect(tabCounts(parsed.scenario)).toMatchObject({ trade: 2, floor: 1, people: 0 });
  });

  it("reports the field that cannot be read, and refuses to make a scenario", () => {
    const form = emptyForm();
    form.demandScale = "lots";
    const parsed = formToScenario(form);
    expect(parsed.scenario).toBeUndefined();
    expect(parsed.errors.demandScale).toBeTruthy();
  });

  it("puts a schema complaint on the cell that caused it", () => {
    const form = emptyForm();
    // The schema allows 0.1 to 5.
    form.demandScale = "50";
    form.demandShocks = [{ fromDay: "0", toDay: "1", factor: "99", category: "" }];
    const parsed = formToScenario(form);
    expect(parsed.scenario).toBeUndefined();
    expect(parsed.errors.demandScale).toBeTruthy();
    expect(parsed.errors["demandShocks.0.factor"]).toBeTruthy();
  });
});

describe("the speed ladder", () => {
  it("steps up and down and stops at both ends", () => {
    expect(stepSpeed(1, -1)).toBe(1);
    expect(stepSpeed(1, 1)).toBe(10);
    expect(stepSpeed(1800, 1)).toBe(1800);
    expect(stepSpeed(300, -1)).toBe(60);
  });

  it("brings a speed that is not on the ladder back to the default", () => {
    expect(stepSpeed(7, 1)).toBe(DEFAULT_SPEED);
    expect(SPEEDS).toContain(DEFAULT_SPEED);
  });
});

describe("skipping the hours with nobody in the shop", () => {
  const quiet = interval([
    [0, 360],
    [1260, 1800],
  ]);

  it("lands on the end of the stretch it is standing in", () => {
    expect(skipAhead(quiet, 0, 2880)).toBe(360);
    expect(skipAhead(quiet, 200, 2880)).toBe(360);
    expect(skipAhead(quiet, 1300, 2880)).toBe(1800);
  });

  it("stays put when somebody is already in the building", () => {
    expect(skipAhead(quiet, 600, 2880)).toBe(600);
    expect(skipAhead(quiet, 1800, 2880)).toBe(1800);
  });

  it("never runs past the horizon, and never before the start", () => {
    expect(skipAhead(quiet, 5000, 2880)).toBe(2880);
    expect(skipAhead(quiet, -10, 2880)).toBe(360);
  });

  it("does nothing for a run the compiler found no quiet time in", () => {
    expect(skipAhead(null, 500, 2880)).toBe(500);
    expect(skipAhead(interval([]), 500, 2880)).toBe(500);
  });
});
