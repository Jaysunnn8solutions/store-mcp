/**
 * Local MCP server over stdio. The same twelve tools as the Vercel endpoint,
 * plus render_floor, which writes a floor plan to an HTML file — something only
 * a local process can do. Add it to Claude Code with:
 *
 *   claude mcp add store-twin -- npx tsx C:/path/to/store-mcp/mcp/stdio.ts
 *
 * The data directory is resolved relative to this file, so the server works
 * from any working directory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { layoutSpecSchema } from "../lib/layout/spec";
import { storeFloorHtml } from "../lib/render/store-floor";
import { registerAll } from "../lib/tools/register";
import { error, fmt1, fmtInt, guarded, pct1, text, z } from "../lib/tools/shared";
import { buildTwin, storeSchema } from "../lib/twin/twin";

// ||= rather than ??=: the loader tests the variable for truthiness, so an
// empty string has to be replaced too.
process.env.STORE_DATA_DIR ||= path.resolve(import.meta.dirname, "..", "data");

const server = new McpServer({ name: "store-mcp", version: "0.1.0" });
registerAll(server);

const renderConfig = {
  title: "Render the floor plan to an HTML file",
  description:
    "Write a self-contained HTML floor plan (no server needed): the outline, the zones, the gondola runs and their aisles, the bulk-bin and wall shelving, " +
    "the seasonal tables, the showcase and the registers, the stockroom, the goods doors and the customer lot, with the fixture bays shaded by the " +
    "merchandising value of their shelves. Works on a shop's built-in building or an imported layout, with the current or the optimized plan. " +
    "Returns the file path. Local only.",
  inputSchema: z
    .object({
      store: storeSchema,
      layout: layoutSpecSchema.optional(),
      merchandising: z.enum(["current", "optimized"]).default("current"),
      path: z.string().max(400).optional().describe("Output file path. Defaults to ./store-floor-<name>-<timestamp>.html in the current directory."),
      overwrite: z.boolean().default(false).describe("Replace the file if it exists. Off by default, so a render never overwrites an existing file."),
    })
    .strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

type RenderArgs = z.infer<typeof renderConfig.inputSchema>;

server.registerTool("render_floor", renderConfig, (args: RenderArgs) =>
  guarded(async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const label = (args.layout?.name ?? args.store).replace(/[^\w-]+/g, "_").slice(0, 40);
    const file = path.resolve(args.path ?? `store-floor-${label}-${stamp}.html`);
    // destructiveHint: false is only honest if the tool never replaces a file
    // the caller did not mean to lose.
    if (!args.overwrite && existsSync(file)) {
      return error(`${file} already exists. Pass overwrite: true to replace it, or omit path for a fresh timestamped file.`);
    }
    const ctx = await buildTwin(args.store, 36, { merchandising: args.merchandising, layout: args.layout });
    const title = `${args.layout ? args.layout.name : ctx.site.name} — ${args.merchandising} merchandising, ${fmtInt(ctx.layout.facings.length)} facings, ${pct1(ctx.merchEval.eyeLevelShare)} of the week's dollars at eye level`;
    const html = storeFloorHtml({ layout: ctx.layout, title }, { shadeBy: "appeal" });
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, html, "utf8");
    return text(`Wrote ${file} (${fmt1(html.length / 1024)} KB). Open it in a browser; it needs no server.`);
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
