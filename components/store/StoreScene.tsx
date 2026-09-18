"use client";

import { useEffect, useImperativeHandle, useRef, type MouseEvent as ReactMouseEvent, type Ref } from "react";
import { DEFAULT_SPEED, PlaybackClock, SPEEDS, stepSpeed } from "@/lib/store-ui/clock";
import { CAMERA_PRESETS, createViewer, type CameraPreset, type PickResult, type Viewer, type ViewerStats, type ViewMode } from "@/lib/three/api";
import { facingBadgeIndex, isQueueChip, MAX_LABELS, queueChipIndex } from "@/lib/three/labels";
import type { Playback, WorldPayload } from "@/lib/trace/types";

export interface ClockView {
  t: number;
  playing: boolean;
  speed: number;
  skipQuiet: boolean;
}

/** Keys the scene does not act on itself: the workbench owns that state. */
export type KeyAction = "toggleLabels" | "toggleNight" | "toggleShadows" | "toggleHud" | "toggleMinimap" | "toggleHelp" | "run" | "compare" | "escape" | "tickerPrev" | "tickerNext";

/** The screenshot and performance harnesses, read out of the URL hash. */
export interface ShotMode {
  kind: "shot" | "perf";
  t: number;
  cam?: CameraPreset;
}

export interface StoreSceneHandle {
  seek(t: number): void;
  setPlaying(on: boolean): void;
  togglePlay(): void;
  setSpeed(speed: number): void;
  setSkipQuiet(on: boolean): void;
  step(dMin: number): void;
  preset(p: CameraPreset): void;
  setMode(mode: ViewMode): void;
  /** Chase an entity; null drops back to the last orbit view. */
  follow(entity: number | null): void;
  clock(): ClockView;
  stats(): ViewerStats | null;
}

interface Props {
  world: WorldPayload | null;
  playback: Playback | null;
  labels: boolean;
  dayNight: boolean;
  shadows: boolean;
  theme: "light" | "dark";
  selection: PickResult | null;
  /** The minute the first playback starts at, from the link. */
  initialT: number;
  shot: ShotMode | null;
  onClock: (c: ClockView) => void;
  onPick: (sel: PickResult | null) => void;
  onSkipped: (gap: [number, number]) => void;
  onAction: (a: KeyAction) => void;
  onMode: (mode: ViewMode) => void;
  ref: Ref<StoreSceneHandle>;
}

/** The playhead reaches React at 12.5 Hz; the frame loop runs at 60. */
const CLOCK_REPORT_MS = 80;
/** Long enough for the frame time to settle past the first compiles and the first garbage collection. */
const PERF_FRAMES = 600;
/** The speed a perf run plays at: a trading day in two real minutes, which is what a viewer actually watches. */
const PERF_SPEED = 300;

function clockView(c: PlaybackClock): ClockView {
  return { t: c.t, playing: c.playing, speed: c.speed, skipQuiet: c.skipQuiet };
}

/**
 * The renderer reads `window.devicePixelRatio` inside `resize`, and a
 * screenshot has to be one device pixel per CSS pixel whatever screen it is
 * captured on. The API takes no ratio, so it is pinned for the duration of that
 * one call and put back — a browser that refuses simply renders at its own.
 */
function resizeAtDpr1(viewer: Viewer, w: number, h: number): void {
  let pinned = false;
  try {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    pinned = true;
  } catch {
    // Left at the display's own ratio.
  }
  try {
    viewer.resize(w, h);
  } finally {
    if (pinned) {
      try {
        Reflect.deleteProperty(window, "devicePixelRatio");
      } catch {
        // The shadowing property outlives the shot; the page is about to be captured and thrown away.
      }
    }
  }
}

/**
 * The canvas, the viewer, the frame loop and the keyboard.
 *
 * three.js objects live only in refs here: React never owns the playhead. A
 * `PlaybackClock` in a ref is advanced once per animation frame and reports up
 * at a throttle, so the HUD, the ticker and the timeline re-render about twelve
 * times a second while the scene draws sixty.
 *
 * `lib/three/api.ts` builds a viewer around one playback, so a new run means a
 * new viewer: the effect keyed on the playback creates it and its cleanup
 * disposes it, while the frame loop and the key listener are mounted once and
 * read whichever viewer is current.
 */
