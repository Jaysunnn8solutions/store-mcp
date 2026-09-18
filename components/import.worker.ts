/**
 * Parses somebody's store plan off the main thread.
 *
 * The file never leaves the browser. This worker takes the bytes the page read
 * from the drop zone, runs the same `importLayout` the MCP tools run, and posts
 * back the compact layout spec and the import report — a few kilobytes. Only
 * that spec ever reaches the network, and only when the visitor asks for a run.
 *
 * It is a worker because every reader is synchronous: a 40 MB DXF or IFC is
 * seconds of straight-line parsing, and on the main thread that is a frozen tab
 * with no way to draw the spinner that would explain it.
 */

import { importLayout, type ImportInput, type ImportOptions, type ImportResult } from "../lib/layout/import";

export type WorkerRequest = {
  /** One file, or several .geojson files for an ArcGIS Indoors export. */
  files: Array<{ name: string; bytes: ArrayBuffer }>;
  options: ImportOptions;
};

/**
 * Plain data both ways. The response crosses by structured clone, which drops
 * an Error subclass's identity, so a failure comes back as its message — the
 * message is the useful part anyway, since both `ImportError` and `LimitError`
 * are written to be read by whoever brought the drawing.
 */
export type WorkerResponse = { ok: true; result: ImportResult } | { ok: false; error: string };

/**
 * Formats that are bytes rather than text. IFC is STEP text, but it is the
 * largest file anyone brings and `importLayout` encodes a string back to bytes
 * anyway, so handing it the bytes saves two copies of a 50 MB model.
 */
const BINARY = /\.(zip|imdf|ifc)$/i;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const post = (r: WorkerResponse) => (self as unknown as Worker).postMessage(r);
  try {
    const { files, options } = e.data;
    if (files.length === 0) throw new Error("No file was given.");
    const dec = new TextDecoder();
    let input: ImportInput;
    if (files.length > 1) {
      const geo = files.filter((f) => /\.(geo)?json$/i.test(f.name));
      if (geo.length !== files.length) {
        throw new Error("Several files at once is only for an ArcGIS Indoors export — Units, Details and Levels as GeoJSON. Drop one DXF, CSV, IFC or IMDF archive at a time.");
      }
      input = { files: Object.fromEntries(geo.map((f) => [f.name, dec.decode(f.bytes)])) };
    } else {
      const f = files[0];
      const bytes = new Uint8Array(f.bytes);
      input = { fileName: f.name, content: BINARY.test(f.name) ? bytes : dec.decode(bytes) };
    }
    // The surface is fixed here rather than trusted from the page: it is what
    // decides the size limit, and the limit for a file parsed in a tab is a
    // property of the tab, not of what the caller asked for.
    post({ ok: true, result: importLayout(input, { ...options, surface: "browser" }) });
  } catch (err) {
    post({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
