/**
 * Pins the run write-up against two real simulations.
 *
 * What is pinned: the day table adds up to the headline (a row that does not
 * sum is a table nobody can trust); every recommendation names a scenario field
 * that exists and a tab that exists, because a recommendation you cannot act on
 * is decoration; the rule engine is a pure function of its input, so the same
 * run always produces the same advice; the CSV is rectangular; and a shop
 * deliberately starved of registers actually gets told to open one.
 */

import { describe, expect, it } from "vitest";
import { runOperations, type OperationsResult } from "../twin/operations";
import { kpis, KPI_KEYS, type Kpis } from "../twin/replicate";
import { buildTwin, operationsOptions, scenarioSchema, type TwinScenario } from "../twin/twin";
import { PROCESSES } from "../twin/types";
import { KPI_META } from "./format";
import { buildReport, DAY_COLUMNS, recommend, REPORT_TABS, reportCsv, reportJson, reportMarkdown, reportFileStem, type ReportInput } from "./report";

const STORE = "store-midtown";
const WEEK = 44;
const DAYS = 3;

async function run(scenario: TwinScenario = {}, seed = 1): Promise<ReportInput> {
  const ctx = await buildTwin(STORE, WEEK, scenario);
  const result: OperationsResult = runOperations(ctx, operationsOptions(ctx, DAYS, seed));
  return { kpis: kpis(result), result, ctx: { storeName: ctx.site.name, startWeek: WEEK, days: DAYS, seed, changes: [...ctx.changes] } };
}

const baseline = await run();
// One register, no patience and no second van: a shop set up to queue.
const stressed = await run(scenarioSchema.parse({ registers: 1, counters: 1, patience: 0.3, demandScale: 2 }));

const sum = (rows: ReadonlyArray<Record<string, string | number>>, key: string): number => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);

describe("the day table", () => {
  it("has one row per horizon day, with every column on every row", () => {
    const r = buildReport(baseline);
    expect(r.days).toHaveLength(baseline.result.daily.length);
    for (const row of r.days) for (const c of DAY_COLUMNS) expect(row[c.key], `column ${c.key}`).toBeDefined();
  });

  it("adds up to the headline numbers the engine reports", () => {
    const r = buildReport(baseline);
    const k = baseline.kpis;
    expect(sum(r.days, "customers")).toBe(k.customers);
    expect(sum(r.days, "transactions")).toBe(k.transactions);
    expect(sum(r.days, "absences")).toBe(k.absences);
    expect(sum(r.days, "restocks")).toBe(k.restocks);
    expect(sum(r.days, "hotRestocks")).toBe(k.hotRestocks);
    expect(sum(r.days, "shelfShorts")).toBe(k.shortAtShelf);
    expect(sum(r.days, "inboundTrucks")).toBe(k.inboundTrucks);
    expect(sum(r.days, "ordersLate")).toBe(k.ordersLate);
    // Rounded to cents on the way into the table, so the sum is only good to
    // half a cent a day.
    expect(sum(r.days, "salesDollars")).toBeCloseTo(k.salesDollars, 1);
    expect(sum(r.days, "lostShelfDollars")).toBeCloseTo(k.lostShelfDollars, 1);
    expect(sum(r.days, "lostQueueDollars")).toBeCloseTo(k.lostQueueDollars, 1);
    expect(sum(r.days, "overtimeHours")).toBeCloseTo(k.overtimeHours, 1);
  });
});

