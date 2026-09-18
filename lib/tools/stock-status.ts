/**
 * The buying question, at day resolution, out to the peak.
 *
 * This is the other model in the twin: `runInventory` drives the same
 * `InventoryBook` a day at a time rather than a minute at a time, with the
 * day's demand as its expectation rather than a draw of baskets and the morning
 * restock free. That makes a 26-week horizon cheap, and it answers exactly one
 * question — will there be enough stock, week by week, through the season.
 * Whether anyone had the hours to work the shelf, and what the queue did at
 * 17:00, is simulate_day's job on the same book.
 *
 * Both forecasts are run, because the difference between a buyer who plans
 * seasonally and one who averages the last four weeks is the difference between
 * meeting Halloween and meeting it with September's order.
 */

import { expectedDailyUnits } from "../twin/demand";
import { runInventory } from "../twin/inventory";
import { buildTwin, scenarioShape, storeSchema } from "../twin/twin";
import { fmt1, fmtInt, guarded, money, pct1, readOnlyOpenWorld, scenarioLine, storeName, text, z } from "./shared";

/** Six weeks is enough for a shop's stock to settle; its own engine warms up the same. */
const WARMUP_WEEKS = 6;
/** Its own seed range, so the buyer's lead-time draws never move the floor's. */
const SEED = 3;

