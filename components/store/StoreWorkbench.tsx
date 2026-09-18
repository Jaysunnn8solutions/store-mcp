"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import manifest from "@/data/manifest.json";
import sites from "@/data/sites.json";
import type { LayoutSpec } from "@/lib/layout/spec";
import { dayClock, DEFAULT_SPEED, nextOpen } from "@/lib/store-ui/clock";
import { csrValueAt, describeDoor, describeEntity, describeFacing, describePost, describeQueue, describeStorage, entityTitle, indexEvents, type DescribeSection, type EventIndex } from "@/lib/store-ui/describe";
import { count, feet, minutes } from "@/lib/store-ui/format";
import { decodeHash, encodeHash, HashError, MAX_DAYS } from "@/lib/store-ui/hash";
import { applyEvent, cloneState, finalize, kpiContext, projectKpis, type KpiContext } from "@/lib/trace/kpis";
import { upperBound } from "@/lib/trace/search";
import type { Playback, RunSpec, TraceInit, TwinRequest, TwinResponse, WorldPayload } from "@/lib/trace/types";
import { CAMERA_PRESETS, type CameraPreset, type PickResult, type ViewMode } from "@/lib/three/api";
import type { OperationsResult } from "@/lib/twin/operations";
import type { Kpis } from "@/lib/twin/replicate";
import { ROLES, ROLE_KEYS } from "@/lib/twin/roles";
import { PROCESSES, type Process, type Site } from "@/lib/twin/types";
import ComparePanel from "./ComparePanel";
import { keepFocus, MAX_SEED, runFromText, skipAhead, textFromRun, type RunText } from "./focus";
import HelpOverlay, { FirstRunHint } from "./HelpOverlay";
import Hud, { type HudSnapshot } from "./Hud";
import Inspector from "./Inspector";
import Minimap from "./Minimap";
import ReportPanel from "./ReportPanel";
import ScenarioPanel, { Datalists, emptyForm, formToScenario, scenarioToForm, tabCounts, type FormContext, type FormErrors, type ScenarioTab, type StoreForm } from "./ScenarioPanel";
import ShopPicker, { BUILTIN, readSessionSpec, specOverLimit, type BuildingChoice } from "./ShopPicker";
import StoreScene, { type ClockView, type KeyAction, type ShotMode, type StoreSceneHandle } from "./StoreScene";
import Disruptions from "./tabs/Disruptions";
import Floor, { floorCheck } from "./tabs/Floor";
import People from "./tabs/People";
import Stock from "./tabs/Stock";
import Trade from "./tabs/Trade";
import Ticker, { notableFrom } from "./Ticker";
import Timeline from "./Timeline";

// ---------------------------------------------------------------------------
// Types and module constants
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: number;
  label: string;
  /** What produced this run, without the layout: what the chips, the URL and Copy link describe. */
  spec: RunSpec;
  /** Where a non-built-in building came from, for the link. */
  src?: string;
  storeName: string;
  playback: Playback;
  world: WorldPayload;
  kpis: Kpis;
  /** The engine's own run record, when the worker sends one; see ReportPanel. */
  result: OperationsResult | null;
  /** Non-fatal notes about the run as it was actually configured. */
  issues: string[];
  /** Wall-clock milliseconds from posting the request to the playback arriving. */
  ms: number;
  index: EventIndex;
  kctx: KpiContext;
  init: TraceInit;
}

type Status = { kind: "idle" } | { kind: "running"; phase: string; day: number; days: number } | { kind: "error"; message: string };

type SideTab = "scenario" | "inspector" | "compare" | "report" | "help";

/** What is open in the inspector. A queue is not a thing a ray can hit, so it rides alongside the renderer's own pick result rather than inside it. */
type Selected = { k: "pick"; pick: PickResult } | { k: "queue"; process: Process } | null;

interface ViewFlags {
  labels: boolean;
  dayNight: boolean;
  shadows: boolean;
  hud: boolean;
  /** The HUD's full grid, the queues and the day's deliveries, behind "More". */
  hudMore: boolean;
  minimap: boolean;
  help: boolean;
  /** The View dropdown on the camera toolbar. */
  menu: boolean;
  /** The timeline's legend popover. */
  legend: boolean;
}

/** Everything a run needs besides the worker. The hashchange path passes the link's values rather than waiting for state to commit. */
interface RunInputs {
  run: ReturnType<typeof runFromText>;
  form: StoreForm;
  building: BuildingChoice;
}

const SITES = sites as unknown as Site[];
const SKU_COUNT = manifest.counts.skus;
const HINT_KEY = "store.hint.v1";
const ROLE_NAMES = ROLE_KEYS.map((k) => ROLES[k].role);

const PRESETS: Array<[CameraPreset, string]> = [
  ["overview", "Overview"],
  ["front", "Storefront"],
  ["aisle", "Aisle"],
  ["counter", "Counter"],
  ["stockroom", "Stockroom"],
  ["dock", "Dock"],
  ["lot", "Car park"],
];

function readHint(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) !== "1";
  } catch {
    return true;
  }
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function buildingFromHash(src: string | undefined): BuildingChoice {
  return src === "session" ? readSessionSpec() : BUILTIN;
}

/** The scenario as a link carries it: an imported plan is handed over in the browser, never in a URL. */
function withoutLayout(s: Record<string, unknown>): Record<string, unknown> {
  const { layout, ...rest } = s;
  void layout;
  return rest;
}

type Composed = { scenario: Record<string, unknown>; bare: Record<string, unknown>; error?: undefined } | { scenario?: undefined; bare?: undefined; error: { where: "form" | "building" | "floor"; message: string } };

/**
 * The scenario a run starts from, or the first reason it cannot start: a field
 * the form could not read, a building that has not been handed over, or a
 * gondola block that does not fit the shop.
 *
 * `scenario` is what the worker runs, with an imported plan attached; `bare` is
 * the same without it, which is what the link and the run record carry.
 */
