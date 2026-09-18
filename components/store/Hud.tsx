"use client";

import { useMemo } from "react";
import { clockLabel, dayOf } from "@/lib/store-ui/clock";
import type { EventIndex } from "@/lib/store-ui/describe";
import { compactMoney, count, minutes, money, percent } from "@/lib/store-ui/format";
import type { Playback, RunningKpis, WorldPayload } from "@/lib/trace/types";
import type { Kpis } from "@/lib/twin/replicate";
import { PROCESSES, type Process } from "@/lib/twin/types";

export interface HudSnapshot {
  kpis: Kpis;
  running: RunningKpis;
  /** At the horizon: the posted kpis(result), with orders still open counted late. */
  final: boolean;
  /** Per process: jobs a free, qualified worker cannot start because the register, the counter, a cart or a door is taken. */
  held: number[];
}

interface Props {
  world: WorldPayload;
  playback: Playback;
  index: EventIndex;
  snapshot: HudSnapshot;
  t: number;
  /** Everything behind "More": the full grid, the queues and today's deliveries. */
  expanded: boolean;
  onToggle: () => void;
  onSelectQueue: (p: Process) => void;
  onSelectEntity: (entity: number) => void;
  onSeek: (t: number) => void;
}

interface TileSpec {
  v: string;
  l: string;
  cls?: string;
}

const CHECKOUT = PROCESSES.indexOf("checkout");
const SERVE = PROCESSES.indexOf("serve");

/** The first HEADLINE tiles make the compact strip: what the shop took, who is in it, who is waiting, what it lost, who is on. */
const HEADLINE = 7;

/**
 * The tiles in display order. Every value is the engine's own accounting at the
 * minute on the clock — nothing here is read off the picture.
 *
 * The thresholds are a shopkeeper's, not a statistician's: three minutes at a
 * till and four at the glass are where a queue starts costing baskets, and a
 * shelf below 95% on-shelf is already losing sales it will never see.
 */
function tiles(kpis: Kpis, running: RunningKpis): TileSpec[] {
  const tillQ = running.queues[CHECKOUT] ?? 0;
  const glassQ = running.queues[SERVE] ?? 0;
  const lost = kpis.lostShelfDollars + kpis.lostQueueDollars;
  return [
    { v: compactMoney(kpis.salesDollars), l: "taken" },
    { v: count(running.inStore), l: "in the shop" },
    { v: String(tillQ), l: "at the tills", cls: tillQ > 8 ? "bad" : tillQ > 4 ? "warn" : "" },
    { v: String(glassQ), l: "at the glass", cls: glassQ > 6 ? "bad" : glassQ > 3 ? "warn" : "" },
    { v: percent(kpis.onShelfShare, 1), l: "on the shelf", cls: kpis.onShelfShare < 0.9 ? "bad" : kpis.onShelfShare < 0.95 ? "warn" : "" },
    { v: compactMoney(lost), l: `lost (${percent(kpis.lostSalesShare, 0)})`, cls: kpis.lostSalesShare > 0.25 ? "bad" : kpis.lostSalesShare > 0.15 ? "warn" : "" },
    { v: `${running.presentWorkers} / ${running.busyWorkers}`, l: "on shift / busy" },

    { v: count(kpis.customers), l: "customers" },
    { v: count(kpis.transactions), l: "transactions" },
    { v: money(kpis.averageBasket, 2), l: "average basket" },
    { v: count(kpis.abandoned), l: "walked out", cls: kpis.abandoned > 0 ? "warn" : "" },
    { v: running.registerWaitN ? minutes(kpis.registerWaitAvgMin) : "–", l: "till wait", cls: kpis.registerWaitAvgMin > 6 ? "bad" : kpis.registerWaitAvgMin > 3 ? "warn" : "" },
    { v: running.counterWaitN ? minutes(kpis.counterWaitAvgMin) : "–", l: "glass wait", cls: kpis.counterWaitAvgMin > 8 ? "bad" : kpis.counterWaitAvgMin > 4 ? "warn" : "" },
    { v: count(kpis.shortAtShelf), l: "shelf came up short", cls: kpis.shortAtShelf > 0 ? "warn" : "" },
    { v: `${count(kpis.restocks)}${kpis.hotRestocks ? ` (${kpis.hotRestocks} hot)` : ""}`, l: "restocks", cls: kpis.hotRestocks > 0 ? "warn" : "" },
    { v: `${count(kpis.ordersPlaced - kpis.ordersLate)} / ${count(kpis.ordersPlaced)}`, l: "orders on time", cls: kpis.ordersLate > 0 ? "bad" : "" },
    { v: `${count(kpis.vanRounds)}${kpis.vanLateRounds ? ` (${kpis.vanLateRounds} late)` : ""}`, l: "van rounds", cls: kpis.vanLateRounds > 0 ? "warn" : "" },
    { v: count(kpis.giftWraps), l: "gifts wrapped" },
    { v: count(kpis.inboundCases), l: "cases in" },
    { v: running.dockToStockN ? minutes(kpis.dockToStockAvgMin) : "–", l: "dock to shelf" },
    { v: count(kpis.paidHours, 1), l: "paid hours" },
    { v: count(kpis.overtimeHours, 1), l: "overtime h", cls: kpis.overtimeHours > 0 ? "warn" : "" },
    { v: percent(kpis.utilization), l: "utilization" },
    { v: compactMoney(kpis.laborCost), l: "labour cost" },
  ];
}

