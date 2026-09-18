/**
 * The shop's answer to a warehouse's slotting, with the sign flipped.
 *
 * In a distribution center the best slot is the one the picker walks least to
 * reach. In a shop the best facing is the one the customer sees, and the shelf
 * a stocker would choose — low, near the stockroom door at the back — is
 * roughly the opposite of the shelf that sells. So an optimized plan spends
 * restock walking to buy exposure, and this tool prices both sides of that
 * trade: what moves to a better facing, what it costs to keep filled, and how
 * many Sunday nights of resetting it takes to pay for itself.
 *
 * Merchandising moves the mix, not the total — the shop's dollars are
 * candystore's either way. The gain is that the fast movers are the ones in
 * front of the customer, so fewer sales are lost to an empty or invisible
 * facing, which is what the optional run on the floor measures.
 */

import { evaluateMerch, facingUnitsFor, facingValue, optimizedPlanogram, partialPlanogram, type MerchEvaluation, type Planogram } from "../twin/merch";
import { replicate } from "../twin/replicate";
import { buildTwin, scenarioShape, storeSchema } from "../twin/twin";
import { dollars2, fmt1, fmtInt, guarded, money, pct1, readOnlyOpenWorld, storeName, text, waitMin, z } from "./shared";

/** Long enough for the shelves to run down and be filled again a few times. */
const VALIDATE_DAYS = 14;
const VALIDATE_RUNS = 2;

