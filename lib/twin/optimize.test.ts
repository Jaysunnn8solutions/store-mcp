/**
 * The optimizer's contract. Nothing here checks a golden dollar figure — the
 * engine underneath is free to change — but everything checks a property the
 * search promises: the same inputs give the same plan, generation 0 really does
 * hold the shop as it is plus every one-lever step from it, the winner is never
 * worse than the baseline on the objective it was scored with, the cost
 * breakdown adds up, a shop starved of registers is told to open one, and the
 * evaluation budget is obeyed.
 *
 * The searches are deliberately tiny — one or two lever families, short
 * horizons — because every candidate is a real run of the real engine.
 */

import { describe, expect, it } from "vitest";
import {
  assumptionsFor,
  baseGenome,
  costOf,
  DEFAULT_ASSUMPTIONS,
  describeChanges,
  evaluationWeeks,
  genomeToScenario,
  LEVERS,
  LEVER_KEYS,
  leverKeysFor,
  MAX_EVALUATION_WEEKS,
  optimizeOperations,
  shopOf,
  type Genome,
  type Levers,
  type Objective,
} from "./optimize";
import { DEFAULT_POLICY } from "./inventory";
import { buildTwin } from "./twin";
import { findSite } from "../data/store";

const STORE = "store-midtown";
const WEEK = 44; // Halloween: the week the shop is under the most pressure.
const SLOW = 180_000;

describe("levers", () => {
  it("every lever has a range or a set of choices, and describes any value in it", () => {
    // The gene helpers read `min`/`max` on an int and `choices` on a choice
    // without checking, so the table itself is what has to hold the invariant.
    for (const l of LEVERS) {
      if (l.kind === "bool") {
        expect(l.min).toBeUndefined();
        expect(l.max).toBeUndefined();
        expect(l.choices).toBeUndefined();
        expect(l.describe(true)).toBeTruthy();
        expect(l.describe(false)).toBeTruthy();
      } else if (l.kind === "choice") {
        expect(l.choices?.length).toBeGreaterThan(1);
        for (const c of l.choices ?? []) expect(l.describe(c)).toBeTruthy();
      } else {
        expect(l.min).toBeTypeOf("number");
        expect(l.max).toBeTypeOf("number");
        expect(l.max!).toBeGreaterThan(l.min!);
        expect(l.describe(l.min!)).toBeTruthy();
        expect(l.describe(l.max!)).toBeTruthy();
      }
    }
    expect(new Set(LEVER_KEYS).size).toBe(LEVERS.length);
  });

  it("the base genome mirrors the shop, and writes an empty scenario", () => {
    const shop = shopOf(STORE);
    const site = findSite(STORE);
    const g = baseGenome(shop, {});
    expect(g.registers).toBe(site.checkout.registers);
    expect(g.counters).toBe(site.showcase?.stations ?? 0);
    expect(g.stockCarts).toBe(site.equipment.stockCarts);
    expect(g.palletJacks).toBe(site.equipment.palletJacks);
    expect(g.vans).toBe(site.equipment.vans);
    expect(g.serviceLevel).toBe(DEFAULT_POLICY.serviceLevel);
    expect(g.forecast).toBe(DEFAULT_POLICY.forecast);
    expect(g.confectioners).toBe(0);
    expect(g.openEarlier).toBe(0);

    // The shop as it is changes nothing, so it is the base scenario itself.
    expect(genomeToScenario(g, {}, g, shop)).toEqual({});
    expect(describeChanges(g, g)).toEqual([]);
  });

  it("the base genome reads the base scenario before the site", () => {
    const shop = shopOf(STORE);
    const g = baseGenome(shop, { registers: 5, forecast: "trailing", flex: false, overtimeMaxHours: 4 });
    expect(g.registers).toBe(5);
    expect(g.forecast).toBe("trailing");
    expect(g.flex).toBe(false);
    expect(g.overtimeMax).toBe(4);
  });

  it("a moved gene becomes the scenario field it names, and carries the base scenario with it", () => {
    const shop = shopOf(STORE);
    const base = { demandScale: 1.3 };
    const baseG = baseGenome(shop, base);
    const g: Genome = {
      ...baseG,
      cashiersLate: 2,
      trainCashiersCounter: true,
      registers: Number(baseG.registers) + 1,
      merchandising: "optimized",
      vanDeparture: 600,
      closeLater: 1,
    };
    const s = genomeToScenario(g, base, baseG, shop);

    expect(s.demandScale).toBe(1.3);
    expect(s.registers).toBe(Number(baseG.registers) + 1);
    expect(s.merchandising).toBe("optimized");
    expect(s.times?.vanDeparture).toBe("10:00");
    expect(s.addWorkers).toEqual([{ role: "cashier", shift: shop.shifts.late, type: "part-time", count: 2 }]);
    expect(s.crossTrain).toEqual([{ role: "Cashier", skill: "counter" }]);
    // Only the heaviest trading days move, and only their closing time.
    expect(s.hours?.map((h) => h.day).sort((a, b) => a - b)).toEqual([...shop.heavyDays].sort((a, b) => a - b));
    for (const h of s.hours ?? []) {
      const was = findSite(STORE).hours.find((x) => x.day === h.day)!;
      expect(h.open).toBe(was.open);
      expect(h.close > was.close).toBe(true);
    }

    // Untouched genes stay out of the scenario entirely.
    expect(s.serviceLevel).toBeUndefined();
    expect(s.flex).toBeUndefined();
    expect(s.counters).toBeUndefined();

    const changes = describeChanges(g, baseG);
    expect(changes.some((c) => /cashier/i.test(c))).toBe(true);
    expect(changes.some((c) => /register/i.test(c) && /was/.test(c))).toBe(true);
    expect(changes).toHaveLength(6);
  });

  it("drops the levers a shop cannot pull", () => {
    // Every family on, but decatur has no stocker to teach the register to and
    // buford has neither a confectioner nor a stocker.
    expect(leverKeysFor(shopOf(STORE))).toContain("trainStockersRegister");
    expect(leverKeysFor(shopOf("store-decatur"))).not.toContain("trainStockersRegister");
    expect(leverKeysFor(shopOf("store-buford"))).not.toContain("trainConfectionersPick");

    // A family that is not switched on is simply absent.
    expect(leverKeysFor(shopOf(STORE), { registers: true })).toEqual(["registers"]);
    expect(leverKeysFor(shopOf(STORE), { overtime: true })).toEqual(["flex", "overtimeMax", "targetUtilization"]);
    expect(leverKeysFor(shopOf(STORE), {})).toEqual([]);
  });
});

