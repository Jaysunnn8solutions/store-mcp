"use client";

import type { ReactNode } from "react";
// Relative, not the "@/" alias: components/store/focus.test.ts imports this
// module for the form round trip, and vitest resolves neither tsconfig paths
// nor Next's alias.
import { WEEKDAYS } from "../../lib/twin/standards";
import { scenarioSchema } from "../../lib/twin/twin";

// ---------------------------------------------------------------------------
// The form: every field a string, every parse in one place
// ---------------------------------------------------------------------------

/**
 * The scenario as the panel holds it.
 *
 * Every field is a string and every row list is an array of all-string records,
 * because a half-typed number is a legal thing to have in a text box and an
 * illegal thing to have in a `TwinScenario`. `formToScenario` is the only place
 * a string becomes a number, and `scenarioSchema` — the same schema the MCP
 * tools validate against — is the only thing that decides whether the result is
 * a scenario. That is why the five tab files are as short as they are: they
 * hold strings and nothing else.
 *
 * A blank field means "leave the shop as it is", never zero.
 */
export interface StoreForm {
  // Trade
  demandScale: string;
  demandShocks: ShockRow[];
  specialShare: string;
  deliveryShare: string;
  patience: string;
  hours: HoursRow[];
  operatingDays: number[];
  orderCutoff: string;
  pickStart: string;
  vanDeparture: string;
  vanSecondDeparture: string;

  // People
  shifts: ShiftRow[];
  addWorkers: AddWorkerRow[];
  removeWorkers: WorkerRow[];
  crossTrain: CrossTrainRow[];
  workerLeave: LeaveRow[];
  workerOverrides: WorkerOverrideRow[];
  absenteeism: string;
  flex: string;
  overtimeMaxHours: string;
  targetUtilization: string;

  // Stock
  forecast: string;
  serviceLevel: string;
  supplierDelays: SupplierDelayRow[];
  supplierOverrides: SupplierOverrideRow[];
  dcDeliveryDays: number[];
  overnightFrom: string;
  overnightTo: string;
  directFrom: string;
  directTo: string;

  // Floor
  merchandising: string;
  facingDays: string;
  registers: string;
  counters: string;
  palletJacks: string;
  stockCarts: string;
  vans: string;
  docks: string;
  groundDoors: string;
  runs: string;
  baysPerRun: string;
  shelves: string;
  facingsPerBay: string;
  aisleWidthFt: string;

  // Disruptions
  registerOutages: SpanRow[];
  counterOutages: SpanRow[];
  dockOutages: SpanRow[];
  vanOutages: SpanRow[];
  posOutages: PosOutageRow[];
  inboundLatenessSdMin: string;
}

export interface ShockRow {
  fromDay: string;
  toDay: string;
  factor: string;
  category: string;
}
export interface HoursRow {
  day: string;
  open: string;
  close: string;
}
export interface ShiftRow {
  id: string;
  start: string;
  end: string;
  breakMin: string;
  indirectMin: string;
}
export interface AddWorkerRow {
  role: string;
  shift: string;
  type: string;
  count: string;
}
export interface WorkerRow {
  worker: string;
}
export interface CrossTrainRow {
  worker: string;
  role: string;
  skill: string;
}
export interface LeaveRow {
  fromDay: string;
  toDay: string;
  worker: string;
  role: string;
  count: string;
}
export interface WorkerOverrideRow {
  worker: string;
  productivity: string;
  maxWeeklyHours: string;
  hourlyRate: string;
}
export interface SupplierDelayRow {
  fromDay: string;
  toDay: string;
  supplier: string;
  category: string;
  extraDays: string;
}
export interface SupplierOverrideRow {
  supplier: string;
  leadDays: string;
  leadSdDays: string;
  orderDay: string;
  channel: string;
}
export interface SpanRow {
  fromDay: string;
  toDay: string;
  count: string;
}
export interface PosOutageRow {
  day: string;
  start: string;
  hours: string;
}