/** How far along a delivery is at t, and what to call it. The stages are the order the events can only happen in. */
export function deliveryStageAt(index: EventIndex, po: string, t: number): { stage: number; label: string } {
  const r = index.po.get(po);
  if (!r?.scheduled) return { stage: 0, label: "due" };
  if (r.putaways.some((p) => p.t <= t)) {
    const done = r.putaways.filter((p) => p.t <= t).length;
    return { stage: 5, label: done >= r.putaways.length ? "put away" : `${done} of ${r.putaways.length} away` };
  }
  if (r.undock && r.undock.t <= t) return { stage: 4, label: "unloaded" };
  if (r.dock && r.dock.t <= t) return { stage: 3, label: r.dock.door ? `on ${r.dock.door}` : "unloading" };
  if (r.arrive && r.arrive.t <= t) return { stage: 2, label: "waiting for a door" };
  return { stage: 1, label: `ETA ${clockLabel(r.scheduled.eta)}` };
}

/** Where a special order has got to at t. `cls` is the pill colour: on the way is blue, done is green, late is red. */
export function orderStateAt(index: EventIndex, order: string, t: number): { text: string; cls: string } {
  const r = index.order.get(order);
  if (!r?.placed) return { text: "unknown", cls: "" };
  if (r.collected && r.collected.t <= t) return { text: r.collected.lateMin > 0 ? `collected ${minutes(r.collected.lateMin)} late` : "collected", cls: r.collected.lateMin > 0 ? "bad" : "good" };
  if (r.departed && r.departed.t <= t) return { text: "out for delivery", cls: "on" };
  if (r.loaded && r.loaded.t <= t) return { text: "on the van", cls: "on" };
  if (r.packed && r.packed.t <= t) return { text: r.packed.wrap ? "packed and wrapped" : "packed", cls: "on" };
  if (r.picked && r.picked.t <= t) return { text: "picked", cls: "on" };
  if (r.late && r.late.t <= t) return { text: `late: ${r.late.reason === "notPicked" ? "not picked" : r.late.reason === "notPacked" ? "not packed" : "not loaded"}`, cls: "bad" };
  if (r.cut && r.cut.t <= t) return { text: `${r.cut.lines} line(s) cut`, cls: "warn" };
  return { text: `due ${clockLabel(r.placed.dueMin)}`, cls: "" };
}

/**
 * The headline numbers over the stage.
 *
 * Compact is the seven tiles plus a queue sparkline; "More" opens every figure,
 * the ten process queues and the day's deliveries in and orders out. Below
 * 1000 px the workbench renders the same component as a block under the stage
 * rather than floating it over the building.
 */
