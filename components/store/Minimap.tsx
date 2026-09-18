"use client";

import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { floorTransform } from "@/lib/render/floor";
import { actorsAt } from "@/lib/store-ui/describe";
import type { PickResult } from "@/lib/three/api";
import type { EntityKind, Playback, WorldPayload } from "@/lib/trace/types";

/** SVG units the plan is laid out in; the box it is drawn in is 220 px, and the viewBox scales between. */
const WIDTH = 320;

/** A dot per entity kind, matching the 3D scene's actor colours closely enough to read across from one to the other. */
const DOT_COLORS: Record<EntityKind, string> = {
  worker: "#1c7ed6",
  customer: "#c2255c",
  cart: "#0ca678",
  jack: "#f08c00",
  pallet: "#8b5e3c",
  van: "#d9480f",
  truck: "#2f9e44",
  car: "#868e96",
};

/** Vehicles read as vehicles at this size only if they are bigger than the people. */
const DOT_R: Partial<Record<EntityKind, number>> = { truck: 4.5, van: 4, car: 3.5 };

/** The fixture families, in the plan's own hues (app/globals.css defines the tokens). */
const FIXTURE_FILL: Record<string, string> = {
  gondola: "var(--gondola)",
  wall: "var(--wall)",
  endcap: "var(--endcap)",
  bulk: "var(--bulk)",
  showcase: "var(--showcase)",
  impulse: "var(--impulse)",
  seasonal: "var(--seasonal)",
};

const DOOR_STROKE: Record<string, string> = { entrance: "var(--entrance)", dock: "var(--dock)", ground: "var(--ground)" };

interface Props {
  world: WorldPayload;
  playback: Playback | null;
  t: number;
  selection: PickResult | null;
  /** A click that hit no actor, in engine feet: the workbench opens whatever fixture is there. */
  onFloorClick: (x: number, y: number) => void;
  onSelect: (entity: number) => void;
}

/**
 * The shop from above, with everybody on it.
 *
 * The plan is drawn here rather than taken from `lib/render/floor.ts`, whose
 * output carries a title strip, a legend and a scale bar that would swamp a
 * 220 px box. What it does share is that renderer's `floorTransform`, so feet
 * map to pixels by exactly the same rule and `toFeet` inverts a click without
 * this file knowing anything about the frame.
 *
 * A click within a few pixels of a dot selects that actor; anywhere else hands
 * the spot in engine feet to the workbench, which opens the shelf standing
 * there.
 */
export default function Minimap({ world, playback, t, selection, onFloorClick, onSelect }: Props) {
  const spec = world.spec;
  const tf = useMemo(() => floorTransform(spec, { width: WIDTH }), [spec]);
  const dots = useMemo(() => (playback ? actorsAt(playback, t) : []), [playback, t]);
  const selected = selection?.kind === "entity" ? selection.index : -1;
  // The plan without the renderer's header and legend strips.
  const plotTop = tf.headerHeight;
  const plotH = tf.height - tf.headerHeight - tf.legendHeight;

  const at = (e: MouseEvent<HTMLDivElement>): [px: number, py: number] | null => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return [((e.clientX - box.left) / box.width) * tf.width, plotTop + ((e.clientY - box.top) / box.height) * plotH];
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const p = at(e);
    if (!p) return;
    const [px, py] = p;
    const box = e.currentTarget.getBoundingClientRect();
    // Seven screen pixels, expressed in the viewBox's units.
    let bestD = 7 * (tf.width / box.width);
    let best = -1;
    for (const d of dots) {
      const dist = Math.hypot(tf.X(d.x) - px, tf.Y(d.y) - py);
      if (dist < bestD) {
        bestD = dist;
        best = d.entity;
      }
    }
    if (best >= 0) onSelect(best);
    else {
      const [x, y] = tf.toFeet(px, py);
      onFloorClick(x, y);
    }
  };

  // A keyboard cannot point at a spot on a plan, so Enter does what clicking the middle of the sales floor does.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onFloorClick(spec.widthFt / 2, spec.backroomY / 2);
  };

  return (
    <div className="store-overlay store-minimap" title="Click a dot to select who it is; click the floor to open the shelf there">
      <div className="wrap" role="button" tabIndex={0} aria-label="Shop plan: click a dot to select who is standing there, click the floor to open the shelf there; Enter opens the middle of the sales floor" onClick={onClick} onKeyDown={onKeyDown}>
        <svg viewBox={`0 ${plotTop} ${tf.width} ${plotH}`} aria-hidden="true">
          {spec.parking.depthFt > 0 && <rect x={tf.X(0)} y={tf.Y(0)} width={tf.X(spec.widthFt) - tf.X(0)} height={tf.Y(-spec.parking.depthFt) - tf.Y(0)} fill="var(--code-bg)" />}
          <rect x={tf.X(0)} y={tf.Y(spec.depthFt)} width={tf.X(spec.widthFt) - tf.X(0)} height={tf.Y(0) - tf.Y(spec.depthFt)} fill="var(--panel)" stroke="var(--line)" strokeWidth={1} />
          <line x1={tf.X(0)} y1={tf.Y(spec.backroomY)} x2={tf.X(spec.widthFt)} y2={tf.Y(spec.backroomY)} stroke="var(--line)" strokeWidth={1} strokeDasharray="3 2" />
          {spec.storage.map((r) => (
            <rect key={r.id} x={tf.X(r.x - r.depthFt / 2)} y={tf.Y(r.y1)} width={Math.max(1.5, tf.X(r.x + r.depthFt / 2) - tf.X(r.x - r.depthFt / 2))} height={Math.max(1.5, tf.Y(r.y0) - tf.Y(r.y1))} fill="var(--rack)" />
          ))}
          {spec.fixtures.map((f) => (
            <rect key={f.id} x={tf.X(f.x - f.depthFt / 2)} y={tf.Y(f.y1)} width={Math.max(1.5, tf.X(f.x + f.depthFt / 2) - tf.X(f.x - f.depthFt / 2))} height={Math.max(1.5, tf.Y(f.y0) - tf.Y(f.y1))} fill={FIXTURE_FILL[f.kind] ?? "var(--gondola)"} />
          ))}
          {spec.service.map((s) => (
            <rect key={s.id} x={tf.X(s.x) - 2} y={tf.Y(s.y) - 2} width={4} height={4} fill="var(--text)" opacity={0.55} />
          ))}
          {spec.doors.map((d) => (
            <line key={d.id} x1={tf.X(d.x - d.widthFt / 2)} y1={tf.Y(d.y)} x2={tf.X(d.x + d.widthFt / 2)} y2={tf.Y(d.y)} stroke={DOOR_STROKE[d.kind] ?? "var(--line)"} strokeWidth={3} strokeLinecap="round" />
          ))}
        </svg>
        <svg className="dots" viewBox={`0 ${plotTop} ${tf.width} ${plotH}`} aria-hidden="true">
          {dots.map((d) => (
            <circle key={d.entity} cx={tf.X(d.x)} cy={tf.Y(d.y)} r={DOT_R[d.kind] ?? 3} fill={DOT_COLORS[d.kind] ?? "#888"} stroke={d.entity === selected ? "#ffd43b" : "#fff"} strokeWidth={d.entity === selected ? 2 : 0.8} />
          ))}
        </svg>
      </div>
    </div>
  );
}
