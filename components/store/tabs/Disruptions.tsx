"use client";

import { NumField, RowList, type Column, type PosOutageRow, type SpanRow, type TabProps } from "../ScenarioPanel";

/** Every outage but the till network is the same shape: a window of horizon days, and how many of the thing are out. */
const spanCols: Array<Column<SpanRow>> = [
  { key: "fromDay", label: "from day", type: "number", min: 0 },
  { key: "toDay", label: "to day", type: "number", min: 0 },
  { key: "count", label: "how many out", type: "number", min: 1, max: 10, placeholder: "1" },
];

const posCols: Array<Column<PosOutageRow>> = [
  { key: "day", label: "day", type: "number", min: 0 },
  { key: "start", label: "from", type: "time" },
  { key: "hours", label: "hours", type: "number", min: 0.25, max: 24, placeholder: "1.5" },
];

/**
 * The things that break.
 *
 * A shop's outages are not a warehouse's. A register out shortens the lane
 * count while the queue keeps arriving; a counter station out closes half the
 * glass; a dock out sends the trailer round to the roll-up or leaves it on the
 * drive; a van out turns every delivery order into a collection. The till
 * network going down is the worst of them, because nothing can be rung up at
 * all and every queue in the shop stalls at once.
 */
export default function Disruptions({ form, update, errors }: TabProps) {
  const set = <K extends keyof typeof form>(key: K, v: (typeof form)[K]) => update((f) => ({ ...f, [key]: v }));
  const blank: SpanRow = { fromDay: "", toDay: "", count: "" };
  return (
    <>
      <p className="sub">Days count from 0, the Monday of the start week, and both ends are included.</p>
      <RowList title="Registers out" rows={form.registerOutages} onChange={(rows) => set("registerOutages", rows)} blank={blank} columns={spanCols} errors={errors} prefix="registerOutages" max={20} addLabel="Close a till" />
      <RowList title="Counter stations out" rows={form.counterOutages} onChange={(rows) => set("counterOutages", rows)} blank={blank} columns={spanCols} errors={errors} prefix="counterOutages" max={20} addLabel="Close a station" />
      <RowList title="Goods doors out" rows={form.dockOutages} onChange={(rows) => set("dockOutages", rows)} blank={blank} columns={spanCols} errors={errors} prefix="dockOutages" max={20} addLabel="Close a dock" help="Trailers wait on the service drive for whatever door is left." />
      <RowList title="Vans off the road" rows={form.vanOutages} onChange={(rows) => set("vanOutages", rows)} blank={blank} columns={spanCols} errors={errors} prefix="vanOutages" max={20} addLabel="Break a van" help="Delivery orders with no van become collections." />
      <RowList title="Till network down" rows={form.posOutages} onChange={(rows) => set("posOutages", rows)} blank={{ day: "", start: "", hours: "" }} columns={posCols} errors={errors} prefix="posOutages" max={20} addLabel="Drop the network" help="Nothing can be rung up: every queue in the shop stalls until it comes back." />

      <h3>Deliveries</h3>
      <div className="store-fields">
        <NumField label="Arrival lateness sd, min" value={form.inboundLatenessSdMin} onChange={(v) => set("inboundLatenessSdMin", v)} error={errors.inboundLatenessSdMin} placeholder="model's own" min={0} max={180} help="How far off its appointment a delivery typically runs. Raise it to see what an unreliable trailer does to the morning fill." />
      </div>
    </>
  );
}
