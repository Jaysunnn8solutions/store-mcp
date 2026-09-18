/**
 * The crew, and the two skills a small shop keeps losing sleep over. A food
 * handler's card and a driving licence with the store's insurance behind it
 * both take longer to get than a season, so the counter and the van are where
 * a twelve-person roster is one phone call from not being able to trade
 * properly. That is what `singlePointsOfFailure` looks for and what the
 * roster table is arranged to show.
 */

import { DEFAULT_COSTS, DEFAULT_STANDARDS, shiftPaidHours } from "../twin/standards";
import { buildTwin, scenarioShape, storeSchema } from "../twin/twin";
import { SKILLS } from "../twin/types";
import { singlePointsOfFailure } from "../twin/workforce";
import { dollars2, guarded, readOnly, scenarioLine, storeName, text, z } from "./shared";

export const getWorkforceConfig = {
  title: "Crew, skills and labor standards",
  description:
    "One shop's roster: each person's id, role, shift, employment type, skills, productivity and wage; how many people hold each skill and which skills " +
    "rest on one person or nobody; the engineered labor standards and cost rates every plan in this twin is built from. Accepts addWorkers, removeWorkers, " +
    "crossTrain and workerOverrides to preview a changed roster before simulating it.",
  inputSchema: z
    .object({
      store: storeSchema,
      addWorkers: scenarioShape.addWorkers,
      removeWorkers: scenarioShape.removeWorkers,
      crossTrain: scenarioShape.crossTrain,
      workerOverrides: scenarioShape.workerOverrides,
    })
    .strict(),
  annotations: readOnly,
};

type Args = z.infer<typeof getWorkforceConfig.inputSchema>;

export async function getWorkforceHandler({ store, ...people }: Args) {
  return guarded(async () => {
    const ctx = await buildTwin(store, 36, people);
    const { workers, site } = ctx;

    const rows = workers.map(
      (w) => `| ${w.id} | ${w.role} | ${w.type} | ${w.homeShift} | ${w.skills.join(", ")} | ${w.productivity.toFixed(2)} | ${dollars2(w.hourlyRate)} | ${w.maxWeeklyHours} |`
    );
    const coverage = SKILLS.map((k) => {
      const holders = workers.filter((w) => w.skills.includes(k));
      return `| ${k} | ${holders.length} | ${holders.map((h) => h.id).join(", ") || "—"} |`;
    });
    const single = singlePointsOfFailure(workers);

    // What the roster is worth in hours: whole shifts, since nobody is booked
    // for a fraction of one.
    let weeklyHours = 0;
    for (const w of workers) {
      const shift = site.shifts.find((s) => s.id === w.homeShift) ?? site.shifts[0];
      const paid = Math.max(1e-6, shiftPaidHours(shift.start, shift.end) - shift.breakMin / 60);
      weeklyHours += Math.floor(w.maxWeeklyHours / paid) * paid;
    }

    const s = DEFAULT_STANDARDS;
    const c = DEFAULT_COSTS;
    return text(
      [
        `# Crew at ${storeName(ctx)}`,
        scenarioLine(ctx),
        ``,
        `${workers.length} people, about ${Math.round(weeklyHours)} scheduled hours a week across ${site.operatingDays.length} trading days. ` +
          `Shifts: ${site.shifts.map((x) => `${x.id} ${x.start}–${x.end} (${x.breakMin} min unpaid break, ${x.indirectMin} min indirect — huddle, counts, cleaning, cash-up)`).join("; ")}.`,
        ``,
        `| id | role | type | shift | skills | productivity | wage | max h/wk |`,
        `|---|---|---|---|---|---:|---:|---:|`,
        ...rows,
        ``,
        `| skill | holders | who |`,
        `|---|---:|---|`,
        ...coverage,
        ``,
        single.length ? `**Thin cover**` : `**Every skill has at least two holders on the standing roster.**`,
        ...single.map((p) => `- ${p.note}`),
        ``,
        `**Labor standards (minutes, before a person's productivity factor).** ` +
          `Receiving: ${s.unloadPerTruck}/truck plus ${s.unloadPerPallet}/pallet off the trailer or ${s.unloadPerCase}/case off a tailgate; ${s.receivePerCase} to receive a case, ${s.labelPerImportCase} more to label an imported one; ${s.putawayHandling} to put a move away plus the walk at ${s.walkFtPerMin} ft/min. ` +
          `Stocking: ${s.restockPerTrip} to build and return a cart, ${s.restockPerCase} a case worked onto a shelf, ${s.restockPerTray} to decant a bulk bin or a showcase tray, ${s.restockBendReachSec}s extra for a shelf below the knee or above the shoulder. ` +
          `Serving: ${s.servePerCustomer} to greet and box at the glass plus ${s.servePerItem} an item; ${s.checkoutPerCustomer} to open and tender plus ${s.checkoutPerItem} an item and ${s.checkoutWeighSec}s to weigh one; ${s.giftWrapPerOrder} to gift-wrap. ` +
          `Orders out: ${s.pickPerTour} a tour plus ${s.pickPerLine} a line and ${s.pickPerUnit} a unit; ${s.packPerOrder} to pack plus ${s.packPerLine} a line; ${s.loadPerVan} to load a van plus ${s.loadPerOrder} an order; ${s.deliverPerStop} a stop and ${s.deliverPerMile} a mile on a ${s.routeBaseMiles}-mile base round. ` +
          `Capacity: a cart carries ${s.cartCubeFt} cu ft, a pallet ${s.palletCubeFt}; a selling shelf is ${s.shelfHeightFt} ft clear; an optimized facing is sized to ${s.facingDaysOfSupply} days of supply.`,
        `**Cost rates.** Overtime ×${c.overtimeMultiplier}; agency temps ${dollars2(c.tempHourly)}/h at ${Math.round(c.tempProductivity * 100)}% of standard, and never behind the glass or on the van; cross-training $${c.crossTrainCost} and ${c.crossTrainWeeks} weeks; a hire $${c.hireCost} and ${c.hireWeeks} weeks. ` +
          `Cost of goods is ${Math.round(c.costOfGoods * 100)}% of retail. A van costs $${c.vanWeekly}/week standing and running, a register lane $${c.registerWeekly}, a showcase station $${c.counterWeekly}.`,
      ]
        .filter((l) => l !== "")
        .join("\n")
    );
  });
}