export const stockStatusConfig = {
  title: "Stock, orders and the projection to the peak",
  description:
    "What one shop is holding and what is coming: retail value on the shelf and in the stockroom by category with days of supply, open purchase orders by " +
    "supplier, a week-by-week projection of sales, lost sales, receipts and stockroom fill, the SKUs that run out and why, and the same horizon under the " +
    "other forecast method. Takes forecast, serviceLevel, supplierDelays, merchandising and demand changes.",
  inputSchema: z
    .object({
      store: storeSchema,
      startWeek: z.number().int().min(1).max(52).default(36),
      weeks: z.number().int().min(1).max(26).default(10),
      category: z.string().max(60).optional().describe("Limit the SKU lists to one category, e.g. traditional or specialty:latam."),
      top: z.number().int().min(3).max(40).default(10),
      forecast: scenarioShape.forecast,
      serviceLevel: scenarioShape.serviceLevel,
      supplierDelays: scenarioShape.supplierDelays,
      merchandising: scenarioShape.merchandising,
      facingDays: scenarioShape.facingDays,
      demandScale: scenarioShape.demandScale,
      demandShocks: scenarioShape.demandShocks,
      candystore: scenarioShape.candystore,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof stockStatusConfig.inputSchema>;

export async function stockStatusHandler(args: Args) {
  return guarded(async () => {
    const { store, startWeek, weeks, category, top, ...scenario } = args;
    const ctx = await buildTwin(store, startWeek, scenario);
    const { model, catalog, policy, costs, layout } = ctx;
    if (category && !catalog.skus.some((s) => s.category === category)) {
      return text(`Unknown category "${category}". Categories: ${[...new Set(catalog.skus.map((s) => s.category))].sort().join(", ")}.`);
    }

    // What the floor holds when every facing is full is what the buyer's
    // order-up-to level has to sit on top of, so the stock model is given the
    // planogram's own facing sizes.
    const facingCap = new Map<string, number>();
    for (const sku of catalog.skus) facingCap.set(sku.id, Math.max(1, Math.round(ctx.facingUnits.get(sku.id) ?? 1)));

    const days = weeks * 7;
    const opts = { startWeek, warmupWeeks: WARMUP_WEEKS, policy, delays: ctx.supplierDelays, seed: SEED, facingCap };
    const snap = runInventory(model, catalog, { ...opts, days: 0 }).book;
    const run = runInventory(model, catalog, { ...opts, days });
    const other = runInventory(model, catalog, { ...opts, days, policy: { ...policy, forecast: policy.forecast === "seasonal" ? "trailing" : "seasonal" } });
    const suppliers = new Map(catalog.suppliers.map((s) => [s.id, s]));

    const next7 = expectedDailyUnits(model, 0, 7, startWeek);
    const cats = new Map<string, { shelf: number; back: number; daily: number; skus: number; empty: number }>();
    for (const s of snap.skus) {
      const d = next7.get(s.sku.id) ?? 0;
      const c = cats.get(s.sku.category) ?? { shelf: 0, back: 0, daily: 0, skus: 0, empty: 0 };
      c.shelf += s.onFacing * s.sku.unitRetail;
      c.back += s.onHandBack * s.sku.unitRetail;
      c.daily += d * s.sku.unitRetail;
      c.skus++;
      if (s.onFacing <= 0 && d > 0) c.empty++;
      cats.set(s.sku.category, c);
    }
    const catRows = [...cats.entries()]
      .sort((a, b) => b[1].shelf + b[1].back - (a[1].shelf + a[1].back) || a[0].localeCompare(b[0]))
      .map(([c, v]) => {
        const total = v.shelf + v.back;
        return `| ${c} | ${v.skus} | ${money(v.shelf)} | ${money(v.back)} | ${money(total * costs.costOfGoods)} | ${v.daily > 0 ? fmt1(total / v.daily) : "—"} | ${v.empty} |`;
      });

    const openBySupplier = new Map<string, { pos: number; cases: number; first: number }>();
    for (const po of snap.open) {
      const o = openBySupplier.get(po.supplier) ?? { pos: 0, cases: 0, first: Number.POSITIVE_INFINITY };
      o.pos++;
      o.cases += po.cases;
      o.first = Math.min(o.first, po.arriveDay);
      openBySupplier.set(po.supplier, o);
    }
    const poRows = [...openBySupplier.keys()].sort().map((id) => {
      const o = openBySupplier.get(id)!;
      const sup = suppliers.get(id);
      return `| ${sup?.name ?? id} | ${sup?.channel === "dc" ? "overnight trailer" : "vendor truck"} | ${sup?.leadDays ?? "—"} d | ${o.pos} | ${fmtInt(o.cases)} | day ${o.first} |`;
    });

    const weekRows: string[] = [];
    for (let w = 0; w < weeks; w++) {
      const rows = run.daily.filter((d) => Math.floor(d.day / 7) === w);
      if (!rows.length) continue;
      const sold = rows.reduce((a, d) => a + d.soldDollars, 0);
      const lost = rows.reduce((a, d) => a + d.lostDollars, 0);
      const cases = rows.reduce((a, d) => a + d.receivedCases, 0);
      const peakCases = Math.max(...rows.map((d) => d.backroomCases));
      const worstShelf = Math.min(...rows.map((d) => d.shelfShare));
      weekRows.push(
        `| ${rows[0].calendarWeek} | ${money(sold)} | ${money(lost)} | ${sold + lost > 0 ? pct1(sold / (sold + lost)) : "—"} | ${fmtInt(cases)} | ${money(rows[rows.length - 1].onHandRetail)} | ${fmtInt(peakCases)}${peakCases > layout.storage.length ? " (over)" : ""} | ${pct1(worstShelf)} |`
      );
    }

    const bySku = new Map(run.book.skus.map((s) => [s.sku.id, s.sku]));
    const outRows = [...run.book.lostBySku.entries()]
      .map(([id, units]) => ({ sku: bySku.get(id), units }))
      .filter((x) => x.sku !== undefined && (!category || x.sku.category === category))
      .sort((a, b) => b.units * (b.sku?.unitRetail ?? 0) - a.units * (a.sku?.unitRetail ?? 0) || (a.sku!.id < b.sku!.id ? -1 : 1))
      .slice(0, top)
      .map((x) => {
        const sku = x.sku!;
        const sup = suppliers.get(sku.supplier);
        return `| ${sku.id} | ${sku.name} | ${sku.category} | ${sku.fixture} | ${fmt1(x.units)} ${sku.sellBy === "weight" ? "lb" : "ea"} | ${money(x.units * sku.unitRetail)} | ${sup?.name ?? sku.supplier}, ${sup?.leadDays ?? "—"} d |`;
      });

    const t = run.book.totals;
    const o = other.book.totals;
    const fill = (x: typeof t) => (x.soldUnits + x.lostUnits > 0 ? x.soldUnits / (x.soldUnits + x.lostUnits) : 1);
    const otherName = policy.forecast === "seasonal" ? "trailing" : "seasonal";

    return text(
      [
        `# Stock at ${storeName(ctx)} from week ${startWeek}, ${weeks} weeks`,
        scenarioLine(ctx),
        `Policy: periodic review on each supplier's order day, order-up-to over review plus lead time with a ${policy.forecast} forecast at ${pct1(policy.serviceLevel)} cycle service. The shop buys by the display box from the distribution center and by the case from a vendor's own truck.`,
        ``,
        `## On hand at the start of week ${startWeek}`,
        `${money(snap.retailValue())} of retail value in the building (${money(snap.retailValue() * costs.costOfGoods)} at cost), ${fmtInt(snap.backroomCases())} master cases in a stockroom with ${fmtInt(layout.storage.length)} positions, ${pct1(snap.shelfShare())} of merchandised facings filled.`,
        ``,
        `| category | SKUs | on the shelf | in the stockroom | at cost | days of supply | facings empty |`,
        `|---|---:|---:|---:|---:|---:|---:|`,
        ...catRows,
        ``,
        `| open orders from | arrives as | lead | POs | cases | first arrival |`,
        `|---|---|---:|---:|---:|---|`,
        ...(poRows.length ? poRows : ["| none | | | | | |"]),
        ``,
        `## Projection`,
        `${money(t.soldDollars)} sold and ${money(t.lostDollars)} lost to an empty shelf over ${weeks} weeks — ${pct1(fill(t))} of what customers reached for was there — on ${fmtInt(t.lostLines)} lines where nothing at all was on the facing. ${t.receipts} receipts, ${fmtInt(t.receivedCases)} cases.`,
        `With a ${otherName} forecast instead: ${pct1(fill(o))} of demand met, ${money(o.lostDollars)} lost, ${fmtInt(o.receivedCases)} cases received.`,
        ``,
        `| week | sold | lost | met | cases in | retail on hand (end) | stockroom cases (peak) | worst on-shelf |`,
        `|---|---:|---:|---:|---:|---:|---:|---:|`,
        ...weekRows,
        ``,
        outRows.length ? `## Runs out${category ? ` in ${category}` : ""}, largest first` : `No SKU${category ? ` in ${category}` : ""} runs out over the horizon.`,
        ...(outRows.length ? [`| SKU | product | category | fixture | units lost | retail lost | supplier |`, `|---|---|---|---|---:|---:|---|`, ...outRows] : []),
        ``,
        `This is the day model: a receipt is sellable the day it lands and the morning restock is free, so what is unfilled here is a buying problem rather than a labor one. ` +
          `Nobody backorders a chocolate bar — a customer who reaches for an empty facing buys something else or walks out — so the shortfall is counted as a lost sale, not as a cut. ` +
          `Special orders are picked by staff and can reach the stockroom; walk-in customers only ever see the facing.`,
      ].join("\n")
    );
  });
}
