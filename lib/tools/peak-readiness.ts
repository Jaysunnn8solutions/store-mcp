/**
 * Halloween is 2.4× an ordinary week in the candy calendar, and a shop that
 * trades comfortably in September can lose a fifth of its Saturday customers
 * to the queue in week 44. This tool asks the one question a manager asks in
 * August — will we cope, and if not, what is the cheapest thing to do about it
 * — and answers it by running the peak week as it stands and then again with
 * each fix in turn, on the same seeds.
 *
 * Every fix is written in the same public scenario vocabulary any other tool
 * takes, so the winner can be handed straight to what_if or simulate_day and
 * watched in 3D. Nothing here reaches past the engine's own contract.
 *
 * The prices are the store's cost rates: a register lane and a showcase station
 * by the week, a temp by the shift, cross-training spread over six months. The
 * benefit is lost sales recovered at gross margin. Neither is a forecast; both
 * are inputs, and both are printed so they can be argued with.
 */

import { replicate, type Kpis } from "../twin/replicate";
import { seasonFactor } from "../twin/season";
import { buildTwin, type TwinScenario } from "../twin/twin";
import { expectedWorkload } from "../twin/workforce";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { fmt1, guarded, money, pct1, readOnlyOpenWorld, scenarioLine, storeLink, storeName, text, waitMin, z } from "./shared";

/** A temp is booked by the agency in blocks of about this many hours. */
const TEMP_WEEK_HOURS = 30;
/** Cross-training is a one-off cost a shop spreads over roughly half a year. */
const CROSS_TRAIN_WEEKS = 26;
/** A planogram reset is a Sunday night, spread over a quarter. */
const RESET_WEEKS = 13;
/** Minutes to move one SKU to a new facing, matching optimize_merchandising's default. */
const MINUTES_PER_MOVE = 12;

