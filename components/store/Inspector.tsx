"use client";

import type { DescribeSection } from "@/lib/store-ui/describe";
import type { PickResult } from "@/lib/three/api";

interface Props {
  title: string;
  selection: PickResult | null;
  sections: DescribeSection[];
  /** The selection is an actor with a track, so the camera can chase it. */
  canFollow: boolean;
  following: boolean;
  onFollow: () => void;
  onClear: () => void;
}

/**
 * Whatever is selected, as sections of label/value rows.
 *
 * The one distinction this panel exists to carry is a CSS pseudo-element: a row
 * `lib/store-ui/describe.ts` flagged `shown` gets a SHOWN tag, because it is
 * something the playback invented so the picture would make sense — which
 * register, which stall, the route drawn on the floor — and not something the
 * engine decided. Everything unflagged is an engine fact.
 */
export default function Inspector({ title, selection, sections, canFollow, following, onFollow, onClear }: Props) {
  return (
    <div className="store-inspect">
      <h3>
        <span style={{ flex: "1 1 auto" }}>{title}</span>
        {canFollow && (
          <button type="button" className={`chip${following ? " primary" : ""}`} onClick={onFollow}>
            {following ? "Following" : "Follow"}
          </button>
        )}
        {selection && (
          <button type="button" className="chip" onClick={onClear}>
            Clear
          </button>
        )}
      </h3>
      {!selection && <p className="sub">Click anything in the shop: a shopper, a clerk, a shelf facing, the glass counter, a register, a stock cart, the van, a trailer on the dock, a car in the lot. In walk mode, look at it and press E.</p>}
      {sections.map((s, i) => (
        <div className="sec" key={`${s.title}-${i}`}>
          <h4>{s.title}</h4>
          <dl>
            {s.rows.map((r, j) => (
              <RowPair key={`${r.label}-${j}`} label={r.label} value={r.value} shown={r.shown === true} />
            ))}
          </dl>
        </div>
      ))}
      {selection && (
        <p className="store-legend">
          Plain rows are engine facts from the run&apos;s own event trace. Rows tagged <em>shown</em> are what the playback added to draw it — which till, which cart, which parking stall, the walk
          across the floor — and they feed back into nothing.
        </p>
      )}
    </div>
  );
}

function RowPair({ label, value, shown }: { label: string; value: string; shown: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={shown ? "shown" : undefined}>{value}</dd>
    </>
  );
}