describe("recommendations", () => {
  it("name a scenario field that exists and a tab that exists", () => {
    const fields = new Set(Object.keys(scenarioSchema.shape));
    for (const input of [baseline, stressed]) {
      const recs = buildReport(input).recommendations;
      expect(recs.length).toBeGreaterThan(0);
      for (const rec of recs) {
        expect(REPORT_TABS).toContain(rec.tab);
        // "times.pickStart" points at a field inside the times object.
        expect(fields, `field ${rec.field}`).toContain(rec.field.split(".")[0]);
        expect(rec.title.length).toBeGreaterThan(0);
        expect(rec.detail.length).toBeGreaterThan(0);
        expect(rec.impact.length).toBeGreaterThan(0);
      }
    }
  });

  it("is a pure function of the run, so the same numbers always give the same advice", () => {
    expect(recommend(baseline)).toEqual(recommend(baseline));
    expect(buildReport(stressed)).toEqual(buildReport(stressed));
  });

  it("tells a shop with one till and impatient shoppers to do something about the queue", () => {
    const recs = buildReport(stressed).recommendations;
    const queue = recs.find((x) => x.field === "registers" || x.field === "addWorkers");
    expect(queue, `got: ${recs.map((x) => `${x.tab}›${x.field}`).join(", ")}`).toBeDefined();
  });

  it("says plainly when nothing fired rather than inventing work", () => {
    const calm = Object.fromEntries(PROCESSES.map((p) => [p, { ...baseline.result.processes[p], waitTotalMin: 0, waitMaxMin: 0 }])) as OperationsResult["processes"];
    const quiet: ReportInput = {
      ...baseline,
      kpis: { ...baseline.kpis, lostShelfDollars: 0, lostQueueDollars: 0, onShelfShare: 1, abandoned: 0, ordersLate: 0, vanLateRounds: 0, orderCutDollars: 0, palletsNotPutAway: 0, dockToStockP90Min: 10, overtimeHours: 0, hotRestocks: 0, registerWaitP90Min: 1, counterWaitP90Min: 1, utilization: 0.7 },
      result: {
        ...baseline.result,
        service: { ...baseline.result.service, abandonedCounter: 0, abandonedRegister: 0 },
        processes: calm,
        labor: { ...baseline.result.labor, absences: 0, overtimeCost: 0 },
        daily: baseline.result.daily.map((d) => ({ ...d, overtimeHours: 0 })),
      },
    };
    const recs = buildReport(quiet).recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toMatch(/Nothing to fix/);
  });
});

describe("formats", () => {
  it("writes a rectangular CSV of the day table", () => {
    const r = buildReport(baseline);
    const lines = reportCsv(r).trim().split("\n");
    expect(lines).toHaveLength(r.days.length + 1);
    expect(lines[0]).toBe(DAY_COLUMNS.map((c) => c.header).join(","));
    for (const line of lines) expect(line.split(",")).toHaveLength(DAY_COLUMNS.length);
  });

  it("writes Markdown that carries the headline, the advice and the caveat", () => {
    const r = buildReport(baseline);
    const md = reportMarkdown(r, stressed.kpis, baseline.kpis);
    expect(md).toContain(r.headline);
    expect(md).toContain("## What to change");
    expect(md).toContain("## Day by day");
    expect(md).toContain("## Against the previous run");
    expect(md).toContain("not an optimizer");
    for (const rec of r.recommendations) expect(md).toContain(rec.field);
  });

  it("leaves the change table out when there is nothing to compare against", () => {
    expect(reportMarkdown(buildReport(baseline))).not.toContain("## Against the previous run");
  });

  it("round-trips through JSON and names a file after the run", () => {
    const r = buildReport(baseline);
    expect(JSON.parse(reportJson(r))).toEqual(r);
    expect(reportFileStem(STORE, WEEK, DAYS, 1)).toBe(`store-report-${STORE}-wk44-3d-seed1`);
  });
});

describe("the KPI table", () => {
  it("covers every KPI the engine reports, once each", () => {
    const keys = KPI_META.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...KPI_KEYS].sort());
  });

  it("formats every KPI of a real run without producing a NaN", () => {
    for (const m of KPI_META) {
      const text = m.fmt(baseline.kpis[m.key as keyof Kpis]);
      expect(text, m.key).not.toContain("NaN");
      expect(text.length, m.key).toBeGreaterThan(0);
    }
  });
});