function composeScenario(form: StoreForm, building: BuildingChoice, ctx: FormContext): Composed {
  const res = formToScenario(form);
  if (!res.scenario) return { error: { where: "form", message: "Fix the highlighted fields first." } };
  if (building.kind !== "builtin") {
    if (!building.spec) return { error: { where: "building", message: building.error ?? "The imported plan has not been handed over to this page yet." } };
    const over = specOverLimit(building.spec);
    if (over) return { error: { where: "building", message: over } };
  }
  const check = floorCheck(form, ctx);
  if (check.error) return { error: { where: "floor", message: check.error } };
  const spec: LayoutSpec | null = building.kind === "builtin" ? null : building.spec;
  return { scenario: spec ? { ...res.scenario, layout: spec } : res.scenario, bare: res.scenario };
}

/**
 * The exact figures at t: the last checkpoint, plus a replay of the events
 * since it. That is O(events since the checkpoint) rather than O(the whole
 * run), which is the only reason the HUD can be live.
 *
 * At the horizon it hands back the posted `kpis` instead of a projection, so
 * the last frame agrees with what an MCP tool would print for the same run.
 */
function snapshotAt(rec: RunRecord, t: number): HudSnapshot {
  const pb = rec.playback;
  const horizon = pb.meta.horizonEnd;
  const atEnd = t >= horizon - 1e-9;
  const cpMin = Math.max(1, pb.meta.checkpointMin);
  let i = Math.min(pb.checkpoints.length - 1, Math.floor((atEnd ? horizon : t) / cpMin));
  while (i > 0 && pb.checkpoints[i].t > t) i--;
  const cp = pb.checkpoints[Math.max(0, i)];
  const running = cloneState(cp.kpis);
  const upTo = atEnd ? horizon : t;
  for (let k = upperBound(rec.index.times, cp.t); k < pb.events.length && rec.index.times[k] <= upTo; k++) applyEvent(running, pb.events[k], rec.kctx);
  let kpis: Kpis;
  if (atEnd) {
    finalize(running, horizon, rec.kctx);
    kpis = rec.kpis;
  } else kpis = projectKpis(running, t, rec.init, pb.samples, false);
  const held = PROCESSES.map(() => 0);
  for (const j of pb.jobs) {
    if (j.queuedAt <= t && j.startAt > t && j.equipWaitMin > 0 && t >= j.startAt - j.equipWaitMin) held[PROCESSES.indexOf(j.process)]++;
  }
  return { kpis, running, final: atEnd, held };
}

/** A fixture run and a parking stall are the two things a ray can hit that describe.ts has no card for; they are plain enough to write here. */
function describeFixture(i: number, world: WorldPayload): DescribeSection[] {
  const f = world.spec.fixtures[i];
  if (!f) return [{ title: "Fixture", rows: [{ label: "Index", value: String(i) }] }];
  const here = world.facings.filter((x) => x.run === f.id).length;
  return [
    {
      title: `${f.id}, a ${f.kind} run`,
      rows: [
        { label: "Runs", value: `${feet(Math.abs(f.y1 - f.y0))} from the storefront end, ${feet(f.depthFt)} deep` },
        { label: "Fixture", value: `${f.bays} bays × ${f.shelves} shelves × ${f.facingsPerBay} facings${f.doubleSided ? ", both sides shop" : ", one shopping side"}` },
        { label: "Facings", value: `${count(here)} merchandised on it` },
        { label: "Where", value: `centred at x ${Math.round(f.x)} ft`, shown: true },
      ],
    },
  ];
}

function describeStall(i: number, pb: Playback, t: number): DescribeSection[] {
  const stall = pb.world.lot.stalls[i];
  if (!stall) return [{ title: "Parking stall", rows: [{ label: "Index", value: String(i) }] }];
  const car = csrValueAt(pb.stalls, i, t, -1);
  const kind = stall.kind === "accessible" ? "an accessible stall" : stall.kind === "curbside" ? "a curbside pickup spot" : "a standard stall";
  return [
    {
      title: `Stall ${i + 1}`,
      rows: [
        { label: "Stall", value: kind },
        { label: "Now", value: car >= 0 ? `${pb.entities[car]?.label ?? `car ${car}`} parked here` : "empty" },
        { label: "Where", value: `${Math.round(stall.pt[0])}, ${Math.round(stall.pt[1])} ft — the lot is drawn to the stall, but a full one never turns anybody away`, shown: true },
      ],
    },
  ];
}

function sectionsFor(sel: Selected, rec: RunRecord | null, t: number): DescribeSection[] {
  if (!sel || !rec) return [];
  const { playback: pb, world, index } = rec;
  if (sel.k === "queue") return describeQueue(sel.process, pb, t);
  const p = sel.pick;
  switch (p.kind) {
    case "entity":
      return describeEntity(p.index, pb, world, t, index);
    case "facing":
      return describeFacing(p.index, pb, world, t, index);
    case "storage":
      return describeStorage(p.index, pb, world, t, index);
    case "post":
      return describePost(p.index, pb, world, t);
    case "door":
      return describeDoor(p.index, pb, world, t, index);
    case "fixture":
      return describeFixture(p.index, world);
    case "stall":
      return describeStall(p.index, pb, t);
  }
}

function selectionTitle(sel: Selected, rec: RunRecord | null): string {
  if (!sel) return "Nothing selected";
  if (sel.k === "queue") return `${sel.process} queue`;
  if (sel.pick.kind === "entity" && rec) return entityTitle(rec.playback, sel.pick.index);
  return sel.pick.label || sel.pick.id || sel.pick.kind;
}

function runLabel(spec: RunSpec, storeName: string): string {
  return `${storeName} · week ${spec.startWeek} · ${spec.days} day${spec.days === 1 ? "" : "s"} · seed ${spec.seed}`;
}

