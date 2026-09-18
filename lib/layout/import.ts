/**
 * One entry point for every layout format: detect it, enforce the size limit
 * for where the file came from, parse it, and then dry-run the result through
 * the twin's own geometry pass so the report can say how many facings and
 * aisles the simulation will actually see before anything runs.
 *
 * The dry run is the point. An import can return a perfectly valid spec that
 * will not simulate — no stockroom, no register, every fixture read as
 * annotation — and the only useful thing to do about that is to say so, in the
 * same report that lists how each layer was read, so the next attempt can pass
 * a roleMap and fix it. Nothing is stored; the caller keeps the spec.
 *
 * Synchronous and isomorphic on purpose: no clock, no random source, no Node
 * built-ins, no WebAssembly boot. The same call works in a route handler, a
 * test, a stdio tool and a browser worker, and the same bytes always produce
 * the same spec, which is what lets the 3D page replay an imported building.
 */

import { buildLayout } from "../twin/layout";
import type { Site } from "../twin/types";
import { assemble, ImportError, type AssembleOptions, type ImportReport, type Role } from "./assemble";
import { readCsv } from "./csv";
import { readDxf } from "./dxf";
import { readGeo } from "./geojson";
import { readIfc } from "./ifc";
import { checkSize, formatBytes, LimitError, type Surface } from "./limits";
import type { LayoutSpec } from "./spec";

export type LayoutFormat = "dxf" | "csv" | "geojson" | "imdf" | "ifc";
export const LAYOUT_FORMATS: LayoutFormat[] = ["dxf", "csv", "geojson", "imdf", "ifc"];

export interface ImportInput {
  /** One file: text for DXF, CSV and GeoJSON, bytes for an IMDF zip. */
  content?: string | Uint8Array;
  /** Several files at once, by name — an ArcGIS Indoors export. */
  files?: Record<string, string | Uint8Array>;
  /** The original file name, if there is one; its extension helps detect the format. */
  fileName?: string;
}

export interface ImportOptions {
  format?: LayoutFormat;
  /** Pattern → role, checked before the built-in guesses. A pattern is a substring or /regex/. */
  roleMap?: Record<string, Role>;
  /** Override the shelf count on every fixture, when a drawing's families are all wrong. */
  shelves?: number;
  facingsPerBay?: number;
  /** Feet per drawing or coordinate unit, when the file does not say. */
  unitsFt?: number;
  name?: string;
  /** Where the file is being parsed, which decides the size limit. Default: local. */
  surface?: Surface;
  /** Which floor of a multi-level IMDF or Indoors file. */
  level?: string;
  aisleWidthFt?: number;
  shelfHeightFt?: number;
}

export interface ImportResult {
  spec: LayoutSpec;
  report: ImportReport;
}

/** Re-exported so a caller needs one module: the sample files, the roles, the error. */
export { sampleStore } from "./samples";
export { ImportError, ROLES, type ImportReport, type Role } from "./assemble";

export function detectFormat(input: ImportInput, opts: ImportOptions = {}): LayoutFormat {
  if (opts.format) return opts.format;
  // Several files at once only ever means an indoor-GeoJSON export.
  if (Object.keys(input.files ?? {}).length) return "geojson";
  const ext = input.fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "dxf") return "dxf";
  if (ext === "csv" || ext === "txt") return "csv";
  if (ext === "geojson" || ext === "json") return "geojson";
  if (ext === "zip" || ext === "imdf") return "imdf";
  if (ext === "ifc") return "ifc";
  if (ext === "dwg") throw new ImportError("DWG is not read directly. Export the drawing to DXF — Autodesk DWG TrueView and the ODA File Converter both do it for free — and import that.");
  const bytes = typeof input.content === "string" ? undefined : input.content;
  if (bytes && bytes[0] === 0x50 && bytes[1] === 0x4b) return "imdf";
  const head = (typeof input.content === "string" ? input.content : new TextDecoder().decode((bytes ?? new Uint8Array()).slice(0, 2000))).slice(0, 2000);
  if (/ISO-10303-21/.test(head)) return "ifc";
  if (/^\s*0\s*\r?\n\s*SECTION/.test(head)) return "dxf";
  if (/^\s*[{[]/.test(head)) return "geojson";
  return "csv";
}

/**
 * A stand-in store for the dry run: buildLayout only reads the spec's geometry,
 * never the site's own fields, so an import can be checked without one.
 */
const PREVIEW_SITE = { id: "preview" } as unknown as Site;

/** What the twin makes of a spec, or why it would refuse it. */
export function layoutStats(spec: LayoutSpec): { facings: number; aisles: number; storagePositions: number; error: string | null } {
  try {
    const l = buildLayout(spec, PREVIEW_SITE);
    return { facings: l.facings.length, aisles: l.salesAisles.length, storagePositions: l.storage.length, error: null };
  } catch (err) {
    if (err instanceof LimitError || err instanceof ImportError) return { facings: 0, aisles: 0, storagePositions: 0, error: err.message };
    throw err;
  }
}

const asText = (v: string | Uint8Array): string => (typeof v === "string" ? v : new TextDecoder().decode(v));
const asBytes = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? new TextEncoder().encode(v) : v);

