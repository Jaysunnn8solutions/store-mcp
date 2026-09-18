/**
 * The seam between a tool's own arguments and the shared scenario vocabulary.
 *
 * Every simulation tool spreads `scenarioShape` into its input schema, so a
 * conversation can carry one set of assumptions from plan_labor through
 * what_if to stress_test without restating them. At call time the fields go
 * back where they belong: the scenario to `buildTwin`, the rest to the tool.
 */

import { z } from "zod";
import { scenarioShape, startWeekSchema, storeSchema, type TwinScenario } from "../twin/twin";

const SCENARIO_KEYS = Object.keys(scenarioShape) as Array<keyof TwinScenario>;

/**
 * Pull the scenario fields out of a tool's arguments, leaving the rest.
 *
 * Undefined values are dropped rather than copied. That is what keeps
 * `Object.keys(scenario).length === 0` a meaningful test in what_if, and what
 * keeps an untouched field out of the 3D link's hash.
 */
export function splitScenario<T extends Record<string, unknown>>(args: T): { scenario: TwinScenario; rest: Omit<T, keyof TwinScenario> } {
  const scenario: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if ((SCENARIO_KEYS as string[]).includes(k)) {
      if (v !== undefined) scenario[k] = v;
    } else rest[k] = v;
  }
  return { scenario: scenario as TwinScenario, rest: rest as Omit<T, keyof TwinScenario> };
}

/** Which shop, and when the horizon starts. Week 36 is early autumn, before the peak. */
export const baseShape = {
  store: storeSchema,
  startWeek: startWeekSchema.default(36),
};

export { scenarioShape, z };
