/**
 * The building, read rather than run. Everything here is a property of the
 * geometry and the planogram, so nothing is simulated and nothing is drawn at
 * random: the same shop with the same merchandising answers the same way every
 * time.
 *
 * The closing table is the one a store manager would ask for — the fastest
 * movers and the facing each one has been given — because in a shop the
 * question is never whether the candy is in the building but whether it is in
 * front of the customer.
 */

import { layoutSpecSchema, type LayoutSpec } from "../layout/spec";
import { isGoldenShelf } from "../twin/layout";
import { facingValue } from "../twin/merch";
import { buildTwin, storeSchema } from "../twin/twin";
import { dollars2, fmt1, fmtInt, guarded, money, pct, pct1, readOnly, text, z } from "./shared";

export const getLayoutConfig = {
  title: "Shop floor and planogram",
  description:
    "One shop's floor: the gondola runs and their aisles, the bulk-bin and wall shelving, the seasonal tables, the showcase glass and the registers, the " +
    "stockroom's racking and shelving, the goods doors and the customer lot; how much of the week's money sits at eye level and on feature fixtures; what " +
    'it costs to keep the shelves filled; and the fastest-selling SKUs with the facing each one has. Use merchandising "optimized" to see the re-merchandised plan instead.',
  inputSchema: z
    .object({
      store: storeSchema,
      layout: layoutSpecSchema.optional(),
      merchandising: z.enum(["current", "optimized"]).default("current"),
      top: z.number().int().min(5).max(50).default(15).describe("How many of the fastest SKUs to list."),
    })
    .strict(),
  annotations: readOnly,
};

