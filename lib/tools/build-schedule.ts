/**
 * One week's roster, laid out the way it goes on the wall.
 *
 * A primary skill is where a person starts the day, not where they spend it:
 * on the floor a cross-trained cashier steps onto the counter when the glass
 * queues and back to the till when it does not. So the grid is a starting
 * point, and the two lines under it are the ones worth arguing about — the
 * hours no primary and no flexing covered, and the days where one person is
 * the only one present who can do something.
 */

import { WEEKDAYS } from "../twin/standards";
import { buildTwin, scenarioShape, storeSchema } from "../twin/twin";
import { SKILLS } from "../twin/types";
import { buildWeekSchedule } from "../twin/workforce";
import { fmt1, guarded, money, pct, readOnlyOpenWorld, scenarioLine, storeName, text, z } from "./shared";

export const buildScheduleConfig = {
  title: "Build a week's schedule",
  description:
    "Who works which day and on what, for one shop and one calendar week: each person's primary skill per day, chosen to cover the scarcest skill first " +
    "with the least flexible people, the hours each skill needs and gets, what is still short, each person's hours and the wage bill, and the days where a " +
    "needed skill rests on one person present. Takes roster changes, merchandising and demand changes.",
  inputSchema: z
    .object({
      store: storeSchema,
      week: z.number().int().min(1).max(52).default(36).describe("Calendar week to schedule; the grid starts on its Monday."),
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

type Args = z.infer<typeof buildScheduleConfig.inputSchema>;

export async function buildScheduleHandler(args: Args) {
  return guarded(async () => {
    const { store, week, ...scenario } = args;
    const ctx = await buildTwin(store, week, scenario);
    const sched = buildWeekSchedule(ctx.workloadContext, ctx.workers, 0, ctx.scheduleOptions);
    const openDays = [...ctx.site.operatingDays].sort((a, b) => a - b);

    const wageOf = new Map(ctx.workers.map((w) => [w.id, w.hourlyRate]));
    const hoursOfWorker = new Map<string, number>();
    let regularCost = 0;
    for (const a of sched.assignments) {
      hoursOfWorker.set(a.worker, (hoursOfWorker.get(a.worker) ?? 0) + a.hours);
      regularCost += a.hours * (wageOf.get(a.worker) ?? 0);
    }

    const header = `| worker | role | shift | ${openDays.map((d) => WEEKDAYS[d - 1]).join(" | ")} | hours |`;
    const sep = `|---|---|---|${openDays.map(() => "---").join("|")}|---:|`;
    const rows = ctx.workers.map((w) => {
      const cells = openDays.map((wd) => sched.assignments.find((a) => a.worker === w.id && a.weekday === wd)?.primary ?? "off");
      return `| ${w.id} | ${w.role}${w.type === "full-time" ? "" : ` (${w.type})`} | ${w.homeShift} | ${cells.join(" | ")} | ${fmt1(hoursOfWorker.get(w.id) ?? 0)} |`;
    });

    const gapBySkill = new Map(sched.gaps.map((g) => [g.skill, g.gapHours]));
    const skillRows = SKILLS.map((k) => {
      const req = sched.required[k];
      const cov = sched.covered[k];
      const gap = gapBySkill.get(k) ?? 0;
      if (req < 0.05 && cov < 0.05) return `| ${k} | — | — | — | — |`;
      return `| ${k} | ${fmt1(req)} | ${fmt1(cov)} | ${gap > 0.25 ? fmt1(gap) : "—"} | ${req > 0 ? pct(Math.min(1, cov / req)) : "—"} |`;
    });

    // Risks come back one per shift per day; collapse to one line per skill
    // and worker so a whole week does not read as forty identical warnings.
    const byRisk = new Map<string, { days: number[]; note: string }>();
    for (const r of sched.risks) {
      const key = `${r.skill}|${r.worker}`;
      const entry = byRisk.get(key);
      if (entry) entry.days.push(r.day);
      else byRisk.set(key, { days: [r.day], note: r.note });
    }
    const risks = [...byRisk.keys()].sort().map((key) => {
      const v = byRisk.get(key)!;
      const days = [...new Set(v.days)].sort((a, b) => a - b).map((d) => WEEKDAYS[((d % 7) + 7) % 7]);
      return `- ${v.note} (${days.join(", ")})`;
    });

    return text(
      [
        `# Schedule for ${storeName(ctx)}, week ${week}`,
        scenarioLine(ctx),
        ``,
        header,
        sep,
        ...rows,
        ``,
        `## Hours by skill, for the week`,
        `| skill | required | covered | short | covered |`,
        `|---|---:|---:|---:|---:|`,
        ...skillRows,
        ``,
        sched.gaps.length
          ? `**Short:** ${sched.gaps.map((g) => `${g.skill} ${fmt1(g.gapHours)} h`).join(", ")}, beyond what anyone present can flex into. ${fmt1(sched.spareHours)} rostered hours went unused elsewhere — that is the slack a flexing floor runs on, and it cannot reach these.`
          : `**No gaps:** primaries plus flexing cover every skill's hours, with ${fmt1(sched.spareHours)} rostered hours to spare.`,
        ``,
        risks.length ? `## One absence away from stopping` : `Every needed skill has at least two holders present on every shift this week.`,
        ...risks,
        ``,
        `Wage bill for the rostered hours: ${money(regularCost)}, before any overtime the floor actually runs. ` +
          `Required hours already carry the target-utilization and absenteeism allowances, so they are bigger than the standard minutes the work takes.`,
      ].join("\n")
    );
  });
}
