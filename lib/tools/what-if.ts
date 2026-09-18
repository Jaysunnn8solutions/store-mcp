/**
 * Two runs of the same fortnight on the same seeds, one as the shop is and one
 * with the scenario, so the difference in the table is the scenario and not
 * the weather.
 *
 * The baseline is the empty scenario rather than the caller's scenario minus
 * one field. That is a deliberate choice and a limitation worth knowing: a
 * field that changes demand also changes the draws it feeds, so a comparison
 * against a busier shop is a comparison of two different fortnights. The
 * closing note says so.
 */

import { replicate } from "../twin/replicate";
import { buildTwin } from "../twin/twin";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { daysSchema, fmt1, guarded, kpiTable, money, readOnlyOpenWorld, runsSchema, scenarioLine, storeLink, storeName, text, waitMin, z } from "./shared";

export const whatIfConfig = {
  title: "Compare a scenario with the baseline",
  description:
    "Simulate one shop twice over the same days with the same random draws, once as it is and once with the scenario, and report every KPI side by side " +
    "with the change and the bottleneck in each. Use it for an extra register or showcase station, a hire, cross-training someone onto the counter, " +
    "re-merchandising, longer trading hours, a demand surge, a till outage, a van off the road, a supplier running late or a candystore store opening nearby.",
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

type Args = z.infer<typeof whatIfConfig.inputSchema>;

export async function whatIfHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const { store, startWeek, days, runs } = rest as { store: string; startWeek: number; days: number; runs: number };
    const scenCtx = await buildTwin(store, startWeek, scenario);
    if (scenCtx.changes.length === 0 && Object.keys(scenario).length === 0) {
      return text('No scenario fields were given, so there is nothing to compare. Add at least one, for example registers: 3, merchandising: "optimized", counters: 2, or demandScale: 1.4.');
    }
    const baseCtx = await buildTwin(store, startWeek, {});
    const base = replicate(baseCtx, days, runs);
    const scen = replicate(scenCtx, days, runs);
    const b = base.bottleneck;
    const s = scen.bottleneck;

    const salesDelta = scen.mean.salesDollars - base.mean.salesDollars;
    const lostBase = base.mean.lostShelfDollars + base.mean.lostQueueDollars;
    const lostScen = scen.mean.lostShelfDollars + scen.mean.lostQueueDollars;
    const walkDelta = scen.mean.abandoned - base.mean.abandoned;
    const waitDelta = scen.mean.registerWaitP90Min - base.mean.registerWaitP90Min;
    const shelfDelta = scen.mean.onShelfShare - base.mean.onShelfShare;
    const costDelta = scen.mean.laborCost - base.mean.laborCost;

    const verdict: string[] = [];
    if (Math.abs(salesDelta) >= 100) verdict.push(`sells ${money(Math.abs(salesDelta))} ${salesDelta > 0 ? "more" : "less"} over ${days} days`);
    if (Math.abs(lostScen - lostBase) >= 100) verdict.push(`${lostScen < lostBase ? "saves" : "adds"} ${money(Math.abs(lostScen - lostBase))} of lost sales`);
    if (Math.abs(walkDelta) >= 1) verdict.push(`${walkDelta < 0 ? "keeps" : "loses"} ${fmt1(Math.abs(walkDelta))} more shoppers at the queue`);
    if (Math.abs(waitDelta) >= 0.5) verdict.push(`p90 register wait ${waitDelta < 0 ? "down" : "up"} ${waitMin(Math.abs(waitDelta))}`);
    if (Math.abs(shelfDelta) >= 0.005) verdict.push(`on-shelf ${shelfDelta > 0 ? "up" : "down"} ${(Math.abs(shelfDelta) * 100).toFixed(1)} points`);
    if (Math.abs(costDelta) >= 50) verdict.push(`labor cost ${costDelta > 0 ? "+" : "−"}${money(Math.abs(costDelta))}`);

    return text(
      [
        `# What if, at ${storeName(scenCtx)}: ${days} days from week ${startWeek}, ${runs} run(s) each, same draws`,
        scenarioLine(scenCtx),
        ``,
        kpiTable(
          [
            ["baseline", base.mean],
            ["scenario", scen.mean],
          ],
          true
        ),
        ``,
        `**Bottleneck:** baseline ${b.process ? `${b.process} (${b.constraint})` : "none"}; scenario ${s.process ? `${s.process} (${s.constraint})` : "none"}.`,
        `**In short:** the scenario ${verdict.length ? verdict.join(", ") : "changes nothing material at this horizon"}.`,
        ``,
        `Means over runs. Customer arrivals, baskets, supplier lead times and absences run on the same seeds on both sides, so the difference is the scenario. ` +
          `Draws are consumed in event order, though, so anything that changes what goes in a basket shifts the sequence too — a demand change obviously, and a floor change as well, since where a SKU sits changes how often it is reached for. ` +
          `Read a small difference in customers in as that, not as an effect of the scenario.`,
        ``,
        // The scenario side; the page's compare view runs the baseline on the same seed.
        storeLink(store, startWeek, days, scenario),
      ].join("\n")
    );
  });
}
