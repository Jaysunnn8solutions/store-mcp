/**
 * The flagship. Everything else in this surface is either an input to this run
 * or a different way of reading it.
 *
 * The sections are ordered the way a store manager reads a week: what the shop
 * sold and what it did not, then which queue was the reason, then the people,
 * then the days. It closes with a link that replays run 1 in three dimensions,
 * because `replicate` runs seeds 1..runs and the page runs seed 1 — so the
 * first column of the table above and the shop on the screen are the same
 * fortnight, minute for minute.
 */

import { replicate } from "../twin/replicate";
import { calendarWeekOfDay } from "../twin/season";
import { buildTwin } from "../twin/twin";
import { PROCESS_SKILL, PROCESSES } from "../twin/types";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { dayLabel, daysSchema, fmt1, fmtInt, guarded, kpiTable, money, pct, pct1, readOnlyOpenWorld, runsSchema, scenarioLine, storeLink, storeName, text, waitMin, z } from "./shared";

export const simulateDayConfig = {
  title: "Simulate the shop",
  description:
    "Run one shop minute by minute for up to eight weeks from a calendar week: customers arriving, walking the aisles, taking stock off the facings, " +
    "queueing at the showcase and the till — and walking out when the queue outlasts their patience — while the crew restocks, receives the overnight " +
    "trailer and the day's vendor trucks, and picks, packs and loads the van before the doors open. Reports sales and lost sales, queue waits, on-shelf " +
    "availability, labor and cost, each process's queue, each person's day, the bottleneck and a day-by-day table. Accepts every scenario field.",
  inputSchema: z
    .object({
      ...baseShape,
      days: daysSchema.default(14),
      runs: runsSchema.default(3),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof simulateDayConfig.inputSchema>;

export async function simulateDayHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const { store, startWeek, days, runs } = rest as { store: string; startWeek: number; days: number; runs: number };
    const ctx = await buildTwin(store, startWeek, scenario);
    const rep = replicate(ctx, days, runs);
    const first = rep.runs[0];
    const k = rep.mean;

    const procRows = PROCESSES.map((p) => {
      const jobs = rep.runs.reduce((a, r) => a + r.processes[p].jobs, 0) / runs;
      const busy = rep.runs.reduce((a, r) => a + r.processes[p].busyMin, 0) / runs;
      const wait = rep.runs.reduce((a, r) => a + r.processes[p].waitTotalMin, 0) / runs;
      const eq = rep.runs.reduce((a, r) => a + r.processes[p].equipmentWaitMin, 0) / runs;
      const maxQ = Math.max(...rep.runs.map((r) => r.processes[p].maxQueue));
      const maxWait = Math.max(...rep.runs.map((r) => r.processes[p].waitMaxMin));
      return `| ${p} | ${PROCESS_SKILL[p]} | ${fmt1(jobs)} | ${fmt1(busy / 60)} | ${jobs ? waitMin(wait / jobs) : "—"} | ${waitMin(maxWait)} | ${maxQ} | ${wait > 0 ? pct(eq / wait) : "—"} |`;
    });

    const workerRows = first.workers.map((w) => {
      const top = Object.entries(w.byProcess)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p, m]) => `${p} ${fmt1(m / 60)}h`)
        .join(", ");
      const prim = Object.entries(w.primaries)
        .map(([s, n]) => `${s}×${n}`)
        .join(", ");
      const paid = w.paidHours + w.overtimeHours;
      return `| ${w.id} | ${w.role} | ${w.shiftsWorked} | ${w.absences} | ${fmt1(paid)} | ${fmt1(w.overtimeHours)} | ${paid ? pct(w.busyHours / paid) : "—"} | ${prim || "—"} | ${top || "—"} |`;
    });

    const dayRows = first.daily
      .filter((d) => d.open)
      .map(
        (d) =>
          `| ${dayLabel(d.day)} | wk ${d.calendarWeek} | ${fmtInt(d.customers)} | ${fmtInt(d.transactions)} | ${money(d.salesDollars)} | ${money(d.lostShelfDollars)} | ` +
          `${d.abandoned}${d.lostQueueDollars ? ` (${money(d.lostQueueDollars)})` : ""} | ${waitMin(d.registerWaitAvgMin)} | ${waitMin(d.counterWaitAvgMin)} | ` +
          `${d.restocks}${d.hotRestocks ? ` (${d.hotRestocks})` : ""} | ${d.ordersDue}${d.ordersLate ? ` (${d.ordersLate} late)` : ""} | ${d.inboundTrucks}/${fmtInt(d.inboundCases)} | ${fmt1(d.overtimeHours)} | ${d.absences} |`
      );

    const lateOrders = first.orderRecords
      .filter((o) => o.lateMin > 0)
      .sort((a, b) => b.lateMin - a.lateMin)
      .slice(0, 5);

    const res = first.resources;
    const endWeek = calendarWeekOfDay(startWeek, days - 1);
    const b = rep.bottleneck;
    const lost = k.lostShelfDollars + k.lostQueueDollars;

    return text(
      [
        `# ${storeName(ctx)}: ${days} days from week ${startWeek}${endWeek !== startWeek ? ` to week ${endWeek}` : ""}, ${runs} run(s)`,
        scenarioLine(ctx),
        ``,
        `${money(k.salesDollars)} sold to ${fmtInt(k.transactions)} of ${fmtInt(k.customers)} customers, and ${money(lost)} not sold — ${money(k.lostShelfDollars)} because the facing was empty and ${money(k.lostQueueDollars)} because ${fmt1(k.abandoned)} shoppers put the basket down and left. ` +
          `That second number is the one this model exists for: it is a staffing decision wearing a sales figure.`,
        ``,
        kpiTable([["mean", k], ...(runs > 1 ? ([["worst run", rep.worst]] as Array<[string, typeof k]>) : [])]),
        ``,
        `**Bottleneck:** ${b.process ? `${b.process}, about ${fmt1(b.waitHours)} job-hours of floor-time waiting per run; ${b.constraint}.` : b.constraint}`,
        `**Service points (run 1):** registers busy ${pct(res.registers.utilization)} of trading time across ${res.registers.count}, showcase ${pct(res.counters.utilization)} across ${res.counters.count}, gift wrap ${res.wrap.count ? pct(res.wrap.utilization) : "—"}; ` +
          `stock carts ${pct(res.stockCarts.utilization)}, van(s) ${res.vans.count ? pct(res.vans.utilization) : "—"}, goods doors ${pct(res.docks.utilization)}.`,
        `**Stock (run 1):** ${money(first.stock.retailStart)} of retail value in the building at the start and ${money(first.stock.retailEnd)} at the end; ${fmtInt(first.stock.backroomCases)} master cases in a stockroom with ${fmtInt(first.stock.backroomPositions)} positions.` +
          (first.inbound.palletsNotPutAway > 0 ? ` ${fmtInt(first.inbound.palletsNotPutAway)} pallet(s) never made it off the apron.` : ``),
        ``,
        `## Processes (mean per run)`,
        `| process | skill | jobs | busy h | avg wait | max wait | max queue | wait held by a till, a counter or a cart |`,
        `|---|---|---:|---:|---:|---:|---:|---:|`,
        ...procRows,
        ``,
        `A customer-facing wait is real minutes, because the person is standing there. Every other wait is floor time: hours with nobody on shift are not counted, so work carried overnight shows as the shift minutes it sat.`,
        ``,
        `## Crew (run 1)`,
        `| worker | role | shifts | absent | paid h | OT h | busy | primary skill days | where the time went |`,
        `|---|---|---:|---:|---:|---:|---:|---|---|`,
        ...workerRows,
        ``,
        `## Days (run 1)`,
        `| day | week | customers | transactions | sales | lost, shelf | walk-outs | register wait | counter wait | restocks (hot) | orders due | trucks/cases | OT h | absent |`,
        `|---|---|---:|---:|---:|---:|---|---:|---:|---|---|---|---:|---:|`,
        ...dayRows,
        lateOrders.length
          ? `\nLatest special orders in run 1: ${lateOrders.map((o) => `${o.id} (${o.kind}) ${dayLabel(o.dueDay)} ${o.outAt === null ? "never went out" : `${waitMin(o.lateMin)} late`}`).join("; ")}.`
          : `\nEvery special order went out on time in run 1.`,
        ``,
        `Dollars are candystore retail value. Buying follows the ${ctx.policy.forecast} forecast at ${pct1(ctx.policy.serviceLevel)} cycle service, and every run warms up six weeks so the shelves start where a trading shop's shelves start. ` +
          `On-shelf availability is the share of merchandised facings with something on them — it moves before lost sales do, which is what makes it worth watching.`,
        ``,
        // Run 1 is seed 1 (replicate runs seeds 1..runs), which is what the page plays.
        storeLink(store, startWeek, days, scenario),
      ].join("\n")
    );
  });
}
