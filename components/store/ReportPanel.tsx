"use client";

import { useMemo, useState } from "react";
import { compactMoney, count, KPI_META, percent } from "@/lib/store-ui/format";
import { buildReport, DAY_COLUMNS, reportCsv, reportFileStem, reportJson, reportMarkdown, type Report } from "@/lib/store-ui/report";
import type { OperationsResult } from "@/lib/twin/operations";
import type { Kpis } from "@/lib/twin/replicate";
import { keepFocus } from "./focus";

export interface ReportRun {
  label: string;
  store: string;
  storeName: string;
  startWeek: number;
  days: number;
  seed: number;
  kpis: Kpis;
  changes: string[];
  /**
   * The engine's own run record. The worker's `done` message does not carry it
   * yet, so this is null in the browser today and the panel falls back to the
   * KPI table; the moment it does arrive, the full write-up appears with no
   * other change here.
   */
  result: OperationsResult | null;
}

interface Props {
  run: ReportRun | null;
  previous: { label: string; kpis: Kpis } | null;
}

type Format = "md" | "csv" | "json";

const MIME: Record<Format, string> = { md: "text/markdown", csv: "text/csv", json: "application/json" };

/** The day columns worth a 340 px panel; the downloads carry all of them. */
const SHOWN_COLUMNS = ["day", "weekday", "salesDollars", "lostShelfDollars", "lostQueueDollars", "walkedOut", "registerWaitMin", "ordersLate"];