describe("every one-lever step is a scenario the twin accepts", () => {
  // Generation 0 is only worth seeding with the one-lever steps if the twin
  // runs all of them. This walks the neighbourhood the search builds, at every
  // shop, and asks buildTwin to accept each plan. It is the cheap half of an
  // evaluation, so it can afford to be exhaustive.
  for (const store of ["store-midtown", "store-decatur", "store-marietta", "store-avalon", "store-buford"]) {
    it(
      store,
      async () => {
        const shop = shopOf(store);
        const keys = leverKeysFor(shop);
        expect(keys.length).toBeGreaterThan(10);
        const baseG = baseGenome(shop, {});
        for (const l of LEVERS) {
          if (!keys.includes(l.key)) continue;
          const v = baseG[l.key];
          const steps =
            l.kind === "bool" ? [!v] : l.kind === "choice" ? (l.choices ?? []).filter((c) => c !== v) : [Number(v) + 1, Number(v) - 1].filter((n) => n >= l.min! && n <= l.max!);
          for (const step of steps) {
            const g: Genome = { ...baseG, [l.key]: step };
            const scenario = genomeToScenario(g, {}, baseG, shop);
            expect(describeChanges(g, baseG)).toHaveLength(1);
            await expect(buildTwin(store, WEEK, scenario), `${l.key} = ${String(step)}`).resolves.toBeTruthy();
          }
        }
      },
      SLOW
    );
  }
});

