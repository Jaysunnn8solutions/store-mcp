/**
 * How much trade the shop can actually take.
 *
 * A distribution center's ceiling is the truck cutoff. A shop's is softer and
 * has three shapes: the queue gets long enough that people put the basket down,
 * the shelf empties faster than anyone can fill it, or the pre-open pick runs
 * past the van's departure. The search scales candystore's demand until one of
 * them gives, then says which one did — because the answer changes what you
 * would buy. A queue ceiling is a person or a till; a shelf ceiling is facing
 * depth or a restock trip; a van ceiling is the clock.
 *
 * A target the shop already misses at today's volume is reported separately
 * and left out of the search. It is not a capacity limit: a one-van shop whose
 * morning round is always tight does not get less late by trading less, and a
 * bisection chasing that target would spend every probe on it and find nothing.
 *
 * The search itself is nothing but repeated public calls: grow until the
 * targets miss, then bisect. It reaches past no engine internals, which is why
 * it keeps working when the engine changes.
 */

import { replicate, type Replications } from "../twin/replicate";
import { seasonFactor } from "../twin/season";
import { buildTwin } from "../twin/twin";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { fmt1, guarded, money, pct, pct1, readOnlyOpenWorld, scenarioLine, storeName, text, waitMin, z } from "./shared";

/** Past this the question stops being about this shop. */
const MAX_SCALE = 6;
const BISECTIONS = 4;

