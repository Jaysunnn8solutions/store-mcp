/**
 * Monte Carlo over the things that go wrong in a shop. Each run draws its own
 * no-shows, till outages, dead registers, vans off the road, late suppliers and
 * short demand surges at the rates the caller sets, writes them into the same
 * public scenario shape any caller could have sent, and simulates.
 *
 * The attribution table compares runs that were hit by a kind of disruption
 * with runs that were not. That is a correlation between runs, not a cause: a
 * run usually carries several disruptions at once, so a large gap is a lead to
 * confirm with what_if, which holds everything else still.
 *
 * Disruption draws use their own seed range (9000+) and the engine another
 * (500+), so adding a knob here never shifts the floor's own random numbers.
 */

import { findSite, loadCatalog } from "../data/load";
import { runOperations } from "../twin/operations";
import { kpis, type Kpis } from "../twin/replicate";
import { buildTwin, operationsOptions, type TwinScenario } from "../twin/twin";
import { mean, quantile, randInt, seededRandom } from "../util/random";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { fmt1, fmtInt, guarded, money, pct, pct1, readOnlyOpenWorld, scenarioLine, storeName, text, waitMin, z } from "./shared";

export const stressTestConfig = {
  title: "Stress-test against random disruptions",
  description:
    "Monte Carlo over disruptions: each run draws its own staff no-shows, till-network outages, dead registers, vans off the road, supplier delays and " +
    "short demand surges at the given rates, on top of daily absenteeism, and simulates the shop. Reports the distribution of walk-outs, lost sales, " +
    "queue waits, on-shelf availability and cost, how often each kind of disruption hit, how much worse the runs it hit were, and the worst run's story.",
  inputSchema: z
    .object({
      ...baseShape,
      days: z.number().int().min(5).max(56).default(20),
      runs: z.number().int().min(10).max(60).default(30),
      sickLeavePerWeek: z.number().min(0).max(0.5).default(0.05).describe("Chance each person is out 2–5 days in a given week."),
      posOutagePerDay: z.number().min(0).max(0.5).default(0.02).describe("Chance the till network goes down for 1–3 hours on a given day; nothing can be rung up and every queue stalls."),
      registerFailurePerDay: z.number().min(0).max(0.5).default(0.015).describe("Chance each register fails on a given day; the engineer takes 1–3 days."),
      vanFailurePerDay: z.number().min(0).max(0.5).default(0.01).describe("Chance each van is off the road on a given day, for 1–2 days."),
      supplierDelayPerWeek: z.number().min(0).max(0.5).default(0.05).describe("Chance each supplier's orders placed in a week arrive 3–10 days late."),
      surgePerWeek: z.number().min(0).max(1).default(0.12).describe("Chance of a 2–4 day demand surge of 20–50% in a given week."),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof stressTestConfig.inputSchema>;

type Kind = "sick" | "pos" | "register" | "van" | "supplier" | "surge";

const KIND_LABEL: Record<Kind, string> = {
  sick: "staff no-show",
  pos: "till network down",
  register: "register out",
  van: "van off the road",
  supplier: "supplier late",
  surge: "demand surge",
};

export async function stressTestHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const r = rest as {
      store: string;
      startWeek: number;
      days: number;
      runs: number;
      sickLeavePerWeek: number;
      posOutagePerDay: number;
      registerFailurePerDay: number;
      vanFailurePerDay: number;
      supplierDelayPerWeek: number;
      surgePerWeek: number;
    };
    const site = findSite(r.store);
    const suppliers = loadCatalog().suppliers;
    const baseCtx = await buildTwin(r.store, r.startWeek, scenario);
    const workers = baseCtx.workers;
    const registers = scenario.registers ?? site.checkout.registers;
    const vans = scenario.vans ?? site.equipment.vans;

    const results: Array<{ k: Kpis; hits: Set<Kind>; story: string[] }> = [];
    for (let run = 0; run < r.runs; run++) {
      const rng = seededRandom(9000 + run);
      const s: TwinScenario = structuredClone(scenario);
      const hits = new Set<Kind>();
      const story: string[] = [];

      for (let d = 0; d < r.days; d++) {
        if (!site.operatingDays.includes((d % 7) + 1)) continue;
        for (let i = 0; i < registers; i++) {
          if (rng() < r.registerFailurePerDay) {
            const len = randInt(rng, 1, 3);
            (s.registerOutages ??= []).push({ count: 1, fromDay: d, toDay: Math.min(364, d + len - 1) });
            hits.add("register");
            story.push(`a register out days ${d}–${d + len - 1}`);
          }
        }
        for (let i = 0; i < vans; i++) {
          if (rng() < r.vanFailurePerDay) {
            const len = randInt(rng, 1, 2);
            (s.vanOutages ??= []).push({ count: 1, fromDay: d, toDay: Math.min(364, d + len - 1) });
            hits.add("van");
            story.push(`a van off the road days ${d}–${d + len - 1}`);
          }
        }
        if (rng() < r.posOutagePerDay) {
          const h = randInt(rng, 1, 3);
          const start = `${String(randInt(rng, 11, 18)).padStart(2, "0")}:00`;
          (s.posOutages ??= []).push({ day: d, start, hours: h });
          hits.add("pos");
          story.push(`till network down day ${d} from ${start} for ${h} h`);
        }
      }

      for (let w = 0; w * 7 < r.days; w++) {
        for (const worker of workers) {
          if (rng() < r.sickLeavePerWeek) {
            const from = w * 7 + randInt(rng, 0, 4);
            const to = Math.min(364, from + randInt(rng, 1, 4));
            (s.workerLeave ??= []).push({ worker: worker.id, fromDay: from, toDay: to });
            hits.add("sick");
            story.push(`${worker.id} (${worker.role}) out days ${from}–${to}`);
          }
        }
        for (const sup of suppliers) {
          if (rng() < r.supplierDelayPerWeek) {
            const extra = randInt(rng, 3, 10);
            // The window opens two weeks early so an order already placed is
            // caught; the schema's floor is day 0, so it is clamped below.
            (s.supplierDelays ??= []).push({ supplier: sup.id, extraDays: extra, fromDay: w * 7 - 14, toDay: w * 7 + 6 });
            hits.add("supplier");
            story.push(`${sup.name} +${extra} days`);
          }
        }
        if (rng() < r.surgePerWeek) {
          const from = w * 7 + randInt(rng, 0, 3);
          const len = randInt(rng, 2, 4);
          const factor = Math.round((1.2 + rng() * 0.3) * 100) / 100;
          (s.demandShocks ??= []).push({ fromDay: from, toDay: Math.min(364, from + len - 1), factor });
          hits.add("surge");
          story.push(`demand ×${factor} days ${from}–${from + len - 1}`);
        }
      }
      for (const d of s.supplierDelays ?? []) d.fromDay = Math.max(0, d.fromDay);

      const ctx = await buildTwin(r.store, r.startWeek, s);
      results.push({ k: kpis(runOperations(ctx, operationsOptions(ctx, r.days, 500 + run))), hits, story });
    }

    const col = (f: (k: Kpis) => number) => results.map((x) => f(x.k));
    const lostOf = (k: Kpis) => k.lostShelfDollars + k.lostQueueDollars;
    const walkOuts = col((k) => k.abandoned);
    const anyWalk = results.filter((x) => x.k.abandoned > 0).length / results.length;

    const attribution = (Object.keys(KIND_LABEL) as Kind[]).map((kind) => {
      const hit = results.filter((x) => x.hits.has(kind));
      const not = results.filter((x) => !x.hits.has(kind));
      const num = (list: typeof results, f: (k: Kpis) => number, fmt: (v: number) => string) => (list.length ? fmt(mean(list.map((x) => f(x.k)))) : "—");
      return `| ${KIND_LABEL[kind]} | ${pct(hit.length / results.length)} | ${num(hit, (k) => k.abandoned, fmt1)} | ${num(not, (k) => k.abandoned, fmt1)} | ${num(hit, lostOf, money)} | ${num(not, lostOf, money)} | ${num(hit, (k) => k.onShelfShare, pct1)} | ${num(not, (k) => k.onShelfShare, pct1)} |`;
    });

    const worst = [...results].sort((a, b) => lostOf(b.k) - lostOf(a.k) || b.k.abandoned - a.k.abandoned)[0];
    const row = (label: string, f: (k: Kpis) => number, fmt: (v: number) => string, lowIsBad = false) => {
      const xs = col(f);
      return `| ${label} | ${fmt(mean(xs))} | ${fmt(quantile(xs, 0.5))} | ${fmt(quantile(xs, lowIsBad ? 0.1 : 0.9))} | ${fmt(lowIsBad ? Math.min(...xs) : Math.max(...xs))} |`;
    };

    return text(
      [
        `# Stress test at ${storeName(baseCtx)}: ${r.runs} runs of ${r.days} days from week ${r.startWeek}`,
        scenarioLine(baseCtx),
        `Rates: no-show ${pct(r.sickLeavePerWeek)} per person-week, till network ${pct(r.posOutagePerDay)}/day, register ${pct(r.registerFailurePerDay)} per register-day, van ${pct(r.vanFailurePerDay)} per van-day, supplier ${pct(r.supplierDelayPerWeek)} per supplier-week, demand surge ${pct(r.surgePerWeek)}/week; daily absenteeism ${pct(baseCtx.scheduleOptions.absenteeism)}.`,
        ``,
        `**Runs where at least one shopper walked out: ${pct(anyWalk)}.** Walk-outs per run: median ${fmt1(quantile(walkOuts, 0.5))}, 90th percentile ${fmt1(quantile(walkOuts, 0.9))}, worst ${fmtInt(Math.max(...walkOuts))}.`,
        ``,
        `| KPI | mean | median | bad tail (p90, or p10) | worst |`,
        `|---|---:|---:|---:|---:|`,
        row("Walk-outs", (k) => k.abandoned, fmt1),
        row("Lost sales, total", lostOf, money),
        row("Lost sales, walked out", (k) => k.lostQueueDollars, money),
        row("Lost sales, empty shelf", (k) => k.lostShelfDollars, money),
        row("Register wait, p90", (k) => k.registerWaitP90Min, waitMin),
        row("Counter wait, p90", (k) => k.counterWaitP90Min, waitMin),
        row("On-shelf availability", (k) => k.onShelfShare, pct1, true),
        row("Sales", (k) => k.salesDollars, money, true),
        row("Special orders late", (k) => k.ordersLate, fmt1),
        row("Overtime hours", (k) => k.overtimeHours, fmt1),
        row("Labor cost", (k) => k.laborCost, money),
        ``,
        `| disruption | share of runs hit | walk-outs when hit | when not | lost sales when hit | when not | on-shelf when hit | when not |`,
        `|---|---:|---:|---:|---:|---:|---:|---:|`,
        ...attribution,
        ``,
        `**Worst run** (${money(lostOf(worst.k))} of lost sales, ${fmtInt(worst.k.abandoned)} walk-outs, on-shelf ${pct1(worst.k.onShelfShare)}): ${worst.story.length ? worst.story.join("; ") : "nothing was drawn; ordinary absence and demand alone"}.`,
        ``,
        `Hit-versus-not compares runs, not causes: a run can carry several disruptions at once, so read a large gap as a lead and confirm it with what_if, which holds everything else still.`,
      ].join("\n")
    );
  });
}