/** Keyed by field path; `""` is a message about the scenario as a whole. Row cells are `"<prefix>.<i>.<column>"`. */
export type FormErrors = Record<string, string>;

export function emptyForm(): StoreForm {
  return {
    demandScale: "",
    demandShocks: [],
    specialShare: "",
    deliveryShare: "",
    patience: "",
    hours: [],
    operatingDays: [],
    orderCutoff: "",
    pickStart: "",
    vanDeparture: "",
    vanSecondDeparture: "",

    shifts: [],
    addWorkers: [],
    removeWorkers: [],
    crossTrain: [],
    workerLeave: [],
    workerOverrides: [],
    absenteeism: "",
    flex: "",
    overtimeMaxHours: "",
    targetUtilization: "",

    forecast: "",
    serviceLevel: "",
    supplierDelays: [],
    supplierOverrides: [],
    dcDeliveryDays: [],
    overnightFrom: "",
    overnightTo: "",
    directFrom: "",
    directTo: "",

    merchandising: "",
    facingDays: "",
    registers: "",
    counters: "",
    palletJacks: "",
    stockCarts: "",
    vans: "",
    docks: "",
    groundDoors: "",
    runs: "",
    baysPerRun: "",
    shelves: "",
    facingsPerBay: "",
    aisleWidthFt: "",

    registerOutages: [],
    counterOutages: [],
    dockOutages: [],
    vanOutages: [],
    posOutages: [],
    inboundLatenessSdMin: "",
  };
}

export interface FormResult {
  /** Absent when a field could not be read or the schema rejected the result. */
  scenario?: Record<string, unknown>;
  errors: FormErrors;
}

const s = (v: string): string | undefined => {
  const t = v.trim();
  return t === "" ? undefined : t;
};

