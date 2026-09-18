"use client";

/**
 * The /import page: bring your own shop.
 *
 * Somebody drops a DXF, a planogram export, an indoor GeoJSON archive or an IFC
 * model; a Web Worker parses it in the tab; and what comes back is a layout the
 * twin runs — with a report saying how every layer was read and what had to be
 * assumed, a plan to look at, and a table to correct the guesses and try again.
 *
 * Three things shape the whole component:
 *
 * - The file never leaves the browser. Only the compact spec — a few kilobytes
 *   — is POSTed, and only when the visitor asks for a run. Said on the page,
 *   because it is the difference between uploading a client's floor plan to a
 *   stranger's server and not.
 * - The import report is the product, not a log. No default pattern table
 *   survives contact with a real drawing, so the loop that matters is
 *   read → see how it was read → override a layer → re-import. The original
 *   ArrayBuffers stay in state for exactly that.
 * - The 3D page gets the building through sessionStorage, never the URL. A spec
 *   can be a megabyte; a link cannot.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ROLES, type Role } from "@/lib/layout/assemble";
import { describeImport, type ImportOptions, type ImportResult } from "@/lib/layout/import";
import { formatBytes, LIMITS } from "@/lib/layout/limits";
import { compactSpec } from "@/lib/layout/spec";
import { storeFloorSvg } from "@/lib/render/store-floor";
import { encodeHash, HASH_DEFAULTS, MAX_DAYS } from "@/lib/store-ui/hash";
import { buildLayout } from "@/lib/twin/layout";
import type { Kpis } from "@/lib/twin/replicate";
import type { Site } from "@/lib/twin/types";
import type { WorkerRequest, WorkerResponse } from "./import.worker";

/** What `app/api/store/route.ts` answers with. */
type RunResult = {
  kpis: Kpis;
  worst: Kpis;
  bottleneck: { process: string | null; constraint: string; waitHours: number };
  svg: string;
  layout: {
    facings: number;
    salesAisles: number;
    storagePositions: number;
    sellingSqFt: number;
    backroomSqFt: number;
    registers: number;
    counters: number;
    eyeLevelShare: number;
    featureShare: number;
    restocksPerWeek: number;
  };
  crew: number;
  changes: string[];
};

/**
 * Where the 3D page reads an imported building from. sessionStorage, not the
 * URL: a spec runs to a megabyte and a link does not, and same-tab storage is
 * the only handoff that keeps the drawing off every server in between.
 */
const STORE_SESSION_KEY = "store.layout.v1";

/** `npm run samples` writes these; each one is the same shop drawn as that format's users draw it. */
const SAMPLES: Array<{ label: string; note: string; files: string[] }> = [
  { label: "DXF", note: "a CAD fixture plan in millimeters, drawn on its side", files: ["sample-store.dxf"] },
  { label: "Fixture CSV", note: "a planogram export, one row per facing", files: ["sample-store-fixtures.csv"] },
  { label: "IMDF", note: "an indoor-mapping archive in lon/lat", files: ["sample-store-imdf.zip"] },
  { label: "ArcGIS Indoors", note: "Units, Details and Levels in Web Mercator", files: ["Units.geojson", "Details.geojson", "Levels.geojson"] },
  { label: "GeoJSON", note: "the same export flattened into one file", files: ["sample-store.geojson"] },
  { label: "IFC", note: "an IFC4 model in meters", files: ["sample-store.ifc"] },
];

/** Feet per drawing unit, for the drawings that do not say. Only DXF and CSV need it; the rest carry a CRS or a unit assignment. */
const UNITS: Array<{ label: string; ft: number }> = [
  { label: "inches", ft: 1 / 12 },
  { label: "feet", ft: 1 },
  { label: "millimeters", ft: 0.003280839895013123 },
  { label: "centimeters", ft: 0.03280839895013123 },
  { label: "meters", ft: 3.280839895013123 },
];

/** The cap this file would hit, by extension. Checked before the file is even read, so a 300 MB drop fails in a sentence rather than in a stalled tab. */
function browserLimit(name: string): number {
  const n = name.toLowerCase();
  if (n.endsWith(".csv") || n.endsWith(".txt")) return LIMITS.browser.csv;
  if (n.endsWith(".zip") || n.endsWith(".imdf")) return LIMITS.browser.imdfZip;
  if (n.endsWith(".ifc")) return LIMITS.browser.ifc;
  if (n.endsWith(".json") || n.endsWith(".geojson")) return LIMITS.browser.geojson;
  return LIMITS.browser.dxf;
}