export default function StoreScene({ world, playback, labels, dayNight, shadows, theme, selection, initialT, shot, onClock, onPick, onSkipped, onAction, onMode, ref }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const clockRef = useRef<PlaybackClock | null>(null);
  if (clockRef.current === null) clockRef.current = new PlaybackClock(0);
  const modeRef = useRef<ViewMode>("orbit");
  const stopped = useRef(false);
  const initialApplied = useRef(false);
  const perf = useRef<{ frames: number; ms: number; active: boolean }>({ frames: 0, ms: 0, active: false });
  const labelPool = useRef<HTMLDivElement[]>([]);
  const renderLabelsRef = useRef<() => void>(() => {});
  const reportRef = useRef<(now: number, force?: boolean) => void>(() => {});
  const latest = useRef({ world, playback, labels, dayNight, shadows, theme, selection, initialT, shot, onClock, onPick, onSkipped, onAction, onMode });
  useEffect(() => {
    latest.current = { world, playback, labels, dayNight, shadows, theme, selection, initialT, shot, onClock, onPick, onSkipped, onAction, onMode };
  });

  // --- Mount: the frame loop, the resize observer and the keyboard. Strict Mode runs this twice; the cleanup makes that harmless.
  useEffect(() => {
    const stage = stageRef.current;
    const clock = clockRef.current;
    if (!stage || !clock) return;
    stopped.current = false;

    const size = () => {
      const r = stage.getBoundingClientRect();
      viewerRef.current?.resize(r.width, r.height);
    };
    const ro = new ResizeObserver(size);
    ro.observe(stage);

    let reported: ClockView = { t: -1, playing: false, speed: 0, skipQuiet: true };
    let lastReport = 0;
    // A transport change reaches the workbench at once; a moving playhead at most every CLOCK_REPORT_MS.
    const report = (now: number, force = false) => {
      const v = clockView(clock);
      const transportChanged = v.playing !== reported.playing || v.speed !== reported.speed || v.skipQuiet !== reported.skipQuiet;
      if (!force && !transportChanged && (now - lastReport < CLOCK_REPORT_MS || v.t === reported.t)) return;
      reported = v;
      lastReport = now;
      latest.current.onClock(v);
    };
    reportRef.current = report;

    const renderLabels = () => {
      const host = labelsRef.current;
      const viewer = viewerRef.current;
      if (!host || !viewer) return;
      const list = viewer.labels();
      const pool = labelPool.current;
      const sel = latest.current.selection;
      const selEntity = sel?.kind === "entity" ? sel.index : null;
      const n = Math.min(list.length, MAX_LABELS);
      for (let i = 0; i < n; i++) {
        let el = pool[i];
        if (!el) {
          el = document.createElement("div");
          host.appendChild(el);
          pool[i] = el;
        }
        const l = list[i];
        el.className = `store-label ${l.kind}${selEntity !== null && l.entity === selEntity ? " selected" : ""}`;
        el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px) translate(-50%, -100%)`;
        if (el.textContent !== l.text) el.textContent = l.text;
        el.dataset.entity = String(l.entity);
        el.hidden = false;
      }
      for (let i = n; i < pool.length; i++) pool[i].hidden = true;
    };
    renderLabelsRef.current = renderLabels;

    let last = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      if (stopped.current) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      const L = latest.current;
      const viewer = viewerRef.current;
      const tick = clock.tick(dt, L.playback?.quiet ?? null);
      if (tick.skipped) L.onSkipped(tick.skipped);
      if (viewer) {
        viewer.setTime(clock.t);
        viewer.frame();
        renderLabels();
        const p = perf.current;
        if (p.active) {
          p.frames++;
          p.ms += viewer.stats().frameMs;
          if (p.frames >= PERF_FRAMES) {
            const s = viewer.stats();
            p.active = false;
            clock.playing = false;
            (window as unknown as { __storePerf?: unknown }).__storePerf = { frameMs: p.ms / p.frames, drawCalls: s.drawCalls, triangles: s.triangles };
            document.title = "store:perf";
          }
        }
      }
      report(now);
    };
    raf = requestAnimationFrame(loop);

    const setMode = (mode: ViewMode) => {
      viewerRef.current?.setMode(mode);
      modeRef.current = mode;
      latest.current.onMode(mode);
      stage.classList.toggle("walking", mode === "walk");
    };

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      // A button reached by Tab activates on Space or Enter itself; toggling play on top of that would fire both.
      if (target && target.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
      if (e.metaKey || e.ctrlKey) return;
      const L = latest.current;
      const viewer = viewerRef.current;
      const horizon = clock.horizonEnd;
      // Walk mode owns WASD and the mouse; only Escape gets out of it.
      if (modeRef.current === "walk" && e.key !== "Escape") return;
      let handled = true;
      const stepMin = e.altKey ? 1440 : e.shiftKey ? 60 : 1;
      switch (e.key) {
        case " ":
          if (L.playback) {
            if (!clock.playing && clock.t >= horizon) clock.seek(0);
            clock.playing = !clock.playing;
          }
          break;
        case "ArrowLeft":
          clock.step(-stepMin);
          break;
        case "ArrowRight":
          clock.step(stepMin);
          break;
        case "Home":
          clock.seek(0);
          break;
        case "End":
          clock.seek(horizon);
          break;
        case ",":
          clock.speed = stepSpeed(clock.speed, -1);
          break;
        case ".":
          clock.speed = stepSpeed(clock.speed, 1);
          break;
        case "0":
          clock.skipQuiet = !clock.skipQuiet;
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          const p = CAMERA_PRESETS[Number(e.key) - 1];
          if (p && viewer) {
            viewer.setCamera(p);
            modeRef.current = "orbit";
            L.onMode("orbit");
            stage.classList.remove("walking");
          } else handled = false;
          break;
        }
        case "o":
        case "O":
          setMode("orbit");
          break;
        case "f":
        case "F": {
          const sel = L.selection;
          const track = sel?.kind === "entity" ? L.playback?.tracks.find((tr) => tr?.entity === sel.index) : null;
          if (sel?.kind === "entity" && track) {
            viewer?.follow(sel.index);
            modeRef.current = "follow";
            L.onMode("follow");
          } else handled = false;
          break;
        }
        case "w":
        case "W":
          setMode("walk");
          break;
        case "Escape":
          if (modeRef.current === "walk") setMode("orbit");
          L.onAction("escape");
          break;
        case "[":
          L.onAction("tickerPrev");
          break;
        case "]":
          L.onAction("tickerNext");
          break;
        case "l":
        case "L":
          L.onAction("toggleLabels");
          break;
        case "n":
        case "N":
          L.onAction("toggleNight");
          break;
        case "s":
        case "S":
          L.onAction("toggleShadows");
          break;
        case "h":
        case "H":
          L.onAction("toggleHud");
          break;
        case "m":
        case "M":
          L.onAction("toggleMinimap");
          break;
        case "?":
          L.onAction("toggleHelp");
          break;
        case "r":
        case "R":
          L.onAction("run");
          break;
        case "c":
        case "C":
          L.onAction("compare");
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        report(performance.now(), true);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      stopped.current = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      ro.disconnect();
      renderLabelsRef.current = () => {};
      reportRef.current = () => {};
      for (const el of labelPool.current) el.remove();
      labelPool.current = [];
      stage.classList.remove("walking");
    };
  }, []);

  // --- The viewer: one per playback, because it is built around the run it draws.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const clock = clockRef.current;
    if (!canvas || !stage || !clock) return;
    if (!playback || !world) {
      clock.horizonEnd = 0;
      clock.seek(0);
      clock.playing = false;
      latest.current.onClock(clockView(clock));
      return;
    }
    const L = latest.current;
    const shotMode = L.shot;
    const frameOnly = shotMode?.kind === "shot";
    const viewer = createViewer({
      canvas,
      playback,
      world,
      theme: L.theme,
      // A screenshot is a fixed frame: no sun angle, no shadows, nothing that depends on the minute it happens to be taken at.
      dayNight: frameOnly ? false : L.dayNight,
      shadows: frameOnly ? false : L.shadows,
      onPick: (p) => latest.current.onPick(p),
    });
    viewer.setLabels(L.labels);
    viewerRef.current = viewer;
    const r = stage.getBoundingClientRect();
    if (frameOnly) resizeAtDpr1(viewer, r.width, r.height);
    else viewer.resize(r.width, r.height);

    clock.horizonEnd = playback.meta.horizonEnd;
    // The link's minute applies to the first playback only; a re-run holds where the viewer was.
    if (!initialApplied.current) {
      initialApplied.current = true;
      clock.seek(L.initialT);
    } else clock.seek(clock.t);

    if (shotMode) clock.seek(shotMode.t);
    if (shotMode?.cam) viewer.setCamera(shotMode.cam);

    if (frameOnly) {
      clock.playing = false;
      viewer.setTime(clock.t);
      // Twice: the first frame resolves the seek and warms the instanced pools, the second is the one that is captured.
      viewer.frame();
      viewer.frame();
      renderLabelsRef.current();
      stopped.current = true;
      L.onClock(clockView(clock));
      document.title = "store:ready";
    } else {
      if (shotMode?.kind === "perf") {
        clock.speed = PERF_SPEED;
        perf.current = { frames: 0, ms: 0, active: true };
      }
      // A finished run plays.
      clock.playing = true;
      L.onClock(clockView(clock));
    }

    return () => {
      viewerRef.current = null;
      viewer.dispose();
      for (const el of labelPool.current) el.hidden = true;
    };
  }, [playback, world]);

  useEffect(() => {
    if (shot?.kind === "shot") return;
    viewerRef.current?.setLabels(labels);
  }, [labels, shot]);
  useEffect(() => {
    if (shot?.kind === "shot") return;
    viewerRef.current?.setDayNight(dayNight);
  }, [dayNight, shot]);
  useEffect(() => {
    if (shot?.kind === "shot") return;
    viewerRef.current?.setShadows(shadows);
  }, [shadows, shot]);
  useEffect(() => {
    viewerRef.current?.setTheme(theme);
  }, [theme]);

  useImperativeHandle(
    ref,
    (): StoreSceneHandle => {
      const clock = clockRef.current!;
      const push = () => reportRef.current(performance.now(), true);
      const setPlaying = (on: boolean) => {
        // Play at the end starts the run again.
        if (on && clock.horizonEnd > 0 && clock.t >= clock.horizonEnd) clock.seek(0);
        clock.playing = on && clock.horizonEnd > 0;
        push();
      };
      return {
        seek(t) {
          clock.seek(t);
          viewerRef.current?.setTime(clock.t);
          push();
        },
        setPlaying,
        togglePlay() {
          setPlaying(!clock.playing);
        },
        setSpeed(speed) {
          clock.speed = SPEEDS.includes(speed) ? speed : DEFAULT_SPEED;
          push();
        },
        setSkipQuiet(on) {
          clock.skipQuiet = on;
          push();
        },
        step(dMin) {
          clock.step(dMin);
          viewerRef.current?.setTime(clock.t);
          push();
        },
        preset(p) {
          viewerRef.current?.setCamera(p);
          modeRef.current = "orbit";
          stageRef.current?.classList.remove("walking");
          latest.current.onMode("orbit");
        },
        setMode(mode) {
          viewerRef.current?.setMode(mode);
          modeRef.current = mode;
          stageRef.current?.classList.toggle("walking", mode === "walk");
          latest.current.onMode(mode);
        },
        follow(entity) {
          viewerRef.current?.follow(entity);
          modeRef.current = entity === null ? "orbit" : "follow";
          stageRef.current?.classList.remove("walking");
          latest.current.onMode(modeRef.current);
        },
        clock: () => clockView(clock),
        stats: () => viewerRef.current?.stats() ?? null,
      };
    },
    []
  );

  /**
   * A click on a label pill. The renderer encodes what a pill belongs to in its
   * entity number: a queue chip is −1 − post, a shelf badge −100 − facing, and
   * anything non-negative is an actor.
   */
  const onLabelClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".store-label");
    if (!el || !playback || !world) return;
    const entity = Number(el.dataset.entity);
    if (!Number.isFinite(entity)) return;
    if (entity >= 0) {
      const def = playback.entities[entity];
      if (def) onPick({ kind: "entity", index: entity, id: def.id, label: def.label });
    } else if (isQueueChip(entity)) {
      const i = queueChipIndex(entity);
      const post = world.spec.service[i];
      if (post) onPick({ kind: "post", index: i, id: post.id, label: post.id });
    } else {
      const i = facingBadgeIndex(entity);
      const facing = world.facings[i];
      if (facing) onPick({ kind: "facing", index: i, id: facing.id, label: facing.id });
    }
  };

  return (
    <div ref={stageRef} className="store-stage-inner" style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvasRef} onContextMenu={(e) => e.preventDefault()} tabIndex={0} aria-label="3D view of the candy shop" />
      {/* The pills are a pointer shortcut to selections the ticker, the HUD and the minimap already reach from the keyboard, so the click handler needs no key handler of its own. */}
      <div ref={labelsRef} className="store-labels" onClick={onLabelClick} />
    </div>
  );
}
