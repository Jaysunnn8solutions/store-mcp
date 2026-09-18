/**
 * The cheapest way to run the shop, searched rather than reasoned about.
 *
 * `peak_readiness` prices a fixed menu of fixes one at a time; this searches
 * the whole lever space at once, which matters because the levers interact. A
 * second counter clerk is worth little until somebody is cross-trained to
 * cover their break, and re-merchandising is worth more once there are enough
 * stocker hours to keep the bigger facings filled. A genetic search over
 * scenarios finds those pairs; a menu cannot.
 *
 * Every candidate is a scenario the twin already accepts, run on the floor and
 * scored as one weekly figure: labour, amortised hiring and training,
 * equipment beyond the shop's own, the carrying cost of the stock, the margin
 * on what it sells — minus the margin on what it does not, which is where a
 * shop differs from a warehouse. In a distribution center a late truck is a
 * penalty somebody invents a price for; here a customer who walks out of a
 * queue is a real, priced loss of gross margin, and the three presets disagree
 * only about how much of it comes back next week.
 *
 * The answer is the best plan found, not a proof of optimality. It comes back
 * as a scenario, so it can be handed straight to `what_if` or watched in 3D.
 */

import {
  DEFAULT_LEVERS,
  MAX_EVALUATION_WEEKS,
  OPTIMIZE_LIMITS,
  evaluationWeeks,
  optimizeOperations,
  type Candidate,
  type CostBreakdown,
  type Levers,
  type Objective,
} from "../twin/optimize";
import { buildTwin, scenarioShape, storeSchema } from "../twin/twin";
import { dollars2, fmtInt, guarded, money, pct1, readOnlyOpenWorld, storeLink, storeName, text, waitMin, z } from "./shared";

const OBJECTIVE_NOTE: Record<Objective, string> = {
  service: "service first — a walked-out shopper costs four times the basket they dropped, because a sweet shop lives on the people who come back",
  balanced: "balanced — a walked-out shopper costs twice the basket they dropped",
  cost: "cost first — a walked-out shopper costs exactly the margin on the basket they dropped, and nothing more",
};