/**
 * A layer override is an anchored regex, not the bare layer name, because a
 * roleMap key is a case-insensitive *substring* by default — mapping "A-CASE"
 * would silently claim "A-CASEWORK" too.
 */
function exactly(layer: string): string {
  return `/^${layer.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/`;
}

/**
 * A stand-in shop for the preview, the same one `importLayout` dry-runs
 * against: `buildLayout` reads the spec's geometry and never the site's own
 * fields, so a plan can be drawn before anyone has chosen whose shop it is.
 */
const PREVIEW_SITE = { id: "preview" } as unknown as Site;

/** A spinner that animates inside the SVG, so this page adds nothing to the site's stylesheet. */
function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }}>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const money = (d: number) => (d >= 1e6 ? `$${(d / 1e6).toFixed(2)}M` : d >= 1e3 ? `$${Math.round(d / 1e3)}k` : `$${Math.round(d)}`);

export default function ImportWorkbench({ stores }: { stores: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const workerRef = useRef<Worker | null>(null);
  const [files, setFiles] = useState<Array<{ name: string; bytes: ArrayBuffer }>>([]);
  const [busy, setBusy] = useState<"" | "parsing" | "running">("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  /** Keyed by the layer name the report shows; turned into anchored regexes on the way to the worker. */
  const [overrides, setOverrides] = useState<Record<string, Role>>({});
  const [opts, setOpts] = useState({ units: "", shelves: "", facings: "", aisle: "" });
  const [run, setRun] = useState({ store: stores[0]?.id ?? HASH_DEFAULTS.store, week: 36, days: 10, runs: 2, merchandising: "current" });
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const parse = (list: Array<{ name: string; bytes: ArrayBuffer }>, map: Record<string, Role>) => {
    const w = workerRef.current;
    if (!w || list.length === 0) return;
    setBusy("parsing");
    setError(null);
    setOpenError(null);
    setRunResult(null);
    const roleMap = Object.fromEntries(Object.entries(map).map(([layer, role]) => [exactly(layer), role]));
    const options: ImportOptions = {
      roleMap: Object.keys(roleMap).length ? roleMap : undefined,
      unitsFt: UNITS.find((u) => u.label === opts.units)?.ft,
      shelves: opts.shelves ? Number(opts.shelves) : undefined,
      facingsPerBay: opts.facings ? Number(opts.facings) : undefined,
      aisleWidthFt: opts.aisle ? Number(opts.aisle) : undefined,
    };
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      setBusy("");
      if (e.data.ok) setResult(e.data.result);
      else {
        setResult(null);
        setError(e.data.error);
      }
    };
    // Copies are transferred, because transferring detaches the buffer and the
    // originals have to survive for "re-import with these roles".
    const payload: WorkerRequest = { files: list.map((f) => ({ name: f.name, bytes: f.bytes.slice(0) })), options };
    w.postMessage(
      payload,
      payload.files.map((f) => f.bytes)
    );
  };

  const accept = async (picked: File[]) => {
    setError(null);
    for (const f of picked) {
      if (f.name.toLowerCase().endsWith(".dwg")) {
        setError("DWG is not read directly. Export the drawing to DXF — Autodesk DWG TrueView and the ODA File Converter both do it for free — and drop that.");
        return;
      }
      const cap = browserLimit(f.name);
      if (f.size > cap) {
        setError(
          `${f.name} is ${formatBytes(f.size)}, over the ${formatBytes(cap)} this page parses in the tab. The local MCP server reads a file by path and takes up to ${formatBytes(LIMITS.local.dxf)}.`
        );
        return;
      }
    }
    const list = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
    setFiles(list);
    setOverrides({});
    parse(list, {});
  };

  const loadSample = async (names: string[]) => {
    setError(null);
    try {
      const list = await Promise.all(
        names.map(async (name) => {
          const res = await fetch(`/samples/${name}`);
          if (!res.ok) throw new Error(`Could not load the sample ${name}. Run "npm run samples" to write public/samples.`);
          return { name, bytes: await res.arrayBuffer() };
        })
      );
      setFiles(list);
      setOverrides({});
      parse(list, {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const bytes = files.reduce((a, f) => a + f.bytes.byteLength, 0);
  const report = useMemo(() => (result ? describeImport(result, bytes) : ""), [result, bytes]);

  /**
   * Left unshaded on purpose. The question this plan answers is "did it read my
   * drawing right" — which rectangle is a gondola, where the entrance landed —
   * and shading every bay by merchandising value buries exactly that. The run
   * below returns its own shaded plan, where the shading is the point.
   */
  const preview = useMemo(() => {
    if (!result) return "";
    try {
      return storeFloorSvg({ layout: buildLayout(result.spec, PREVIEW_SITE), title: result.spec.name }, { width: 900, shadeBy: "none" });
    } catch {
      return "";
    }
  }, [result]);

  const runTwin = async () => {
    if (!result) return;
    setBusy("running");
    setError(null);
    try {
      const res = await fetch("/api/store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: result.spec, store: run.store, startWeek: run.week, days: run.days, runs: run.runs, merchandising: run.merchandising }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const msg = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `The server answered ${res.status}.`;
        throw new Error(msg);
      }
      setRunResult(body as RunResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const copySpec = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.spec));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("This browser would not give the page the clipboard. Run the twin here instead, or import the file through the MCP tool.");
    }
  };

  /** The 3D page simulates in the browser, so the building goes through sessionStorage and only the run settings go in the link. */
  const openIn3d = () => {
    if (!result) return;
    setOpenError(null);
    const json = JSON.stringify(compactSpec(result.spec));
    if (json.length > LIMITS.specJson) {
      setOpenError(
        `The layout comes to ${formatBytes(json.length)}, over the ${formatBytes(LIMITS.specJson)} a spec may be. Re-import with the wall and outline layers set to ignore — they are drawn, never simulated — or split the building.`
      );
      return;
    }
    try {
      window.sessionStorage.setItem(STORE_SESSION_KEY, json);
    } catch {
      setOpenError("This browser would not keep the layout for the 3D page (storage full or blocked). Run the twin here instead.");
      return;
    }
    router.push(`/store#${encodeHash({ store: run.store, week: run.week, days: Math.min(run.days, MAX_DAYS), seed: 1, src: "session" })}`);
  };

  const c = result?.report.counts;
  const k = runResult?.kpis;
  const specBytes = result ? JSON.stringify(result.spec).length : 0;

  return (
    <div className="workbench">
      <section className="panel">
        <h2>1. Your store plan</h2>
        <p className="sub">
          A DXF fixture plan, a planogram or location CSV, ArcGIS Indoors GeoJSON (all three files at once), an IMDF archive, or an IFC model.{" "}
          <b>The file is parsed here, in your browser, and never uploaded.</b> Only the layout it becomes — a few kilobytes of fixture runs, doors and service
          points — is sent to the server, and only when you ask for a run.
        </p>
        <label
          className={`drop${dragging ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void accept([...e.dataTransfer.files]);
          }}
        >
          <input type="file" multiple accept=".dxf,.csv,.txt,.geojson,.json,.zip,.imdf,.ifc,.dwg" onChange={(e) => void accept([...(e.target.files ?? [])])} />
          <span>{files.length ? files.map((f) => `${f.name} (${formatBytes(f.bytes.byteLength)})`).join(", ") : "Drop a plan here, or click to choose one"}</span>
        </label>
        <p className="sub" style={{ marginTop: 10 }}>
          Limits, because a tab has to hold the whole drawing while it reads it: DXF, IFC and GeoJSON {formatBytes(LIMITS.browser.dxf)}, IMDF archive{" "}
          {formatBytes(LIMITS.browser.imdfZip)}, CSV {formatBytes(LIMITS.browser.csv)}. Bigger files go through the local MCP server, which reads them by path
          up to {formatBytes(LIMITS.local.dxf)}. Whatever the drawing weighs, the layout it becomes is capped at {formatBytes(LIMITS.specJson)} — that is what
          travels in a request or a tool call. A shop of {LIMITS.maxSideFt} ft a side with {LIMITS.maxFacings.toLocaleString("en-US")} facings is the largest
          building the twin will simulate.
        </p>

        <div className="row">
          <span className="sub">Or read the sample candy shop as</span>
          {SAMPLES.map((s) => (
            <button key={s.label} type="button" className="chip" title={s.note} onClick={() => void loadSample(s.files)} disabled={busy !== ""}>
              {s.label}
            </button>
          ))}
        </div>
        <p className="sub" style={{ marginTop: 8 }}>
          The same 70 × 110 ft shop written six ways — download one and open it in your own tools:{" "}
          {SAMPLES.flatMap((s) => s.files).map((f, i, all) => (
            <span key={f}>
              <a href={`/samples/${f}`} download>
                {f}
              </a>
              {i < all.length - 1 ? ", " : ""}
            </span>
          ))}
          .
        </p>

        <div className="row">
          <label>
            Drawing units{" "}
            <select value={opts.units} onChange={(e) => setOpts({ ...opts, units: e.target.value })}>
              <option value="">from the file</option>
              {UNITS.map((u) => (
                <option key={u.label}>{u.label}</option>
              ))}
            </select>
          </label>
          <label>
            Shelves per bay <input type="number" min={1} max={10} placeholder="by fixture" value={opts.shelves} onChange={(e) => setOpts({ ...opts, shelves: e.target.value })} />
          </label>
          <label>
            Facings per bay <input type="number" min={1} max={20} placeholder="by fixture" value={opts.facings} onChange={(e) => setOpts({ ...opts, facings: e.target.value })} />
          </label>
          <label>
            Aisle width (ft) <input type="number" min={2} max={22} placeholder="5.5" value={opts.aisle} onChange={(e) => setOpts({ ...opts, aisle: e.target.value })} />
          </label>
          <button type="button" onClick={() => parse(files, overrides)} disabled={!files.length || busy !== ""}>
            Re-import
          </button>
        </div>
        <p className="sub">
          A plan is a plan view, so the vertical dimension is always assumed. Units matter to DXF and CSV only — GeoJSON carries a coordinate system and IFC a
          unit assignment.
        </p>
        {busy === "parsing" && (
          <p className="sub">
            <Spinner />
            Reading the drawing…
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {result && c && (
        <section className="panel">
          <h2>2. What the twin read</h2>
          <div className="tiles">
            <div className="tile">
              <b>{c.fixtures}</b>
              <span>fixture runs</span>
            </div>
            <div className="tile">
              <b>{c.facings.toLocaleString("en-US")}</b>
              <span>facings</span>
            </div>
            <div className="tile">
              <b>{c.aisles}</b>
              <span>sales aisles</span>
            </div>
            <div className="tile">
              <b>{c.storage}</b>
              <span>back-stock runs</span>
            </div>
            <div className="tile">
              <b>{c.service}</b>
              <span>service points</span>
            </div>
            <div className="tile">
              <b>{c.doors}</b>
              <span>doors</span>
            </div>
          </div>
          <pre className="report">{report}</pre>
          {preview ? (
            <div dangerouslySetInnerHTML={{ __html: preview }} />
          ) : (
            <p className="sub">No plan to draw yet: the report above says what the reader could not make a shop out of. Correct a layer below and re-import.</p>
          )}

          {result.report.layers.length > 0 && (
            <details>
              <summary>How each layer, block or category was read — change one and read it again ({result.report.layers.length})</summary>
              <p className="sub" style={{ marginTop: 8 }}>
                Every guess the importer made about a name is here. A layer set to <code>ignore</code> is dropped; <code>outline</code> and <code>wall-line</code>{" "}
                are drawn but never simulated; the rest become fixtures, storage, service points or doors.
              </p>
              <table className="roles">
                <tbody>
                  {result.report.layers.slice(0, 60).map((l) => (
                    <tr key={l.layer}>
                      <td>{l.layer}</td>
                      <td>{l.count}</td>
                      <td>
                        <select value={overrides[l.layer] ?? l.role} onChange={(e) => setOverrides({ ...overrides, [l.layer]: e.target.value as Role })}>
                          {ROLES.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                      <td className="sub">{l.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.report.layers.length > 60 && <p className="sub">The 60 layers with the most shapes are shown.</p>}
              <button type="button" onClick={() => parse(files, overrides)} disabled={busy !== ""}>
                Re-import with these roles
              </button>
            </details>
          )}

          <div className="row">
            <button type="button" onClick={() => void copySpec()}>
              {copied ? "Copied" : `Copy the layout (${formatBytes(specBytes)})`}
            </button>
            <span className="sub">Paste it into Claude as the {"`layout`"} field of simulate_day, what_if, optimize_merchandising or any other tool.</span>
          </div>
        </section>
      )}

      {result && c && c.facings > 0 && (
        <section className="panel">
          <h2>3. Run the twin in it</h2>
          <p className="sub">
            Your building, a committed shop&rsquo;s demand, catalog, crew and hours. Only the layout above is sent; nothing is stored, and the answer comes back
            in one response.
          </p>
          <div className="row">
            <label>
              Customers, crew and catalog from{" "}
              <select value={run.store} onChange={(e) => setRun({ ...run, store: e.target.value })}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Week <input type="number" min={1} max={52} value={run.week} onChange={(e) => setRun({ ...run, week: Number(e.target.value) })} />
            </label>
            <label>
              Days <input type="number" min={1} max={28} value={run.days} onChange={(e) => setRun({ ...run, days: Number(e.target.value) })} />
            </label>
            <label>
              Runs <input type="number" min={1} max={5} value={run.runs} onChange={(e) => setRun({ ...run, runs: Number(e.target.value) })} />
            </label>
            <label>
              Merchandising{" "}
              <select value={run.merchandising} onChange={(e) => setRun({ ...run, merchandising: e.target.value })}>
                <option value="current">current</option>
                <option value="optimized">optimized</option>
              </select>
            </label>
            <button type="button" className="primary" onClick={() => void runTwin()} disabled={busy !== ""}>
              {busy === "running" ? (
                <>
                  <Spinner />
                  Simulating…
                </>
              ) : (
                "Run the twin"
              )}
            </button>
            <button type="button" onClick={openIn3d} disabled={busy !== ""} title="Watch a week trade in this building, simulated and drawn in your browser">
              Open in 3D →
            </button>
          </div>
          {openError && <p className="error">{openError}</p>}
          {runResult && k && (
            <>
              <div className="tiles">
                <div className="tile">
                  <b>{money(k.salesDollars)}</b>
                  <span>sold over {run.days} days</span>
                </div>
                <div className="tile">
                  <b>{pct(k.lostSalesShare)}</b>
                  <span>of demand lost</span>
                </div>
                <div className="tile">
                  <b>{pct(k.onShelfShare)}</b>
                  <span>on the shelf</span>
                </div>
                <div className="tile">
                  <b>{pct(k.abandonRate)}</b>
                  <span>walk out of a queue</span>
                </div>
                <div className="tile">
                  <b>{k.registerWaitP90Min.toFixed(1)} min</b>
                  <span>p90 wait at the till</span>
                </div>
                <div className="tile">
                  <b>{k.counterWaitP90Min.toFixed(1)} min</b>
                  <span>p90 wait at the glass</span>
                </div>
                <div className="tile">
                  <b>{pct(k.utilization)}</b>
                  <span>labour utilization</span>
                </div>
              </div>
              <p className="sub" style={{ marginTop: 10 }}>
                {runResult.layout.facings.toLocaleString("en-US")} facings in {runResult.layout.salesAisles} aisle
                {runResult.layout.salesAisles === 1 ? "" : "s"} over {runResult.layout.sellingSqFt.toLocaleString("en-US")} sq ft of sales floor,{" "}
                {runResult.layout.storagePositions.toLocaleString("en-US")} stockroom positions behind, {runResult.layout.registers} register
                {runResult.layout.registers === 1 ? "" : "s"} and {runResult.layout.counters} counter station
                {runResult.layout.counters === 1 ? "" : "s"}, {runResult.crew} people. Mean of {run.runs} run{run.runs === 1 ? "" : "s"} from week {run.week}.
                Busiest queue: {runResult.bottleneck.process ?? "none"}
                {runResult.bottleneck.process ? ` (${runResult.bottleneck.constraint})` : ""}. {pct(runResult.layout.eyeLevelShare)} of the top sellers sit at eye
                level.
              </p>
              {runResult.changes.length > 0 && <p className="sub">Changed from the shop&rsquo;s own setup: {runResult.changes.join("; ")}.</p>}
              <p className="sub">The plan below is shaded by merchandising value — what a facing is worth to whatever sits in it, from its fixture and its height.</p>
              <div dangerouslySetInnerHTML={{ __html: runResult.svg }} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