export const peakReadinessConfig = {
  title: "Halloween readiness, and the cheapest fix",
  description:
    "Run one shop through the peak week as it stands, check it against the service targets — the checkout queue, the showcase queue, walk-outs, on-shelf " +
    "availability and the delivery van — and if it misses any of them, price a menu of fixes on the same random draws: an extra register, another showcase " +
    "station, a temp cashier or stocker, cross-training someone onto the counter, another van, a higher overtime cap and a re-merchandised floor. Reports " +
    "what each costs a week, what it recovers in lost sales, whether it clears the targets, and what has to be booked now given the lead times.",
  inputSchema: z
    .object({
      store: baseShape.store,
      week: z.number().int().min(1).max(52).default(44).describe("The peak week to test; 44 is Halloween, 51 Christmas, 6 Valentine's."),
      days: z.number().int().min(3).max(14).default(7),
      runs: z.number().int().min(1).max(5).default(2),
      targetWaitMin: z.number().min(0.5).max(60).default(6).describe("Longest acceptable 90th-percentile queue wait, minutes, at the till and at the glass."),
      targetWalkOutRate: z.number().min(0).max(0.5).default(0.02).describe("Largest acceptable share of customers who leave without paying."),
      targetOnShelf: z.number().min(0.5).max(1).default(0.97).describe("Smallest acceptable share of merchandised facings with something on them."),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof peakReadinessConfig.inputSchema>;

interface Candidate {
  label: string;
  scenario: TwinScenario;
  /** What it adds to the weekly bill beyond the labor the engine already charges. */
  fixedWeekly: number;
  /** Weeks of notice the fix needs before the peak. */
  leadWeeks: number;
}

export async function peakReadinessHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const r = rest as { store: string; week: number; days: number; runs: number; targetWaitMin: number; targetWalkOutRate: number; targetOnShelf: number };

    const base = await buildTwin(r.store, r.week, scenario);
    const { site, costs } = base;
    const baseRep = replicate(base, r.days, r.runs);

    const checksFor = (k: Kpis) => [
      { label: "checkout queue", ok: k.registerWaitP90Min <= r.targetWaitMin, value: waitMin(k.registerWaitP90Min), target: `≤ ${waitMin(r.targetWaitMin)}` },
      { label: "showcase queue", ok: k.counterWaitP90Min <= r.targetWaitMin, value: waitMin(k.counterWaitP90Min), target: `≤ ${waitMin(r.targetWaitMin)}` },
      { label: "walk-outs", ok: k.abandonRate <= r.targetWalkOutRate, value: pct1(k.abandonRate), target: `≤ ${pct1(r.targetWalkOutRate)}` },
      { label: "on-shelf availability", ok: k.onShelfShare >= r.targetOnShelf, value: pct1(k.onShelfShare), target: `≥ ${pct1(r.targetOnShelf)}` },
      { label: "delivery van", ok: k.vanLateRounds < 0.5, value: `${fmt1(k.vanLateRounds)} late rounds`, target: "on time" },
    ];
    const baseChecks = checksFor(baseRep.mean);
    const failing = baseChecks.filter((c) => !c.ok);

    // Who to put the extra hands on: the shift the week's own workload says is
    // busiest, rather than a guess.
    const load = expectedWorkload(base.workloadContext, 0);
    const busiestShift = Object.keys(load.byShift).sort((a, b) => load.byShift[b] - load.byShift[a] || a.localeCompare(b))[0] ?? site.shifts[0].id;
    const openShift = site.shifts[0].id;

    // Cross-training targets are named by worker id, not by role, so the
    // scenario cannot match nobody and fail the whole tool.
    const teachable = base.workers.filter((w) => w.type !== "temp" && w.skills.includes("register") && !w.skills.includes("counter")).slice(0, 2);

    const add = (extra: NonNullable<TwinScenario["addWorkers"]>) => [...(scenario.addWorkers ?? []), ...extra];
    const resetMoves = base.rates.length;

    const candidates: Candidate[] = [
      { label: `+1 register (${site.checkout.registers} → ${site.checkout.registers + 1})`, scenario: { ...scenario, registers: Math.min(12, site.checkout.registers + 1) }, fixedWeekly: costs.registerWeekly, leadWeeks: 4 },
      { label: `+1 temp cashier on the ${busiestShift} shift`, scenario: { ...scenario, addWorkers: add([{ role: "cashier", shift: busiestShift, type: "temp", count: 1 }]) }, fixedWeekly: 0, leadWeeks: 1 },
      { label: `+1 temp stocker on the ${openShift} shift`, scenario: { ...scenario, addWorkers: add([{ role: "stocker", shift: openShift, type: "temp", count: 1 }]) }, fixedWeekly: 0, leadWeeks: 1 },
      { label: "re-merchandise the floor", scenario: { ...scenario, merchandising: "optimized" }, fixedWeekly: ((resetMoves * MINUTES_PER_MOVE) / 60) * (base.workers.reduce((a, w) => a + w.hourlyRate, 0) / Math.max(1, base.workers.length)) / RESET_WEEKS, leadWeeks: 1 },
      { label: "overtime cap 2 h → 3 h", scenario: { ...scenario, overtimeMaxHours: 3 }, fixedWeekly: 0, leadWeeks: 0 },
    ];
    if (site.showcase) {
      candidates.splice(1, 0, {
        label: `+1 showcase station (${site.showcase.stations} → ${site.showcase.stations + 1})`,
        scenario: { ...scenario, counters: Math.min(8, site.showcase.stations + 1) },
        fixedWeekly: costs.counterWeekly,
        leadWeeks: 4,
      });
    }
    if (teachable.length > 0) {
      candidates.push({
        label: `cross-train ${teachable.map((w) => w.id).join(" and ")} onto the counter`,
        scenario: { ...scenario, crossTrain: [...(scenario.crossTrain ?? []), ...teachable.map((w) => ({ worker: w.id, skill: "counter" as const }))] },
        fixedWeekly: (teachable.length * costs.crossTrainCost) / CROSS_TRAIN_WEEKS,
        leadWeeks: costs.crossTrainWeeks,
      });
    }
    if (baseRep.mean.vanLateRounds >= 0.5) {
      candidates.push({ label: `+1 van (${site.equipment.vans} → ${site.equipment.vans + 1})`, scenario: { ...scenario, vans: site.equipment.vans + 1 }, fixedWeekly: costs.vanWeekly, leadWeeks: 2 });
    }

    const margin = 1 - costs.costOfGoods;
    const perWeek = (x: number) => (x / r.days) * 7;
    const lostOf = (k: Kpis) => k.lostShelfDollars + k.lostQueueDollars;
    const baseLost = perWeek(lostOf(baseRep.mean));
    const baseLabor = perWeek(baseRep.mean.laborCost);

    const scored: Array<{ c: Candidate; k: Kpis; checks: ReturnType<typeof checksFor>; clears: boolean; cost: number; recovered: number; net: number }> = [];
    for (const c of candidates) {
      const rep = replicate(await buildTwin(r.store, r.week, c.scenario), r.days, r.runs);
      const checks = checksFor(rep.mean);
      const recovered = baseLost - perWeek(lostOf(rep.mean));
      const cost = perWeek(rep.mean.laborCost) - baseLabor + c.fixedWeekly;
      scored.push({ c, k: rep.mean, checks, clears: checks.every((x) => x.ok), cost, recovered, net: recovered * margin - cost });
    }
    // Cheapest fix that clears wins; failing that, the best margin left over.
    scored.sort((a, b) => Number(b.clears) - Number(a.clears) || (a.clears ? a.cost - b.cost : b.net - a.net));

    // The per-target columns already say which ones a fix misses, so this one
    // only counts them; repeating four labels on every row buries the numbers.
    const rows = scored.map((s) => {
      const missed = s.checks.filter((c) => !c.ok).length;
      return (
        `| ${s.c.label} | ${money(s.cost)} | ${money(s.recovered)} | ${money(s.net)} | ${waitMin(s.k.registerWaitP90Min)} | ${waitMin(s.k.counterWaitP90Min)} | ` +
        `${pct1(s.k.abandonRate)} | ${pct1(s.k.onShelfShare)} | ${fmt1(s.k.vanLateRounds)} | ${s.clears ? "clears" : `${missed} missed`} | ${s.c.leadWeeks} wk |`
      );
    });
    const winner = scored[0];
    const ready = failing.length === 0;

    const verdict = ready
      ? `**${site.name} is ready for week ${r.week}.** Every target is met as the shop stands: ${baseChecks.map((c) => `${c.label} ${c.value}`).join(", ")}. It still loses ${money(baseLost)} a week of sales, so the table below prices what buying that back would cost.`
      : `**${site.name} is not ready for week ${r.week}.** It misses ${failing.length} of ${baseChecks.length} targets — ${failing.map((c) => `${c.label} at ${c.value} against ${c.target}`).join(", ")} — and loses ${money(baseLost)} a week of sales, ${money(baseLost * margin)} of it gross margin.`;

    const recommendation = winner
      ? winner.clears
        ? `**Cheapest fix that clears every target: ${winner.c.label}**, ${money(winner.cost)} a week, recovering ${money(winner.recovered)} of sales — ${money(winner.net)} a week net of margin. Book it ${winner.c.leadWeeks} week(s) out.`
        : `**No single fix clears every target.** The best of them on its own is ${winner.c.label} (${money(winner.net)} a week net), which still misses ${winner.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}. Combine the top two with what_if before committing to either.`
      : `No fixes were evaluated.`;

    return text(
      [
        `# Peak readiness: ${storeName(base)}, week ${r.week}`,
        scenarioLine(base),
        `Week ${r.week} runs ${fmt1(seasonFactor(r.week))}× an average week in the candy calendar. ${r.runs} run(s) of ${r.days} days, the same draws under every option.`,
        ``,
        verdict,
        ``,
        `| target | as it stands | wanted | |`,
        `|---|---:|---:|---|`,
        ...baseChecks.map((c) => `| ${c.label} | ${c.value} | ${c.target} | ${c.ok ? "met" : "**missed**"} |`),
        ``,
        `## What each fix buys`,
        `| fix | costs/week | lost sales recovered/week | net margin/week | till p90 | glass p90 | walk-outs | on-shelf | van late | targets | lead |`,
        `|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|`,
        ...rows,
        ``,
        recommendation,
        ``,
        `Prices are this shop's cost rates: a register lane ${money(costs.registerWeekly)} a week, a showcase station ${money(costs.counterWeekly)}, a van ${money(costs.vanWeekly)}, an agency temp ${money(costs.tempHourly * TEMP_WEEK_HOURS)} a week at ${Math.round(costs.tempProductivity * 100)}% of standard, ` +
          `cross-training $${costs.crossTrainCost} a head spread over ${CROSS_TRAIN_WEEKS} weeks, a hire $${costs.hireCost} with ${costs.hireWeeks} weeks' notice. A temp's own wages are in the labor the engine charges, so the "costs/week" column carries only what is on top. ` +
          `Recovered sales are valued at ${pct1(margin)} gross margin. The lead column is what has to be booked before the week, not after it: cross-training takes ${costs.crossTrainWeeks} weeks and a hire ${costs.hireWeeks}, which is why August is when this question gets asked.`,
        `Every option runs on the same seeds, but draws are consumed in event order and a fix that changes the floor — a register, a station, the planogram — changes what goes in a basket as well, which shifts the sequence. ` +
          `Read a recovery of a few hundred dollars either way as noise rather than as an effect, and confirm the two or three that matter with what_if.`,
        ``,
        storeLink(r.store, r.week, r.days, winner ? winner.c.scenario : scenario),
      ].join("\n")
    );
  });
}