export function importLayout(input: ImportInput, opts: ImportOptions = {}): ImportResult {
  const format = detectFormat(input, opts);
  const surface = opts.surface ?? "local";
  const bytes =
    input.content !== undefined
      ? asBytes(input.content).byteLength
      : Object.values(input.files ?? {}).reduce((a, v) => a + (typeof v === "string" ? new TextEncoder().encode(v).byteLength : v.byteLength), 0);
  if (bytes === 0) throw new ImportError("No file content was given.");
  checkSize(format === "imdf" ? "imdfZip" : format, bytes, surface);

  const base = input.fileName?.replace(/\.[^.]+$/, "") ?? `Imported ${format.toUpperCase()} store`;
  const shared: AssembleOptions = {
    name: opts.name ?? base,
    format: format === "geojson" ? "imdf" : format,
    file: input.fileName,
    roleMap: opts.roleMap,
    shelves: opts.shelves,
    facingsPerBay: opts.facingsPerBay,
    aisleWidthFt: opts.aisleWidthFt,
    shelfHeightFt: opts.shelfHeightFt,
  };

  let out: { spec: LayoutSpec; report: ImportReport };
  switch (format) {
    case "dxf": {
      const dxf = readDxf(asText(input.content ?? ""), { unitsFt: opts.unitsFt });
      out = assemble(dxf.features, { ...shared, format: "dxf", unitsFrom: dxf.unitsFrom });
      break;
    }
    case "csv":
      out = readCsv(asText(input.content ?? ""), { ...shared, format: "csv", unitsFt: opts.unitsFt });
      break;
    case "geojson": {
      const files: Record<string, string> = {};
      if (input.files) for (const [k, v] of Object.entries(input.files)) files[k] = asText(v);
      else files[input.fileName ?? "layout.geojson"] = asText(input.content ?? "");
      out = readGeo({ files }, { ...shared, level: opts.level });
      break;
    }
    case "imdf": {
      if (input.content === undefined) throw new ImportError("An IMDF archive must be sent as the bytes of a .zip.");
      out = readGeo({ zip: asBytes(input.content) }, { ...shared, level: opts.level });
      break;
    }
    case "ifc":
      if (input.content === undefined) throw new ImportError("No IFC content.");
      out = readIfc(asBytes(input.content), { ...shared, format: "ifc" });
      break;
  }

  const stats = layoutStats(out.spec);
  const report: ImportReport = {
    ...out.report,
    format,
    counts: { ...out.report.counts, facings: stats.facings, aisles: stats.aisles },
    warnings: stats.error ? [...out.report.warnings, `This layout will not simulate yet: ${stats.error}`] : out.report.warnings,
  };
  return { spec: out.spec, report };
}

/** The markdown report the MCP tool and the web page both print. */
export function describeImport(r: ImportResult, bytes?: number): string {
  const rep = r.report;
  const c = rep.counts;
  const positions = c.facings > 0 ? layoutStats(r.spec).storagePositions : 0;
  const lines = [
    `Imported ${rep.format.toUpperCase()}${bytes ? ` (${formatBytes(bytes)})` : ""} as "${r.spec.name}": ${Math.round(r.spec.widthFt)}×${Math.round(r.spec.depthFt)} ft, sales floor to ${Math.round(r.spec.backroomY)} ft and the stockroom behind it. Units from ${rep.unitsFrom}. Storefront placed by ${rep.orientedBy}.`,
    `Fixtures: ${c.fixtures} runs on the sales floor and ${c.storage} back-stock runs. Service points: ${c.service}. Doors: ${r.spec.doors.filter((d) => d.kind === "entrance").length} customer, ${r.spec.doors.filter((d) => d.kind !== "entrance").length} goods.`,
    c.facings > 0
      ? `The twin reads ${c.facings.toLocaleString("en-US")} facings in ${c.aisles} aisle(s), with ${positions.toLocaleString("en-US")} stockroom positions behind.`
      : `**This layout will not simulate yet.**`,
  ];
  if (rep.assumptions.length) lines.push("", "Assumed:", ...rep.assumptions.map((n) => `- ${n}`));
  if (rep.warnings.length) lines.push("", "Warnings:", ...rep.warnings.map((n) => `- ${n}`));
  if (rep.layers.length) {
    const shown = rep.layers.slice(0, 30);
    lines.push("", "How each layer, block or category was read (override with roleMap):", ...shown.map((s) => `- ${s.layer} → ${s.role} (${s.count})${s.note ? ` — ${s.note}` : ""}`));
    if (rep.layers.length > shown.length) lines.push(`- … ${rep.layers.length - shown.length} more`);
  }
  return lines.join("\n");
}