/**
 * The `done` message does not carry the engine's `OperationsResult` today. This
 * reads it if it ever does, rather than making the Report tab wait for a change
 * in two files at once.
 */
function resultOf(m: Extract<TwinResponse, { type: "done" }>): OperationsResult | null {
  const r = (m as { result?: unknown }).result;
  return r !== null && typeof r === "object" ? (r as OperationsResult) : null;
}

// ---------------------------------------------------------------------------
// The workbench
// ---------------------------------------------------------------------------

/**
 * The whole client application behind /store.
 *
 * It owns every piece of React state, spawns the simulation worker, composes
 * the header, the stage, its overlays, the side panel and the timeline, and
 * reads and writes the URL hash — which is the run's identity, so a tool's
 * "watch this run" link and this page's own history entry are the same string
 * and the server is never involved.
 *
 * What it deliberately does *not* own is the playhead: that lives in a ref
 * inside StoreScene and arrives here throttled, so sixty frames a second cost
 * about twelve React renders.
 */
export default function StoreWorkbench() {
  const [hash] = useState(() => decodeHash(window.location.hash));
  const [runText, setRunText] = useState<RunText>(() => textFromRun({ store: hash.store, week: hash.week, days: hash.days, seed: hash.seed }));
  const [building, setBuilding] = useState<BuildingChoice>(() => buildingFromHash(hash.src));
  const [form, setForm] = useState<StoreForm>(() => scenarioToForm(hash.scenario));
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [current, setCurrent] = useState<RunRecord | null>(null);
  const [previous, setPrevious] = useState<RunRecord | null>(null);
  const [selection, setSelection] = useState<Selected>(null);
  const [tab, setTab] = useState<SideTab>("scenario");
  const [scenarioTab, setScenarioTab] = useState<ScenarioTab>("trade");
  const [clock, setClock] = useState<ClockView>({ t: hash.t ?? 0, playing: false, speed: DEFAULT_SPEED, skipQuiet: true });
  const [view, setView] = useState<ViewFlags>({ labels: true, dayNight: true, shadows: true, hud: true, hudMore: false, minimap: true, help: false, menu: false, legend: false });
  const [theme, setTheme] = useState<"light" | "dark">(() => (prefersDark() ? "dark" : "light"));
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mode, setMode] = useState<ViewMode>("orbit");
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A frame-only screenshot hides the hint with the rest of the chrome; a layout capture (shot=1&chrome=1) shows it as a first visit would.
  const [hint, setHint] = useState<boolean>(() => (!hash.shot || !!hash.chrome) && !hash.perf && readHint());
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef(0);
  const nextId = useRef(1);
  const sceneRef = useRef<StoreSceneHandle | null>(null);
  const toastTimer = useRef<number | null>(null);
  /** The request behind each run in flight, so the record describes what was actually run even if the form is edited meanwhile. */
  const requests = useRef(new Map<number, { spec: RunSpec; src?: string; storeName: string; at: number }>());
  /** The hash this page last wrote itself, so its own replaceState is never mistaken for a navigation. */
  const written = useRef<string>(window.location.hash);
  /** A minute to seek to once the next run's playback is on screen (a link opened in this tab). */
  const pendingSeek = useRef<number | null>(null);

  const run = useMemo(() => runFromText(runText), [runText]);
  const shot: ShotMode | null = useMemo(() => {
    // `cam` is a loose string in the codec so the renderer can add a preset without a codec release; the renderer's own list is what decides whether this one exists.
    const cam = CAMERA_PRESETS.find((p) => p === hash.cam);
    return hash.shot ? { kind: "shot", t: hash.t ?? 0, cam } : hash.perf ? { kind: "perf", t: hash.t ?? 0, cam } : null;
  }, [hash]);
  const frameOnly = shot?.kind === "shot" && !hash.chrome;

  const site = useMemo(() => SITES.find((x) => x.id === run.store) ?? SITES[0], [run.store]);
  const parsed = useMemo(() => formToScenario(form), [form]);
  const errors: FormErrors = parsed.errors;
  const errorCount = Object.keys(errors).length;

  const formCtx: FormContext = useMemo(() => {
    const world = current?.world;
    const init = current?.init;
    const imported = building.kind !== "builtin";
    const hours = site.hours.map((h) => `${h.open}–${h.close}`);
    return {
      workerIds: init ? init.workers.map((w) => w.id) : [],
      roles: init ? [...new Set(init.workers.map((w) => w.role))] : ROLE_NAMES,
      shiftIds: form.shifts.length ? form.shifts.map((s) => s.id).filter(Boolean) : init ? init.shifts.map((s) => s.id) : site.shifts.map((s) => s.id),
      supplierIds: world ? world.suppliers.map((s) => s.id) : [],
      categories: world ? [...new Set(world.skus.map((s) => s.category))] : [],
      skuCount: world ? world.skus.length : SKU_COUNT,
      site: {
        registers: site.checkout.registers,
        counters: site.showcase?.stations ?? 0,
        palletJacks: site.equipment.palletJacks,
        stockCarts: site.equipment.stockCarts,
        vans: site.equipment.vans,
        docks: site.doors.docks,
        groundDoors: site.doors.ground,
        widthFt: site.building.widthFt,
        hours: [...new Set(hours)].join(", "),
        operatingDays: site.operatingDays,
      },
      gondolas: imported ? null : { runs: site.gondolas.runs, baysPerRun: site.gondolas.baysPerRun, shelves: site.gondolas.shelves, facingsPerBay: site.gondolas.facingsPerBay, depthFt: site.gondolas.depthFt, aisleWidthFt: site.gondolas.aisleWidthFt, originX: site.gondolas.originX },
      imported,
    };
  }, [current, building, form.shifts, site]);

  const counts = useMemo(() => tabCounts(parsed.scenario), [parsed.scenario]);

  /** The form or the run row no longer describes the run on screen. */
  const edited = useMemo(() => {
    if (!current) return false;
    const s = parsed.scenario;
    if (!s) return true;
    const spec = current.spec;
    const src = building.kind === "builtin" ? undefined : "session";
    return run.store !== spec.store || run.week !== spec.startWeek || run.days !== spec.days || run.seed !== spec.seed || src !== current.src || JSON.stringify(s) !== JSON.stringify(spec.scenario);
  }, [current, parsed.scenario, run, building]);

  const hud = useMemo(() => (current ? snapshotAt(current, clock.t) : null), [current, clock.t]);
  const sections = useMemo(() => sectionsFor(selection, current, clock.t), [selection, current, clock.t]);
  const pick = selection?.k === "pick" ? selection.pick : null;
  const canFollow = !!(current && pick?.kind === "entity" && current.playback.tracks.some((tr) => tr?.entity === pick.index));

  // --- The worker. Handlers never close over state: they call through a ref refreshed every render, which is what lets the spawn effect stay []-deped.
  const latest = useRef<{ onMessage: (m: TwinResponse) => void; onWorkerError: (msg: string) => void; startRun: (inputs?: RunInputs) => void; launch: (inputs: RunInputs) => void }>({
    onMessage: () => {},
    onWorkerError: () => {},
    startRun: () => {},
    launch: () => {},
  });

  const spawn = () => {
    const w = new Worker(new URL("../store.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<TwinResponse>) => latest.current.onMessage(e.data);
    w.onerror = (e) => latest.current.onWorkerError(e.message || "The simulation worker failed to start.");
    workerRef.current = w;
    return w;
  };

  const writeHash = (h: string) => {
    window.history.replaceState(null, "", `#${h}`);
    written.current = `#${h}`;
  };

  const showToast = (text: string) => {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };

  const startRun = (inputs?: RunInputs) => {
    const w = workerRef.current;
    if (!w) return;
    const useRun = inputs?.run ?? run;
    const useForm = inputs?.form ?? form;
    const useBuilding = inputs?.building ?? building;
    const composed = composeScenario(useForm, useBuilding, formCtx);
    if (composed.error) {
      if (composed.error.where !== "building") {
        setTab("scenario");
        setSheetOpen(true);
      }
      if (composed.error.where === "floor") setScenarioTab("floor");
      setStatus({ kind: "error", message: composed.error.message });
      return;
    }
    const { scenario, bare } = composed;
    const id = nextId.current++;
    runIdRef.current = id;
    const spec: RunSpec = { store: useRun.store, startWeek: useRun.week, days: useRun.days, seed: useRun.seed, scenario };
    const src = useBuilding.kind === "builtin" ? undefined : "session";
    const storeName = SITES.find((x) => x.id === useRun.store)?.name ?? useRun.store;
    requests.current.set(id, { spec: { ...spec, scenario: bare }, src, storeName, at: performance.now() });
    const req: TwinRequest = { type: "run", id, spec };
    setStatus({ kind: "running", phase: "building", day: 0, days: useRun.days });
    w.postMessage(req);
    try {
      writeHash(encodeHash({ store: useRun.store, week: useRun.week, days: useRun.days, seed: useRun.seed, src, scenario: bare }));
      setLinkMsg(null);
    } catch (err) {
      setLinkMsg(err instanceof HashError ? err.message : String(err));
    }
  };

  /**
   * Stop a run. The worker is single-threaded and `runOperations` is one long
   * synchronous call, so a `cancel` message would sit in its queue until the
   * run it cancels had finished. Terminating and respawning is the only thing
   * that actually stops it.
   */
  const cancelRun = () => {
    workerRef.current?.terminate();
    runIdRef.current = 0;
    requests.current.clear();
    spawn();
    setStatus({ kind: "idle" });
  };

  const launch = (inputs: RunInputs) => {
    if (runIdRef.current) cancelRun();
    startRun(inputs);
  };

  const onMessage = (m: TwinResponse) => {
    if (m.id !== runIdRef.current) return;
    switch (m.type) {
      case "progress":
        setStatus({ kind: "running", phase: m.phase, day: m.day ?? 0, days: m.days ?? run.days });
        break;
      case "done": {
        const init = m.playback.events[0]?.k === "init" ? (m.playback.events[0] as TraceInit) : null;
        if (!init) {
          setStatus({ kind: "error", message: "The playback has no init event, so nothing can be replayed from it." });
          return;
        }
        const req = requests.current.get(m.id);
        requests.current.delete(m.id);
        const spec: RunSpec = req ? { ...req.spec, scenario: withoutLayout(req.spec.scenario) } : { store: init.store, startWeek: init.startWeek, days: init.days, seed: init.seed, scenario: {} };
        const storeName = req?.storeName ?? init.storeName;
        const rec: RunRecord = {
          id: m.id,
          label: runLabel(spec, storeName),
          spec,
          src: req?.src,
          storeName,
          playback: m.playback,
          world: m.world,
          kpis: m.kpis,
          result: resultOf(m),
          issues: m.issues,
          ms: req ? Math.round(performance.now() - req.at) : 0,
          index: indexEvents(m.playback),
          kctx: kpiContext(init, m.playback.events, m.world.skus),
          init,
        };
        // One line is the whole Compare feature: the run that was playing becomes A.
        setPrevious(current);
        setCurrent(rec);
        setSelection(null);
        setStatus({ kind: "idle" });
        setNotice(m.issues.length ? m.issues.join(" ") : null);
        break;
      }
      case "error":
        runIdRef.current = 0;
        requests.current.delete(m.id);
        setStatus({ kind: "error", message: m.message });
        // The worker states which field it rejected in the message itself; the fields are on the Scenario tab.
        if (m.message.startsWith("Invalid scenario")) {
          setTab("scenario");
          setSheetOpen(true);
        }
        break;
    }
  };

  // A worker that failed to load stays dead: replace it, as Cancel does, so the next Run has somewhere to go.
  const onWorkerError = (msg: string) => {
    workerRef.current?.terminate();
    runIdRef.current = 0;
    requests.current.clear();
    spawn();
    setStatus({ kind: "error", message: msg });
  };

  // These three effects run in this order on mount, which is the order they need: a worker, then the handlers that reach it, then the run.
  useEffect(() => {
    spawn();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      runIdRef.current = 0;
      latest.current = { onMessage: () => {}, onWorkerError: () => {}, startRun: () => {}, launch: () => {} };
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    latest.current = { onMessage, onWorkerError, startRun, launch };
  });

  // Every load runs once, so a tool's deep link plays without a click.
  useEffect(() => {
    latest.current.startRun();
  }, []);

  // A link pasted into this tab's address bar is a fragment navigation: the document stays, so the page runs the new link itself.
  useEffect(() => {
    const onHashChange = () => {
      const h = window.location.hash;
      if (h === written.current) return;
      const decoded = decodeHash(h);
      const nextRun = { store: decoded.store, week: decoded.week, days: decoded.days, seed: decoded.seed };
      const nextForm = scenarioToForm(decoded.scenario);
      const nextBuilding = buildingFromHash(decoded.src);
      setRunText(textFromRun(nextRun));
      setForm(nextForm);
      setBuilding(nextBuilding);
      pendingSeek.current = decoded.t ?? 0;
      written.current = h;
      // A link that arrives mid-run replaces it: launch cancels whatever is in flight first.
      latest.current.launch({ run: nextRun, form: nextForm, building: nextBuilding });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The scene binds a new playback in its own effect first (a child's effects run before its parent's); the link's minute then wins.
  useEffect(() => {
    if (!current || pendingSeek.current === null) return;
    const t = pendingSeek.current;
    pendingSeek.current = null;
    sceneRef.current?.seek(t);
  }, [current]);

  // --- Environment
  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const small = window.matchMedia("(max-width: 999px)");
    const onDark = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    const onSmall = (e: MediaQueryListEvent) => setNarrow(e.matches);
    dark.addEventListener("change", onDark);
    small.addEventListener("change", onSmall);
    return () => {
      dark.removeEventListener("change", onDark);
      small.removeEventListener("change", onSmall);
    };
  }, []);

  // The View menu and the timeline legend close on a click anywhere else, like any dropdown.
  useEffect(() => {
    if (!view.menu && !view.legend) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (view.menu && !el?.closest(".store-menuwrap")) setView((v) => ({ ...v, menu: false }));
      if (view.legend && !el?.closest(".store-legendwrap")) setView((v) => ({ ...v, legend: false }));
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [view.menu, view.legend]);

  // --- Handlers
  const select = (sel: Selected) => {
    setSelection(sel);
    if (sel) {
      setTab("inspector");
      if (narrow) setSheetOpen(true);
    }
  };
  const selectEntity = (entity: number) => {
    const def = current?.playback.entities[entity];
    if (def) select({ k: "pick", pick: { kind: "entity", index: entity, id: def.id, label: def.label } });
  };
  const seek = (t: number) => sceneRef.current?.seek(t);
  const onSkipped = (gap: [number, number]) => showToast(`Skipped ${minutes(gap[1] - gap[0])} with nobody in the shop, ${dayClock(gap[0])} → ${dayClock(gap[1])}. Press 0 to keep them.`);
  const skipQuietNow = () => {
    if (!current) return;
    const to = skipAhead(current.playback.quiet, clock.t, current.playback.meta.horizonEnd);
    if (to > clock.t) seek(to);
  };
  const floorClick = (x: number, y: number) => {
    if (!current) return;
    let best = -1;
    // Eight feet: the width of an aisle, so a click between two runs picks the nearer one rather than nothing.
    let bestD = 8;
    current.world.facings.forEach((f, i) => {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      const f = current.world.facings[best];
      select({ k: "pick", pick: { kind: "facing", index: best, id: f.id, label: f.id } });
    }
  };
  const jumpNotable = (dir: 1 | -1) => {
    if (!current) return;
    const i = notableFrom(current.playback, clock.t, dir);
    if (i < 0) return;
    const e = current.playback.ticker[i];
    seek(e.t);
    if (e.entity >= 0) selectEntity(e.entity);
  };
  const onAction = (a: KeyAction) => {
    switch (a) {
      case "toggleLabels":
        setView((v) => ({ ...v, labels: !v.labels }));
        break;
      case "toggleNight":
        setView((v) => ({ ...v, dayNight: !v.dayNight }));
        break;
      case "toggleShadows":
        setView((v) => ({ ...v, shadows: !v.shadows }));
        break;
      case "toggleHud":
        setView((v) => ({ ...v, hud: !v.hud }));
        break;
      case "toggleMinimap":
        setView((v) => ({ ...v, minimap: !v.minimap }));
        break;
      case "toggleHelp":
        setView((v) => ({ ...v, help: !v.help }));
        break;
      case "run":
        if (status.kind !== "running") startRun();
        break;
      case "compare":
        setTab("compare");
        if (narrow) setSheetOpen(true);
        break;
      case "escape":
        // Overlays close one at a time, the most recent kind first; the selection and the sheet come last.
        if (view.help) setView((v) => ({ ...v, help: false }));
        else if (view.menu) setView((v) => ({ ...v, menu: false }));
        else if (view.legend) setView((v) => ({ ...v, legend: false }));
        else if (view.hudMore) setView((v) => ({ ...v, hudMore: false }));
        else if (selection) setSelection(null);
        else if (narrow) setSheetOpen(false);
        break;
      case "tickerPrev":
        jumpNotable(-1);
        break;
      case "tickerNext":
        jumpNotable(1);
        break;
    }
  };
  const dismissHint = () => {
    setHint(false);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      // A blocked storage just means the hint comes back next visit.
    }
  };
  /** The link describes the run on screen at this minute, whatever the form says now. */
  const copyLink = async () => {
    if (!current) return;
    try {
      const h = encodeHash({ store: current.spec.store, week: current.spec.startWeek, days: current.spec.days, seed: current.spec.seed, t: Math.round(clock.t), src: current.src, scenario: current.spec.scenario });
      await navigator.clipboard.writeText(`${window.location.origin}/store#${h}`);
      setLinkMsg("Link copied");
    } catch (err) {
      setLinkMsg(err instanceof HashError ? err.message : err instanceof Error ? err.message : String(err));
    }
  };
  const swapRuns = () => {
    if (!previous || !current) return;
    setPrevious(current);
    setCurrent(previous);
    setSelection(null);
    try {
      writeHash(encodeHash({ store: previous.spec.store, week: previous.spec.startWeek, days: previous.spec.days, seed: previous.spec.seed, src: previous.src, scenario: previous.spec.scenario }));
    } catch {
      // A run whose scenario cannot be linked leaves the URL as it was.
    }
  };
  const updateForm = (fn: (f: StoreForm) => StoreForm) => setForm(fn);
  const setRunField = (key: keyof RunText, value: string) => setRunText((r) => ({ ...r, [key]: value }));
  /** On blur the field shows the value the run will actually use: clamped, or the default for a blank. */
  const commitRunField = (key: "week" | "days" | "seed") => setRunText((r) => ({ ...r, [key]: String(runFromText(r)[key]) }));

  const running = status.kind === "running";
  const progressShare = status.kind === "running" ? (status.phase === "building" ? 0.05 : status.phase === "compiling" ? 0.95 : 0.05 + (0.9 * Math.max(0, status.day - 1)) / Math.max(1, status.days)) : 0;
  const chips = current ? { name: current.storeName, week: current.spec.startWeek, days: current.spec.days, seed: current.spec.seed } : { name: site.name, week: run.week, days: run.days, seed: run.seed };
  const showSide = (id: SideTab) => {
    setTab(id);
    if (narrow) setSheetOpen(id === tab ? !sheetOpen : true);
  };
  const atQuiet = !!current && nextOpen(current.playback, clock.t, current.playback.meta.horizonEnd) > clock.t;

  const viewMenu: Array<[label: string, key: string, on: boolean, action: KeyAction]> = [
    ["Labels", "L", view.labels, "toggleLabels"],
    ["Lighting follows the clock", "N", view.dayNight, "toggleNight"],
    ["Shadows", "S", view.shadows, "toggleShadows"],
    ["Minimap", "M", view.minimap, "toggleMinimap"],
    ["Key figures (HUD)", "H", view.hud, "toggleHud"],
  ];

  const hudEl =
    view.hud && current && hud ? (
      <Hud
        world={current.world}
        playback={current.playback}
        index={current.index}
        snapshot={hud}
        t={clock.t}
        expanded={view.hudMore}
        onToggle={() => setView((v) => ({ ...v, hudMore: !v.hudMore }))}
        onSelectQueue={(p: Process) => select({ k: "queue", process: p })}
        onSelectEntity={selectEntity}
        onSeek={seek}
      />
    ) : null;
  // Wide: the hint floats over the stage above the ticker. Narrow: the stage is short, so it is a block under it and never hides the shop.
  const hintEl = hint && current && !view.help ? <FirstRunHint block={narrow} onDismiss={dismissHint} onHelp={() => setView((v) => ({ ...v, help: true }))} /> : null;

  return (
    <div className={`store-app${narrow ? " sheeted" : ""}${frameOnly ? " shot" : ""}`}>
      <header className="store-top">
        <span className="store-crumb">
          <Link href="/" title="Candy shop twin">
            ← Shop twin
          </Link>
        </span>
        <h1>3D twin</h1>
        <span className="store-runline">
          <span className="store-chip">{chips.name}</span>
          <span className="store-chip">week {chips.week}</span>
          <span className="store-chip">
            {chips.days} day{chips.days === 1 ? "" : "s"}
          </span>
          <span className="store-chip">seed {chips.seed}</span>
          {edited && (
            <span className="store-chip edited" title="The scenario or the run row has changed since this run; run again to see it">
              edited
            </span>
          )}
          {current && (
            <span className="sub store-ranin" title="The engine, the trace compiler and the transfer, in this browser">
              ran in {count(current.ms)} ms · {count(current.playback.jobs.length)} jobs · {count(current.playback.events.length)} events
            </span>
          )}
        </span>
        <div className="store-actions" onMouseDown={keepFocus}>
          {running && (
            <>
              <span className="store-chip busy">{status.phase === "building" ? "building the twin" : status.phase === "compiling" ? "compiling the playback" : `simulating day ${status.day} of ${status.days}`}</span>
              <span className="store-progress">
                <i style={{ width: `${Math.round(progressShare * 100)}%` }} />
              </span>
              <button type="button" onClick={cancelRun}>
                Cancel
              </button>
            </>
          )}
          {!running && (
            <button type="button" className="primary" onClick={() => startRun()} title="R">
              {current ? "Run again" : "Run"}
            </button>
          )}
          <button type="button" onClick={() => void copyLink()} disabled={!current} title="A link that replays this run at this minute">
            Copy link
          </button>
          {linkMsg && (
            <span className="sub" style={{ margin: 0 }}>
              {linkMsg}
            </span>
          )}
        </div>
      </header>

      {notice && (
        <div className="store-notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {status.kind === "error" && (
        <div className="store-notice error">
          <span>{status.message}</span>
          <button type="button" onClick={() => setStatus({ kind: "idle" })}>
            Dismiss
          </button>
        </div>
      )}

      <div className="store-body">
        <div className="store-stage">
          <StoreScene
            ref={sceneRef}
            world={current?.world ?? null}
            playback={current?.playback ?? null}
            labels={view.labels}
            dayNight={view.dayNight}
            shadows={view.shadows}
            theme={theme}
            selection={pick}
            initialT={hash.t ?? 0}
            shot={shot}
            onClock={setClock}
            onPick={(p) => select(p ? { k: "pick", pick: p } : null)}
            onSkipped={onSkipped}
            onAction={onAction}
            onMode={setMode}
          />
          {!current && (
            <div className="store-empty">
              <div>
                <b>{running ? "Simulating…" : status.kind === "error" ? "The run did not start" : "Opening the shop…"}</b>
                {running ? `${status.phase === "simulating" ? `day ${status.day} of ${status.days}` : status.phase} — the engine runs in a web worker in your browser` : "Nothing leaves your browser: the simulation and the 3D playback both run here."}
              </div>
            </div>
          )}
          {/* The overlays are flex stacks, not free-floating boxes: the toolbar and the clock share the first row, the HUD gets the whole width under them however the toolbar wraps, and nothing covers anything else. */}
          <div className="store-ovl store-ovl-top" onMouseDown={keepFocus}>
            <div className="store-ovl-row">
              <div className="store-ovl-col left">
                <div className="store-overlay store-campill" role="toolbar" aria-label="Camera">
                  <button type="button" className={mode === "orbit" ? "on" : ""} onClick={() => sceneRef.current?.setMode("orbit")} title="O: orbit (drag to turn, wheel to zoom, right-drag to pan)">
                    Orbit
                  </button>
                  <button type="button" className={mode === "follow" ? "on" : ""} disabled={!canFollow && mode !== "follow"} onClick={() => pick?.kind === "entity" && sceneRef.current?.follow(pick.index)} title="F: follow whoever is selected">
                    Follow
                  </button>
                  {!narrow && (
                    <button type="button" className={mode === "walk" ? "on" : ""} onClick={() => sceneRef.current?.setMode("walk")} title="W: walk the sales floor (WASD, mouse to look, E to inspect, Esc to leave)">
                      Walk
                    </button>
                  )}
                  <span className="sep" />
                  {PRESETS.map(([p, label], i) => (
                    <button type="button" key={p} className="narrow-hide" onClick={() => sceneRef.current?.preset(p)} title={`${i + 1}: ${label}`}>
                      {label}
                    </button>
                  ))}
                  <span className="sep" />
                  <span className="store-menuwrap">
                    <button type="button" className={view.menu ? "on" : ""} onClick={() => setView((v) => ({ ...v, menu: !v.menu }))} aria-haspopup="menu" aria-expanded={view.menu} title="Labels, lighting, shadows, minimap, HUD">
                      View ▾
                    </button>
                    {view.menu && (
                      <div className="store-overlay store-menu" role="menu">
                        {viewMenu.map(([label, key, on, action]) => (
                          <button type="button" role="menuitemcheckbox" aria-checked={on} key={action} className={on ? "on" : ""} onClick={() => onAction(action)}>
                            <i aria-hidden="true">{on ? "✓" : ""}</i>
                            <span>{label}</span>
                            <kbd>{key}</kbd>
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                  <button type="button" className={view.help ? "on" : ""} onClick={() => onAction("toggleHelp")} title="?: the keyboard map and how to drive the shop" aria-label="Help">
                    ?
                  </button>
                </div>
              </div>
              <div className="store-ovl-col right">
                {current && (
                  <div className="store-overlay store-clockpill" title=", and . change the speed; 0 toggles skipping the empty hours">
                    <b>{dayClock(clock.t)}</b>
                    <span className="store-speed">
                      {clock.playing ? "▶" : "❚❚"} {clock.speed}×{clock.playing ? "" : " · paused"}
                    </span>
                    <span className="store-sel">{selectionTitle(selection, current)}</span>
                    {atQuiet && (
                      <button type="button" className="chip" onClick={skipQuietNow}>
                        Skip to the next thing
                      </button>
                    )}
                  </div>
                )}
                {toast && (
                  <div className="store-overlay store-toast" role="status">
                    {toast}
                  </div>
                )}
              </div>
            </div>
            {!narrow && hudEl}
          </div>
          <div className="store-ovl store-ovl-bottom" onMouseDown={keepFocus}>
            <div className="store-ovl-col left">
              {!narrow && hintEl}
              {current && <Ticker playback={current.playback} t={clock.t} onSelect={selectEntity} onSeek={seek} />}
            </div>
            {current && view.minimap && !narrow && <Minimap world={current.world} playback={current.playback} t={clock.t} selection={pick} onFloorClick={floorClick} onSelect={selectEntity} />}
          </div>
          <HelpOverlay open={view.help} onClose={() => setView((v) => ({ ...v, help: false }))} />
        </div>

        <aside className={`store-side${narrow ? " sheet" : ""}${sheetOpen ? " open" : ""}`}>
          <div className="store-tabs" role="tablist">
            {(
              [
                ["scenario", "Scenario"],
                ["inspector", "Inspector"],
                ["compare", "Compare"],
                ["report", "Report"],
                ["help", "Help"],
              ] as Array<[SideTab, string]>
            ).map(([id, label]) => (
              <button type="button" key={id} id={`store-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`store-panel-${id}`} className={tab === id ? "on" : ""} onClick={() => showSide(id)}>
                {label}
                {id === "scenario" && errorCount > 0 && <span className="n">{errorCount}</span>}
              </button>
            ))}
          </div>
          {tab === "scenario" && (
            <ScenarioPanel
              tab={scenarioTab}
              onTab={setScenarioTab}
              counts={counts}
              errorCount={errorCount}
              panelId="store-panel-scenario"
              labelledBy="store-tab-scenario"
              runControls={
                <>
                  <ShopPicker store={run.store} shops={SITES.map((x) => ({ id: x.id, name: x.name }))} value={building} disabled={running} onStore={(id) => setRunField("store", id)} onChange={setBuilding} />
                  <div className="row">
                    <label>
                      Week{" "}
                      <input type="number" min={1} max={52} value={runText.week} onChange={(e) => setRunField("week", e.target.value)} onBlur={() => commitRunField("week")} title="Calendar week the run starts on its Monday; 44 is Halloween week" />
                    </label>
                    <label>
                      Days <input type="number" min={1} max={MAX_DAYS} value={runText.days} onChange={(e) => setRunField("days", e.target.value)} onBlur={() => commitRunField("days")} title={`1 to ${MAX_DAYS} days`} />
                    </label>
                    <label>
                      Seed{" "}
                      <input type="number" min={1} max={MAX_SEED} value={runText.seed} onChange={(e) => setRunField("seed", e.target.value)} onBlur={() => commitRunField("seed")} title="Seed 1 replays a tool's first run exactly" />
                    </label>
                    {/* The buttons alone keep focus off themselves, so Space plays instead of re-running; the inputs beside them still take the caret. */}
                    <span className="store-runbtns" onMouseDown={keepFocus}>
                      {!running ? (
                        <button type="button" className="primary" onClick={() => startRun()}>
                          Run
                        </button>
                      ) : (
                        <button type="button" onClick={cancelRun}>
                          Cancel
                        </button>
                      )}
                      <button type="button" className="chip" onClick={() => updateForm(() => emptyForm())} title="Clear every scenario field">
                        Reset
                      </button>
                    </span>
                  </div>
                  {current && current.world.changes.length > 0 && (
                    <ul className="store-changes">
                      {current.world.changes.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                  {errors[""] && <span className="store-err">{errors[""]}</span>}
                </>
              }
            >
              <Datalists ctx={formCtx} />
              {scenarioTab === "trade" && <Trade form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "people" && <People form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "stock" && <Stock form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "floor" && <Floor form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "disruptions" && <Disruptions form={form} update={updateForm} errors={errors} ctx={formCtx} />}
            </ScenarioPanel>
          )}
          {tab === "inspector" && (
            <div className="store-tabbody" role="tabpanel" id="store-panel-inspector" aria-labelledby="store-tab-inspector">
              <Inspector
                title={selectionTitle(selection, current)}
                selection={pick}
                sections={sections}
                canFollow={canFollow}
                following={mode === "follow"}
                onFollow={() => pick?.kind === "entity" && sceneRef.current?.follow(pick.index)}
                onClear={() => setSelection(null)}
              />
            </div>
          )}
          {tab === "compare" && (
            <div className="store-tabbody" role="tabpanel" id="store-panel-compare" aria-labelledby="store-tab-compare">
              <ComparePanel
                a={previous ? { label: previous.label, kpis: previous.kpis, changes: previous.world.changes } : null}
                b={current ? { label: current.label, kpis: current.kpis, changes: current.world.changes } : null}
                onSwap={swapRuns}
              />
            </div>
          )}
          {tab === "report" && (
            <div className="store-tabbody" role="tabpanel" id="store-panel-report" aria-labelledby="store-tab-report">
              {/* The records themselves, not copies: their identity is stable between renders, so the report is built once per run. */}
              <ReportPanel
                run={current ? { label: current.label, store: current.spec.store, storeName: current.storeName, startWeek: current.spec.startWeek, days: current.spec.days, seed: current.spec.seed, kpis: current.kpis, changes: current.world.changes, result: current.result } : null}
                previous={previous ? { label: previous.label, kpis: previous.kpis } : null}
              />
            </div>
          )}
          {tab === "help" && (
            <div className="store-tabbody" role="tabpanel" id="store-panel-help" aria-labelledby="store-tab-help">
              <h3>What you are looking at</h3>
              <p>
                A discrete-event simulation of one candy shop runs in a web worker in your browser, records every event, and the playback compiles them into the animation: the overnight trailer at the
                back door, the morning fill, the special orders picked and packed and loaded onto the van, then customers in off the car park, down the aisles, queueing at the glass and at the till —
                and some of them walking out again.
              </p>
              <p>
                The numbers on the HUD are the engine&apos;s own accounting at the minute on the clock. What the engine never decides — which register, which stall, which cart, how a shopper walks
                between two fixtures — the playback picks deterministically and the inspector labels as <em>shown</em>.
              </p>
              <p>Seed 1 replays run 1 of the MCP tools&apos; table exactly. Change one field on the Scenario tab, run the same seed again, and the Compare tab puts every KPI side by side.</p>
              <h3>Keys</h3>
              <button type="button" onClick={() => setView((v) => ({ ...v, help: true }))}>
                Show the keyboard map
              </button>
              <h3>Camera</h3>
              <p className="sub">{CAMERA_PRESETS.map((p, i) => `${i + 1} ${p}`).join(" · ")}</p>
              <h3>Links</h3>
              <p>
                <Link href="/import">Import your own shop plan</Link> and press &ldquo;Open in 3D&rdquo;: the drawing is handed to this page in the browser, never through the URL. Every{" "}
                <code>simulate_day</code> and <code>what_if</code> answer from the MCP tools ends with a link that replays its first run here.
              </p>
            </div>
          )}
        </aside>
      </div>

      {narrow && hintEl}
      {narrow && hudEl}

      <Timeline
        playback={current?.playback ?? null}
        compare={previous?.playback ?? null}
        t={clock.t}
        playing={clock.playing}
        speed={clock.speed}
        skipQuiet={clock.skipQuiet}
        onSeek={seek}
        onTogglePlay={() => sceneRef.current?.togglePlay()}
        onSpeed={(s) => sceneRef.current?.setSpeed(s)}
        onSkipQuiet={(on) => sceneRef.current?.setSkipQuiet(on)}
        onStep={(d) => sceneRef.current?.step(d)}
        legendOpen={view.legend}
        onLegend={(open) => setView((v) => ({ ...v, legend: open }))}
      />
    </div>
  );
}
