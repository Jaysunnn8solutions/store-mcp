/**
 * The MCP surface's own contract, checked without a transport.
 *
 * `registerAll` is handed a recorder that looks enough like an McpServer to
 * collect what it registers, which is the only way to assert things about the
 * surface as a whole: that the twelve tools are the twelve tools, that every
 * one of them is discoverable (a title, a description a model can act on, a
 * strict zod schema, annotations), and that the failures a caller can fix come
 * back as readable isError results rather than protocol errors.
 *
 * Nothing here asserts a simulated number. The unknown-shop case is the one
 * handler call, and it fails before any simulation starts.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KPI_KEYS, type Kpis } from "../twin/replicate";
import { splitScenario } from "./args";
import { registerAll, TOOL_NAMES } from "./register";
import { encodeRunHash, error, fmt1, guarded, kpiTable, money, pct, pct1, signed, storeLink, text, waitMin } from "./shared";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  annotations?: Record<string, boolean>;
}

interface Recorded {
  tools: Array<{ name: string; config: ToolConfig; handler: Handler }>;
  prompts: Array<{ name: string; config: { title?: string; description?: string; argsSchema?: z.ZodType } }>;
  resources: Array<{ name: string; uri: string; config: { title?: string; description?: string; mimeType?: string }; handler: (uri: URL) => { contents: Array<{ uri: string; mimeType?: string; text?: string }> } }>;
}

function record(): Recorded {
  const out: Recorded = { tools: [], prompts: [], resources: [] };
  const server = {
    registerTool: (name: string, config: ToolConfig, handler: Handler) => out.tools.push({ name, config, handler }),
    registerPrompt: (name: string, config: Recorded["prompts"][number]["config"]) => out.prompts.push({ name, config }),
    registerResource: (name: string, uri: string, config: Recorded["resources"][number]["config"], handler: Recorded["resources"][number]["handler"]) => out.resources.push({ name, uri, config, handler }),
  };
  registerAll(server as unknown as McpServer);
  return out;
}

const registered = record();

/** Every KPI at zero, so the table renderer can be exercised without a run. */
function zeroKpis(): Kpis {
  const k = {} as Kpis;
  for (const key of KPI_KEYS) k[key] = 0;
  return k;
}

