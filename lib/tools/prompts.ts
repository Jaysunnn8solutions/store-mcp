/**
 * Three chains worth having as one call. Each is a plan of tool calls rather
 * than an answer: the prompt hands the model the order to ask the questions in
 * and the comparison that makes the answers mean something, and the tools do
 * the work.
 *
 * Prompt arguments arrive as strings over the wire, so every numeric one is
 * coerced.
 */

import { z } from "zod";

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export const peakPrompt = {
  name: "peak_readiness",
  config: {
    title: "Halloween readiness",
    description: "Is a shop ready for the candy peak: what breaks on the floor, what it costs to fix, and what has to be booked now.",
    argsSchema: z.object({ store: z.string().default("store-midtown"), week: z.coerce.number().int().min(1).max(52).default(44) }),
  },
  handler: ({ store, week }: { store: string; week: number }) =>
    userMessage(
      [
        `Assess whether ${store} is ready for the candy peak around calendar week ${week}.`,
        `1. Call describe_store, then peak_readiness for ${store} at week ${week}.`,
        `2. Call simulate_day for ${store} with startWeek ${week - 2} and days 21 to see the run-up, not just the week itself.`,
        `3. Call plan_labor for ${store} from week ${week - 8} for 10 weeks, and get_workforce to see which skills rest on one person.`,
        `4. Call stock_status for ${store} from week ${week - 6} for 8 weeks, and again with forecast "trailing" to see what a buyer who does not plan seasonally would be holding.`,
        `5. Confirm the two best fixes from step 1 with what_if at startWeek ${week}, days 7 — separately, then together.`,
        `Report: the walk-outs and lost sales as things stand, which queue or shelf causes them, which fix buys back the most margin per dollar a week, what must be ordered or booked now given the cross-training and hiring lead times, and the risks that remain. Say plainly that the buildings, roster, standards and cost rates are mock inputs.`,
      ].join("\n")
    ),
};

export const servicePrompt = {
  name: "service_drill",
  config: {
    title: "What a dead register on a Saturday costs",
    description: "Price the shop's fragility: a till down at the worst hour of the week, a no-show behind the glass, a van off the road — and what protects against each.",
    argsSchema: z.object({ store: z.string().default("store-decatur"), week: z.coerce.number().int().min(1).max(52).default(36) }),
  },
  handler: ({ store, week }: { store: string; week: number }) =>
    userMessage(
      [
        `Run a service drill for ${store} starting week ${week}. Day 0 is the Monday of that week, so Saturday is day 5.`,
        `1. Call get_workforce for ${store} and note every skill one person or nobody holds.`,
        `2. Call stress_test for ${store} at startWeek ${week} to see how often each kind of disruption bites and how much worse the runs it hits are.`,
        `3. Price the deterministic versions with what_if at startWeek ${week}, days 7: a register out on the Saturday (registerOutages days 5–5), the till network down for three hours on the Saturday afternoon (posOutages day 5 from "14:00"), the only counter-trained person away (workerLeave for that worker, days 5–6), and the van off the road (vanOutages days 0–2).`,
        `4. Test a protection for each with what_if: an extra register, a second showcase station, cross-training someone onto the counter, and an extra van.`,
        `Report, for each failure: how likely it is in an ordinary fortnight, what it costs in walk-outs and lost sales when it happens, and the cheapest protection. Say which of them is worth buying and which is worth simply accepting.`,
      ].join("\n")
    ),
};

export const merchandisingPrompt = {
  name: "merchandising_review",
  config: {
    title: "Is the floor merchandised for what sells",
    description: "Walk the planogram: where the week's dollars sit, what a reset would move, what it costs in stocker hours and what it pays back.",
    argsSchema: z.object({ store: z.string().default("store-avalon"), week: z.coerce.number().int().min(1).max(52).default(40) }),
  },
  handler: ({ store, week }: { store: string; week: number }) =>
    userMessage(
      [
        `Review the merchandising at ${store} for week ${week}.`,
        `1. Call get_layout for ${store} with top 20, then again with merchandising "optimized", and compare where the fastest movers sit.`,
        `2. Call optimize_merchandising for ${store} at startWeek ${week} with validate true.`,
        `3. Call stock_status for ${store} from week ${week} for 6 weeks and check whether the SKUs that run out are the ones the reset would move.`,
        `4. Confirm with what_if at startWeek ${week}, days 14: merchandising "optimized" alone, then with facingDays raised to 6.`,
        `Report: how much of the week's money is at eye level and on feature fixtures today, which SKUs are in the wrong place and what each is worth a week, what the reset costs in stocker hours and pays back in lost sales avoided, and how many Sunday nights it takes to earn back. Note that merchandising moves the mix and not the total — the shop's dollars come from candystore's market model either way — so the whole gain is in sales not lost.`,
      ].join("\n")
    ),
};