export const optimizeMerchandisingConfig = {
  title: "Optimize the planogram",
  description:
    "Re-merchandise one shop so the fastest movers sit at eye level and on the feature fixtures, and size each facing to a few days of its own demand. " +
    "Compares the current plan, a partial reset limited to maxMoves swaps, and the full optimum: where the week's dollars sit, facing refills and stocker " +
    "hours a week, the labor to make the moves and the payback, the first moves to make, and optionally a run of the floor before and after showing the " +
    "lost sales avoided.",
  inputSchema: z
    .object({
      store: storeSchema,
      startWeek: z.number().int().min(1).max(52).default(36),
      maxMoves: z.number().int().min(1).max(200).default(25).describe("Swaps the partial reset may make. A swap moves two SKUs — the one gaining the facing and the one giving it up — so this allows up to twice as many moves."),
      minutesPerMove: z.number().min(1).max(60).default(12).describe("Labor to clear a facing, move the stock and re-label the shelf edge, per SKU moved."),
      listMoves: z.number().int().min(0).max(40).default(12),
      validate: z.boolean().default(true).describe("Also simulate two weeks of the floor with the current and the optimized plan."),
      facingDays: scenarioShape.facingDays,
      demandScale: scenarioShape.demandScale,
      candystore: scenarioShape.candystore,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof optimizeMerchandisingConfig.inputSchema>;

export async function optimizeMerchandisingHandler(args: Args) {
  return guarded(async () => {
    const { store, startWeek, maxMoves, minutesPerMove, listMoves, validate, ...demand } = args;
    const ctx = await buildTwin(store, startWeek, demand);
    const { layout, catalog, model, std, site, rates, plan: current } = ctx;

    const optimal = optimizedPlanogram(layout, catalog, model, rates);
    const partial = partialPlanogram(layout, current, optimal, rates, maxMoves);

    const evalOf = (p: Planogram, policy: "current" | "optimized") => {
      const units = facingUnitsFor(policy, layout, p, rates, std, site);
      return evaluateMerch(layout, p, units, rates, std);
    };
    const cur = evalOf(current, "current");
    const par = evalOf(partial, "optimized");
    const opt = evalOf(optimal, "optimized");

    // Built from `rates`, an array in catalog order, rather than by iterating a
    // planogram Map: two plans built different ways insert their keys in
    // different orders and must still count the same moves.
    const movedIn = (p: Planogram) => rates.filter((r) => current.get(r.sku.id)?.id !== p.get(r.sku.id)?.id).length;

    const wage = ctx.workers.length ? ctx.workers.reduce((a, w) => a + w.hourlyRate, 0) / ctx.workers.length : 0;
    const option = (label: string, e: MerchEvaluation, p: Planogram) => {
      const moves = movedIn(p);
      const moveH = (moves * minutesPerMove) / 60;
      const savedH = (cur.restockMinutesPerWeek - e.restockMinutesPerWeek) / 60;
      return (
        `| ${label} | ${moves} | ${pct1(e.eyeLevelShare)} | ${pct1(e.featureShare)} | ${fmt1(e.weightedAppeal)} | ${fmtInt(e.restocksPerWeek)} | ` +
        `${fmt1(e.restockMinutesPerWeek / 60)} | ${fmt1(savedH)} | ${fmt1(e.daysOfSupply)} | ${fmt1(moveH)} | ${savedH > 0.05 && moves > 0 ? `${fmt1(moveH / savedH)} wk` : "—"} |`
      );
    };

    const value = new Map(layout.facings.map((f) => [f.id, facingValue(layout, f)]));
    const v = (id: string | undefined) => (id ? value.get(id) ?? 0 : 0);
    const topMoves = rates
      .map((r) => {
        const from = current.get(r.sku.id);
        const to = optimal.get(r.sku.id);
        const dollars = r.unitsPerWeek * r.sku.unitRetail;
        return { r, from, to, dollars, gain: dollars * (v(to?.id) - v(from?.id)) };
      })
      .filter((m) => m.from && m.to && m.from.id !== m.to.id && m.gain > 0)
      .sort((a, b) => b.gain - a.gain || (a.r.sku.id < b.r.sku.id ? -1 : 1))
      .slice(0, listMoves)
      .map((m) => `| ${m.r.sku.id} | ${m.r.sku.name} | ${money(m.dollars)} | ${m.from?.kind} ${m.from?.id} | ${m.to?.kind} ${m.to?.id} | ${fmt1(v(m.from?.id))} → ${fmt1(v(m.to?.id))} | ${money(m.gain)} |`);

    const lines = [
      `# Merchandising at ${storeName(ctx)}`,
      ``,
      `${rates.filter((r) => r.unitsPerWeek > 0).length} SKUs with demand in ${fmtInt(layout.facings.length)} facings, week ${startWeek}${args.demandScale ? `, demand ×${args.demandScale}` : ""}. ` +
        `An optimized facing is sized to ${fmt1(std.facingDaysOfSupply)} days of that SKU's own demand, capped by what the shelf physically holds and never smaller than the display box it arrives in.`,
      ``,
      `| option | SKUs moved | eye-level $ | feature $ | facing value | refills/wk | restock h/wk | h/wk saved | days on the floor | move labor h | payback |`,
      `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
      option("current", cur, current),
      option(`partial (${maxMoves} swaps)`, par, partial),
      option("full optimum", opt, optimal),
      ``,
      `Facing value is the fixture family's pull × the shelf's height × how near the door it is, dollar-weighted and normalised so an average facing is 1.0. ` +
        `Moving ${movedIn(optimal)} SKUs costs about ${fmt1((movedIn(optimal) * minutesPerMove) / 60)} hours, ${money(((movedIn(optimal) * minutesPerMove) / 60) * wage)} at this shop's average wage of ${dollars2(wage)}.`,
      ``,
      `## First moves`,
      `| SKU | product | $/wk | from | to | facing value | weekly $ × gain |`,
      `|---|---|---:|---|---|---|---:|`,
      ...(topMoves.length ? topMoves : ["| — | nothing gains a better facing | | | | | |"]),
    ];

    if (validate) {
      const before = replicate(await buildTwin(store, startWeek, demand), VALIDATE_DAYS, VALIDATE_RUNS);
      const after = replicate(await buildTwin(store, startWeek, { ...demand, merchandising: "optimized" }), VALIDATE_DAYS, VALIDATE_RUNS);
      const lostOf = (k: typeof before.mean) => k.lostShelfDollars + k.lostQueueDollars;
      const avoided = lostOf(before.mean) - lostOf(after.mean);
      const margin = 1 - ctx.costs.costOfGoods;
      const weeklyMargin = (avoided / VALIDATE_DAYS) * 7 * margin;
      const moveCost = ((movedIn(optimal) * minutesPerMove) / 60) * wage;
      lines.push(
        ``,
        `## On the floor (${VALIDATE_DAYS} days from week ${startWeek}, ${VALIDATE_RUNS} runs, full optimum)`,
        `| KPI | current | optimized |`,
        `|---|---:|---:|`,
        `| Sales | ${money(before.mean.salesDollars)} | ${money(after.mean.salesDollars)} |`,
        `| Lost sales, empty shelf | ${money(before.mean.lostShelfDollars)} | ${money(after.mean.lostShelfDollars)} |`,
        `| Lost sales, walked out | ${money(before.mean.lostQueueDollars)} | ${money(after.mean.lostQueueDollars)} |`,
        `| On-shelf availability | ${pct1(before.mean.onShelfShare)} | ${pct1(after.mean.onShelfShare)} |`,
        `| Empty-facing hours | ${fmt1(before.mean.emptyFacingHours)} | ${fmt1(after.mean.emptyFacingHours)} |`,
        `| Restocks (hot) | ${fmt1(before.mean.restocks)} (${fmt1(before.mean.hotRestocks)}) | ${fmt1(after.mean.restocks)} (${fmt1(after.mean.hotRestocks)}) |`,
        `| Register wait, p90 | ${waitMin(before.mean.registerWaitP90Min)} | ${waitMin(after.mean.registerWaitP90Min)} |`,
        `| Busy labor hours | ${fmt1(before.mean.busyHours)} | ${fmt1(after.mean.busyHours)} |`,
        `| Labor cost | ${money(before.mean.laborCost)} | ${money(after.mean.laborCost)} |`,
        ``,
        avoided > 0
          ? `The reset avoids about ${money((avoided / VALIDATE_DAYS) * 7)} of lost sales a week, ${money(weeklyMargin)} of gross margin at ${pct1(margin)}. Against ${money(moveCost)} of move labor that is a payback of about ${weeklyMargin > 0 ? fmt1(moveCost / weeklyMargin) : "—"} weeks.`
          : `The reset does not reduce lost sales at this demand level; the current plan is already good enough for the volume this shop takes. Re-run at a peak week, or with demandScale, to see whether that holds when the shelves are under pressure.`
      );
    }

    lines.push(
      ``,
      `Total sales are candystore's either way: an endcap steals its lift from the shelf behind it, so the appeal map is normalised to mean 1 across the assortment. ` +
        `What a better plan really buys is fewer sales lost to an empty or badly placed facing, and fewer trips to the stockroom to prevent them — which is why the payback column is in stocker hours and the check on the floor is in lost sales.`
    );
    return text(lines.join("\n"));
  });
}