export const findCapacityConfig = {
  title: "Find the shop's real capacity",
  description:
    "Scale candystore's demand for one shop up until the floor stops keeping up, and report the most retail dollars a week it serves within the service " +
    "targets, which target breaks first past that point — the checkout queue, the showcase queue, walk-outs, on-shelf availability or the delivery van — " +
    "and how that compares with the dollars candystore routes to the shop today. Targets the shop already misses at today's volume are named separately, " +
    "because they are a problem now rather than a ceiling. Takes any scenario, so it also answers what an extra register, a cross-trained crew or " +
    "re-merchandising buys in capacity.",
  inputSchema: z
    .object({
      store: baseShape.store,
      startWeek: z.number().int().min(1).max(52).default(20).describe("Calendar week to test in; week 20 is an ordinary week, 44 is Halloween."),
      days: z.number().int().min(7).max(28).default(14),
      runs: z.number().int().min(1).max(5).default(2),
      targetWaitMin: z.number().min(0.5).max(60).default(6).describe("Longest acceptable 90th-percentile queue wait, minutes, at the till and at the glass."),
      targetWalkOutRate: z.number().min(0).max(0.5).default(0.02).describe("Largest acceptable share of customers who leave without paying."),
      targetOnShelf: z.number().min(0.5).max(1).default(0.97).describe("Smallest acceptable share of merchandised facings with something on them."),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof findCapacityConfig.inputSchema>;

interface Check {
  label: string;
  ok: boolean;
  value: string;
}

interface Probe {
  scale: number;
  rep: Replications;
  checks: Check[];
  /** Meets every target that was not already missed at today's volume. */
  ok: boolean;
}

export async function findCapacityHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const r = rest as { store: string; startWeek: number; days: number; runs: number; targetWaitMin: number; targetWalkOutRate: number; targetOnShelf: number };

    const checksFor = (rep: Replications): Check[] => {
      const k = rep.mean;
      return [
        { label: "checkout queue", ok: k.registerWaitP90Min <= r.targetWaitMin, value: waitMin(k.registerWaitP90Min) },
        { label: "showcase queue", ok: k.counterWaitP90Min <= r.targetWaitMin, value: waitMin(k.counterWaitP90Min) },
        { label: "walk-outs", ok: k.abandonRate <= r.targetWalkOutRate, value: pct1(k.abandonRate) },
        { label: "on-shelf availability", ok: k.onShelfShare >= r.targetOnShelf, value: pct1(k.onShelfShare) },
        { label: "delivery van", ok: k.vanLateRounds < 0.5, value: `${fmt1(k.vanLateRounds)} late rounds` },
      ];
    };

    const baseScale = scenario.demandScale ?? 1;
    const preExisting = new Set<string>();
    const contextOf = new Map<number, Awaited<ReturnType<typeof buildTwin>>>();
    const probe = async (scale: number): Promise<Probe> => {
      const rounded = Math.round(scale * 1000) / 1000;
      const ctx = await buildTwin(r.store, r.startWeek, { ...scenario, demandScale: rounded });
      contextOf.set(rounded, ctx);
      const rep = replicate(ctx, r.days, r.runs);
      const checks = checksFor(rep);
      return { scale: rounded, rep, checks, ok: checks.every((c) => c.ok || preExisting.has(c.label)) };
    };

    // The base probe defines the reference point, so by construction it is the
    // largest demand known to clear; everything it misses is pre-existing.
    const log: Probe[] = [];
    const first = await probe(baseScale);
    for (const c of first.checks) if (!c.ok) preExisting.add(c.label);
    let lo: Probe = { ...first, ok: true };
    log.push(lo);

    let hi = lo;
    let s = baseScale;
    while (hi.ok && s < MAX_SCALE) {
      s = Math.min(MAX_SCALE, s * 1.5);
      hi = await probe(s);
      log.push(hi);
      if (hi.ok) lo = hi;
    }
    if (!hi.ok) {
      for (let i = 0; i < BISECTIONS; i++) {
        const mid = await probe((lo.scale + hi.scale) / 2);
        log.push(mid);
        if (mid.ok) lo = mid;
        else hi = mid;
      }
    }

    const ctx = contextOf.get(lo.scale) ?? (await buildTwin(r.store, r.startWeek, scenario));
    const netStore = ctx.network.stores.find((x) => x.id === ctx.site.store);
    const weeklyToday = netStore ? Object.values(netStore.revenueBy).reduce((a, b) => a + b, 0) / 52 : 0;
    const season = seasonFactor(r.startWeek);
    const soldPerWeek = (x: Probe) => (x.rep.mean.salesDollars / r.days) * 7;
    const label = (c: Check) => `${c.label} (${c.value})`;

    const rows = [...log]
      .sort((a, b) => a.scale - b.scale)
      .map((x) => {
        const k = x.rep.mean;
        const broke = x.checks.filter((c) => !c.ok && !preExisting.has(c.label)).map((c) => c.label);
        return `| ×${x.scale.toFixed(2)} | ${money(soldPerWeek(x))} | ${waitMin(k.registerWaitP90Min)} | ${waitMin(k.counterWaitP90Min)} | ${pct1(k.abandonRate)} | ${pct1(k.onShelfShare)} | ${fmt1(k.vanLateRounds)} | ${pct(k.utilization)} | ${broke.length ? broke.join(", ") : "meets"} |`;
      });

    const maxWeekly = soldPerWeek(lo);
    const atAverage = maxWeekly / season;
    const stillBroken = hi.ok ? [] : hi.checks.filter((c) => !c.ok && !preExisting.has(c.label));
    const already = first.checks.filter((c) => preExisting.has(c.label));

    const lines = [
      `# Capacity of ${storeName(ctx)} in week ${r.startWeek}`,
      scenarioLine(await buildTwin(r.store, r.startWeek, scenario)),
      `Targets: 90th-percentile queue no longer than ${waitMin(r.targetWaitMin)} at the till and at the glass, at most ${pct1(r.targetWalkOutRate)} of customers walking out, at least ${pct1(r.targetOnShelf)} of facings stocked, and the van's rounds on time. ${r.runs} run(s) of ${r.days} days per probe, growing ×1.5 from today's demand and then bisecting.`,
      ``,
    ];

    if (already.length > 0) {
      lines.push(
        `**Before volume comes into it, this shop already misses ${already.map(label).join(", ")}** at today's demand in week ${r.startWeek}. ` +
          `That is not a ceiling — trading less would not fix it — so it is held out of the search below. Run simulate_day or peak_readiness to price it.`,
        ``
      );
    }

    if (preExisting.size >= 5) {
      lines.push(`Every target is already missed, so there is no capacity question left to ask. Fix what is wrong today first.`);
    } else {
      lines.push(
        `**Serves up to about ${money(maxWeekly)}/week of retail value inside the remaining targets** (×${lo.scale.toFixed(2)} of candystore's demand${hi.ok ? ", the top of the search range" : ""}). In an average-season week that is about ${money(atAverage)}.`,
        `candystore routes ${money(weeklyToday)}/week to this shop today, so the floor has about ${pct(atAverage / Math.max(1e-9, weeklyToday))} of today's trade in it before something has to change — and Halloween week alone runs ${fmt1(seasonFactor(44))}× an average week, which is ${money(weeklyToday * seasonFactor(44))}.`,
        hi.ok
          ? ``
          : `**What breaks first** past ×${lo.scale.toFixed(2)}: ${stillBroken.length ? stillBroken.map(label).join(", ") : "nothing new"}. At ×${hi.scale.toFixed(2)} the busiest queue is ${hi.rep.bottleneck.process ?? "none"} (${hi.rep.bottleneck.constraint}).`
      );
    }

    lines.push(
      ``,
      `| demand | sold/week | till p90 | glass p90 | walk-outs | on-shelf | van late | labor busy | targets |`,
      `|---|---:|---:|---:|---:|---:|---:|---:|---|`,
      ...rows,
      ``,
      `Demand scales the shop's candystore dollars, and the buyer's forecast scales with it, so the ceiling found is the floor's and not a stock-out artifact. ` +
        `Overtime is capped at ${fmt1(ctx.scenario.overtimeMaxHours ?? 2)} h a person a day on the closing shift. Walk-outs are the honest capacity signal: a queue that is merely long costs nothing until somebody leaves.`
    );
    return text(lines.join("\n"));
  });
}