/** Drop the keys nobody filled in, so `{}` really is "the shop as it is" and the link stays short. */
function prune(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The form as a scenario, or the fields that stopped it.
 *
 * Numbers are read here and nothing else is: whether 0.4 is a legal
 * `serviceLevel` is `scenarioSchema`'s business, and asking it rather than
 * restating its ranges is what keeps the page and the MCP tools agreeing about
 * what a scenario is. Unreadable text is caught first, because "expected
 * number, received NaN" is not a sentence anybody wants in a form.
 */
export function formToScenario(form: StoreForm): FormResult {
  const errors: FormErrors = {};
  const num = (key: string, text: string): number | undefined => {
    const t = text.trim();
    if (t === "") return undefined;
    const n = Number(t);
    if (!Number.isFinite(n)) {
      errors[key] = "Not a number.";
      return undefined;
    }
    return n;
  };
  const rows = <R, T>(prefix: string, list: R[], map: (r: R, key: (col: string) => string) => T | undefined): T[] =>
    list.map((r, i) => map(r, (col) => `${prefix}.${i}.${col}`)).filter((x): x is T => x !== undefined);

  const times = prune({
    orderCutoff: s(form.orderCutoff),
    pickStart: s(form.pickStart),
    vanDeparture: s(form.vanDeparture),
    vanSecondDeparture: form.vanSecondDeparture.trim() === "none" ? null : s(form.vanSecondDeparture),
    overnightWindow: s(form.overnightFrom) && s(form.overnightTo) ? [form.overnightFrom.trim(), form.overnightTo.trim()] : undefined,
    directWindow: s(form.directFrom) && s(form.directTo) ? [form.directFrom.trim(), form.directTo.trim()] : undefined,
  });

  const raw = prune({
    demandScale: num("demandScale", form.demandScale),
    demandShocks: rows("demandShocks", form.demandShocks, (r, k) => prune({ fromDay: num(k("fromDay"), r.fromDay), toDay: num(k("toDay"), r.toDay), factor: num(k("factor"), r.factor), category: s(r.category) })),
    specialShare: num("specialShare", form.specialShare),
    deliveryShare: num("deliveryShare", form.deliveryShare),
    patience: num("patience", form.patience),
    hours: rows("hours", form.hours, (r, k) => prune({ day: num(k("day"), r.day), open: s(r.open), close: s(r.close) })),
    operatingDays: form.operatingDays.length ? [...form.operatingDays].sort((a, b) => a - b) : undefined,
    times: Object.keys(times).length ? times : undefined,

    shifts: rows("shifts", form.shifts, (r, k) => prune({ id: s(r.id), start: s(r.start), end: s(r.end), breakMin: num(k("breakMin"), r.breakMin), indirectMin: num(k("indirectMin"), r.indirectMin) })),
    addWorkers: rows("addWorkers", form.addWorkers, (r, k) => prune({ role: s(r.role), shift: s(r.shift), type: s(r.type), count: num(k("count"), r.count) })),
    removeWorkers: form.removeWorkers.map((r) => r.worker.trim()).filter((v) => v !== ""),
    crossTrain: rows("crossTrain", form.crossTrain, (r) => prune({ worker: s(r.worker), role: s(r.role), skill: s(r.skill) })),
    workerLeave: rows("workerLeave", form.workerLeave, (r, k) => prune({ fromDay: num(k("fromDay"), r.fromDay), toDay: num(k("toDay"), r.toDay), worker: s(r.worker), role: s(r.role), count: num(k("count"), r.count) })),
    workerOverrides: rows("workerOverrides", form.workerOverrides, (r, k) => prune({ worker: s(r.worker), productivity: num(k("productivity"), r.productivity), maxWeeklyHours: num(k("maxWeeklyHours"), r.maxWeeklyHours), hourlyRate: num(k("hourlyRate"), r.hourlyRate) })),
    absenteeism: num("absenteeism", form.absenteeism),
    flex: form.flex === "" ? undefined : form.flex === "on",
    overtimeMaxHours: num("overtimeMaxHours", form.overtimeMaxHours),
    targetUtilization: num("targetUtilization", form.targetUtilization),

    forecast: s(form.forecast),
    serviceLevel: num("serviceLevel", form.serviceLevel),
    supplierDelays: rows("supplierDelays", form.supplierDelays, (r, k) => prune({ fromDay: num(k("fromDay"), r.fromDay), toDay: num(k("toDay"), r.toDay), supplier: s(r.supplier), category: s(r.category), extraDays: num(k("extraDays"), r.extraDays) })),
    supplierOverrides: rows("supplierOverrides", form.supplierOverrides, (r, k) =>
      prune({ supplier: s(r.supplier), leadDays: num(k("leadDays"), r.leadDays), leadSdDays: num(k("leadSdDays"), r.leadSdDays), orderDay: num(k("orderDay"), r.orderDay), channel: s(r.channel) })
    ),
    dcDeliveryDays: form.dcDeliveryDays.length ? [...form.dcDeliveryDays].sort((a, b) => a - b) : undefined,

    merchandising: s(form.merchandising),
    facingDays: num("facingDays", form.facingDays),
    registers: num("registers", form.registers),
    counters: num("counters", form.counters),
    palletJacks: num("palletJacks", form.palletJacks),
    stockCarts: num("stockCarts", form.stockCarts),
    vans: num("vans", form.vans),
    docks: num("docks", form.docks),
    groundDoors: num("groundDoors", form.groundDoors),
    fixtures: prune({
      runs: num("runs", form.runs),
      baysPerRun: num("baysPerRun", form.baysPerRun),
      shelves: num("shelves", form.shelves),
      facingsPerBay: num("facingsPerBay", form.facingsPerBay),
      aisleWidthFt: num("aisleWidthFt", form.aisleWidthFt),
    }),

    registerOutages: rows("registerOutages", form.registerOutages, (r, k) => prune({ fromDay: num(k("fromDay"), r.fromDay), toDay: num(k("toDay"), r.toDay), count: num(k("count"), r.count) })),
    counterOutages: rows("counterOutages", form.counterOutages, (r, k) => prune({ fromDay: num(k("fromDay"), r.fromDay), toDay: num(k("toDay"), r.toDay), count: num(k("count"), r.count) })),
    dockOutages: rows("dockOutages", form.dockOutages, (r, k) => prune({ fromDay: num(k("fromDay"), r.fromDay), toDay: num(k("toDay"), r.toDay), count: num(k("count"), r.count) })),
    vanOutages: rows("vanOutages", form.vanOutages, (r, k) => prune({ fromDay: num(k("fromDay"), r.fromDay), toDay: num(k("toDay"), r.toDay), count: num(k("count"), r.count) })),
    posOutages: rows("posOutages", form.posOutages, (r, k) => prune({ day: num(k("day"), r.day), start: s(r.start), hours: num(k("hours"), r.hours) })),
    inboundLatenessSdMin: num("inboundLatenessSdMin", form.inboundLatenessSdMin),
  });

  if (Object.keys(errors).length > 0) return { errors };
  const res = scenarioSchema.safeParse(raw);
  if (!res.success) {
    for (const issue of res.error.issues) errors[issue.path.map(String).join(".")] = issue.message;
    return { errors };
  }
  return { scenario: res.data as Record<string, unknown>, errors: {} };
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A scenario back into the form, so a link or an applied plan lands in the fields a reader can edit. */
export function scenarioToForm(scenario: Record<string, unknown> | undefined): StoreForm {
  const f = emptyForm();
  const sc = scenario ?? {};
  const times = obj(sc.times);
  const fixtures = obj(sc.fixtures);
  const overnight = arr<string>(times.overnightWindow);
  const direct = arr<string>(times.directWindow);

  f.demandScale = str(sc.demandScale);
  f.demandShocks = arr<Record<string, unknown>>(sc.demandShocks).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), factor: str(r.factor), category: str(r.category) }));
  f.specialShare = str(sc.specialShare);
  f.deliveryShare = str(sc.deliveryShare);
  f.patience = str(sc.patience);
  f.hours = arr<Record<string, unknown>>(sc.hours).map((r) => ({ day: str(r.day), open: str(r.open), close: str(r.close) }));
  f.operatingDays = arr<number>(sc.operatingDays);
  f.orderCutoff = str(times.orderCutoff);
  f.pickStart = str(times.pickStart);
  f.vanDeparture = str(times.vanDeparture);
  f.vanSecondDeparture = times.vanSecondDeparture === null ? "none" : str(times.vanSecondDeparture);

  f.shifts = arr<Record<string, unknown>>(sc.shifts).map((r) => ({ id: str(r.id), start: str(r.start), end: str(r.end), breakMin: str(r.breakMin), indirectMin: str(r.indirectMin) }));
  f.addWorkers = arr<Record<string, unknown>>(sc.addWorkers).map((r) => ({ role: str(r.role), shift: str(r.shift), type: str(r.type), count: str(r.count) }));
  f.removeWorkers = arr<string>(sc.removeWorkers).map((w) => ({ worker: str(w) }));
  f.crossTrain = arr<Record<string, unknown>>(sc.crossTrain).map((r) => ({ worker: str(r.worker), role: str(r.role), skill: str(r.skill) }));
  f.workerLeave = arr<Record<string, unknown>>(sc.workerLeave).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), worker: str(r.worker), role: str(r.role), count: str(r.count) }));
  f.workerOverrides = arr<Record<string, unknown>>(sc.workerOverrides).map((r) => ({ worker: str(r.worker), productivity: str(r.productivity), maxWeeklyHours: str(r.maxWeeklyHours), hourlyRate: str(r.hourlyRate) }));
  f.absenteeism = str(sc.absenteeism);
  f.flex = sc.flex === undefined ? "" : sc.flex ? "on" : "off";
  f.overtimeMaxHours = str(sc.overtimeMaxHours);
  f.targetUtilization = str(sc.targetUtilization);

  f.forecast = str(sc.forecast);
  f.serviceLevel = str(sc.serviceLevel);
  f.supplierDelays = arr<Record<string, unknown>>(sc.supplierDelays).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), supplier: str(r.supplier), category: str(r.category), extraDays: str(r.extraDays) }));
  f.supplierOverrides = arr<Record<string, unknown>>(sc.supplierOverrides).map((r) => ({ supplier: str(r.supplier), leadDays: str(r.leadDays), leadSdDays: str(r.leadSdDays), orderDay: str(r.orderDay), channel: str(r.channel) }));
  f.dcDeliveryDays = arr<number>(sc.dcDeliveryDays);
  f.overnightFrom = str(overnight[0]);
  f.overnightTo = str(overnight[1]);
  f.directFrom = str(direct[0]);
  f.directTo = str(direct[1]);

  f.merchandising = str(sc.merchandising);
  f.facingDays = str(sc.facingDays);
  f.registers = str(sc.registers);
  f.counters = str(sc.counters);
  f.palletJacks = str(sc.palletJacks);
  f.stockCarts = str(sc.stockCarts);
  f.vans = str(sc.vans);
  f.docks = str(sc.docks);
  f.groundDoors = str(sc.groundDoors);
  f.runs = str(fixtures.runs);
  f.baysPerRun = str(fixtures.baysPerRun);
  f.shelves = str(fixtures.shelves);
  f.facingsPerBay = str(fixtures.facingsPerBay);
  f.aisleWidthFt = str(fixtures.aisleWidthFt);

  const span = (v: unknown): SpanRow[] => arr<Record<string, unknown>>(v).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), count: str(r.count) }));
  f.registerOutages = span(sc.registerOutages);
  f.counterOutages = span(sc.counterOutages);
  f.dockOutages = span(sc.dockOutages);
  f.vanOutages = span(sc.vanOutages);
  f.posOutages = arr<Record<string, unknown>>(sc.posOutages).map((r) => ({ day: str(r.day), start: str(r.start), hours: str(r.hours) }));
  f.inboundLatenessSdMin = str(sc.inboundLatenessSdMin);
  return f;
}