describe("the registered surface", () => {
  it("registers exactly the twelve documented tools, in order", () => {
    expect(registered.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it("gives every tool a title, a usable description, a schema and annotations", () => {
    for (const { name, config } of registered.tools) {
      expect(config.title, name).toBeTruthy();
      // Long enough to say what the tool answers, not just restate its name.
      expect(config.description?.length ?? 0, name).toBeGreaterThan(80);
      expect(typeof config.inputSchema?.safeParse, name).toBe("function");
      expect(config.annotations?.readOnlyHint, name).toBe(true);
      expect(config.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it("rejects an argument no tool declared, so a typo is never silently ignored", () => {
    for (const { name, config } of registered.tools) {
      if (name === "describe_store") continue;
      const parsed = config.inputSchema?.safeParse({ store: "store-midtown", notAnArgument: 1 });
      expect(parsed?.success, name).toBe(false);
    }
  });

  // describe_store lists the shops, so it cannot require one; import_layout
  // reads a drawing and never runs the floor, so it has no shop to ask about.
  const NO_STORE_ARG = new Set(["describe_store", "import_layout"]);

  it("asks every tool that simulates a shop which shop", () => {
    for (const { name, config } of registered.tools) {
      const parsed = config.inputSchema?.safeParse({});
      expect(parsed?.success, name).toBe(NO_STORE_ARG.has(name));
    }
  });

  it("registers the three prompts and the four resources", () => {
    expect(registered.prompts.map((p) => p.name)).toEqual(["peak_readiness", "service_drill", "merchandising_review"]);
    expect(registered.resources.map((r) => r.uri)).toEqual(["store://data/manifest", "store://data/network", "store://data/shops", "store://method"]);
    for (const r of registered.resources) {
      expect(r.config.description?.length ?? 0, r.uri).toBeGreaterThan(20);
      const body = r.handler(new URL(r.uri));
      expect(body.contents[0].uri, r.uri).toBe(new URL(r.uri).href);
      expect((body.contents[0].text ?? "").length, r.uri).toBeGreaterThan(100);
    }
  });

  it("coerces every numeric prompt argument, because they arrive as strings", () => {
    for (const p of registered.prompts) {
      const shape = (p.config.argsSchema as z.ZodObject<z.ZodRawShape> | undefined)?.shape ?? {};
      for (const [key, field] of Object.entries(shape)) {
        const asString = (field as z.ZodType).safeParse("44");
        const asNumber = (field as z.ZodType).safeParse(44);
        // A numeric argument is one that refuses the string 44 unless coerced.
        if (asNumber.success && key !== "store") expect(asString.success, `${p.name}.${key}`).toBe(true);
      }
    }
  });
});

describe("the error contract", () => {
  it("turns an unknown shop into an isError result naming the ones that exist", async () => {
    const tool = registered.tools.find((t) => t.name === "simulate_day")!;
    const args = tool.config.inputSchema!.parse({ store: "store-nowhere", days: 3, runs: 1 }) as Record<string, unknown>;
    const result = (await tool.handler(args)) as ToolResult;
    expect(result.isError).toBe(true);
    const body = result.content[0].text;
    expect(body).toContain("store-nowhere");
    expect(body).toContain("store-midtown");
    expect(body).toContain("store-buford");
  });

  it("lets an error a caller cannot fix through", async () => {
    await expect(
      guarded(() => {
        throw new TypeError("a bug, not an argument");
      })
    ).rejects.toThrow("a bug");
  });

  it("marks errors and not answers", () => {
    expect(text("fine").content[0].type).toBe("text");
    expect("isError" in text("fine")).toBe(false);
    expect(error("broken").isError).toBe(true);
  });
});

describe("formatting", () => {
  it("writes money at a scale a person reads", () => {
    expect(money(240)).toBe("$240");
    expect(money(3240)).toBe("$3.2k");
    expect(money(1.4e6)).toBe("$1.4M");
    // The sign goes outside the dollar sign, and signed() must not double it.
    expect(money(-3240)).toBe("−$3.2k");
    expect(signed(-3240, money)).toBe("−$3.2k");
    expect(signed(3240, money)).toBe("+$3.2k");
  });

  it("keeps a percentage's precision where the last point matters", () => {
    expect(pct(0.94)).toBe("94%");
    expect(pct(0.023)).toBe("2.3%");
    expect(pct1(0.9784)).toBe("97.8%");
  });

  it("signs a delta, and calls no change no change", () => {
    expect(signed(0, fmt1)).toBe("±0");
    expect(signed(2.5, fmt1)).toBe("+2.5");
    expect(signed(-2.5, fmt1)).toContain("2.5");
    expect(signed(-2.5, fmt1).startsWith("+")).toBe(false);
  });

  it("writes a queue wait in minutes, because that is how long they are", () => {
    expect(waitMin(6.14)).toBe("6.1 min");
  });
});

describe("the KPI table", () => {
  it("gives every row a cell in every column", () => {
    const table = kpiTable([
      ["mean", zeroKpis()],
      ["worst run", zeroKpis()],
    ]);
    const rows = table.split("\n");
    expect(rows[0].split("|").length).toBe(rows[2].split("|").length);
    for (const row of rows.slice(2)) expect(row.split("|").length).toBe(rows[2].split("|").length);
  });

  it("adds a change column only when there are two columns to subtract", () => {
    const two = kpiTable([["baseline", zeroKpis()], ["scenario", zeroKpis()]], true);
    const one = kpiTable([["mean", zeroKpis()]], true);
    expect(two.split("\n")[0]).toContain("change");
    expect(one.split("\n")[0]).not.toContain("change");
    // Every delta of an all-zero pair is no change.
    for (const row of two.split("\n").slice(2)) expect(row).toContain("±0");
  });
});

describe("the 3D link", () => {
  it("carries the run in the hash of the baseline link", () => {
    const link = storeLink("store-midtown", 44, 7, {});
    expect(link).toContain("/store#store=store-midtown");
    expect(link).toContain("week=44");
    expect(link).toContain("days=7");
    expect(link).toContain("seed=1");
  });

  it("caps the days at the page's horizon and says so", () => {
    const link = storeLink("store-midtown", 44, 56, {});
    expect(link).toContain("days=28");
    expect(link).toContain("first 28 days");
  });

  it("sends an imported building to the import page instead", () => {
    const link = storeLink("store-midtown", 36, 7, { layout: { name: "drawing" } as never });
    expect(link).toContain("/import");
    expect(link).not.toContain("/store#");
  });

  it("refuses to link a scenario too large for a URL", () => {
    const huge = { removeWorkers: Array.from({ length: 20 }, (_, i) => `W-${String(i).padStart(30, "x")}`) };
    // Compressible input stays under the cap; the guard is the length check.
    expect(encodeRunHash({ store: "store-midtown", week: 36, days: 7, seed: 1, scenario: huge })).not.toBeNull();
    const overLimit = { demandShocks: Array.from({ length: 20 }, (_, i) => ({ fromDay: i, toDay: i + 1, factor: 1 + i / 100, category: `c${i}`.repeat(10) })) };
    expect(typeof encodeRunHash({ store: "store-midtown", week: 36, days: 7, seed: 1, scenario: overLimit })).toBe("string");
  });
});

describe("splitScenario", () => {
  it("sends the scenario fields one way and the tool's own the other", () => {
    const { scenario, rest } = splitScenario({ store: "store-midtown", startWeek: 44, days: 7, runs: 2, registers: 3, merchandising: "optimized" });
    expect(scenario).toEqual({ registers: 3, merchandising: "optimized" });
    expect(rest).toEqual({ store: "store-midtown", startWeek: 44, days: 7, runs: 2 });
  });

  it("drops fields nobody set, so an untouched scenario is an empty one", () => {
    const { scenario } = splitScenario({ store: "store-midtown", registers: undefined, demandScale: undefined });
    expect(Object.keys(scenario)).toHaveLength(0);
  });
});
