"use client";

import { ROLES, ROLE_KEYS } from "@/lib/twin/roles";
import { SKILLS } from "@/lib/twin/types";
import { NumField, RowList, SelectField, type AddWorkerRow, type Column, type CrossTrainRow, type LeaveRow, type ShiftRow, type TabProps, type WorkerOverrideRow, type WorkerRow } from "../ScenarioPanel";

const ROLE_OPTIONS = ROLE_KEYS.map((k) => ({ value: k, label: ROLES[k].role }));
const SKILL_OPTIONS = SKILLS.map((s) => ({ value: s, label: s }));
const TYPE_OPTIONS = [
  { value: "full-time", label: "full-time" },
  { value: "part-time", label: "part-time" },
  { value: "temp", label: "temp" },
];

const shiftCols: Array<Column<ShiftRow>> = [
  { key: "id", label: "id", type: "text", placeholder: "open", list: "store-shifts" },
  { key: "start", label: "start", type: "time" },
  { key: "end", label: "end", type: "time" },
  { key: "breakMin", label: "break", type: "number", min: 0, max: 120, placeholder: "30" },
  { key: "indirectMin", label: "indirect", type: "number", min: 0, max: 180, placeholder: "30" },
];

const addCols: Array<Column<AddWorkerRow>> = [
  { key: "role", label: "role", type: "select", options: ROLE_OPTIONS },
  { key: "shift", label: "shift", type: "text", list: "store-shifts", placeholder: "open" },
  { key: "type", label: "type", type: "select", options: TYPE_OPTIONS },
  { key: "count", label: "how many", type: "number", min: 1, max: 20, placeholder: "1" },
];

const removeCols: Array<Column<WorkerRow>> = [{ key: "worker", label: "worker id", type: "text", list: "store-workers", placeholder: "w-012" }];

const trainCols: Array<Column<CrossTrainRow>> = [
  { key: "worker", label: "worker", type: "text", list: "store-workers", placeholder: "one worker" },
  { key: "role", label: "or every", type: "text", list: "store-roles", placeholder: "role" },
  { key: "skill", label: "learns", type: "select", options: SKILL_OPTIONS },
];

const leaveCols: Array<Column<LeaveRow>> = [
  { key: "fromDay", label: "from day", type: "number", min: 0 },
  { key: "toDay", label: "to day", type: "number", min: 0 },
  { key: "worker", label: "worker", type: "text", list: "store-workers", placeholder: "one worker" },
  { key: "role", label: "or role", type: "text", list: "store-roles", placeholder: "role" },
  { key: "count", label: "how many", type: "number", min: 1, max: 20, placeholder: "1" },
];

const overrideCols: Array<Column<WorkerOverrideRow>> = [
  { key: "worker", label: "worker", type: "text", list: "store-workers" },
  { key: "productivity", label: "productivity", type: "number", min: 0.4, max: 2, placeholder: "1" },
  { key: "maxWeeklyHours", label: "max h/wk", type: "number", min: 0, max: 60 },
  { key: "hourlyRate", label: "$/h", type: "number", min: 0, max: 200 },
];

/**
 * The crew, the shifts they work and who can do what.
 *
 * Cross-training is the lever that matters most in a small shop: the counter
 * needs a food handler's card and the van needs a licence and the insurance, so
 * those two gaps cannot be closed by hiring a temp — only by training somebody
 * who is already here, which is what this tab does.
 */
export default function People({ form, update, errors, ctx }: TabProps) {
  const set = <K extends keyof typeof form>(key: K, v: (typeof form)[K]) => update((f) => ({ ...f, [key]: v }));
  return (
    <>
      <h3>Attendance and flexing</h3>
      <div className="store-fields">
        <NumField label="Absenteeism" value={form.absenteeism} onChange={(v) => set("absenteeism", v)} error={errors.absenteeism} placeholder="roster's own" min={0} max={0.5} step={0.01} help="Share of shifts somebody does not turn up for." />
        <SelectField
          label="Flexing"
          value={form.flex}
          onChange={(v) => set("flex", v)}
          error={errors.flex}
          options={[
            { value: "", label: "leave as it is" },
            { value: "on", label: "on: take work outside your primary" },
            { value: "off", label: "off: stay in your own queue" },
          ]}
          help="A stocker whose own queue is empty walking to an open till. Off is a shop that will not do that."
        />
        <NumField label="Overtime cap" value={form.overtimeMaxHours} onChange={(v) => set("overtimeMaxHours", v)} error={errors.overtimeMaxHours} placeholder="0" min={0} max={6} step={0.5} help="Hours past a shift anybody may be kept." />
        <NumField label="Target utilization" value={form.targetUtilization} onChange={(v) => set("targetUtilization", v)} error={errors.targetUtilization} placeholder="0.85" min={0.5} max={1} step={0.05} help="How hard the roster is planned to run; the schedule builder buys cover against this." />
      </div>

      <h3>Crew</h3>
      <RowList title="Hire" rows={form.addWorkers} onChange={(rows) => set("addWorkers", rows)} blank={{ role: "", shift: "", type: "", count: "" }} columns={addCols} errors={errors} prefix="addWorkers" max={10} addLabel="Add people" help="A temp is never counter- or driving-qualified: a card and the insurance take longer than a season." />
      <RowList title="Remove" rows={form.removeWorkers} onChange={(rows) => set("removeWorkers", rows)} blank={{ worker: "" }} columns={removeCols} errors={errors} prefix="removeWorkers" max={20} addLabel="Remove somebody" help={`${ctx.workerIds.length || "–"} workers on this shop's roster.`} />
      <RowList title="Cross-train" rows={form.crossTrain} onChange={(rows) => set("crossTrain", rows)} blank={{ worker: "", role: "", skill: "" }} columns={trainCols} errors={errors} prefix="crossTrain" max={20} addLabel="Train somebody" help="Name a worker, or a role to train everybody in it." />
      <RowList title="Leave and no-shows" rows={form.workerLeave} onChange={(rows) => set("workerLeave", rows)} blank={{ fromDay: "", toDay: "", worker: "", role: "", count: "" }} columns={leaveCols} errors={errors} prefix="workerLeave" max={20} addLabel="Take somebody out" help="Days count from 0. One named worker, or any N of a role — which is how you find the single point of failure." />
      <RowList title="Per-worker overrides" rows={form.workerOverrides} onChange={(rows) => set("workerOverrides", rows)} blank={{ worker: "", productivity: "", maxWeeklyHours: "", hourlyRate: "" }} columns={overrideCols} errors={errors} prefix="workerOverrides" max={40} addLabel="Override somebody" />

      <h3>Shifts</h3>
      <RowList title="Shifts" rows={form.shifts} onChange={(rows) => set("shifts", rows)} blank={{ id: "", start: "", end: "", breakMin: "", indirectMin: "" }} columns={shiftCols} errors={errors} prefix="shifts" max={4} addLabel="Add a shift" help={`Replaces the shop's own shifts outright — list all of them, not just the one you are changing. As it stands: ${ctx.shiftIds.join(", ") || "–"}.`} />
    </>
  );
}