export const optimizeOperationsConfig = {
  title: "Find the cheapest way to run the shop",
  description:
    "Search the shop's levers — people by role and shift, cross-training, overtime and target utilization, registers and counter stations, carts, jacks and " +
    "vans, merchandising and facing depth, service level and forecast, the pick start and the van's departures, and the trading hours — for the plan with " +
    "the lowest weekly cost by stated prices. Scores labour, hiring, training, equipment and stock against the margin it earns and the margin it loses to " +
    "empty shelves, abandoned queues and late orders. Returns the winning plan as a scenario any other tool accepts, its KPIs and cost against the shop as " +
    "it is, and the runners-up. Slower than the other tools: it runs the floor hundreds of times.",
  inputSchema: z
    .object({
      store: storeSchema,
      startWeek: z.number().int().min(1).max(52).default(44).describe("Week to optimize for. 44 is Halloween, which is where a candy shop's plan is decided."),
      objective: z
        .enum(["service", "balanced", "cost"])
        .default("balanced")
        .describe("How dearly a customer who walks out is priced against an hour of wages. The presets differ in nothing else."),
      levers: z
        .object({
          labor: z.boolean().default(true).describe("Hiring by role and shift, cross-training, flexing, the overtime cap and target utilization."),
          service: z.boolean().default(true).describe("Registers and showcase stations."),
          floor: z.boolean().default(true).describe("Merchandising and facing depth."),
          backroom: z.boolean().default(true).describe("Stock carts, pallet jacks and vans."),
          supply: z.boolean().default(true).describe("Service level and forecast method."),
          hours: z.boolean().default(true).describe("Trading hours, the pick start and the van's departures."),
        })
        .partial()
        .optional()
        .describe("Which families of levers the search may move. All of them by default."),
      population: z.number().int().min(OPTIMIZE_LIMITS.population.min).max(OPTIMIZE_LIMITS.population.max).default(16),
      generations: z.number().int().min(OPTIMIZE_LIMITS.generations.min).max(OPTIMIZE_LIMITS.generations.max).default(8),
      seeds: z.number().int().min(OPTIMIZE_LIMITS.seeds.min).max(OPTIMIZE_LIMITS.seeds.max).default(1).describe("Engine seeds averaged per plan. 2–3 smooths a noisy week at several times the cost."),
      days: z.number().int().min(OPTIMIZE_LIMITS.days.min).max(OPTIMIZE_LIMITS.days.max).default(7),
      runnersUp: z.number().int().min(0).max(10).default(3),
      // The base the search builds on: whatever the levers do not touch.
      demandScale: scenarioShape.demandScale,
      demandShocks: scenarioShape.demandShocks,
      candystore: scenarioShape.candystore,
      patience: scenarioShape.patience,
      layout: scenarioShape.layout,
      registerOutages: scenarioShape.registerOutages,
      counterOutages: scenarioShape.counterOutages,
      dockOutages: scenarioShape.dockOutages,
      vanOutages: scenarioShape.vanOutages,
      posOutages: scenarioShape.posOutages,
      workerLeave: scenarioShape.workerLeave,
      supplierDelays: scenarioShape.supplierDelays,
      absenteeism: scenarioShape.absenteeism,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof optimizeOperationsConfig.inputSchema>;

const COST_ROWS: Array<[keyof CostBreakdown, string]> = [
  ["labor", "labour"],
  ["overtime", "overtime"],
  ["hiring", "hiring, amortized"],
  ["training", "cross-training, amortized"],
  ["equipment", "tills, counters, carts, vans"],
  ["stock", "stock carrying"],
  ["lostShelf", "margin lost to an empty shelf"],
  ["lostQueue", "margin lost to a queue"],
  ["lateOrders", "late and missed orders"],
];

function costTable(base: Candidate, best: Candidate): string {
  const rows = COST_ROWS.filter(([k]) => base.cost[k] !== 0 || best.cost[k] !== 0).map(([k, label]) => {
    const a = base.cost[k];
    const b = best.cost[k];
    return `| ${label} | ${dollars2(a)} | ${dollars2(b)} | ${dollars2(b - a)} |`;
  });
  return [
    "| a week | as it is | the plan | change |",
    "|---|---:|---:|---:|",
    ...rows,
    `| **total cost** | **${dollars2(base.cost.total)}** | **${dollars2(best.cost.total)}** | **${dollars2(best.cost.total - base.cost.total)}** |`,
    `| gross margin earned | ${dollars2(base.cost.margin)} | ${dollars2(best.cost.margin)} | ${dollars2(best.cost.margin - base.cost.margin)} |`,
    `| **net** | **${dollars2(base.cost.net)}** | **${dollars2(best.cost.net)}** | **${dollars2(best.cost.net - base.cost.net)}** |`,
  ].join("\n");
}

function kpiRow(label: string, base: Candidate, best: Candidate, f: (c: Candidate) => string): string {
  return `| ${label} | ${f(base)} | ${f(best)} |`;
}

export async function optimizeOperationsHandler(args: Args) {
  return guarded(async () => {
    const { store, startWeek, objective, levers, population, generations, seeds, days, runnersUp, ...base } = args;

    // Built once for the shop's name and to reject a bad scenario before the
    // search spends a minute on it; buildTwin caches, so the run below is free.
    const ctx = await buildTwin(store, startWeek, base);

    const weeks = evaluationWeeks(population, generations, seeds, days);
    const budgetNote =
      weeks > MAX_EVALUATION_WEEKS
        ? `\n\n**Trimmed to fit.** A ${population} × ${generations + 1} search over ${seeds} seed(s) of ${days} days is ${fmtInt(weeks)} simulated weeks, over the hosted budget of ${fmtInt(MAX_EVALUATION_WEEKS)}; the search stopped when it reached it. The 3D page's Optimize tab runs the same search in your browser with no cap.`
        : "";

    const result = await optimizeOperations(store, startWeek, base, {
      objective,
      levers: levers ? ({ ...DEFAULT_LEVERS, ...levers } as Levers) : undefined,
      population,
      generations,
      seeds,
      days,
      maxEvaluationWeeks: MAX_EVALUATION_WEEKS,
    });

    const { best, baseline } = result;
    const better = best.cost.net < baseline.cost.net;
    const saving = baseline.cost.net - best.cost.net;

    const head = better
      ? `**The search found a plan worth ${money(saving)} a week** against the shop as it stands — ${pct1(saving / Math.max(1, Math.abs(baseline.cost.net)))} of its net. ` +
        `It ran ${fmtInt(result.evaluated)} plans over ${result.generations.length} generation(s) of ${days} days on ${seeds} engine seed(s)${result.stoppedEarly ? ", stopping early" : ""}.`
      : `**The shop as it stands is the best plan the search found.** ${fmtInt(result.evaluated)} plans over ${result.generations.length} generation(s) turned up nothing that paid for itself at these prices.`;

    const changes = best.changes.length > 0 ? best.changes.map((c) => `- ${c}`).join("\n") : "_nothing — the shop as it is_";

    const kpis = [
      "| | as it is | the plan |",
      "|---|---:|---:|",
      kpiRow("sales a week", baseline, best, (c) => money(c.kpis.salesDollars * (7 / days))),
      kpiRow("share of demand lost", baseline, best, (c) => pct1(c.kpis.lostSalesShare)),
      kpiRow("on the shelf when reached for", baseline, best, (c) => pct1(c.kpis.onShelfShare)),
      kpiRow("walked out of a queue", baseline, best, (c) => pct1(c.kpis.abandonRate)),
      kpiRow("register wait, p90", baseline, best, (c) => waitMin(c.kpis.registerWaitP90Min)),
      kpiRow("counter wait, p90", baseline, best, (c) => waitMin(c.kpis.counterWaitP90Min)),
      kpiRow("orders late", baseline, best, (c) => fmtInt(c.kpis.ordersLate)),
      kpiRow("labour utilization", baseline, best, (c) => pct1(c.kpis.utilization)),
      kpiRow("labour as a share of sales", baseline, best, (c) => pct1(c.kpis.laborShareOfSales)),
    ].join("\n");

    const runners =
      runnersUp > 0 && result.runnersUp.length > 0
        ? "\n\n## Runners-up\n\n" +
          result.runnersUp
            .slice(0, runnersUp)
            .map((c, i) => `${i + 1}. **${dollars2(c.cost.net)}/week net** — ${c.changes.join("; ") || "the shop as it is"}`)
            .join("\n")
        : "";

    const trace =
      result.generations.length > 1
        ? "\n\n## The search\n\n" +
          "| generation | best net/week | mean |\n|---|---:|---:|\n" +
          result.generations.map((g) => `| ${g.index} | ${dollars2(g.best)} | ${dollars2(g.mean)} |`).join("\n") +
          "\n\nGeneration 0 is the shop as it is plus every one-lever step from it, so an obvious single fix is found at once."
        : "";

    const link = storeLink(store, startWeek, Math.min(days, 28), best.scenario);

    return text(
      [
        `# The cheapest way to run ${storeName(ctx)}, week ${startWeek}`,
        "",
        `Objective: ${OBJECTIVE_NOTE[objective]}. Gross margin ${pct1(result.assumptions.grossMargin)}; every price is an input and is listed below.${budgetNote}`,
        "",
        head,
        "",
        "## The plan",
        "",
        changes,
        "",
        "## What it does",
        "",
        kpis,
        "",
        "## What it costs",
        "",
        costTable(baseline, best),
        runners,
        trace,
        "",
        "---",
        "",
        "The plan above **is** a scenario: pass it to `what_if` or `simulate_day` to see it day by day, or open it in 3D.",
        "",
        "```json",
        JSON.stringify(best.scenario, null, 2),
        "```",
        "",
        link,
        "",
        "_The best plan found, not a proof of optimality. Every candidate was scored on the same engine seeds the 3D page replays, so the winner plays back exactly._",
      ].join("\n")
    );
  });
}
