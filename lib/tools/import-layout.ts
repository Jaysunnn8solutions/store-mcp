/**
 * Bring your own shop. Turns a floor plan into a layout spec the rest of the
 * tools accept as `layout`, and reports how every layer, block or category was
 * read so the next call can correct it with `roleMap` — which is the whole
 * point, because no default pattern table survives contact with a real drawing.
 *
 * Two doors into the same importer. The hosted server takes the file inline, in
 * the tool call, which is why the limit there is a few hundred kilobytes: the
 * model has to write the content, at roughly 300 tokens per KB. The local stdio
 * server reads a path instead and takes files a thousand times larger, because
 * the file is already on the machine and only the few-kilobyte spec travels.
 *
 * Nothing is stored. The spec comes back in the answer and the caller passes it
 * on; a second import of the same bytes gives the same spec.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ImportError, ROLES, type Role } from "../layout/assemble";
import { describeImport, importLayout, LAYOUT_FORMATS, type ImportInput, type ImportOptions } from "../layout/import";
import { formatBytes, LIMITS } from "../layout/limits";
import { error, guarded, readOnly, text, z } from "./shared";

const baseShape = {
  format: z
    .enum(LAYOUT_FORMATS as [string, ...string[]])
    .optional()
    .describe("dxf, csv (a fixture or planogram export), geojson (ArcGIS Indoors or plain), imdf (zip) or ifc. Detected from the file name or the content when omitted."),
  fileName: z.string().max(260).optional().describe("The original file name; its extension helps detect the format."),
  content: z.string().optional().describe(`File content as text — DXF, CSV or GeoJSON. Up to ${formatBytes(LIMITS.inline.text)} on the hosted server.`),
  contentBase64: z.string().optional().describe(`Binary file content as base64 — an IMDF .zip. Up to ${formatBytes(LIMITS.inline.zip)} decoded on the hosted server.`),
  files: z.record(z.string(), z.string()).optional().describe('Several GeoJSON files by name, e.g. an ArcGIS Indoors export: {"Units.geojson": "…", "Details.geojson": "…"}.'),
  name: z.string().max(120).optional().describe("What to call the shop. Defaults to the file name."),
  roleMap: z
    .record(z.string().max(120), z.enum(ROLES as [string, ...string[]]))
    .optional()
    .describe(
      `How to read layers, block names or categories: pattern (a substring, or /regex/) → role. Roles: ${ROLES.join(", ")}. ` +
        `"wall" is wall shelving a shopper buys from; "wall-line" is the building fabric. Checked before the built-in guesses — run once without it and read the report.`
    ),
  unitsFt: z.number().positive().max(5000).optional().describe("Feet in one drawing or coordinate unit, when the file does not say: 1 for feet, 0.0833 for inches, 0.00328 for mm, 3.281 for meters."),
  level: z.string().max(80).optional().describe("Which floor of a multi-level IMDF or Indoors file (id or name). Defaults to the one with the most fixtures."),
  shelves: z.number().int().min(1).max(10).optional().describe("Selling shelves per bay on every fixture, overriding the per-family defaults (gondola 5, bulk 4, showcase 3)."),
  facingsPerBay: z.number().int().min(1).max(20).optional().describe("Facings side by side on one shelf of one bay, overriding the per-family defaults."),
  aisleWidthFt: z.number().min(2.5).max(20).optional().describe("Aisle width for a run with open floor on one side only. Defaults to the median gap in the drawing."),
  shelfHeightFt: z.number().min(0.5).max(6).optional().describe("Clear height of one selling shelf (default 1.25 ft). It sets what a facing holds."),
};

const description =
  "Turn a shop's floor plan into a layout the twin can simulate: DXF (CAD — export DWG to DXF first), a fixture or planogram CSV, ArcGIS Indoors GeoJSON, " +
  "an IMDF archive, or IFC (BIM). Reports which wall it took for the storefront and why, how each layer or category was read, the fixture runs, aisles, " +
  "facings, service points and doors it found, and everything it had to assume. Returns the layout spec: pass it as `layout` to get_layout, simulate_day, " +
  "what_if, stress_test or any other tool, together with a store id, which supplies the demand, the crew and the equipment. Nothing is stored.";

/** One of content / contentBase64 / files / path, and no more than one. */
function pickSource(args: { content?: string; contentBase64?: string; files?: Record<string, string>; fileName?: string; path?: string }, local: boolean): { input: ImportInput } | { message: string } {
  const given = [args.content !== undefined, args.contentBase64 !== undefined, args.files !== undefined, args.path !== undefined].filter(Boolean).length;
  if (given !== 1) return { message: `Give exactly one of content, contentBase64, files${local ? " or path" : ""}.` };
  if (args.path !== undefined && !local) return { message: "The hosted server cannot read files on your machine. Send the content, use the web page, or run the local server (npm run mcp:stdio)." };
  const input: ImportInput = { fileName: args.fileName };
  if (args.content !== undefined) input.content = args.content;
  else if (args.contentBase64 !== undefined) {
    if (args.contentBase64.length > (LIMITS.inline.zip * 4) / 3 + 8) return { message: `The base64 content is over the ${formatBytes(LIMITS.inline.zip)} limit.` };
    input.content = new Uint8Array(Buffer.from(args.contentBase64, "base64"));
  } else if (args.files !== undefined) input.files = args.files;
  return { input };
}