export async function getLayoutHandler(args: { store: string; layout?: LayoutSpec; merchandising: "current" | "optimized"; top: number }) {
  return guarded(async () => {
    const ctx = await buildTwin(args.store, 36, { merchandising: args.merchandising, layout: args.layout });
    const { site, layout, plan, facingUnits, rates, merchEval, std } = ctx;

    const shelvesOn = new Map(layout.spec.fixtures.map((f) => [f.id, f.shelves]));
    const days = site.operatingDays.length || 7;
    const live = rates.filter((r) => r.unitsPerWeek > 0);
    const dead = rates.length - live.length;
    const ranked = [...live].sort((a, b) => b.unitsPerWeek * b.sku.unitRetail - a.unitsPerWeek * a.sku.unitRetail);
    const totalDollars = live.reduce((a, r) => a + r.unitsPerWeek * r.sku.unitRetail, 0);
    const topShare = ranked.slice(0, Math.ceil(ranked.length * 0.2)).reduce((a, r) => a + r.unitsPerWeek * r.sku.unitRetail, 0) / Math.max(1, totalDollars);

    const rows = ranked.slice(0, args.top).map((r, i) => {
      const f = plan.get(r.sku.id);
      const shelves = f ? shelvesOn.get(f.run) ?? f.shelf : 1;
      const holds = facingUnits.get(r.sku.id) ?? 0;
      const unit = r.sku.sellBy === "weight" ? "lb" : "ea";
      return (
        `| ${i + 1} | ${r.sku.id} | ${r.sku.name} | ${r.sku.category} | ${f?.kind ?? "—"} | ${money(r.unitsPerWeek * r.sku.unitRetail)} | ` +
        `${fmt1(r.unitsPerWeek)} ${unit} | ${fmt1(r.basketsPerWeek)} | ${f?.id ?? "unplaced"} | ${f ? `${f.shelf}/${shelves}${isGoldenShelf(f.shelf, shelves) ? " golden" : ""}` : "—"} | ` +
        `${f ? fmt1(facingValue(layout, f)) : "—"} | ${fmt1(holds)} ${unit} | ${r.unitsPerWeek > 0 ? fmt1((holds / r.unitsPerWeek) * days) : "—"} |`
      );
    });

    const byKind = new Map<string, number>();
    for (const f of layout.facings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    // Sorted, because a Map's insertion order follows the order the building
    // happened to be built in and must never decide what a tool prints.
    const fixtureLine = [...byKind.keys()]
      .sort()
      .map((k) => `${fmtInt(byKind.get(k) ?? 0)} ${k}`)
      .join(", ");

    const racks = layout.storage.filter((s) => s.kind === "rack").length;
    const shelvingPositions = layout.storage.length - racks;

    return text(
      [
        `# ${site.name} (${site.id}) — ${args.merchandising} merchandising`,
        ``,
        `**Building** ${Math.round(site.building.widthFt)}×${Math.round(site.building.depthFt)} ft${args.layout ? ` (imported from ${args.layout.source.format.toUpperCase()}${args.layout.source.file ? ` ${args.layout.source.file}` : ""})` : ""}: ` +
          `${fmtInt(layout.sellingSqFt)} sq ft of sales floor to the stockroom wall at ${Math.round(layout.spec.backroomY)} ft, ${fmtInt(layout.backroomSqFt)} sq ft behind it. ` +
          `Doors: ${layout.doors.map((d) => `${d.id} (${d.kind})`).join(", ")}. Lot: ${site.parking.stalls} stalls, ${site.parking.accessibleStalls} accessible, ${site.parking.curbsideStalls} curbside, ${Math.round(site.parking.depthFt)} ft deep.`,
        `**Sales floor** ${layout.salesAisles.length} aisles, ${Math.round(layout.salesAisleLength)} ft between the front and back cross aisles; ${fmtInt(layout.facings.length)} facings — ${fixtureLine}. Median facing holds ${fmt1(layout.facingCubeFt)} cu ft.`,
        `**Service counter** ${layout.service.filter((s) => s.kind === "register").length} register(s), ${layout.service.filter((s) => s.kind === "counter").length} showcase station(s), ${layout.service.filter((s) => s.kind === "wrap").length} wrap station(s). ` +
          `Customers queue at the head of each; staff work the corridor behind the glass.`,
        `**Stockroom** ${layout.backroomAisles.length} aisles, ${fmtInt(racks)} pallet-rack positions and ${fmtInt(shelvingPositions)} case-shelf positions; the pick-and-pack bench sits ${Math.round(Math.abs(layout.bench.y - layout.spec.backroomY))} ft behind the sales floor, the receiving apron ${Math.round(Math.abs(layout.staging.y - layout.bench.y))} ft further back.`,
        ``,
        `**The plan** gives each of ${fmtInt(merchEval.skus)} SKUs one facing, on fixtures that hold ${fmtInt(merchEval.facings)}; ${dead} SKU(s) sell nothing here and still hold one. ` +
        `The rest of the shelf is spare: candystore's catalog is ${fmtInt(merchEval.skus)} SKUs in the categories this shop sells, and a real shop this size would carry several times that and block each one across a few facings. ` +
        `The twin sizes how much one facing **holds** (below) rather than how many facings a SKU spreads over, so stock and restocking are right and shelf occupancy is not. ` +
          `${pct1(merchEval.eyeLevelShare)} of the week's dollars are merchandised at eye level and ${pct1(merchEval.featureShare)} on feature fixtures — endcaps, seasonal tables and the register racks. Dollar-weighted facing value ${fmt1(merchEval.weightedAppeal)} (1.0 is an average facing).`,
        `**Velocity:** the fastest fifth of the range takes ${pct(topShare)} of the money.`,
        `**Keeping it filled:** ${fmtInt(merchEval.restocksPerWeek)} facing refills an ordinary week, ${fmt1(merchEval.restockMinutesPerWeek / 60)} stocker-hours, ${fmtInt(merchEval.feetPerRestock)} ft walked per refill. ` +
          `A full floor holds ${fmt1(merchEval.daysOfSupply)} days of demand${args.merchandising === "optimized" ? `; facings are sized to ${std.facingDaysOfSupply} days within what the shelf physically holds` : "; every facing is one display box, as a shop that grew one delivery at a time ends up"}.`,
        ``,
        `| # | SKU | product | category | fixture | $/wk | units/wk | baskets/wk | facing | shelf | facing value | holds | days on shelf |`,
        `|---|---|---|---|---|---:|---:|---:|---|---|---:|---:|---:|`,
        ...rows,
        ``,
        `Facing value is the fixture family's pull × the shelf's height × how near the door it is, normalised so an average facing is 1.0. A golden shelf is between knee and shoulder, where a stocker needs no bend or stretch; ` +
          `eye level is a little higher and sells a little more. Facing ids read <run>-<side><bay>-<shelf>. Units are pieces for packaged candy and pounds for anything weighed; the average basket here is ${dollars2(ctx.model.meanBasket)}.`,
      ].join("\n")
    );
  });
}
