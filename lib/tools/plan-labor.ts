/**
 * The season's hours against the roster, and what to do about the gap.
 *
 * The arithmetic is the warehouse's — workload is expected volume times an
 * engineered standard, and requirement is workload ÷ productivity ÷ target
 * utilization ÷ (1 − absenteeism) — but a shop's answer to a gap is narrower.
 * Overtime first, then agency temps, and then a wall: a temp cannot work behind
 * the glass or take the van out, because a food handler's card and the store's
 * driving insurance both take longer than a season. Those two gaps can only be
 * closed by cross-training somebody already on the payroll or by hiring, and
 * the plan names the lead time for each.
 *
 * Weekly hours and a Saturday teatime queue are different things, so the plan
 * closes with a simulation of the heaviest week: a shop can be comfortably
 * under-utilised across the week and still lose customers at 17:30.
 */

import { replicate } from "../twin/replicate";
import { buildTwin, scenarioShape, storeSchema } from "../twin/twin";
import { expectedWorkload, planSeason } from "../twin/workforce";
import { clockOf, fmt1, guarded, money, pct, pct1, readOnlyOpenWorld, scenarioLine, storeName, text, waitMin, z } from "./shared";

/** One week of floor, three ways, is enough to tell a queue from a rounding error. */
const CHECK_DAYS = 7;
const CHECK_RUNS = 3;
/** Hours an agency books a temp for in a week. */
const TEMP_WEEK_HOURS = 30;

