/**
 * The 3D page's URL hash: which shop and week to run, for how many days, the
 * seed, where the playback stands, and the scenario, compressed. The page and
 * the MCP tools share this codec, so a tool's "watch this run" link and the
 * page's own history entries are the same bytes and decode the same way.
 *
 * Format, keys in this order, absent ones omitted, no leading "#":
 *   store=store-midtown&week=36&days=7&seed=1&t=630&cam=counter&src=session
 *   &shot=1&chrome=1&perf=1&s=<base64url(deflate(JSON.stringify(scenario)))>
 *
 * Only the scenario is compressed. Keeping `store`, `week`, `days`, `seed`,
 * `t`, `cam` and `src` as plain text is the whole point: a link is readable and
 * editable by hand, and a reader can tell what run it opens without a decoder.
 *
 * A `layout` never travels in the URL: an imported drawing is up to a megabyte
 * and is handed to the page in-browser instead, so the encoder refuses one and
 * the decoder drops one and keeps the rest.
 *
 * Decoding never throws. Anything unreadable — bad base64, non-deflate bytes,
 * JSON that is not an object, a scenario the schema rejects — falls back to the
 * defaults, numbers are clamped rather than rejected, and unknown query keys
 * are ignored so older links keep working when the page learns new ones. Only
 * `encodeHash` throws, and only `HashError`, so a caller that cannot make a
 * link can say "open the page and enter it" instead of failing the run.
 *
 * Pure: fflate and the scenario schema, no DOM, no node: modules.
 */

import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { scenarioSchema } from "../twin/twin";

/** Everything a link carries. `cam` and `src` stay loose strings so the renderer can add presets without a codec release. */
export interface HashState {
  /** Site id, e.g. "store-midtown". */
  store: string;
  /** Calendar week the horizon starts on its Monday, 1–52. */
  week: number;
  /** Days to run, 1–MAX_DAYS. */
  days: number;
  /** Integer ≥ 1. replicate() runs seeds 1..runs, so seed 1 is a tool's first run. */
  seed: number;
  /** Playback position, engine minutes from 00:00 on horizon day 0. */
  t?: number;
  /** Camera preset name. */
  cam?: string;
  /** Where a non-built-in building came from ("session", "sample"). */
  src?: string;
  /** Screenshot mode: a fixed frame with the page chrome hidden. */
  shot?: boolean;
  /** With `shot`: keep the chrome, so a capture shows the panels too. */
  chrome?: boolean;
  /** Performance overlay. */
  perf?: boolean;
  /** A scenario as the schema parses it; `{}` and undefined both mean "baseline". */
  scenario?: Record<string, unknown>;
}

/** Filled in for whatever a link leaves out or gets wrong. Midtown in an ordinary week, one week of playback, the tools' first seed. */
export const HASH_DEFAULTS: Readonly<Pick<HashState, "store" | "week" | "days" | "seed">> = { store: "store-midtown", week: 36, days: 7, seed: 1 };

/**
 * Cap on the whole encoded hash, in bytes (base64url characters are one byte
 * each in a URL). 6 KB keeps a link inside every browser's address-bar limit
 * with room to spare for the page path.
 */
export const MAX_HASH_BYTES = 6 * 1024;

/**
 * Cap on the inflated scenario JSON. A real scenario inflates to a few
 * kilobytes, but a crafted link could inflate to gigabytes, so the decoder
 * refuses oversized input before inflating and then inflates into a fixed
 * buffer with one spare byte as the overflow sentinel — fflate truncates
 * silently once the output buffer is full, so that spare byte *is* the check.
 */
export const MAX_INFLATED_BYTES = 256 * 1024;

/**
 * The horizon cap, declared once. The worker imports it rather than restating
 * it: if the two ever disagreed, a link the tools emit would be rejected by the
 * page that the link points at.
 */
export const MAX_DAYS = 28;

const MAX_WEEK = 52;
const MAX_SEED = 2 ** 31 - 1;
const MAX_STORE_CHARS = 40;
/** `cam` and `src` are opaque to this module, so they are gated on shape rather than a list. */
const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** Thrown by encodeHash for a scenario that must not go in a URL: one carrying a layout, or one too large. */
export class HashError extends Error {}

/**
 * The link for a run. Throws HashError when the scenario carries an imported
 * layout or when the result is over MAX_HASH_BYTES.
 *
 * Determinism: the same state always produces the same string, which is what
 * lets a tool's link and the page's history entry be compared. That rests on
 * JSON.stringify over a schema-parsed scenario (key order comes from the
 * schema's shape), fflate at level 9, and the hand-rolled base64url below —
 * never Buffer.toString("base64url") on Node or btoa in the browser, because
 * both runtimes must emit identical bytes.
 */