// ---------------------------------------------------------------------------
// What the tabs receive
// ---------------------------------------------------------------------------

/** Ids and facts the tabs offer as suggestions; taken from the last run's world when there has been one. */
export interface FormContext {
  workerIds: string[];
  roles: string[];
  shiftIds: string[];
  supplierIds: string[];
  categories: string[];
  skuCount: number;
  /** The shop as it stands, for the placeholders: a blank field means this. */
  site: {
    registers: number;
    counters: number;
    palletJacks: number;
    stockCarts: number;
    vans: number;
    docks: number;
    groundDoors: number;
    widthFt: number;
    hours: string;
    operatingDays: number[];
  };
  /** The gondola block the Floor tab re-fixtures; null when a plan was imported, because then the drawing's fixtures are used. */
  gondolas: { runs: number; baysPerRun: number; shelves: number; facingsPerBay: number; depthFt: number; aisleWidthFt: number; originX: number } | null;
  imported: boolean;
}

export interface TabProps {
  form: StoreForm;
  update: (fn: (f: StoreForm) => StoreForm) => void;
  errors: FormErrors;
  ctx: FormContext;
}

export type ScenarioTab = "trade" | "people" | "stock" | "floor" | "disruptions";
export const SCENARIO_TABS: Array<[ScenarioTab, string]> = [
  ["trade", "Trade"],
  ["people", "People"],
  ["stock", "Stock"],
  ["floor", "Floor"],
  ["disruptions", "Disruptions"],
];