export const planLaborConfig = {
  title: "Plan labor through the season",
  description:
    "Week by week for up to 26 weeks: the hours each skill needs from candystore's seasonal volume and the engineered standards, what the roster covers, " +
    "the gap, and how to close it — overtime, agency temps, and the counter and van hours only cross-training or hiring can fix, with their lead times and " +
    "the cost. Then simulates the heaviest week as planned and with the plan's temps added, to check it against the queue rather than the timesheet.",
  inputSchema: z
    .object({
      store: storeSchema,
      startWeek: z.number().int().min(1).max(52).default(36),
      weeks: z.number().int().min(1).max(26).default(12),
      validate: z.boolean().default(true).describe("Also simulate the heaviest week with and without the plan's temps."),
      targetUtilization: scenarioShape.targetUtilization,
      absenteeism: scenarioShape.absenteeism,
      addWorkers: scenarioShape.addWorkers,
      removeWorkers: scenarioShape.removeWorkers,
      crossTrain: scenarioShape.crossTrain,
      merchandising: scenarioShape.merchandising,
      demandScale: scenarioShape.demandScale,
      hours: scenarioShape.hours,
      operatingDays: scenarioShape.operatingDays,
      candystore: scenarioShape.candystore,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof planLaborConfig.inputSchema>;

export async function planLaborHandler(args: Args) {
  return guarded(async () => {
    const { store, startWeek, weeks, validate, ...scenario } = args;
    const ctx = await buildTwin(store, startWeek, scenario);
    const plan = planSeason(ctx.workloadContext, ctx.workers, ctx.costs, 0, weeks, ctx.scheduleOptions);

    const rows = plan.map(
      (w) =>
        `| ${w.calendarWeek} | ${fmt1(w.requiredHours)} | ${fmt1(w.rosterHours)} | ${w.overtimeHours > 0.05 ? fmt1(w.overtimeHours) : "—"} | ${w.tempHours > 0.05 ? `${fmt1(w.tempHours)} (${Math.ceil(w.tempHours / TEMP_WEEK_HOURS - 1e-9)})` : "—"} | ${w.gapHours > 0.25 ? fmt1(w.gapHours) : "—"} | ${money(w.laborCost)} |`
    );
    const total = plan.reduce((a, w) => a + w.laborCost, 0);
    const totalGap = plan.reduce((a, w) => a + w.gapHours, 0);

    // One line per distinct recommendation, earliest week first, so a plan for
    // six months does not repeat the same sentence twenty times.
    const seen = new Map<string, number>();
    for (const w of plan) {
      for (const n of w.notes) {
        if (n.startsWith("The roster covers")) continue;
        if (!seen.has(n)) seen.set(n, w.calendarWeek);
      }
    }
    const advice = [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

    const lines = [
      `# Labor plan for ${storeName(ctx)}: ${weeks} weeks from week ${startWeek}`,
      scenarioLine(ctx),
      `Requirement = standard minutes ÷ average productivity ÷ ${pct(ctx.scheduleOptions.targetUtilization)} target utilization ÷ (1 − ${pct(ctx.scheduleOptions.absenteeism)} absenteeism). ` +
        `Cross-trained people cover a short skill out of their spare hours before anything counts as a gap; overtime is capped at 8 h a person a week before a temp is booked.`,
      ``,
      `| week | required h | rostered h | overtime h | temp h (people) | still short h | cost |`,
      `|---|---:|---:|---:|---:|---:|---:|`,
      ...rows,
      ``,
      `Total ${money(total)} over ${weeks} weeks${totalGap > 0.25 ? `, with ${fmt1(totalGap)} hours neither overtime nor a temp can cover` : `, with every week covered`}.`,
      ``,
      `## What to do`,
      ...(advice.length ? advice.map(([note, week]) => `- **From week ${week}:** ${note}`) : [`- Nothing. The roster covers every week at the target utilization without overtime or temps.`]),
    ];

    if (validate) {
      const peak = plan.reduce((best, w) => (w.requiredHours > best.requiredHours ? w : best), plan[0]);
      const load = expectedWorkload(ctx.workloadContext, peak.week);
      const busiestShift = Object.keys(load.byShift).sort((a, b) => load.byShift[b] - load.byShift[a] || a.localeCompare(b))[0] ?? ctx.site.shifts[0].id;
      const worstDay = load.days.reduce((best, d) => (d.peakHalfHour.minutes > best.peakHalfHour.minutes ? d : best), load.days[0]);
      const temps = Math.ceil(peak.tempHours / TEMP_WEEK_HOURS - 1e-9);

      const asIs = replicate(await buildTwin(store, peak.calendarWeek, scenario), CHECK_DAYS, CHECK_RUNS);
      const row = (label: string, k: typeof asIs.mean) =>
        `| ${label} | ${money(k.salesDollars)} | ${money(k.lostShelfDollars + k.lostQueueDollars)} | ${fmt1(k.abandoned)} | ${waitMin(k.registerWaitP90Min)} | ${pct1(k.onShelfShare)} | ${fmt1(k.overtimeHours)} | ${pct(k.utilization)} | ${money(k.laborCost)} |`;
      const table = [
        `| roster | sales | lost sales | walk-outs | till p90 | on-shelf | OT h | busy | labor cost |`,
        `|---|---:|---:|---:|---:|---:|---:|---:|---:|`,
        row("as planned, no temps", asIs.mean),
      ];
      if (temps > 0) {
        const withTemps = replicate(
          await buildTwin(store, peak.calendarWeek, { ...scenario, addWorkers: [...(scenario.addWorkers ?? []), { role: "cashier", shift: busiestShift, type: "temp" as const, count: temps }] }),
          CHECK_DAYS,
          CHECK_RUNS
        );
        table.push(row(`+${temps} temp cashier(s) on ${busiestShift}`, withTemps.mean));
      }
      lines.push(
        ``,
        `## Check on the floor: week ${peak.calendarWeek}, the heaviest (${CHECK_RUNS} runs)`,
        `The busiest shift that week is \`${busiestShift}\`, and the heaviest half hour at the counter is ${clockOf(worstDay.peakHalfHour.minuteOfDay)} on ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][worstDay.weekday - 1]}, with ${fmt1(worstDay.peakHalfHour.minutes)} standard minutes of serving and ringing up landing in it.`,
        ``,
        ...table,
        ``,
        `Restocking, receiving and picking can wait an hour; a queue cannot. That is why the plan balances the week in hours and this table asks the other question — ` +
          `whether the people are on the floor at the half hour the customers are. A temp here is a cashier, the role that needs no certification.`
      );
    }
    return text(lines.join("\n"));
  });
}