export default function Hud({ world, playback, index, snapshot, t, expanded, onToggle, onSelectQueue, onSelectEntity, onSeek }: Props) {
  const { kpis, running, final, held } = snapshot;
  const day = dayOf(t);
  const maxQueue = Math.max(4, ...running.queues);
  const waiting = running.queues.reduce((a, b) => a + b, 0);
  const all = tiles(kpis, running);

  // Entity ids are unique inside a kind, so one pass per playback answers every "which truck is this PO?" lookup.
  const entityOf = useMemo(() => {
    const m = new Map<string, number>();
    playback.entities.forEach((e, i) => m.set(`${e.kind}:${e.id}`, i));
    return m;
  }, [playback]);

  const today = useMemo(() => {
    const supplierName = new Map(world.suppliers.map((s) => [s.id, s.name]));
    const deliveries: Array<{ key: string; name: string; label: string; stage: number; at: number; entity: number }> = [];
    for (const [po, r] of index.po) {
      if (!r.scheduled || dayOf(r.scheduled.eta) !== day) continue;
      const stage = deliveryStageAt(index, po, t);
      deliveries.push({ key: po, name: supplierName.get(r.scheduled.supplier) ?? r.scheduled.supplier, label: stage.label, stage: stage.stage, at: r.scheduled.eta, entity: entityOf.get(`truck:${po}`) ?? -1 });
    }
    deliveries.sort((a, b) => a.at - b.at);

    const out: Array<{ key: string; name: string; text: string; cls: string; at: number }> = [];
    for (const [id, r] of index.order) {
      if (!r.placed || r.placed.dueDay !== day) continue;
      const state = orderStateAt(index, id, t);
      out.push({ key: id, name: `${r.placed.kind === "delivery" ? "→" : "⌂"} ${id}`, text: state.text, cls: state.cls, at: r.placed.dueMin });
    }
    out.sort((a, b) => a.at - b.at);
    // The panel is 160 px tall; past a dozen rows it is a list nobody reads.
    return { deliveries, out: out.slice(0, 12), outTotal: out.length };
  }, [world, index, entityOf, day, t]);

  const heading = `${final ? "Run totals" : "So far"} · ${count(kpis.customers)} customer${kpis.customers === 1 ? "" : "s"}`;

  if (!expanded) {
    return (
      <div className="store-overlay store-hud compact" role="region" aria-label="Key figures">
        <div className="store-tiles">
          {all.slice(0, HEADLINE).map((s) => (
            <Tile key={s.l} v={s.v} l={s.l} cls={s.cls} />
          ))}
          <button type="button" className="store-qmini" onClick={onToggle} title={`${waiting} job${waiting === 1 ? "" : "s"} waiting: ${PROCESSES.map((p, i) => `${running.queues[i] ?? 0} ${p}`).join(", ")}`}>
            <span className="bars" aria-hidden="true">
              {PROCESSES.map((p, i) => (
                <i key={p} style={{ height: `${Math.max(2, (14 * (running.queues[i] ?? 0)) / maxQueue)}px` }} />
              ))}
            </span>
            <b>{waiting}</b>
            <span>waiting</span>
          </button>
        </div>
        <button type="button" className="store-hud-more" onClick={onToggle} title={`${heading}: every figure, the queues and today's deliveries`} aria-expanded={false}>
          More ▾
        </button>
      </div>
    );
  }

  return (
    <div className="store-overlay store-hud expanded" role="region" aria-label="Key figures">
      <div className="store-hud-head">
        <h4>{heading}</h4>
        <button type="button" className="store-hud-more" onClick={onToggle} aria-expanded={true} title="Back to the headline tiles (Esc)">
          Less ▴
        </button>
      </div>
      <div className="store-tiles">
        {all.map((s) => (
          <Tile key={s.l} v={s.v} l={s.l} cls={s.cls} />
        ))}
      </div>
      <div className="store-hud-cols">
        <div>
          <h4>Queues</h4>
          <div className="store-queues">
            {PROCESSES.map((p, i) => {
              const n = running.queues[i] ?? 0;
              const h = Math.min(n, held[i] ?? 0);
              return (
                <button type="button" className="store-queue" key={p} onClick={() => onSelectQueue(p)} title={`${n} ${p} job${n === 1 ? "" : "s"} waiting${h ? `, ${h} held because the till, the counter or a cart is taken` : ""}`}>
                  <span>{p}</span>
                  <span className="bar">
                    <i style={{ width: `${(100 * n) / maxQueue}%` }} />
                    {h > 0 && <i className="held" style={{ width: `${(100 * h) / maxQueue}%` }} />}
                  </span>
                  <em>{n}</em>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <h4>Day {day + 1}</h4>
          <div className="store-today">
            {today.deliveries.length === 0 && <span className="sub">No deliveries due today.</span>}
            {today.deliveries.map((d) => (
              <button type="button" className="row" key={d.key} onClick={() => (d.entity >= 0 ? onSelectEntity(d.entity) : onSeek(d.at))} title={`${d.key} from ${d.name}${d.entity >= 0 ? ": select the truck" : ": seek to its appointment"}`}>
                <span className="name">▲ {d.name}</span>
                <span className={`store-status ${d.stage >= 5 ? "good" : d.stage >= 2 ? "on" : ""}`}>{d.label}</span>
              </button>
            ))}
            {today.out.length === 0 && <span className="sub">No special orders due today.</span>}
            {today.out.map((o) => (
              <button type="button" className="row" key={o.key} onClick={() => onSeek(o.at)} title={`${o.key}: seek to when it was promised`}>
                <span className="name">{o.name}</span>
                <span className={`store-status ${o.cls}`}>{o.text}</span>
              </button>
            ))}
            {today.outTotal > today.out.length && <span className="sub">and {today.outTotal - today.out.length} more orders.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ v, l, cls = "" }: { v: string; l: string; cls?: string }) {
  return (
    <div className={`store-tile ${cls}`}>
      <b>{v}</b>
      <span>{l}</span>
    </div>
  );
}
