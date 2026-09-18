/**
 * Pins the playback clock, which is the only stateful thing in lib/store-ui.
 *
 * The invariants that matter: time never leaves [0, horizonEnd]; a quiet
 * stretch is jumped exactly once per pass, so the "skipped the night" toast
 * cannot fire twice for the same night; the jump lands exactly on the end of
 * the gap, so the next tick starts past it; and scrubbing back into a gap and
 * playing on skips it again, which is what somebody who dragged the scrubber
 * there expects.
 */

import { describe, expect, it } from "vitest";
import type { Interval } from "../trace/types";
import { clockLabel, dayClock, dayLabel, dayOf, DEFAULT_SPEED, isQuiet, nextOpen, PlaybackClock, quietGapAt, speedLabel, SPEEDS, stepSpeed, weekdayLabel } from "./clock";

/** Two nights on a two-day horizon: closed at 20:00, nobody in until 05:00. */
const quiet: Interval = {
  t0: Float64Array.from([1260, 2700]),
  t1: Float64Array.from([1740, 4140]),
};

describe("quietGapAt", () => {
  it("treats a gap as half-open, so landing on its end is outside it", () => {
    expect(quietGapAt(quiet, 1260)).toEqual([1260, 1740]);
    expect(quietGapAt(quiet, 1500)).toEqual([1260, 1740]);
    expect(quietGapAt(quiet, 1740)).toBeNull();
    expect(quietGapAt(quiet, 1259)).toBeNull();
    expect(quietGapAt(quiet, 3000)).toEqual([2700, 4140]);
  });

  it("copes with an empty interval list", () => {
    expect(quietGapAt({ t0: new Float64Array(0), t1: new Float64Array(0) }, 500)).toBeNull();
    expect(isQuiet({ quiet: { t0: new Float64Array(0), t1: new Float64Array(0) } }, 500)).toBe(false);
  });

  it("answers isQuiet and nextOpen from the same intervals", () => {
    expect(isQuiet({ quiet }, 1500)).toBe(true);
    expect(isQuiet({ quiet }, 900)).toBe(false);
    expect(nextOpen({ quiet }, 1500, 2880)).toBe(1740);
    expect(nextOpen({ quiet }, 900, 2880)).toBe(900);
    // Never past the end of the run, even when the last gap runs off it.
    expect(nextOpen({ quiet }, 3000, 2880)).toBe(2880);
  });
});

describe("PlaybackClock", () => {
  it("clamps every seek and step into the horizon", () => {
    const c = new PlaybackClock(2880);
    expect(c.seek(-100)).toBe(0);
    expect(c.seek(9999)).toBe(2880);
    expect(c.seek(Number.NaN)).toBe(0);
    c.seek(600);
    expect(c.step(-1000)).toBe(0);
    expect(c.step(5000)).toBe(2880);
  });

  it("stands still while paused", () => {
    const c = new PlaybackClock(2880);
    c.seek(600);
    expect(c.tick(10, quiet)).toEqual({ t: 600 });
  });

  it("advances at speed simulated minutes per real minute", () => {
    const c = new PlaybackClock(10_000);
    c.playing = true;
    c.speed = 60;
    // One real second at 60× is one simulated minute.
    expect(c.tick(1, null).t).toBeCloseTo(1, 9);
    expect(c.tick(30, null).t).toBeCloseTo(31, 9);
    // A negative frame time (a clock that jumped backwards) moves nothing.
    expect(c.tick(-5, null).t).toBeCloseTo(31, 9);
  });

  it("jumps a quiet stretch once, landing exactly on its end", () => {
    const c = new PlaybackClock(4320);
    c.playing = true;
    c.speed = 600;
    c.seek(1200);
    const first = c.tick(10, quiet); // 1200 + 100 lands inside [1260, 1740)
    expect(first.skipped).toEqual([1260, 1740]);
    expect(first.t).toBe(1740);
    const second = c.tick(10, quiet);
    expect(second.skipped).toBeUndefined();
    expect(second.t).toBeCloseTo(1840, 9);
  });

  it("skips the same stretch again after scrubbing back into it", () => {
    const c = new PlaybackClock(4320);
    c.playing = true;
    c.speed = 600;
    c.seek(1200);
    expect(c.tick(10, quiet).skipped).toEqual([1260, 1740]);
    c.seek(1300);
    expect(c.tick(1, quiet).skipped).toEqual([1260, 1740]);
  });

  it("does not jump with skipQuiet off", () => {
    const c = new PlaybackClock(4320);
    c.playing = true;
    c.speed = 600;
    c.skipQuiet = false;
    c.seek(1200);
    const tick = c.tick(10, quiet);
    expect(tick.skipped).toBeUndefined();
    expect(tick.t).toBeCloseTo(1300, 9);
  });

  it("stops playing when it reaches the horizon", () => {
    const c = new PlaybackClock(1440);
    c.playing = true;
    c.speed = 1800;
    c.seek(1400);
    expect(c.tick(10, null).t).toBe(1440);
    expect(c.playing).toBe(false);
  });
});

describe("labels", () => {
  it("reads engine minutes as a day and a time of day", () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(1439)).toBe(0);
    expect(dayOf(1440)).toBe(1);
    expect(clockLabel(600)).toBe("10:00");
    expect(clockLabel(1440 * 2 + 1215)).toBe("20:15");
    // Day 0 is a Monday, so the run's third day is a Wednesday.
    expect(weekdayLabel(2 * 1440)).toBe("Wed");
    expect(dayClock(2 * 1440 + 435)).toBe("Day 3 · Wed 07:15");
  });

  it("names the calendar week the season model uses", () => {
    expect(dayLabel(0, 44)).toBe("Day 1 · Mon, week 44");
    expect(dayLabel(7 * 1440, 44)).toBe("Day 8 · Mon, week 45");
    // Week 52 wraps to week 1 rather than running off the end of the year.
    expect(dayLabel(7 * 1440, 52)).toBe("Day 8 · Mon, week 1");
  });

  it("steps along the speed row and stops at both ends", () => {
    expect(SPEEDS).toContain(DEFAULT_SPEED);
    expect(speedLabel(300)).toBe("300×");
    expect(stepSpeed(SPEEDS[0], -1)).toBe(SPEEDS[0]);
    expect(stepSpeed(SPEEDS[SPEEDS.length - 1], 1)).toBe(SPEEDS[SPEEDS.length - 1]);
    expect(stepSpeed(60, 1)).toBe(300);
    expect(stepSpeed(60, -1)).toBe(10);
    expect(stepSpeed(7, 1)).toBe(DEFAULT_SPEED);
  });
});
