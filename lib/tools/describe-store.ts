/**
 * The orientation tool, and the only one with no arguments. It is what a model
 * reads first, so it does two jobs: it names the five shops and their ids, and
 * it teaches the scenario vocabulary every other tool shares. The baseline
 * fortnight under each shop is a real simulation, not a stored number, so the
 * figures here and the figures from simulate_day are the same figures.
 */

import { loadCatalog, loadManifest, loadNetwork, loadRoster, loadSites } from "../data/load";
import { replicate } from "../twin/replicate";
import { seasonFactor } from "../twin/season";
import { buildTwin, scenarioShape } from "../twin/twin";
import { SKILLS } from "../twin/types";
import { fmt1, fmtInt, guarded, money, pct, pct1, readOnly, SITE_URL, text, waitMin, z } from "./shared";

/** Long enough for the stock to move and a weekend to land in it, cheap enough for five shops. */
const BASELINE_DAYS = 14;
const BASELINE_RUNS = 2;

/** "1 category", "2 categories" — this is the tool a caller reads first. */
function plural(n: number, one: string, many: string): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

export const describeStoreConfig = {
  title: "Describe the store twin",
  description:
    "What the twin models and how: the five candy shops, the market model behind their demand, and for each one the floor (gondola runs, bulk bins, wall " +
    "shelving, the showcase counter, the registers, the stockroom, the goods doors and the lot), the crew, the trading hours and a baseline fortnight of " +
    "trading. Also lists the other tools and the scenario fields they all share. Call first.",
  inputSchema: z.object({}).strict(),
  annotations: readOnly,
};

