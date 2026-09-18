"use client";

import { LIMITS } from "@/lib/layout/limits";
import type { LayoutSpec } from "@/lib/layout/spec";

/**
 * Where the building on screen came from. A built-in shop is one of the five in
 * `data/sites.json` and travels in a link as its id; an imported plan is up to a
 * megabyte of drawing and never travels at all — the import page hands it over
 * in the browser through sessionStorage, and the link carries only `src=session`.
 */
export type BuildingKind = "builtin" | "session";

export interface BuildingChoice {
  kind: BuildingKind;
  /** null for a built-in shop, and for an imported one that has not been handed over. */
  spec: LayoutSpec | null;
  /** The plan's own name, for the header chip. */
  name: string;
  error: string | null;
}

/** The hand-over slot. The import page writes a LayoutSpec here and sends the reader to /store#…&src=session. */
export const SESSION_KEY = "store.layout.v1";

export const BUILTIN: BuildingChoice = { kind: "builtin", spec: null, name: "", error: null };

/**
 * The imported plan waiting in this tab, if there is one. Never throws: a
 * browser with storage blocked throws on the *access*, not on a missing key, and
 * a half-written value is somebody else's bug, not a reason to fail the page.
 */
export function readSessionSpec(): BuildingChoice {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return { kind: "session", spec: null, name: "", error: "This browser is blocking session storage, so an imported plan cannot be handed to this page." };
  }
  if (!raw) return { kind: "session", spec: null, name: "", error: "No imported plan in this tab. Open the import page, read a drawing and press “Open in 3D”." };
  if (raw.length > LIMITS.specJson) return { kind: "session", spec: null, name: "", error: "The stored plan is over the 1 MB spec limit." };
  try {
    const spec = JSON.parse(raw) as LayoutSpec;
    if (!spec || typeof spec !== "object" || typeof spec.widthFt !== "number") throw new Error("not a layout spec");
    return { kind: "session", spec, name: spec.name || "imported plan", error: null };
  } catch {
    return { kind: "session", spec: null, name: "", error: "The stored plan could not be read; import the drawing again." };
  }
}

/** Forget the imported plan. Silent when storage is blocked: there was nothing to forget. */
export function clearSessionSpec(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Blocked storage held nothing in the first place.
  }
}

/** A plan the simulation will refuse, said before the run rather than after it. */
export function specOverLimit(spec: LayoutSpec): string | null {
  if (spec.fixtures.length > LIMITS.maxFixtureRuns) return `${spec.fixtures.length} fixture runs is over the ${LIMITS.maxFixtureRuns} limit.`;
  if (spec.doors.length > LIMITS.maxDoors) return `${spec.doors.length} doors is over the ${LIMITS.maxDoors} limit.`;
  if (spec.service.length > LIMITS.maxServicePoints) return `${spec.service.length} service points is over the ${LIMITS.maxServicePoints} limit.`;
  if (spec.widthFt > LIMITS.maxSideFt || spec.depthFt > LIMITS.maxSideFt) return `The plan is ${Math.round(spec.widthFt)} × ${Math.round(spec.depthFt)} ft; ${LIMITS.maxSideFt} ft a side is the limit.`;
  return null;
}

interface Props {
  /** The shop the run row names, and every shop there is. */
  store: string;
  shops: Array<{ id: string; name: string }>;
  value: BuildingChoice;
  disabled: boolean;
  onStore: (id: string) => void;
  onChange: (b: BuildingChoice) => void;
}

/**
 * Which shop to run: one of the five buildings, or the plan handed over from
 * the import page. An imported plan still needs a shop chosen, because the
 * crew, the demand and the trading hours come from the site record even when
 * the building comes from a drawing.
 */
export default function ShopPicker({ store, shops, value, disabled, onStore, onChange }: Props) {
  const imported = value.kind === "session";
  return (
    <>
      <div className="row" style={{ marginTop: 0 }}>
        <label style={{ flex: "1 1 auto" }}>
          Shop{" "}
          <select value={store} disabled={disabled} onChange={(e) => onStore(e.target.value)} title="Which of the five shops to run; its crew, demand, hours and fixtures come with it">
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row" style={{ marginTop: 0 }}>
        <label style={{ flex: "1 1 auto" }}>
          Building{" "}
          <select
            value={value.kind}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "session" ? readSessionSpec() : BUILTIN)}
            title="The shop's own plan, or a drawing imported in this tab (the crew and the demand still come from the shop above)"
          >
            <option value="builtin">the shop&apos;s own plan</option>
            <option value="session">imported plan{value.kind === "session" && value.name ? ` · ${value.name}` : ""}</option>
          </select>
        </label>
        {imported && (
          <button
            type="button"
            className="chip"
            disabled={disabled}
            onClick={() => {
              clearSessionSpec();
              onChange(BUILTIN);
            }}
          >
            Forget it
          </button>
        )}
      </div>
      {imported && value.error && <span className="store-err">{value.error}</span>}
      {imported && value.spec && (
        <span className="sub" style={{ margin: 0 }}>
          {Math.round(value.spec.widthFt)} × {Math.round(value.spec.depthFt)} ft · {value.spec.fixtures.length} fixture runs · {value.spec.doors.length} doors · from {value.spec.source.format.toUpperCase()}
        </span>
      )}
    </>
  );
}