/** Which scenario keys belong to which tab, for the "3 fields set" badges. */
const TAB_KEYS: Record<ScenarioTab, string[]> = {
  trade: ["demandScale", "demandShocks", "specialShare", "deliveryShare", "patience", "hours", "operatingDays", "times"],
  people: ["shifts", "addWorkers", "removeWorkers", "crossTrain", "workerLeave", "workerOverrides", "absenteeism", "flex", "overtimeMaxHours", "targetUtilization"],
  stock: ["forecast", "serviceLevel", "supplierDelays", "supplierOverrides", "dcDeliveryDays"],
  floor: ["merchandising", "facingDays", "registers", "counters", "palletJacks", "stockCarts", "vans", "docks", "groundDoors", "fixtures"],
  disruptions: ["registerOutages", "counterOutages", "dockOutages", "vanOutages", "posOutages", "inboundLatenessSdMin"],
};

/** How many fields each tab has set, counted on the parsed scenario so a half-typed number never counts. */
export function tabCounts(scenario: Record<string, unknown> | undefined): Record<ScenarioTab, number> {
  const sc = scenario ?? {};
  const count = (keys: string[]) => keys.filter((k) => sc[k] !== undefined).length;
  return { trade: count(TAB_KEYS.trade), people: count(TAB_KEYS.people), stock: count(TAB_KEYS.stock), floor: count(TAB_KEYS.floor), disruptions: count(TAB_KEYS.disruptions) };
}