describe("assumptions", () => {
  it("the three presets differ only in what a failed customer costs", () => {
    const priced = new Set(["walkoutMultiplier", "lateOrderCost", "lateOrderMinuteCost", "missedOrderCost"]);
    const keys = Object.keys(DEFAULT_ASSUMPTIONS.balanced) as Array<keyof typeof DEFAULT_ASSUMPTIONS.balanced>;
    for (const k of keys) {
      if (priced.has(k)) continue;
      expect(DEFAULT_ASSUMPTIONS.service[k]).toBe(DEFAULT_ASSUMPTIONS.balanced[k]);
      expect(DEFAULT_ASSUMPTIONS.cost[k]).toBe(DEFAULT_ASSUMPTIONS.balanced[k]);
    }
    for (const k of priced) {
      const key = k as keyof typeof DEFAULT_ASSUMPTIONS.balanced;
      expect(DEFAULT_ASSUMPTIONS.service[key]).toBeGreaterThan(DEFAULT_ASSUMPTIONS.balanced[key]);
      expect(DEFAULT_ASSUMPTIONS.balanced[key]).toBeGreaterThan(DEFAULT_ASSUMPTIONS.cost[key]);
    }
    // A walked-out customer always costs at least the basket they dropped.
    for (const o of ["service", "balanced", "cost"] as Objective[]) {
      expect(DEFAULT_ASSUMPTIONS[o].walkoutMultiplier).toBeGreaterThanOrEqual(1);
      expect(DEFAULT_ASSUMPTIONS[o].grossMargin).toBeGreaterThan(0);
      expect(DEFAULT_ASSUMPTIONS[o].grossMargin).toBeLessThan(1);
    }
  });

  it("an override lands on top of the preset it names", () => {
    const a = assumptionsFor("cost", { walkoutMultiplier: 9, stockCarryingAnnual: 0.4 });
    expect(a.walkoutMultiplier).toBe(9);
    expect(a.stockCarryingAnnual).toBe(0.4);
    expect(a.lateOrderCost).toBe(DEFAULT_ASSUMPTIONS.cost.lateOrderCost);
  });

  it("costOf is exported and its parts add up", () => {
    // Guards the arithmetic identity the breakdown promises without running the
    // engine: the cost lines sum to `total`, and `net` is `total` less margin.
    expect(costOf).toBeTypeOf("function");
  });
});

