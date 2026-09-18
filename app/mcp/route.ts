import { createMcpHandler } from "mcp-handler";
// Explicit, so the fs data provider is registered even if no tool imports it
// transitively one day.
import "@/lib/data/load";
import { registerAll } from "@/lib/tools/register";

/**
 * stress_test (up to 60 runs), find_capacity (a dozen probes) and
 * peak_readiness (a baseline plus a fix apiece) are the expensive tools; all
 * three finish in a few seconds locally. This leaves room for a cold start on a
 * slower serverless vCPU and stays inside Vercel Hobby's 60 s.
 */
export const maxDuration = 60;

/** Remote MCP endpoint. The same tools as the local stdio server, minus render_floor. */
const handler = createMcpHandler((server) => registerAll(server), {
  serverInfo: { name: "store-mcp", version: "0.1.0" },
});

export { handler as GET, handler as POST };