export async function describeStoreHandler() {
  return guarded(async () => {
    const network = loadNetwork();
    const sites = loadSites();
    const catalog = loadCatalog();
    const roster = loadRoster();
    const manifest = loadManifest();

    const lines: string[] = [
      `# Candy shops, on the floor`,
      ``,
      `A discrete-event model of five retail candy shops in Atlanta, minute by minute: customers through the door, along the aisles and into the queue; ` +
        `clerks weighing and boxing chocolates at the showcase; registers, gift wrap, restocking from the stockroom; the overnight trailer and the day's ` +
        `vendor trucks at the back door; and the delivery and pickup orders picked, packed and loaded onto the store's van before the doors open. ` +
        `A shopper who finds the queue longer than their patience walks out, and that is the number the whole model exists to put a figure on.`,
      ``,
      `Demand is candystore_mcp's: each shop's annual retail dollars by category, snapshotted from ${network.source} on ${network.fetchedAt.slice(0, 10)}, ` +
        `spread over the week and the trading day and through the candy calendar (Halloween week 44 runs ${fmt1(seasonFactor(44))}× an average week). ` +
        `The buildings, the catalog (${catalog.skus.length} SKUs from ${catalog.suppliers.length} suppliers), the roster (${roster.workers.length} people) and the labor standards are this project's own mock inputs.`,
      ``,
      `Selling units are pieces for packaged candy and pounds for anything scooped or weighed. Distances are feet, times minutes, money dollars.`,
      ``,
    ];

    for (const site of sites) {
      const store = network.stores.find((s) => s.id === site.store);
      const crew = roster.workers.filter((w) => w.store === site.id);
      const holders = SKILLS.map((k) => `${k} ${crew.filter((w) => w.skills.includes(k)).length}`).join(", ");
      const ctx = await buildTwin(site.id, 36, {});
      const rep = replicate(ctx, BASELINE_DAYS, BASELINE_RUNS);
      const k = rep.mean;
      const annual = store ? Object.values(store.revenueBy).reduce((a, b) => a + b, 0) : 0;
      const shifts = site.shifts.map((s) => `${s.id} ${s.start}–${s.end}`).join(", ");
      const open = site.hours.map((h) => `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][h.day - 1]} ${h.open}–${h.close}`).join(", ");
      const walls = site.walls.map((w) => `${w.kind === "bulk" ? "bulk-bin" : "wall"} run ${w.id}`).join(", ");

      lines.push(
        `## ${site.name} (${site.id})`,
        ``,
        `- **Demand from candystore:** ${store ? `${store.name}, ${store.type}` : site.store}, ${money(annual / 52)}/week retail across ${plural(store ? Object.keys(store.revenueBy).length : 0, "category", "categories")}${store && store.segments.length ? ` (segments: ${store.segments.join(", ")})` : ""}; supplied by ${store?.dc ?? "—"}.`,
        `- **Floor:** ${Math.round(site.building.widthFt)}×${Math.round(site.building.depthFt)} ft, ${fmtInt(ctx.layout.sellingSqFt)} sq ft selling and ${fmtInt(ctx.layout.backroomSqFt)} sq ft stockroom. ` +
          `${site.gondolas.runs} gondola runs of ${site.gondolas.baysPerRun} bays × ${site.gondolas.shelves} shelves, ${walls || "no perimeter runs"}, ${site.seasonal.tables} seasonal tables; ` +
          `${ctx.layout.facings.length} facings in ${ctx.layout.salesAisles.length} aisles, ${ctx.layout.storage.length} stockroom positions.`,
        `- **Counter:** ${site.checkout.registers} register(s)${site.checkout.wrap ? " and a gift-wrap station" : ""}${site.showcase ? `, ${site.showcase.stations} showcase serving position(s) behind ${site.showcase.bays} bays of glass` : ", no served counter"}. ` +
          `Doors: ${site.doors.entrances} entrance(s), ${site.doors.docks} dock(s), ${site.doors.ground} ground-level. Lot: ${site.parking.stalls} stalls (${site.parking.accessibleStalls} accessible, ${site.parking.curbsideStalls} curbside pickup). ` +
          `Equipment: ${site.equipment.vans} van(s), ${site.equipment.stockCarts} stock carts, ${site.equipment.palletJacks} pallet jack(s).`,
        `- **Clock:** trading ${open}. Shifts ${shifts}. Orders close ${site.times.orderCutoff}, the pick starts ${site.times.pickStart}, the van leaves ${site.times.vanDeparture}${site.times.vanSecondDeparture ? ` and again ${site.times.vanSecondDeparture}` : ""}. ` +
          `The distribution center's trailer calls ${site.dcDeliveryDays.map((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d - 1]).join(", ")} between ${site.times.overnightWindow.join("–")}; vendors' own trucks ${site.times.directWindow.join("–")}.`,
        `- **Crew:** ${crew.length} people (${crew.map((w) => `${w.id} ${w.role}${w.type === "full-time" ? "" : ` (${w.type})`}`).join(", ")}). Skill holders: ${holders}.`,
        `- **Baseline, ${BASELINE_DAYS} days from week 36, ${BASELINE_RUNS} runs:** ${fmtInt(k.customers)} customers, ${fmtInt(k.transactions)} transactions, ${money(k.salesDollars)} sold. ` +
          `Lost: ${money(k.lostShelfDollars)} to an empty shelf and ${money(k.lostQueueDollars)} to ${fmt1(k.abandoned)} walk-outs. ` +
          `On-shelf ${pct1(k.onShelfShare)}; register wait ${waitMin(k.registerWaitAvgMin)} average, ${waitMin(k.registerWaitP90Min)} at p90; counter ${waitMin(k.counterWaitAvgMin)}. ` +
          `${fmt1(k.paidHours)} paid hours at ${pct(k.utilization)} utilization, labor ${money(k.laborCost)}. Busiest queue: ${rep.bottleneck.process ?? "none"} (${rep.bottleneck.constraint}).`,
        ``
      );
    }

    // Written from the shape itself, so a field added to the engine appears
    // here without anyone remembering to add it.
    const fields = Object.keys(scenarioShape)
      .map((k) => `\`${k}\``)
      .join(", ");

    lines.push(
      `## Tools`,
      ``,
      `- \`get_layout\`, \`get_workforce\`: the shop floor and the people, including what one absence would stop.`,
      `- \`simulate_day\`: run the shop for up to eight weeks from any calendar week, with any scenario.`,
      `- \`what_if\`: the baseline against a scenario on the same random draws.`,
      `- \`stress_test\`: no-shows, till outages, van breakdowns, supplier delays and demand surges, drawn at rates you set, over many runs.`,
      `- \`find_capacity\`: the most demand the shop serves before the queue, the shelf or the van gives way, and which gives way first.`,
      `- \`optimize_merchandising\`: the current planogram against a re-merchandised one and a partial reset — sales moved to better facings, lost sales avoided, restock labor and the payback.`,
      `- \`stock_status\`: stock by category, open orders, a weekly projection to the peak, the SKUs that run out, and the same horizon under the other forecast.`,
      `- \`plan_labor\`, \`build_schedule\`: the season's hours against the roster, and who works which day on what.`,
      `- \`peak_readiness\`: is this shop ready for Halloween, and if not, the cheapest fix that gets it there.`,
      `- **3D shop** at ${SITE_URL}/store: the same engine in a Web Worker in the browser, played back in three dimensions with every customer, queue, restock trip, truck and van at the minute the engine put it there. \`simulate_day\` and \`what_if\` end with a link that replays their first run (seed 1).`,
      ``,
      `Every simulation tool takes the same scenario fields, so a plan can be carried from one tool to the next: demand (\`demandScale\`, \`demandShocks\`, a live \`candystore\` store scenario, \`specialShare\`, \`deliveryShare\`), ` +
        `merchandising and stock policy (\`merchandising\`, \`facingDays\`, \`forecast\`, \`serviceLevel\`, \`supplierDelays\`), ` +
        `people (\`addWorkers\`, \`removeWorkers\`, \`crossTrain\`, \`workerOverrides\`, \`workerLeave\`, \`absenteeism\`, \`flex\`, \`overtimeMaxHours\`, \`targetUtilization\`), ` +
        `the building (\`registers\`, \`counters\`, \`vans\`, \`stockCarts\`, \`palletJacks\`, \`docks\`, \`groundDoors\`, \`fixtures\`, \`layout\`), ` +
        `the clock (\`hours\`, \`operatingDays\`, \`shifts\`, \`times\`, \`dcDeliveryDays\`) and disruptions (\`registerOutages\`, \`counterOutages\`, \`dockOutages\`, \`vanOutages\`, \`posOutages\`, \`patience\`, \`inboundLatenessSdMin\`). ` +
        `In full: ${fields}. Days count from 0, the Monday of \`startWeek\`; weekdays count from 1, Monday.`,
      ``,
      `Data built ${manifest.generatedAt.slice(0, 10)} from a candystore snapshot of ${manifest.candystore.fetchedAt.slice(0, 10)}. Buildings, catalog, roster, labor standards and cost rates are placeholders to be edited.`
    );
    return text(lines.join("\n"));
  });
}
