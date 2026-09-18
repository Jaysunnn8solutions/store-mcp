"use client";

import { useEffect, useRef } from "react";

/** The keyboard map, and the source of the first-run hint's shortlist. */
export const KEY_MAP: ReadonlyArray<[keys: string, what: string]> = [
  ["Space", "play / pause"],
  ["← →", "one minute back / forward (Shift: an hour, Alt: a day)"],
  ["Home / End", "start / end of the run"],
  [", .", "slower / faster (1× 10× 60× 300× 1800×)"],
  ["0", "skip the hours with nobody in the shop, on / off"],
  ["1 2 3 4 5 6 7", "camera: overview, storefront, aisle, counter, stockroom, dock, car park"],
  ["O F W", "orbit · follow the selected actor · walk the floor (WASD, mouse to look, E to inspect, Esc to leave)"],
  ["Esc", "clear the selection, leave walk mode, close a menu, close this help"],
  ["[ ]", "jump to the previous / next notable line in the ticker"],
  ["L", "labels on / off"],
  ["N", "day-and-night lighting on / off"],
  ["S", "shadows on / off"],
  ["H", "key figures (HUD) on / off"],
  ["M", "minimap on / off"],
  ["R", "run the scenario again"],
  ["C", "compare against the previous run"],
  ["?", "this help"],
];

interface Props {
  open: boolean;
  onClose: () => void;
}

/** A modal over the stage: takes focus when it opens and gives it back where it was when it closes. */
export default function HelpOverlay({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      before?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="store-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="row" style={{ marginTop: 0, justifyContent: "space-between" }}>
        <h3>How to drive the shop</h3>
        <button type="button" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="sub">
        Press Space and watch a trading day: the overnight trailer on the dock before dawn, the morning fill, the special orders picked and packed and loaded onto the van, the doors opening at ten,
        shoppers coming in off the car park, the queue at the glass and the queue at the till — and the ones who put the basket down and leave. Click anything to open it in the inspector. Drag the
        canvas to orbit, wheel to zoom, right-drag to pan. The numbers on the HUD are the engine&apos;s own accounting at the minute on the clock; the inspector says which rows the engine decided and
        which the picture added.
      </p>
      <table>
        <tbody>
          {KEY_MAP.map(([k, what]) => (
            <tr key={k}>
              <td>
                {k.split(" ").map((key) => (
                  <kbd key={key} style={{ marginRight: 4 }}>
                    {key}
                  </kbd>
                ))}
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface HintProps {
  /** A full-width block in the page flow (narrow layouts) rather than a box floating over the stage. */
  block?: boolean;
  onDismiss: () => void;
  onHelp: () => void;
}

/** Shown once per browser until dismissed; "Got it" remembers in localStorage. */
export function FirstRunHint({ block = false, onDismiss, onHelp }: HintProps) {
  return (
    <div className={`store-overlay store-hint${block ? " block" : ""}`} role="status">
      <span>
        <b>Space</b> plays, <b>drag the timeline</b> to scrub, <b>click anything</b> in the shop to inspect it, <b>1–7</b> jump between camera views.{" "}
        <button type="button" className="chip" onClick={onHelp}>
          All keys
        </button>
      </span>
      <button type="button" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
