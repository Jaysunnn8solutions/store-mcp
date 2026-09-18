"use client";

import { delta, KPI_META } from "@/lib/store-ui/format";
import type { Kpis } from "@/lib/twin/replicate";
import { keepFocus } from "./focus";

export interface CompareRun {
  label: string;
  kpis: Kpis;
  /** What the scenario changed about the shop, as buildTwin recorded it. */
  changes: string[];
}

interface Props {
  /** The run before this one. */
  a: CompareRun | null;
  /** The run on screen. */
  b: CompareRun | null;
  onSwap: () => void;
}

/**
 * A against B over every KPI the tools publish, with the change coloured by
 * whether a rise is worse for that metric — `lib/store-ui/format.ts` owns that
 * judgement, so the page and an MCP answer never disagree about which way is
 * better.
 *
 * There is no run history here on purpose: the workbench keeps exactly two
 * runs, the one playing and the one before it. Same seed both times, so a
 * difference is the scenario and not the dice.
 */
export default function ComparePanel({ a, b, onSwap }: Props) {
  if (!b) return <p className="sub">Run a scenario first. The run before it becomes A and the new one B.</p>;
  if (!a) return <p className="sub">One run so far. Change something on the Scenario tab and run again: this run becomes A, the new one B, and every KPI lines up side by side.</p>;
  return (
    <div className="store-compare">
      <div className="runs">
        <div>
          <b>A</b> {a.label}
          {a.changes.length > 0 && <span className="sub"> · {a.changes.join("; ")}</span>}
        </div>
        <div>
          <b>B</b> {b.label}
          {b.changes.length > 0 && <span className="sub"> · {b.changes.join("; ")}</span>}
        </div>
        <div className="row" style={{ marginTop: 2 }}>
          <span onMouseDown={keepFocus}>
            <button type="button" onClick={onSwap}>
              Swap: play A
            </button>
          </span>
          <span className="sub">The timeline draws B&apos;s queue and walk-out strips over A&apos;s.</span>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>KPI</th>
            <th>A</th>
            <th>B</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {KPI_META.map((m) => {
            const d = delta(m.key, a.kpis[m.key], b.kpis[m.key]);
            return (
              <tr key={m.key}>
                <td>{m.label}</td>
                <td>{m.fmt(a.kpis[m.key])}</td>
                <td>{m.fmt(b.kpis[m.key])}</td>
                <td className={d.cls}>{d.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="store-legend">Green: B is better on that KPI; red: worse. Both runs used the same seed, so the difference is what you changed.</p>
    </div>
  );
}