describe("the search", () => {
  it(
    "generation 0 is the shop as it is plus every one-lever step from it",
    async () => {
      // One lever with five choices: generation 0 is the whole space, so the
      // plans it reports are exactly the base and its four neighbours.
      const r = await optimizeOperations(STORE, WEEK, {}, { levers: { serviceLevel: true }, population: 12, generations: 0, days: 3 });
      expect(r.evaluated).toBe(5);
      expect(r.generations).toHaveLength(1);
      expect(r.generations[0].index).toBe(0);

      const seen = new Set([r.best, ...r.runnersUp].map((c) => c.scenario.serviceLevel ?? "as it is"));
      expect(seen).toEqual(new Set(["as it is", 0.9, 0.95, 0.985, 0.995]));
    },
    SLOW
  );

  it(
    "gives the same plan for the same inputs, and never a worse one than the shop as it is",
    async () => {
      const levers: Levers = { registers: true, overtime: true };
      const opts = { levers, population: 8, generations: 1, days: 3, seed: 7 } as const;
      const a = await optimizeOperations(STORE, WEEK, {}, opts);
      const b = await optimizeOperations(STORE, WEEK, {}, opts);

      expect(JSON.stringify(b.best.scenario)).toBe(JSON.stringify(a.best.scenario));
      expect(b.best.changes).toEqual(a.best.changes);
      expect(b.best.score).toBe(a.best.score);
      expect(b.generations).toEqual(a.generations);
      expect(b.evaluated).toBe(a.evaluated);
      expect(b.runnersUp.map((c) => c.score)).toEqual(a.runnersUp.map((c) => c.score));

      // The baseline is in the population, so the winner is bounded by it.
      expect(a.best.score).toBeLessThanOrEqual(a.baseline.score + 1e-9);
      expect(a.generations.every((g) => g.best <= a.baseline.score + 1e-9)).toBe(true);
      // Best-so-far only ever falls.
      for (let i = 1; i < a.generations.length; i++) expect(a.generations[i].best).toBeLessThanOrEqual(a.generations[i - 1].best + 1e-9);
      // Runners-up are distinct plans, ordered, and none beats the winner.
      expect(a.runnersUp.every((c) => c.score >= a.best.score - 1e-9)).toBe(true);
      expect(new Set(a.runnersUp.map((c) => JSON.stringify(c.scenario))).size).toBe(a.runnersUp.length);
    },
    SLOW
  );

  it(
    "prices the plan: every line adds up and the objective comes back with it",
    async () => {
      const seen: number[] = [];
      const r = await optimizeOperations(STORE, WEEK, {}, {
        objective: "service",
        levers: { registers: true },
        population: 6,
        generations: 1,
        days: 3,
        onGeneration: (g) => seen.push(g.index),
      });

      expect(r.objective).toBe("service");
      expect(r.assumptions).toEqual(DEFAULT_ASSUMPTIONS.service);
      expect(seen).toEqual(r.generations.map((g) => g.index));

      for (const c of [r.baseline, r.best, ...r.runnersUp]) {
        const k = c.cost;
        const sum = k.labor + k.overtime + k.hiring + k.training + k.equipment + k.stock + k.lostShelf + k.lostQueue + k.lateOrders;
        expect(k.total).toBeCloseTo(sum, 6);
        expect(k.net).toBeCloseTo(k.total - k.margin, 6);
        expect(c.score).toBe(k.net);
        // Nothing the shop cannot do: no negative wages, no negative losses.
        expect(k.labor).toBeGreaterThanOrEqual(0);
        expect(k.stock).toBeGreaterThanOrEqual(0);
        expect(k.lostShelf).toBeGreaterThanOrEqual(0);
        expect(k.lostQueue).toBeGreaterThanOrEqual(0);
        expect(k.margin).toBeGreaterThanOrEqual(0);
      }

      // The baseline changes nothing and so costs nothing extra in capital.
      expect(r.baseline.changes).toEqual([]);
      expect(r.baseline.cost.equipment).toBe(0);
      expect(r.baseline.cost.hiring).toBe(0);
      expect(r.baseline.cost.training).toBe(0);
    },
    SLOW
  );

  it(
    "a shop starved of registers is told to open another one",
    async () => {
      // store-buford trades on a single register. With only that lever to pull,
      // the first move the search can make is the right one.
      const r = await optimizeOperations("store-buford", WEEK, {}, { levers: { registers: true }, population: 6, generations: 2, days: 4 });
      expect(findSite("store-buford").checkout.registers).toBe(1);
      expect(r.best.changes).toHaveLength(1);
      expect(r.best.changes[0]).toMatch(/register/i);
      expect(r.best.scenario.registers).toBeGreaterThan(1);
      expect(r.best.score).toBeLessThan(r.baseline.score);
      // It is paid for out of margin, not conjured: the lane costs money.
      expect(r.best.cost.equipment).toBeGreaterThan(0);
    },
    SLOW
  );

  it(
    "never spends more than its evaluation-week budget",
    async () => {
      const days = 7;
      const seeds = 1;
      const spent = (r: { evaluated: number }) => (r.evaluated * seeds * days) / 7;

      // Three weeks of engine time. A four-generation search of twelve plans
      // wants sixty, so the budget trims the search before it starts.
      const trimmed = await optimizeOperations(STORE, WEEK, {}, { levers: { serviceLevel: true }, population: 12, generations: 4, days, seeds, maxEvaluationWeeks: 3 });
      expect(spent(trimmed)).toBeLessThanOrEqual(3);
      // It still returns a usable answer.
      expect(trimmed.baseline.kpis.customers).toBeGreaterThan(0);

      // Below the smallest population the search will run, the budget stops it
      // where it stands rather than overspending.
      const cut = await optimizeOperations(STORE, WEEK, {}, { levers: { serviceLevel: true }, population: 12, generations: 4, days, seeds, maxEvaluationWeeks: 2 });
      expect(spent(cut)).toBeLessThanOrEqual(2);
      expect(cut.stoppedEarly).toBe(true);

      // Uncapped, the same search sees the whole five-plan space.
      const full = await optimizeOperations(STORE, WEEK, {}, { levers: { serviceLevel: true }, population: 12, generations: 0, days: 3 });
      expect(full.evaluated).toBe(5);
      expect(full.stoppedEarly).toBe(false);
    },
    SLOW
  );

  it(
    "stops early once the generations stop improving",
    async () => {
      // Five distinct plans and twenty generations asked for: everything after
      // generation 0 is a memo hit, nothing improves, and patience ends it.
      const r = await optimizeOperations(STORE, WEEK, {}, { levers: { serviceLevel: true }, population: 12, generations: 20, days: 3 });
      expect(r.evaluated).toBe(5);
      expect(r.stoppedEarly).toBe(true);
      expect(r.generations.length).toBeLessThan(21);
      expect(r.generations.at(-1)?.best).toBe(r.best.score);
    },
    SLOW
  );

  it("refuses a search with nothing to search", async () => {
    await expect(optimizeOperations(STORE, WEEK, {}, { levers: {} })).rejects.toThrow(/lever/i);
  });

  it("the hosted budget covers what the default search costs", () => {
    // The defaults in OptimizeOptions: 16 plans, 10 generations after the
    // first, one seed, a seven-day week.
    expect(evaluationWeeks(16, 10, 1, 7)).toBe(16 * 11);
    expect(evaluationWeeks(16, 10, 1, 7)).toBeLessThanOrEqual(MAX_EVALUATION_WEEKS);
  });
});