export function encodeHash(state: HashState): string {
  const p = new URLSearchParams();
  p.set("store", storeId(state.store));
  p.set("week", String(clampInt(state.week, HASH_DEFAULTS.week, 1, MAX_WEEK)));
  const days = clampInt(state.days, HASH_DEFAULTS.days, 1, MAX_DAYS);
  p.set("days", String(days));
  p.set("seed", String(clampInt(state.seed, HASH_DEFAULTS.seed, 1, MAX_SEED)));
  if (state.t !== undefined && Number.isFinite(state.t)) p.set("t", String(clampInt(state.t, 0, 0, days * 1440)));
  if (state.cam !== undefined && NAME_RE.test(state.cam)) p.set("cam", state.cam);
  if (state.src !== undefined && NAME_RE.test(state.src)) p.set("src", state.src);
  if (state.shot) p.set("shot", "1");
  if (state.chrome) p.set("chrome", "1");
  if (state.perf) p.set("perf", "1");
  const s = encodeScenario(state.scenario);
  if (s !== null) p.set("s", s);
  const hash = p.toString();
  if (hash.length > MAX_HASH_BYTES) {
    throw new HashError(`The link comes to ${hash.length} bytes, over the ${MAX_HASH_BYTES}-byte limit. Drop some scenario fields, or run it on the page instead of linking to it.`);
  }
  return hash;
}

/** Whatever a link says, made safe: every required field filled, every number clamped, the scenario always an object. */
export function decodeHash(hash: string): HashState {
  const p = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const raw = p.get("store")?.trim() ?? "";
  const days = int(p.get("days"), HASH_DEFAULTS.days, 1, MAX_DAYS);
  const out: HashState = {
    store: raw.length > 0 && raw.length <= MAX_STORE_CHARS ? raw : HASH_DEFAULTS.store,
    week: int(p.get("week"), HASH_DEFAULTS.week, 1, MAX_WEEK),
    days,
    seed: int(p.get("seed"), HASH_DEFAULTS.seed, 1, MAX_SEED),
    scenario: decodeScenario(p.get("s")),
  };
  const t = p.get("t");
  if (t !== null && t.trim() !== "" && Number.isFinite(Number(t))) out.t = Math.min(days * 1440, Math.max(0, Number(t)));
  const cam = p.get("cam");
  if (cam !== null && NAME_RE.test(cam)) out.cam = cam;
  const src = p.get("src");
  if (src !== null && NAME_RE.test(src)) out.src = src;
  if (flag(p.get("shot"))) out.shot = true;
  if (flag(p.get("chrome"))) out.chrome = true;
  if (flag(p.get("perf"))) out.perf = true;
  return out;
}

/**
 * The base64url form of a scenario, or null when there is nothing to carry.
 * Exposed so a page can show a link's size before writing it to history.
 */
export function encodeScenario(scenario: Record<string, unknown> | undefined): string | null {
  if (!scenario) return null;
  if (scenario.layout !== undefined) {
    throw new HashError("An imported layout never travels in the URL: it is up to a megabyte. Hand it to the page in the browser and link to the rest of the scenario.");
  }
  const json = JSON.stringify(scenario);
  if (json === "{}") return null;
  return toBase64Url(deflateSync(strToU8(json), { level: 9 }));
}

/** The scenario a link carries, or `{}`. Never throws: a link this cannot read opens the baseline run rather than an error page. */
export function decodeScenario(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  // Refuse before decoding: a 260 KB link of well-chosen deflate inflates to
  // hundreds of megabytes, and the work of finding that out is the attack.
  if (raw.length > MAX_HASH_BYTES) return {};
  let parsed: unknown;
  try {
    const out = inflateSync(fromBase64Url(raw), { out: new Uint8Array(MAX_INFLATED_BYTES + 1) });
    if (out.length > MAX_INFLATED_BYTES) return {};
    parsed = JSON.parse(strFromU8(out));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  // A layout in the URL is dropped rather than refused: the rest of the link is
  // still a run worth opening, and the page can say where the building went.
  const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete rest.layout;
  const res = scenarioSchema.safeParse(rest);
  return res.success ? (res.data as Record<string, unknown>) : {};
}

/** An integer in [min, max]: clamped when out of range, the fallback when it is not a number at all. */
function int(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampInt(v: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function storeId(v: string): string {
  const s = (v ?? "").trim();
  return s.length > 0 && s.length <= MAX_STORE_CHARS ? s : HASH_DEFAULTS.store;
}

function flag(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

// ---------------------------------------------------------------------------
// base64url, hand-rolled so Node and the browser produce identical strings
// without going through binary strings (btoa) or Buffer. Unpadded: "=" would
// have to be percent-encoded in a query string.
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function toBase64Url(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(B64[n >> 18], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]);
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    parts.push(B64[n >> 18], B64[(n >> 12) & 63]);
    if (i + 1 < bytes.length) parts.push(B64[(n >> 6) & 63]);
  }
  return parts.join("");
}

function fromBase64Url(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (const ch of s) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) throw new HashError("Not base64url.");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}
