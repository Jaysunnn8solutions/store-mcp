/**
 * The playback clock the 3D page's animation loop drives, and the labels that
 * turn engine minutes into a time a shopkeeper would recognise.
 *
 * The engine counts minutes from 00:00 on horizon day 0, which is the Monday of
 * the run's start week. A shop trades about 10:00–20:00, seven days, so most of
 * a 24-hour day is either the overnight receiving and pre-open pick window or
 * nothing at all. The compiler marks the stretches with nobody in the building
 * as `quiet`, and the clock jumps each of them exactly once, reporting the gap
 * so the page can say it skipped the night rather than appearing to freeze.
 *
 * Pure: minutes, a horizon and a sorted interval list. The RAF loop owns one
 * clock; the tests drive it by hand.
 */

import type { Interval, Playback } from "../trace/types";
import { calendarWeekOfDay } from "../twin/season";
import { clock as hhmmOf, WEEKDAYS } from "../twin/standards";

export interface ClockTick {
  t: number;
  /** The quiet interval this tick jumped over, when it did. */
  skipped?: [t0: number, t1: number];
}

/**
 * Simulated minutes per real minute when a run first plays. A trading day is
 * 600 minutes, so 300× shows the doors opening, the afternoon peak and the
 * close in two real minutes — fast enough to see the day's shape, slow enough
 * to watch a queue build. 60× (one simulated minute per second) made the same
 * day take ten real minutes and is still on the speed row.
 */
export const DEFAULT_SPEED = 300;

/** The speed row, slowest first. 1× is minute-for-minute, for watching one register. */
export const SPEEDS: readonly number[] = [1, 10, 60, 300, 1800];

export class PlaybackClock {
  t = 0;
  /** Simulated minutes per real minute. */
  speed = DEFAULT_SPEED;
  playing = false;
  /** Jump the stretches the compiler marked as having nobody in the building. */
  skipQuiet = true;

  constructor(public horizonEnd: number) {}

  /** Clamp into [0, horizonEnd]; anything that is not a number goes to 0. */
  seek(t: number): number {
    this.t = Math.min(this.horizonEnd, Math.max(0, Number.isFinite(t) ? t : 0));
    return this.t;
  }

  /** Move by a signed number of simulated minutes, clamped. */
  step(dMin: number): number {
    return this.seek(this.t + dMin);
  }

  /**
   * Advance by a real-time slice. The jump rule: when the advanced time lands
   * inside a quiet interval [t0, t1) the clock goes to t1 and reports it, so the
   * next tick starts past the gap and cannot report the same gap twice. Seeking
   * back into a gap and playing on skips it again, which is what a viewer who
   * scrubbed there expects. Reaching the horizon stops playback.
   */
  tick(dtSec: number, quiet: Interval | null): ClockTick {
    if (!this.playing) return { t: this.t };
    const dtMin = (Math.max(0, dtSec) * this.speed) / 60;
    let next = this.t + dtMin;
    let skipped: [number, number] | undefined;
    if (this.skipQuiet && quiet) {
      const gap = quietGapAt(quiet, next);
      if (gap) {
        next = gap[1];
        skipped = gap;
      }
    }
    if (next >= this.horizonEnd) {
      next = this.horizonEnd;
      this.playing = false;
    }
    this.t = next;
    return skipped ? { t: next, skipped } : { t: next };
  }
}

/** The quiet interval containing t (t0 ≤ t < t1), or null. Intervals are sorted and disjoint. */
export function quietGapAt(quiet: Interval, t: number): [number, number] | null {
  const n = Math.min(quiet.t0.length, quiet.t1.length);
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (quiet.t0[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  if (i < 0) return null;
  const t0 = quiet.t0[i];
  const t1 = quiet.t1[i];
  return t >= t0 && t < t1 ? [t0, t1] : null;
}

/**
 * Is there nobody in the building at t? Takes the playback structurally rather
 * than a whole `Playback` so a test can pass a hand-built interval list.
 */
export function isQuiet(pb: Pick<Playback, "quiet">, t: number): boolean {
  return quietGapAt(pb.quiet, t) !== null;
}

/**
 * The next minute something happens: the end of the quiet stretch t sits in, or
 * t itself when the shop is already awake. The page uses it for the "skip to
 * the morning" button, so it never runs past the horizon.
 */
export function nextOpen(pb: Pick<Playback, "quiet">, t: number, horizonEnd: number): number {
  const gap = quietGapAt(pb.quiet, t);
  return gap ? Math.min(horizonEnd, gap[1]) : t;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Horizon day of t; day 0 is the Monday of the start week. */
export function dayOf(t: number): number {
  return Math.floor(t / 1440);
}

/** "07:15". Wraps past midnight, so an overnight receiving job reads correctly. */
export function clockLabel(t: number): string {
  return hhmmOf(t);
}

/** Day 0 is a Monday, so the weekday is the day index mod 7. */
export function weekdayLabel(t: number): string {
  return WEEKDAYS[((dayOf(t) % 7) + 7) % 7];
}

/** "Day 3 · Wed, week 38" — the run's own day, then the calendar week the season model uses. */
export function dayLabel(t: number, startWeek: number): string {
  return `Day ${dayOf(t) + 1} · ${weekdayLabel(t)}, week ${calendarWeekOfDay(startWeek, dayOf(t))}`;
}

/** "Day 3 · Wed 07:15" — the one-line stamp the HUD and the inspector share. */
export function dayClock(t: number): string {
  return `Day ${dayOf(t) + 1} · ${weekdayLabel(t)} ${hhmmOf(t)}`;
}

export function speedLabel(speed: number): string {
  return `${speed}×`;
}

/** The next speed up or down the row, clamped at the ends. */
export function stepSpeed(speed: number, by: 1 | -1): number {
  const i = SPEEDS.indexOf(speed);
  if (i < 0) return DEFAULT_SPEED;
  return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + by))];
}