function optionsOf(args: Record<string, unknown>): ImportOptions {
  return {
    format: args.format as ImportOptions["format"],
    name: args.name as string | undefined,
    roleMap: args.roleMap as Record<string, Role> | undefined,
    unitsFt: args.unitsFt as number | undefined,
    level: args.level as string | undefined,
    shelves: args.shelves as number | undefined,
    facingsPerBay: args.facingsPerBay as number | undefined,
    aisleWidthFt: args.aisleWidthFt as number | undefined,
    shelfHeightFt: args.shelfHeightFt as number | undefined,
  };
}

/**
 * The report plus the spec as one fenced JSON block. A spec that will not
 * simulate is still returned: the reason is in the report, and the fix is
 * another call with roleMap, which needs the spec to compare against.
 */
function answer(input: ImportInput, opts: ImportOptions, bytes: number) {
  const result = importLayout(input, opts);
  const json = JSON.stringify(result.spec);
  const runnable = result.report.counts.facings > 0;
  return text(
    [
      describeImport(result, bytes),
      "",
      runnable
        ? `Layout spec (${formatBytes(json.length)}). Pass it as \`layout\` with a store id — the shop supplies the demand, the crew and the equipment, this supplies the building:`
        : `Layout spec so far (${formatBytes(json.length)}); fix the problem above with roleMap or the fixture options and import again:`,
      "```json",
      json,
      "```",
    ].join("\n")
  );
}

export const importLayoutConfig = {
  title: "Import a shop's floor plan",
  description: `${description} Files over ${formatBytes(LIMITS.inline.text)} belong on the web page or the local server (npm run mcp:stdio).`,
  inputSchema: z.object(baseShape).strict(),
  annotations: readOnly,
};

type Args = z.infer<typeof importLayoutConfig.inputSchema>;

export async function importLayoutHandler(args: Args) {
  return guarded(async () => {
    const picked = pickSource(args, false);
    if ("message" in picked) return error(picked.message);
    const bytes = typeof picked.input.content === "string" ? Buffer.byteLength(picked.input.content) : (picked.input.content?.byteLength ?? Object.values(args.files ?? {}).reduce((a, t) => a + t.length, 0));
    try {
      return answer(picked.input, { ...optionsOf(args), surface: "inline" }, bytes);
    } catch (err) {
      if (err instanceof ImportError) return error(err.message);
      throw err;
    }
  });
}

/**
 * The same tool on the local stdio server, where a path can be read and the
 * limits are the ones a real CAD export needs.
 */
export function importLayoutLocalTool() {
  const config = {
    title: importLayoutConfig.title,
    description: `${description} Give a local file path (up to ${formatBytes(LIMITS.local.dxf)} for DXF and IFC). Local only.`,
    inputSchema: z
      .object({ ...baseShape, path: z.string().max(400).optional().describe("Path to the file on this machine.") })
      .strict(),
    annotations: readOnly,
  };
  type LocalArgs = z.infer<typeof config.inputSchema>;

  const handler = (args: LocalArgs) =>
    guarded(async () => {
      const picked = pickSource(args, true);
      if ("message" in picked) return error(picked.message);
      const input = picked.input;
      if (args.path !== undefined) {
        const file = path.resolve(args.path);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return error(`No file at ${file}.`);
        if (info.size > LIMITS.local.dxf) return error(`${formatBytes(info.size)} is over the ${formatBytes(LIMITS.local.dxf)} limit for local files.`);
        input.content = new Uint8Array(await readFile(file));
        input.fileName ??= path.basename(file);
      }
      const bytes = typeof input.content === "string" ? Buffer.byteLength(input.content) : (input.content?.byteLength ?? Object.values(args.files ?? {}).reduce((a, t) => a + t.length, 0));
      try {
        return answer(input, { ...optionsOf(args), surface: "local" }, bytes);
      } catch (err) {
        if (err instanceof ImportError) return error(err.message);
        throw err;
      }
    });

  return { config, handler };
}