/** Hand the browser a file: a Blob URL on a throwaway anchor, revoked after the click. */
function download(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The KPI table on its own, for when there is no operations result to write a report from. */
function kpiText(run: ReportRun, f: Format): string {
  if (f === "json") return JSON.stringify({ run: run.label, changes: run.changes, kpis: run.kpis }, null, 2);
  const rows = KPI_META.map((m) => [m.label, m.key, run.kpis[m.key]] as const);
  if (f === "csv") return ["metric,key,value", ...rows.map(([l, k, v]) => `${JSON.stringify(l)},${k},${Number.isFinite(v) ? v : ""}`)].join("\n") + "\n";
  return [`# ${run.label}`, "", run.changes.length ? run.changes.map((c) => `- ${c}`).join("\n") : "Baseline scenario.", "", "| KPI | value |", "|---|---:|", ...rows.map(([l, , v], i) => `| ${l} | ${KPI_META[i].fmt(v)} |`), ""].join("\n");
}

/**
 * The run written up: one sentence a reader can stop after, what happened,
 * what to change, and a day-by-day table — plus the same thing as a file.
 *
 * The recommendations are a rule engine, not a search. Each one is a threshold
 * somebody who has run a shop would recognise, it fires on evidence it names,
 * and it points at the single scenario field that moves it and the tab that
 * field lives on. It cannot tell you the right number of registers; it can tell
 * you the queue is costing money and which knob to turn. Change one input, run
 * the same seed, compare.
 */
export default function ReportPanel({ run, previous }: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  // Memoized on the record's identity, so the report is built once per run and not once per frame.
  const report: Report | null = useMemo(
    () => (run?.result ? buildReport({ kpis: run.kpis, result: run.result, ctx: { storeName: run.storeName, startWeek: run.startWeek, days: run.days, seed: run.seed, changes: run.changes }, previous: previous?.kpis }) : null),
    [run, previous]
  );
  if (!run) return <p className="sub">Run a scenario first. The report reads the run on screen: what the shop took, what it lost and to which of the two failures, who waited, and what to change.</p>;

  const stem = reportFileStem(run.store, run.startWeek, run.days, run.seed);
  const save = (f: Format) => {
    try {
      download(`${stem}.${f}`, MIME[f], report ? (f === "md" ? reportMarkdown(report, previous?.kpis, run.kpis) : f === "csv" ? reportCsv(report) : reportJson(report)) : kpiText(run, f));
      setMsg(`Saved ${stem}.${f}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report ? reportMarkdown(report, previous?.kpis, run.kpis) : kpiText(run, "md"));
      setMsg("Markdown copied");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const k = run.kpis;
  const lost = k.lostShelfDollars + k.lostQueueDollars;
  const columns = DAY_COLUMNS.filter((c) => SHOWN_COLUMNS.includes(c.key));

  return (
    <div className="store-report">
      <div className="head">
        <b>{run.label}</b>
        <span className="sub">{run.changes.length ? run.changes.join("; ") : "baseline scenario"}</span>
      </div>
      <div className="row" onMouseDown={keepFocus}>
        <button type="button" onClick={() => save("md")} title="The write-up: headline, findings, what to change, and every day">
          Download .md
        </button>
        <button type="button" onClick={() => save("csv")} title="The day table with unformatted numbers, for a spreadsheet">
          .csv
        </button>
        <button type="button" onClick={() => save("json")} title="Everything in the report as data">
          .json
        </button>
        <button type="button" onClick={() => void copy()}>
          Copy Markdown
        </button>
        {msg && (
          <span className="sub" role="status">
            {msg}
          </span>
        )}
      </div>

      <h3>Headline</h3>
      <div className="tiles">
        <div>
          <b>{compactMoney(k.salesDollars)}</b>
          <span>taken from {count(k.customers)} shoppers</span>
        </div>
        <div>
          <b className={k.lostSalesShare > 0.2 ? "bad" : ""}>{compactMoney(lost)}</b>
          <span>lost, {percent(k.lostSalesShare, 1)} of demand</span>
        </div>
        <div>
          <b className={k.onShelfShare < 0.9 ? "bad" : ""}>{percent(k.onShelfShare, 1)}</b>
          <span>{count(k.abandoned)} walked out of a queue</span>
        </div>
        <div>
          <b>{compactMoney(k.laborCost)}</b>
          <span>wages at {percent(k.utilization)} utilization</span>
        </div>
      </div>

      {report ? (
        <>
          <p className="sub">{report.headline}</p>
          <h3>What happened</h3>
          <ul className="recs">
            {report.findings.map((f, i) => (
              <li key={i}>
                <p>{f}</p>
              </li>
            ))}
          </ul>
          <h3>What to change</h3>
          {report.recommendations.length === 0 && <p className="sub">Nothing fired: no rule found a threshold this run crossed.</p>}
          <ul className="recs">
            {report.recommendations.map((rec, i) => (
              <li key={i}>
                <span className="area">
                  {rec.tab} › <code>{rec.field}</code>
                </span>
                <p>
                  <b>{rec.title}</b> — at stake: {rec.impact}.
                </p>
                <p className="action">{rec.detail}</p>
              </li>
            ))}
          </ul>
          <h3>Day by day</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key}>{c.header.replace(/_/g, " ")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.days.map((row, i) => (
                  <tr key={i} className={Number(row.ordersLate ?? 0) > 0 ? "bad" : ""}>
                    {columns.map((c) => (
                      <td key={c.key}>{c.fmt(row[c.key] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="store-legend">
            Dollars are candystore retail value. Waits are the time a person actually stood there. The recommendations are a rule engine over these numbers, each one a threshold with the evidence it
            fired on — change one field, run the same seed again, and compare.
          </p>
        </>
      ) : (
        <>
          <h3>Every KPI</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>KPI</th>
                  <th>value</th>
                </tr>
              </thead>
              <tbody>
                {KPI_META.map((m) => (
                  <tr key={m.key}>
                    <td>{m.label}</td>
                    <td>{m.fmt(k[m.key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="store-legend">
            The findings, the recommendations and the day-by-day table are written from the engine&apos;s own run record, which the simulation worker does not send to the page yet. The KPIs above are
            the run&apos;s posted totals and the downloads carry them; ask an MCP tool for the full write-up in the meantime.
          </p>
        </>
      )}
    </div>
  );
}
