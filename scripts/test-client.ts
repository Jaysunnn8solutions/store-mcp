/**
 * Smoke test. Against a running HTTP server:
 *   npm run test:client -- http://localhost:3000
 * Against the local stdio server (spawns it, and exercises render_floor too):
 *   npm run test:client -- stdio
 *
 * It calls every registered tool on the transport under test, every prompt and
 * every resource, and then the arguments that must be rejected: an unknown
 * shop, an unknown worker, a temp taught a skill that needs a card, an unknown
 * supplier, a shift that closes before it opens, a number out of range, and
 * render_floor refusing to clobber a file. The rejects list is the real
 * specification of the error contract, so it is worth reading first.
 *
 * The live candystore call is skipped with --offline.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { findSite } from "../lib/data/load";
import { sampleStore } from "../lib/layout/samples";
import { compactSpec } from "../lib/layout/spec";
import { siteToSpec } from "../lib/twin/layout";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const target = argv.find((a) => !a.startsWith("--")) ?? "http://localhost:3000";
const offline = argv.includes("--offline");
const PREVIEW = 10;

const root = path.resolve(import.meta.dirname, "..");
// Read lazily by lib/data/load, so setting it after the imports still lands.
process.env.STORE_DATA_DIR ||= path.join(root, "data");

const OUT_DIR = path.join(os.tmpdir(), "store-mcp-smoke");
const FLOOR_FILE = path.join(OUT_DIR, "floor.html");

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

async function main() {
  const client = new Client({ name: "store-mcp-smoke", version: "0.1.0" });
  if (target === "stdio") {
    await client.connect(
      new StdioClientTransport({
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args: ["tsx", path.join(root, "mcp", "stdio.ts")],
        cwd: root,
      })
    );
    console.log("Connected to local stdio server");
  } else {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", `${target}/`)));
    console.log("Connected to", target);
  }

  const { tools } = await client.listTools();
  console.log(`Tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
  const { prompts } = await client.listPrompts();
  console.log(`Prompts (${prompts.length}):`, prompts.map((p) => p.name).join(", "));
  const { resources } = await client.listResources();
  console.log(`Resources (${resources.length}):`, resources.map((r) => r.uri).join(", "));

  // A built-in shop turned into a spec is a real, valid layout to hand back
  // through the `layout` field, which is the path an imported drawing takes.
  const spec = compactSpec(siteToSpec(findSite("store-marietta")));

  const calls: Array<[string, Record<string, unknown>]> = [
    ["describe_store", {}],
    ["get_layout", { store: "store-midtown", top: 5 }],
    ["get_layout", { store: "store-avalon", merchandising: "optimized", top: 5 }],
    ["get_workforce", { store: "store-decatur" }],
    ["simulate_day", { store: "store-midtown", startWeek: 43, days: 7, runs: 2 }],
    ["what_if", { store: "store-decatur", startWeek: 36, days: 7, runs: 2, registers: 4, crossTrain: [{ role: "Cashier", skill: "counter" }] }],
    ["stress_test", { store: "store-buford", days: 10, runs: 10 }],
    ["find_capacity", { store: "store-marietta", days: 7, runs: 1 }],
    ["optimize_merchandising", { store: "store-midtown", maxMoves: 20, listMoves: 5, validate: true }],
    // A small search: enough to prove the tool wires up and returns a runnable
    // scenario, not enough to spend a minute of a smoke test on it.
    ["optimize_operations", { store: "store-buford", startWeek: 44, population: 6, generations: 2, seeds: 1, days: 5, runnersUp: 2 }],
    ["import_layout", { format: "csv", content: sampleStore("csv") as string }],
    ["stock_status", { store: "store-avalon", startWeek: 38, weeks: 6, forecast: "trailing", supplierDelays: [{ category: "specialty:latam", extraDays: 14, fromDay: 0, toDay: 20 }] }],
    ["plan_labor", { store: "store-midtown", startWeek: 38, weeks: 8, validate: true }],
    ["build_schedule", { store: "store-decatur", week: 44, addWorkers: [{ role: "cashier", shift: "close", type: "temp", count: 1 }] }],
    ["peak_readiness", { store: "store-buford", week: 44, days: 3, runs: 1 }],
    [
      "simulate_day",
      {
        store: "store-midtown",
        startWeek: 36,
        days: 5,
        runs: 1,
        registerOutages: [{ count: 1, fromDay: 0, toDay: 2 }],
        posOutages: [{ day: 1, start: "14:00", hours: 3 }],
        workerLeave: [{ role: "Counter confectioner", fromDay: 0, toDay: 4 }],
        patience: 0.6,
      },
    ],
    ["simulate_day", { store: "store-marietta", layout: spec, days: 5, runs: 1, merchandising: "optimized" }],
  ];
  if (!offline) calls.push(["what_if", { store: "store-midtown", days: 7, runs: 1, candystore: { add: [{ type: "general", lon: -84.38, lat: 33.79 }] } }]);
  if (target === "stdio") {
    mkdirSync(OUT_DIR, { recursive: true });
    rmSync(FLOOR_FILE, { force: true });
    calls.push(["render_floor", { store: "store-midtown", merchandising: "optimized", path: FLOOR_FILE }]);
  }

  const rejects: Array<[string, string, Record<string, unknown>]> = [
    ["simulate_day", "unknown shop", { store: "store-nowhere", days: 3, runs: 1 }],
    ["what_if", "unknown worker", { store: "store-midtown", removeWorkers: ["W-MID-099"], days: 3, runs: 1 }],
    [
      "what_if",
      "a temp taught the counter",
      { store: "store-midtown", addWorkers: [{ role: "cashier", shift: "mid", type: "temp", count: 1 }], crossTrain: [{ worker: "NEW-01", skill: "counter" }], days: 3, runs: 1 },
    ],
    ["build_schedule", "unknown shift", { store: "store-midtown", week: 40, addWorkers: [{ role: "stocker", shift: "graveyard", type: "full-time", count: 1 }] }],
    ["stock_status", "unknown supplier", { store: "store-decatur", supplierDelays: [{ supplier: "SUP-NOPE", extraDays: 5, fromDay: 0, toDay: 3 }] }],
    ["what_if", "hours that close before they open", { store: "store-midtown", days: 3, runs: 1, hours: [{ day: 6, open: "18:00", close: "10:00" }] }],
    ["simulate_day", "days out of range", { store: "store-midtown", days: 400 }],
    ["get_layout", "an unknown argument", { store: "store-midtown", slotting: "optimized" }],
  ];
  if (target === "stdio") rejects.push(["render_floor", "an existing file, no overwrite", { store: "store-midtown", path: FLOOR_FILE }]);

  let failures = 0;
  for (const [name, args] of calls) {
    const started = Date.now();
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    const body = result.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result);
    if (result.isError) failures++;
    console.log(`\n=== ${name} (${result.isError ? "ERROR" : "ok"}, ${Date.now() - started} ms) ===`);
    console.log(body.split("\n").slice(0, PREVIEW).join("\n"));
    // The simulation tools end with a 3D link, or a pointer to the import page
    // when the run was of an imported building.
    if (!result.isError && (name === "simulate_day" || name === "what_if") && !("candystore" in args)) {
      const want = "layout" in args ? "/import" : "/store#";
      const ok = body.includes(want);
      if (!ok) failures++;
      console.log(`3D link (${want}): ${ok ? "present" : "MISSING"}`);
    }
    // peak_readiness always names a recommendation, whether or not one clears.
    if (!result.isError && name === "peak_readiness") {
      const ok = body.includes("What each fix buys") && (body.includes("Cheapest fix") || body.includes("No single fix"));
      if (!ok) failures++;
      console.log(`verdict and fix menu: ${ok ? "present" : "MISSING"}`);
    }
  }

  const promptCalls: Array<[string, Record<string, string>]> = [
    ["peak_readiness", { store: "store-midtown", week: "44" }],
    ["service_drill", { store: "store-decatur" }],
    ["merchandising_review", { store: "store-avalon", week: "40" }],
  ];
  for (const [name, args] of promptCalls) {
    try {
      const r = await client.getPrompt({ name, arguments: args });
      const body = r.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
      console.log(`\n=== prompt ${name} (ok) ===`);
      console.log(body.split("\n").slice(0, 3).join("\n"));
    } catch (e) {
      failures++;
      console.log(`\n=== prompt ${name} (ERROR) ===\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const uris = ["store://data/manifest", "store://data/network", "store://data/shops", "store://method"];
  for (const uri of uris) {
    try {
      const r = await client.readResource({ uri });
      const body = r.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
      console.log(`\n=== resource ${uri} (ok, ${body.length} chars) ===`);
    } catch (e) {
      failures++;
      console.log(`\n=== resource ${uri} (ERROR) ===\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const [name, label, args] of rejects) {
    let rejected = false;
    let body = "";
    try {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      rejected = result.isError === true;
      body = result.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result);
    } catch (e) {
      rejected = true;
      body = e instanceof Error ? e.message : String(e);
    }
    if (!rejected) failures++;
    console.log(`\n=== ${name}: ${label} (${rejected ? "rejected, as it should be" : "ACCEPTED — should have been rejected"}) ===`);
    console.log(body.split("\n").slice(0, 3).join("\n"));
  }

  // The stateless endpoint the import page posts to is not MCP, so it is only
  // reachable when there is an HTTP server to ask.
  let apiChecks = 0;
  if (target !== "stdio") {
    apiChecks = 1;
    try {
      const res = await fetch(new URL("/api/store", `${target}/`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: spec, store: "store-marietta", days: 5, runs: 1 }),
      });
      const json = (await res.json()) as { kpis?: { salesDollars?: number }; error?: string };
      const ok = res.ok && typeof json.kpis?.salesDollars === "number";
      if (!ok) failures++;
      console.log(`\n=== POST /api/store (${ok ? "ok" : `FAILED ${res.status}`}) ===\n${ok ? `${Math.round(json.kpis!.salesDollars!)} sold over 5 days` : json.error}`);
    } catch (e) {
      failures++;
      console.log(`\n=== POST /api/store (ERROR) ===\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (target === "stdio") console.log(`\nrender_floor wrote ${FLOOR_FILE}: ${existsSync(FLOOR_FILE) ? "yes" : "NO"}`);

  await client.close();
  const total = calls.length + promptCalls.length + uris.length + rejects.length + apiChecks;
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${total} checks passed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