// ---------------------------------------------------------------------------
// Widgets (function declarations: hoisted, so the order in the file is free)
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, help, error, children }: FieldProps) {
  return (
    <div className={`store-field${error ? " invalid" : ""}`}>
      <label>{label}</label>
      {children}
      {help && <span className="help">{help}</span>}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

interface NumFieldProps {
  label: string;
  help?: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

export function NumField({ label, help, error, value, onChange, placeholder, min, max, step }: NumFieldProps) {
  return (
    <Field label={label} help={help} error={error}>
      <input type="number" inputMode="decimal" value={value} placeholder={placeholder} min={min} max={max} step={step ?? "any"} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

interface TextFieldProps {
  label: string;
  help?: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  list?: string;
  type?: "text" | "time";
}

export function TextField({ label, help, error, value, onChange, placeholder, list, type = "text" }: TextFieldProps) {
  return (
    <Field label={label} help={help} error={error}>
      <input type={type} value={value} placeholder={placeholder} list={list} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

interface SelectFieldProps {
  label: string;
  help?: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}

export function SelectField({ label, help, error, value, onChange, options }: SelectFieldProps) {
  return (
    <Field label={label} help={help} error={error}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

interface WeekdayProps {
  label: string;
  help?: string;
  error?: string;
  value: number[];
  onChange: (days: number[]) => void;
}

export function WeekdayPicker({ label, help, error, value, onChange }: WeekdayProps) {
  const toggle = (d: number) => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b));
  return (
    <Field label={label} help={help} error={error}>
      <div className="store-days">
        {WEEKDAYS.map((name, i) => (
          <button type="button" key={name} className={value.includes(i + 1) ? "on" : ""} onClick={() => toggle(i + 1)} aria-pressed={value.includes(i + 1)}>
            {name}
          </button>
        ))}
        {value.length > 0 && (
          <button type="button" className="chip" onClick={() => onChange([])} title="Leave the shop's own days">
            default
          </button>
        )}
      </div>
    </Field>
  );
}

export interface Column<R> {
  key: keyof R & string;
  label: string;
  type: "number" | "text" | "time" | "select";
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  list?: string;
  min?: number;
  max?: number;
}

interface RowListProps<R> {
  title: string;
  help?: string;
  rows: R[];
  onChange: (rows: R[]) => void;
  blank: R;
  columns: Array<Column<R>>;
  errors: FormErrors;
  prefix: string;
  addLabel?: string;
  max?: number;
  children?: ReactNode;
}

/**
 * A little table of rows, which is what most of a scenario is: a window of
 * days and a number. The error keys it reads — `"<prefix>.<i>.<column>"` for a
 * cell, `"<prefix>.<i>"` for a row, `"<prefix>"` for the list — are exactly the
 * paths `formToScenario` writes out of the schema's own issues, so a message
 * lands on the box that caused it without either side knowing about the other.
 */
export function RowList<R extends { [K in keyof R]: string }>({ title, help, rows, onChange, blank, columns, errors, prefix, addLabel, max, children }: RowListProps<R>) {
  const set = (i: number, key: keyof R & string, v: string) => onChange(rows.map((r, k) => (k === i ? { ...r, [key]: v } : r)));
  const rowError = (i: number) => errors[`${prefix}.${i}`];
  return (
    <div className="store-rows">
      <div className="row" style={{ marginTop: 0, justifyContent: "space-between" }}>
        <b style={{ fontSize: 12 }}>{title}</b>
        <span className="sub" style={{ margin: 0 }}>
          {rows.length ? `${rows.length} row${rows.length === 1 ? "" : "s"}` : "none"}
        </span>
      </div>
      {help && (
        <div className="help sub" style={{ margin: "2px 0 4px", fontSize: 11 }}>
          {help}
        </div>
      )}
      {children}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const err = errors[`${prefix}.${i}.${c.key}`];
                  const value = r[c.key] as string;
                  return (
                    <td key={c.key} title={err}>
                      {c.type === "select" ? (
                        <select className={err ? "invalid" : ""} value={value} onChange={(e) => set(i, c.key, e.target.value)}>
                          <option value="">{c.placeholder ?? "–"}</option>
                          {(c.options ?? []).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={err ? "invalid" : ""}
                          type={c.type === "number" ? "number" : c.type}
                          inputMode={c.type === "number" ? "decimal" : undefined}
                          step={c.type === "number" ? "any" : undefined}
                          min={c.min}
                          max={c.max}
                          value={value}
                          placeholder={c.placeholder}
                          list={c.list}
                          onChange={(e) => set(i, c.key, e.target.value)}
                        />
                      )}
                    </td>
                  );
                })}
                <td>
                  <button type="button" className="del" onClick={() => onChange(rows.filter((_, k) => k !== i))} title="Remove">
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.map((_, i) => rowError(i) && <div key={i} className="store-err">{`Row ${i + 1}: ${rowError(i)}`}</div>)}
      <div className="foot">
        <button type="button" className="chip" onClick={() => onChange([...rows, { ...blank }])} disabled={max !== undefined && rows.length >= max}>
          {addLabel ?? "Add"}
        </button>
        {errors[prefix] && <span className="store-err">{errors[prefix]}</span>}
      </div>
    </div>
  );
}

/** The suggestion lists the text inputs reference by id. De-duplicated, so two shift rows with the same id are not two React children with one key. */
export function Datalists({ ctx }: { ctx: FormContext }) {
  const list = (id: string, values: string[]) => (
    <datalist id={id}>
      {[...new Set(values)].map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
  return (
    <>
      {list("store-workers", ctx.workerIds)}
      {list("store-roles", ctx.roles)}
      {list("store-shifts", ctx.shiftIds)}
      {list("store-suppliers", ctx.supplierIds)}
      {list("store-categories", ctx.categories)}
    </>
  );
}

// ---------------------------------------------------------------------------
// The panel shell: the run controls above, one tab below
// ---------------------------------------------------------------------------

interface PanelProps {
  tab: ScenarioTab;
  onTab: (t: ScenarioTab) => void;
  counts: Record<ScenarioTab, number>;
  errorCount: number;
  /** The side tab's panel id, and the id of the tab button that labels it. */
  panelId: string;
  labelledBy: string;
  runControls: ReactNode;
  children: ReactNode;
}

export default function ScenarioPanel({ tab, onTab, counts, errorCount, panelId, labelledBy, runControls, children }: PanelProps) {
  return (
    <>
      <div className="store-runrow">{runControls}</div>
      <div className="store-tabbody" role="tabpanel" id={panelId} aria-labelledby={labelledBy}>
        <div className="store-subtabs" role="tablist">
          {SCENARIO_TABS.map(([id, label]) => (
            <button type="button" key={id} id={`store-subtab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`store-subpanel-${id}`} className={tab === id ? "on" : ""} onClick={() => onTab(id)}>
              {label}
              {counts[id] > 0 ? ` · ${counts[id]}` : ""}
            </button>
          ))}
        </div>
        {errorCount > 0 && <p className="store-err">{errorCount === 1 ? "One field needs attention before the run." : `${errorCount} fields need attention before the run.`}</p>}
        <div role="tabpanel" id={`store-subpanel-${tab}`} aria-labelledby={`store-subtab-${tab}`}>
          {children}
        </div>
      </div>
    </>
  );
}
