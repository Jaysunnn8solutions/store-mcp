/**
 * One registration function for both transports: the HTTP handler on Vercel and
 * the stdio server run locally. The stdio server adds render_floor on top,
 * because only a local process can write a file.
 *
 * The order below is the order a conversation wants them in: orientation
 * first, then the building and the crew, then the runs, then the plans.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { buildScheduleConfig, buildScheduleHandler } from "./build-schedule";
import { describeStoreConfig, describeStoreHandler } from "./describe-store";
import { findCapacityConfig, findCapacityHandler } from "./find-capacity";
import { getLayoutConfig, getLayoutHandler } from "./get-layout";
import { getWorkforceConfig, getWorkforceHandler } from "./get-workforce";
import { importLayoutConfig, importLayoutHandler } from "./import-layout";
import { optimizeMerchandisingConfig, optimizeMerchandisingHandler } from "./optimize-merchandising";
import { optimizeOperationsConfig, optimizeOperationsHandler } from "./optimize-operations";
import { peakReadinessConfig, peakReadinessHandler } from "./peak-readiness";
import { planLaborConfig, planLaborHandler } from "./plan-labor";
import { merchandisingPrompt, peakPrompt, servicePrompt } from "./prompts";
import { manifestResource, methodResource, networkResource, sitesResource } from "./resources";
import { simulateDayConfig, simulateDayHandler } from "./simulate-day";
import { stockStatusConfig, stockStatusHandler } from "./stock-status";
import { stressTestConfig, stressTestHandler } from "./stress-test";
import { whatIfConfig, whatIfHandler } from "./what-if";

/** The fourteen tools both transports carry, in the order they are registered. */
export const TOOL_NAMES = [
  "describe_store",
  "import_layout",
  "get_layout",
  "get_workforce",
  "simulate_day",
  "what_if",
  "stress_test",
  "find_capacity",
  "optimize_merchandising",
  "optimize_operations",
  "stock_status",
  "plan_labor",
  "build_schedule",
  "peak_readiness",
] as const;

export function registerAll(server: McpServer): void {
  server.registerTool("describe_store", describeStoreConfig, describeStoreHandler);
  server.registerTool("import_layout", importLayoutConfig, importLayoutHandler);
  server.registerTool("get_layout", getLayoutConfig, getLayoutHandler);
  server.registerTool("get_workforce", getWorkforceConfig, getWorkforceHandler);
  server.registerTool("simulate_day", simulateDayConfig, simulateDayHandler);
  server.registerTool("what_if", whatIfConfig, whatIfHandler);
  server.registerTool("stress_test", stressTestConfig, stressTestHandler);
  server.registerTool("find_capacity", findCapacityConfig, findCapacityHandler);
  server.registerTool("optimize_merchandising", optimizeMerchandisingConfig, optimizeMerchandisingHandler);
  server.registerTool("optimize_operations", optimizeOperationsConfig, optimizeOperationsHandler);
  server.registerTool("stock_status", stockStatusConfig, stockStatusHandler);
  server.registerTool("plan_labor", planLaborConfig, planLaborHandler);
  server.registerTool("build_schedule", buildScheduleConfig, buildScheduleHandler);
  server.registerTool("peak_readiness", peakReadinessConfig, peakReadinessHandler);

  server.registerPrompt(peakPrompt.name, peakPrompt.config, peakPrompt.handler);
  server.registerPrompt(servicePrompt.name, servicePrompt.config, servicePrompt.handler);
  server.registerPrompt(merchandisingPrompt.name, merchandisingPrompt.config, merchandisingPrompt.handler);
  for (const r of [manifestResource, networkResource, sitesResource, methodResource]) {
    server.registerResource(r.name, r.uri, r.config, r.handler);
  }
}
