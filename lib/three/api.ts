/**
 * The renderer's contract with the React page. `lib/three/viewer.ts`
 * implements it; the page is the only React code that calls it.
 *
 * Everything in this file except the last line is a type or a plain constant,
 * so a component can `import type { Viewer, PickResult } from "./api"` and
 * compile, and be tested, without WebGL ever loading. `createViewer` is
 * re-exported from viewer.ts rather than defined here, which is the one
 * import that does pull three in — the page takes it only where it actually
 * builds a scene.
 */

import type { Playback, WorldPayload } from "../trace/types";

/**
 * The seven places people look at a shop. `overview` is above the lot looking
 * at the shopfront, `front` is eye level at the entrance, `aisle` looks down a
 * gondola aisle, `counter` stands at the showcase glass, `stockroom` is over
 * the racking, `dock` is out on the service drive and `lot` is over the
 * customer parking.
 */
export type CameraPreset = "overview" | "front" | "aisle" | "counter" | "stockroom" | "dock" | "lot";

export const CAMERA_PRESETS: CameraPreset[] = ["overview", "front", "aisle", "counter", "stockroom", "dock", "lot"];

export type ViewMode = "orbit" | "follow" | "walk";

/**
 * What a ray hit, named in the page's vocabulary. `index` addresses the array
 * the kind names — `facing` and `storage` index `WorldPayload.facings` and
 * `.storage`, `fixture` indexes `spec.fixtures`, `door` indexes `spec.doors`
 * (and `World.frames`, same order), `post` indexes `World.posts`, `stall`
 * indexes `World.lot.stalls`, and `entity` indexes `Playback.entities`.
 */
export interface PickResult {
  kind: "facing" | "fixture" | "storage" | "entity" | "door" | "post" | "stall";
  index: number;
  id: string;
  label: string;
}

export interface ViewerStats {
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  playback: Playback;
  world: WorldPayload;
  theme?: "light" | "dark";
  /** Sun, sky and shop lights follow the simulated clock; off pins everything at noon with the lights on. */
  dayNight?: boolean;
  shadows?: boolean;
  onPick?: (p: PickResult | null) => void;
}

export interface Viewer {
  /** The simulated minute the next frame() draws. */
  setTime(t: number): void;
  /** Sample, apply and render one frame. */
  frame(): void;
  resize(w: number, h: number): void;
  setCamera(preset: CameraPreset): void;
  setMode(mode: ViewMode): void;
  /** Chase an entity index in follow mode; null drops back to the last orbit view. */
  follow(entity: number | null): void;
  setTheme(theme: "light" | "dark"): void;
  setDayNight(on: boolean): void;
  setShadows(on: boolean): void;
  setLabels(on: boolean): void;
  /** Ray-cast at a pointer event's client coordinates. */
  pickAt(clientX: number, clientY: number): PickResult | null;
  /** Screen anchors for the DOM label overlay, valid until the next frame(). */
  labels(): Array<{ x: number; y: number; text: string; kind: string; entity: number }>;
  stats(): ViewerStats;
  /** Frees the renderer, the controls, every geometry and material, and the listeners; safe to call twice. */
  dispose(): void;
}

export { createViewer } from "./viewer";
