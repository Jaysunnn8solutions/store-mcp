/**
 * The small pure things the workbench and its panels share.
 *
 * `keepFocus` is the one that earns the file name: buttons that drive the
 * playback keep focus off themselves on a mouse click, so Space afterwards
 * still plays instead of re-firing the button that was pressed (Run again,
 * Swap, −1 min). Put it on a wrapper's `onMouseDown`, never on a row that
 * holds text inputs, because preventDefault on mousedown also stops an input
 * taking the caret.
 *
 * The rest is the run row's text-to-number rule and the "skip the quiet
 * stretch" jump. They live here rather than inside StoreWorkbench.tsx so a
 * unit test can reach them without React, a canvas or a worker — none of which
 * vitest has.
 *
 * Pure: no DOM beyond the one-method event `keepFocus` takes, no imports from
 * anything that touches three.js.
 */

// Relative, not the "@/" alias: this module and ScenarioPanel.tsx are the two
// the unit test imports, and vitest resolves neither tsconfig paths nor Next's
// alias.
import { nextOpen } from "../../lib/store-ui/clock";
import { HASH_DEFAULTS, MAX_DAYS } from "../../lib/store-ui/hash";
import type { Interval } from "../../lib/trace/types";

/** Seed 1 replays a tool's first run, so the field is never allowed below it; the cap is the widest a 32-bit stream accepts. */
export const MAX_SEED = 2 ** 31 - 1;

export function keepFocus(e: { preventDefault(): void }): void {
  e.preventDefault();
}

/** The run row exactly as typed: a field can be cleared and retyped without the run row snapping back under the cursor. */
export interface RunText {
  store: string;
  week: string;
  days: string;
  seed: string;
}

/** The same row as the worker wants it: whole numbers, in range. */
export interface RunNumbers {
  store: string;
  week: number;
  days: number;
  seed: number;
}

/** A whole number in [min, max] from a text field; the fallback for a blank or unreadable one. */
export function clampInt(text: string, fallback: number, min: number, max: number): number {
  const trimmed = text.trim();
  const n = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * The run the row describes. The ranges are the hash codec's own, so a link the
 * page writes always decodes back to the run it wrote — a week outside 1–52 or
 * a horizon over MAX_DAYS would come home clamped and the replay would differ.
 */
export function runFromText(t: RunText): RunNumbers {
  return {
    store: t.store,
    week: clampInt(t.week, HASH_DEFAULTS.week, 1, 52),
    days: clampInt(t.days, HASH_DEFAULTS.days, 1, MAX_DAYS),
    seed: clampInt(t.seed, HASH_DEFAULTS.seed, 1, MAX_SEED),
  };
}

export function textFromRun(r: RunNumbers): RunText {
  return { store: r.store, week: String(r.week), days: String(r.days), seed: String(r.seed) };
}

/**
 * Where "skip to the next thing that happens" lands from t: the end of the
 * quiet stretch t sits in, or t itself when somebody is already in the
 * building. Never past the horizon, so the button cannot run the clock off the
 * end of the playback.
 *
 * A shop's dead time is not the night — a trailer is being unloaded at 03:00 —
 * it is the hours with nobody in the building at all, which is exactly what the
 * compiler marks as `quiet`.
 */
export function skipAhead(quiet: Interval | null, t: number, horizonEnd: number): number {
  if (!quiet || quiet.t0.length === 0) return Math.min(horizonEnd, Math.max(0, t));
  return nextOpen({ quiet }, Math.min(horizonEnd, Math.max(0, t)), horizonEnd);
}
