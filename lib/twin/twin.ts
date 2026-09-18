/**
 * Scenario in, context out.
 *
 * `buildTwin(store, startWeek, scenario)` is the one place a caller's question
 * becomes a runnable model. Every MCP tool, the stateless API route and the 3D
 * page's Web Worker call it with the same `scenarioSchema`, so a conversation
 * can chain "plan the crew, test the fix, stress-test it" against one set of
 * assumptions.
 *
 * The order of operations below is load-bearing and commented as such. Nothing
 * mutates the committed data: the site is structure-cloned, the roster copied
 * and the catalog rebuilt copy-on-write, because contexts are cached, shared
 * across replications and treated as immutable by everything above.
 */

import { z } from "zod";
import { LIMITS, LimitError } from "../layout/limits";
import { layoutSpecSchema, type LayoutSpec } from "../layout/spec";
import { findSite, loadCatalog, loadNetwork, loadRoster, dataVersion, UnknownIdError } from "../data/store";
import { fetchNetwork, type CandystoreScenario } from "./candystore";
import type { DemandModel, DemandShock } from "./demand";
import { buildDemandModel } from "./demand";
import type { InventoryPolicy, SupplierDelay } from "./inventory";
import { DEFAULT_POLICY } from "./inventory";
import type { Layout } from "./layout";
import { buildLayout, siteToSpec, withDoorCounts, withServiceCounts } from "./layout";
import type { FacingUnits, MerchEvaluation, MerchPolicy, Planogram, SkuRate } from "./merch";
import { appealOf, evaluateMerch, facingUnitsFor, planogramFor, skuRates } from "./merch";
import type { Disruptions, OperationsOptions } from "./operations";
import { NO_DISRUPTIONS } from "./operations";
import { ROLE_KEYS, ROLES, type RoleKey } from "./roles";
import { DEFAULT_COSTS, DEFAULT_STANDARDS, hhmm, shiftPaidHours } from "./standards";
import type { Catalog, CostRates, LaborStandards, Network, Site, Skill, Worker } from "./types";
import { SKILLS } from "./types";
import type { ScheduleOptions, WeekSchedule, WorkloadContext } from "./workforce";
import { DEFAULT_SCHEDULE_OPTIONS } from "./workforce";

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const daySpan = { fromDay: z.number().int().min(0).max(364), toDay: z.number().int().min(0).max(364) };
const clockString = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'Times are "HH:MM", 24-hour.')
  .refine((s) => {
    const [h, m] = s.split(":").map(Number);
    return h < 24 && m < 60;
  }, "Not a real time of day.");

export const scenarioShape = {
  /** A store plan from import_layout or the web page's import. */
  layout: layoutSpecSchema.optional(),

  // Demand
  demandScale: z.number().min(0.1).max(5).optional().describe("Multiply every customer's spend and the number of them. 1.2 is a fifth busier."),
  demandShocks: z
    .array(z.object({ ...daySpan, factor: z.number().min(0).max(10), category: z.string().max(60).optional() }))
    .max(20)
    .optional()
    .describe("A run on one category, or a quiet fortnight, over a window of horizon days."),
  candystore: z
    .object({
      add: z.array(z.object({ type: z.enum(["general", "specialty"]), lon: z.number(), lat: z.number(), size: z.number().min(0.2).max(5).optional(), segments: z.array(z.string()).max(7).optional(), name: z.string().max(80).optional(), dc: z.string().max(40).optional() })).max(20).optional(),
      remove: z.array(z.string().max(40)).max(20).optional(),
    })
    .optional()
    .describe("Open or close stores in candystore's market model and take this shop's demand from the result."),
  specialShare: z.number().min(0).max(0.5).optional().describe("Share of the shop's dollars taken as delivery and pickup orders rather than over the counter."),
  deliveryShare: z.number().min(0).max(1).optional().describe("Share of special orders that ride the van rather than being collected."),

  // Merchandising and stock policy
  merchandising: z.enum(["current", "optimized"]).optional().describe("Leave the planogram as it is, or re-merchandise so the fastest movers sit at eye level and on the feature fixtures."),
  facingDays: z
    .number()
    .min(0.5)
    .max(21)
    .optional()
    .describe('Days of supply a facing is sized to hold. Only bites with merchandising "optimized": the shop as it is has whatever facing the fixture gives it.'),
  forecast: z.enum(["seasonal", "trailing"]).optional(),
  serviceLevel: z.number().min(0.5).max(0.999).optional(),
  supplierDelays: z
    .array(z.object({ ...daySpan, supplier: z.string().max(40).optional(), category: z.string().max(60).optional(), extraDays: z.number().int().min(1).max(60) }))
    .max(20)
    .optional(),

  // People
  absenteeism: z.number().min(0).max(0.5).optional(),
  workerLeave: z.array(z.object({ ...daySpan, worker: z.string().max(40).optional(), role: z.string().max(60).optional(), count: z.number().int().min(1).max(20).optional() })).max(20).optional(),
  addWorkers: z.array(z.object({ role: z.enum(ROLE_KEYS as [string, ...string[]]), shift: z.string().max(40), type: z.enum(["full-time", "part-time", "temp"]), count: z.number().int().min(1).max(20) })).max(10).optional(),
  removeWorkers: z.array(z.string().max(40)).max(20).optional(),
  crossTrain: z.array(z.object({ worker: z.string().max(40).optional(), role: z.string().max(60).optional(), skill: z.enum(SKILLS as [Skill, ...Skill[]]) })).max(20).optional(),
  workerOverrides: z.array(z.object({ worker: z.string().max(40), productivity: z.number().min(0.4).max(2).optional(), maxWeeklyHours: z.number().min(0).max(60).optional(), hourlyRate: z.number().min(0).max(200).optional() })).max(40).optional(),
  flex: z.boolean().optional().describe("Let cross-trained people take work outside their primary when their own queue is idle."),
  overtimeMaxHours: z.number().min(0).max(6).optional(),
  targetUtilization: z.number().min(0.5).max(1).optional(),

  // The building
  registers: z.number().int().min(1).max(12).optional(),
  counters: z.number().int().min(0).max(8).optional().describe("Serving positions behind the showcase glass."),
  palletJacks: z.number().int().min(0).max(6).optional(),
  stockCarts: z.number().int().min(1).max(20).optional(),
  vans: z.number().int().min(0).max(6).optional(),
  docks: z.number().int().min(0).max(6).optional(),
  groundDoors: z.number().int().min(0).max(6).optional(),
  fixtures: z
    .object({
      runs: z.number().int().min(1).max(20).optional(),
      baysPerRun: z.number().int().min(2).max(40).optional(),
      shelves: z.number().int().min(2).max(8).optional(),
      facingsPerBay: z.number().int().min(1).max(8).optional(),
      aisleWidthFt: z.number().min(2.5).max(14).optional(),
    })
    .optional()
    .describe("Re-fixture a built-in shop's gondola block. Ignored, with a note, when a layout is imported."),

  // Hours and the calendar
  hours: z.array(z.object({ day: z.number().int().min(1).max(7), open: clockString, close: clockString })).max(7).optional(),
  operatingDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  shifts: z.array(z.object({ id: z.string().max(40), start: clockString, end: clockString, breakMin: z.number().min(0).max(120), indirectMin: z.number().min(0).max(180) })).min(1).max(4).optional(),
  times: z
    .object({
      orderCutoff: clockString.optional(),
      pickStart: clockString.optional(),
      vanDeparture: clockString.optional(),
      vanSecondDeparture: clockString.nullable().optional(),
      overnightWindow: z.tuple([clockString, clockString]).optional(),
      directWindow: z.tuple([clockString, clockString]).optional(),
    })
    .optional(),
  dcDeliveryDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),

  // Disruptions
  registerOutages: z.array(z.object({ ...daySpan, count: z.number().int().min(1).max(10) })).max(20).optional(),
  counterOutages: z.array(z.object({ ...daySpan, count: z.number().int().min(1).max(10) })).max(20).optional(),
  dockOutages: z.array(z.object({ ...daySpan, count: z.number().int().min(1).max(10) })).max(20).optional(),
  vanOutages: z.array(z.object({ ...daySpan, count: z.number().int().min(1).max(10) })).max(20).optional(),
  posOutages: z.array(z.object({ day: z.number().int().min(0).max(364), start: clockString, hours: z.number().min(0.25).max(24) })).max(20).optional().describe("The till network down: nothing can be rung up and every queue stalls."),
  patience: z.number().min(0.2).max(3).optional().describe("Multiplier on how long a shopper will stand in a queue before walking out."),
  inboundLatenessSdMin: z.number().min(0).max(180).optional(),

  // Engineering
  standards: z.record(z.string(), z.number().min(0)).optional().describe("Override engineered labor standards by name; see get_workforce for the list."),
  supplierOverrides: z.array(z.object({ supplier: z.string().max(40), leadDays: z.number().min(0).max(120).optional(), leadSdDays: z.number().min(0).max(60).optional(), orderDay: z.number().int().min(1).max(7).optional(), channel: z.enum(["dc", "direct"]).optional() })).max(20).optional(),
};

export const scenarioSchema = z.object(scenarioShape).strict();
export type TwinScenario = z.infer<typeof scenarioSchema>;

export const storeSchema = z.string().max(40).describe('Which shop, e.g. "store-midtown". describe_store lists them.');
export const startWeekSchema = z.number().int().min(1).max(52).describe("Calendar week the horizon starts on; the candy calendar peaks in week 44.");

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export interface TwinContext {
  site: Site;
  layout: Layout;
  catalog: Catalog;
  network: Network;
  model: DemandModel;
  std: LaborStandards;
  costs: CostRates;
  workers: Worker[];
  merchPolicy: MerchPolicy;
  plan: Planogram;
  merchEval: MerchEvaluation;
  facingUnits: FacingUnits;
  rates: SkuRate[];
  startWeek: number;
  policy: InventoryPolicy;
  supplierDelays: SupplierDelay[];
  workloadContext: WorkloadContext;
  scheduleOptions: ScheduleOptions;
  /** A fixed schedule instead of building one per week; the optimizer sets it. */
  schedule?: WeekSchedule;
  scenario: TwinScenario;
  /** Human-readable "label old → new" notes, echoed back by every tool. */
  changes: string[];
}

// ---------------------------------------------------------------------------
// Applying a scenario
// ---------------------------------------------------------------------------

function override<T>(changes: string[], label: string, cur: T, next: T | undefined, apply: (v: T) => void, fmt: (v: T) => string = String): void {
  if (next === undefined) return;
  if (fmt(next) === fmt(cur)) return;
  apply(next);
  changes.push(`${label} ${fmt(cur)} → ${fmt(next)}`);
}

const dayNames = (ds: number[]) => ds.map((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d - 1]).join(", ");

export const FIXTURES_IGNORED = "fixtures was ignored because a layout was imported: the drawing's own fixtures are used.";

function applySite(base: Site, s: TwinScenario, changes: string[]): Site {
  const site: Site = structuredClone(base);

  if (s.layout) {
    site.building = { widthFt: s.layout.widthFt, depthFt: s.layout.depthFt };
    site.backroomY = s.layout.backroomY;
    site.doors = {
      docks: s.layout.doors.filter((d) => d.kind === "dock").length,
      ground: s.layout.doors.filter((d) => d.kind === "ground").length,
      entrances: s.layout.doors.filter((d) => d.kind === "entrance").length,
    };
    site.parking = s.layout.parking;
    changes.push(`imported layout "${s.layout.name}" (${Math.round(s.layout.widthFt)} × ${Math.round(s.layout.depthFt)} ft)`);
  }

  override(changes, "registers", site.checkout.registers, s.registers, (v) => (site.checkout.registers = v));
  if (site.showcase) override(changes, "counter stations", site.showcase.stations, s.counters, (v) => (site.showcase!.stations = v));
  override(changes, "pallet jacks", site.equipment.palletJacks, s.palletJacks, (v) => (site.equipment.palletJacks = v));
  override(changes, "stock carts", site.equipment.stockCarts, s.stockCarts, (v) => (site.equipment.stockCarts = v));
  override(changes, "vans", site.equipment.vans, s.vans, (v) => (site.equipment.vans = v));
  override(changes, "dock doors", site.doors.docks, s.docks, (v) => (site.doors.docks = v));
  override(changes, "ground-level doors", site.doors.ground, s.groundDoors, (v) => (site.doors.ground = v));

  if (s.fixtures) {
    if (s.layout) changes.push(FIXTURES_IGNORED);
    else {
      const g = site.gondolas;
      override(changes, "gondola runs", g.runs, s.fixtures.runs, (v) => (g.runs = v));
      override(changes, "bays per run", g.baysPerRun, s.fixtures.baysPerRun, (v) => (g.baysPerRun = v));
      override(changes, "shelves", g.shelves, s.fixtures.shelves, (v) => (g.shelves = v));
      override(changes, "facings per bay", g.facingsPerBay, s.fixtures.facingsPerBay, (v) => (g.facingsPerBay = v));
      override(changes, "aisle width", g.aisleWidthFt, s.fixtures.aisleWidthFt, (v) => (g.aisleWidthFt = v), (v) => `${v} ft`);
    }
  }

  if (s.operatingDays) {
    const days = [...new Set(s.operatingDays)].sort((a, b) => a - b);
    if (days.length === 0) throw new LimitError("operatingDays cannot be empty: a shop that never opens has nothing to simulate.");
    override(changes, "trading days", site.operatingDays, days, (v) => (site.operatingDays = v), dayNames);
  }

  if (s.hours) {
    for (const h of s.hours) {
      if (hhmm(h.close) <= hhmm(h.open)) throw new LimitError(`Trading hours for day ${h.day} close at or before they open (${h.open}–${h.close}).`);
      const i = site.hours.findIndex((x) => x.day === h.day);
      const label = `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][h.day - 1]} hours`;
      if (i < 0) {
        site.hours.push({ ...h });
        changes.push(`${label} added ${h.open}–${h.close}`);
      } else {
        override(changes, label, site.hours[i], { ...h }, (v) => (site.hours[i] = v), (v) => `${v.open}–${v.close}`);
      }
    }
    site.hours.sort((a, b) => a.day - b.day);
  }

  if (s.shifts) {
    const ids = new Set(s.shifts.map((x) => x.id));
    if (ids.size !== s.shifts.length) throw new LimitError("Every shift needs its own id.");
    for (const sh of s.shifts) {
      if (sh.start === sh.end) throw new LimitError(`Shift "${sh.id}" starts and ends at the same time.`);
      const paid = shiftPaidHours(sh.start, sh.end) * 60;
      if (sh.breakMin + sh.indirectMin >= paid) throw new LimitError(`Shift "${sh.id}" is ${paid / 60} h long but its break and indirect time come to ${(sh.breakMin + sh.indirectMin) / 60} h.`);
    }
    override(changes, "shifts", site.shifts, s.shifts, (v) => (site.shifts = v), (v) => v.map((x) => `${x.id} ${x.start}–${x.end}`).join(", "));
  }

  if (s.times) {
    const t = site.times;
    override(changes, "order cutoff", t.orderCutoff, s.times.orderCutoff, (v) => (t.orderCutoff = v));
    override(changes, "pick start", t.pickStart, s.times.pickStart, (v) => (t.pickStart = v));
    override(changes, "van departure", t.vanDeparture, s.times.vanDeparture, (v) => (t.vanDeparture = v));
    if (s.times.vanSecondDeparture !== undefined) {
      override(changes, "second van round", t.vanSecondDeparture ?? "none", s.times.vanSecondDeparture ?? "none", (v) => (t.vanSecondDeparture = v === "none" ? null : v));
    }
    override(changes, "overnight window", t.overnightWindow, s.times.overnightWindow, (v) => (t.overnightWindow = v), (v) => `${v[0]}–${v[1]}`);
    override(changes, "daytime delivery window", t.directWindow, s.times.directWindow, (v) => (t.directWindow = v), (v) => `${v[0]}–${v[1]}`);
  }

  if (s.dcDeliveryDays) {
    const days = [...new Set(s.dcDeliveryDays)].sort((a, b) => a - b);
    override(changes, "distribution-center delivery days", site.dcDeliveryDays, days, (v) => (site.dcDeliveryDays = v), dayNames);
  }

  return site;
}

function applyWorkers(site: Site, base: Worker[], s: TwinScenario, changes: string[]): Worker[] {
  let workers = base.filter((w) => w.store === site.id).map((w) => ({ ...w, skills: [...w.skills] }));

  if (s.removeWorkers?.length) {
    for (const id of s.removeWorkers) {
      if (!workers.some((w) => w.id === id)) throw new UnknownIdError(`Unknown worker "${id}" at ${site.id}. Known: ${workers.map((w) => w.id).join(", ")}.`);
    }
    const gone = new Set(s.removeWorkers);
    workers = workers.filter((w) => !gone.has(w.id));
    changes.push(`removed ${s.removeWorkers.length} worker${s.removeWorkers.length === 1 ? "" : "s"} (${s.removeWorkers.join(", ")})`);
  }

  if (s.addWorkers?.length) {
    let n = 0;
    for (const add of s.addWorkers) {
      const role = ROLES[add.role as RoleKey];
      if (!site.shifts.some((sh) => sh.id === add.shift)) {
        throw new UnknownIdError(`Unknown shift "${add.shift}" at ${site.id}. Known: ${site.shifts.map((sh) => sh.id).join(", ")}.`);
      }
      for (let i = 0; i < add.count; i++) {
        // A temp can be taught the floor in a morning, but not a food handler's
        // card or the store's driving insurance.
        const skills = add.type === "temp" ? role.skills.filter((k) => k !== "counter" && k !== "drive") : [...role.skills];
        if (skills.length === 0) throw new LimitError(`A temp cannot be hired as a ${role.role}: the role is nothing but counter and driving work, which needs certification.`);
        workers.push({
          id: `NEW-${String(++n).padStart(2, "0")}`,
          store: site.id,
          role: role.role,
          type: add.type,
          homeShift: add.shift,
          skills,
          productivity: 1,
          hourlyRate: add.type === "temp" ? DEFAULT_COSTS.tempHourly : role.wage,
          maxWeeklyHours: add.type === "part-time" ? 24 : 40,
        });
      }
      changes.push(`added ${add.count} ${add.type} ${role.role}${add.count === 1 ? "" : "s"} on the ${add.shift} shift`);
    }
  }

  if (s.crossTrain?.length) {
    for (const ct of s.crossTrain) {
      const targets = workers.filter((w) => (ct.worker ? w.id === ct.worker : ct.role ? w.role === ct.role : false));
      if (targets.length === 0) throw new UnknownIdError(`crossTrain matched nobody at ${site.id}: ${ct.worker ? `worker "${ct.worker}"` : `role "${ct.role}"`}. Workers: ${workers.map((w) => w.id).join(", ")}.`);
      for (const w of targets) {
        if (w.type === "temp" && (ct.skill === "counter" || ct.skill === "drive")) {
          throw new LimitError(`A temp cannot be cross-trained on ${ct.skill}: it needs ${ct.skill === "counter" ? "a food handler's card" : "the store's driving insurance"}, which takes longer than a season.`);
        }
        if (!w.skills.includes(ct.skill)) {
          w.skills.push(ct.skill);
          changes.push(`cross-trained ${w.id} on ${ct.skill}`);
        }
      }
    }
  }

  if (s.workerOverrides?.length) {
    for (const o of s.workerOverrides) {
      const w = workers.find((x) => x.id === o.worker);
      if (!w) throw new UnknownIdError(`Unknown worker "${o.worker}" at ${site.id}. Known: ${workers.map((x) => x.id).join(", ")}.`);
      override(changes, `${w.id} productivity`, w.productivity, o.productivity, (v) => (w.productivity = v));
      override(changes, `${w.id} weekly hours`, w.maxWeeklyHours, o.maxWeeklyHours, (v) => (w.maxWeeklyHours = v));
      override(changes, `${w.id} wage`, w.hourlyRate, o.hourlyRate, (v) => (w.hourlyRate = v), (v) => `$${v.toFixed(2)}`);
    }
  }

  if (s.workerLeave?.length) {
    for (const l of s.workerLeave) {
      if (l.worker && !workers.some((w) => w.id === l.worker)) throw new UnknownIdError(`Unknown worker "${l.worker}" at ${site.id}. Known: ${workers.map((w) => w.id).join(", ")}.`);
      if (l.role && !workers.some((w) => w.role === l.role)) throw new UnknownIdError(`Nobody at ${site.id} has the role "${l.role}". Roles: ${[...new Set(workers.map((w) => w.role))].join(", ")}.`);
    }
  }

  if (workers.length === 0) throw new LimitError(`${site.id} has nobody left on the roster. Remove fewer people, or add some.`);
  return workers;
}

function applyStandards(base: LaborStandards, s: TwinScenario, changes: string[]): LaborStandards {
  if (!s.standards) return base;
  const std: LaborStandards = { ...base };
  const keys = Object.keys(base) as Array<keyof LaborStandards>;
  for (const [k, v] of Object.entries(s.standards).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!keys.includes(k as keyof LaborStandards)) {
      throw new UnknownIdError(`Unknown labor standard "${k}". Known: ${keys.join(", ")}.`);
    }
    override(changes, `standard ${k}`, base[k as keyof LaborStandards], v, (x) => (std[k as keyof LaborStandards] = x));
  }
  return std;
}

function applyCatalog(base: Catalog, s: TwinScenario, changes: string[]): Catalog {
  if (!s.supplierOverrides?.length) return base;
  const suppliers = base.suppliers.map((x) => ({ ...x }));
  for (const o of s.supplierOverrides) {
    const sup = suppliers.find((x) => x.id === o.supplier);
    if (!sup) throw new UnknownIdError(`Unknown supplier "${o.supplier}". Known: ${suppliers.map((x) => x.id).join(", ")}.`);
    override(changes, `${sup.id} lead time`, sup.leadDays, o.leadDays, (v) => (sup.leadDays = v), (v) => `${v} d`);
    override(changes, `${sup.id} lead-time variability`, sup.leadSdDays, o.leadSdDays, (v) => (sup.leadSdDays = v), (v) => `${v} d`);
    override(changes, `${sup.id} order day`, sup.orderDay, o.orderDay, (v) => (sup.orderDay = v), (v) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][v - 1]);
    override(changes, `${sup.id} channel`, sup.channel, o.channel, (v) => (sup.channel = v));
  }
  return { ...base, suppliers };
}

function validateCategories(network: Network, catalog: Catalog, s: TwinScenario): void {
  const cats = new Set(catalog.skus.map((x) => x.category));
  for (const shock of s.demandShocks ?? []) {
    if (shock.category && !cats.has(shock.category)) throw new UnknownIdError(`Unknown category "${shock.category}". Known: ${[...cats].sort().join(", ")}.`);
  }
  for (const d of s.supplierDelays ?? []) {
    if (d.category && !cats.has(d.category)) throw new UnknownIdError(`Unknown category "${d.category}". Known: ${[...cats].sort().join(", ")}.`);
    if (d.supplier && !catalog.suppliers.some((x) => x.id === d.supplier)) {
      throw new UnknownIdError(`Unknown supplier "${d.supplier}". Known: ${catalog.suppliers.map((x) => x.id).join(", ")}.`);
    }
  }
  void network;
}

// ---------------------------------------------------------------------------
// buildTwin
// ---------------------------------------------------------------------------

const cache = new Map<string, TwinContext>();
let cacheLimit = 40;

/** The browser worker holds two; a server can afford more. */
export function setContextCacheLimit(n: number): void {
  cacheLimit = Math.max(1, n);
  while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string);
}

export function contextCacheSize(): number {
  return cache.size;
}

export async function buildTwin(store: string, startWeek: number, scenario: TwinScenario = {}): Promise<TwinContext> {
  const key = JSON.stringify([dataVersion(), store, startWeek, scenario]);
  const hit = cache.get(key);
  if (hit) return hit;

  const changes: string[] = [];

  // 1. The building. Extensions run last so they see the numeric overrides.
  const site = applySite(findSite(store), scenario, changes);

  // 2. The catalog, copy-on-write.
  const catalog = applyCatalog(loadCatalog(), scenario, changes);

  // 3. The market. A candystore scenario is fetched live; otherwise the snapshot.
  const wantsLive = (scenario.candystore?.add?.length ?? 0) > 0 || (scenario.candystore?.remove?.length ?? 0) > 0;
  const network = wantsLive ? await fetchNetwork(scenario.candystore as CandystoreScenario) : loadNetwork();
  if (!network.stores.some((x) => x.id === site.store)) {
    throw new UnknownIdError(`Store "${site.store}" is not in the candystore network${wantsLive ? " after the scenario was applied" : ""}. Known: ${network.stores.map((x) => x.id).join(", ")}.`);
  }
  if (wantsLive) changes.push(`candystore scenario applied (${scenario.candystore?.add?.length ?? 0} opened, ${scenario.candystore?.remove?.length ?? 0} closed)`);
  validateCategories(network, catalog, scenario);

  // 4. Geometry.
  if (scenario.layout && JSON.stringify(scenario.layout).length > LIMITS.specJson) {
    throw new LimitError(`The layout spec is over the ${Math.round(LIMITS.specJson / 1024)} KB limit. Simplify the drawing, or import it on the web page.`);
  }
  const spec: LayoutSpec = scenario.layout
    ? withServiceCounts(withDoorCounts(scenario.layout, site.doors.docks, site.doors.ground), site.checkout.registers, site.showcase?.stations ?? 0)
    : siteToSpec(site);
  const layout = buildLayout(spec, site);

  // 5. People and standards.
  const workers = applyWorkers(site, loadRoster().workers, scenario, changes);
  const std = applyStandards(DEFAULT_STANDARDS, scenario, changes);
  if (scenario.facingDays !== undefined) override(changes, "facing days of supply", std.facingDaysOfSupply, scenario.facingDays, (v) => (std.facingDaysOfSupply = v));
  const costs: CostRates = DEFAULT_COSTS;

  // 6. Demand, then the planogram, then demand again.
  //    The mix depends on where things sit and where things sit depends on how
  //    fast they sell, so the planogram is built on an unmerchandised model and
  //    the model is then rebuilt with the appeal it implies. One pass is
  //    enough: the second model only reweights within a category, and the
  //    appeal is normalised to mean 1, so it converges immediately.
  const specialShare = scenario.specialShare ?? 0.12;
  const deliveryShare = scenario.deliveryShare ?? 0.6;
  const base = buildDemandModel(network, catalog.skus, site, scenario.demandScale ?? 1, (scenario.demandShocks ?? []) as DemandShock[], new Map(), specialShare, deliveryShare);
  const merchPolicy: MerchPolicy = scenario.merchandising ?? "current";
  const baseRates = skuRates(base);
  const plan = planogramFor(merchPolicy, layout, catalog, base, baseRates);
  const appeal = appealOf(layout, plan);
  const model = buildDemandModel(network, catalog.skus, site, scenario.demandScale ?? 1, (scenario.demandShocks ?? []) as DemandShock[], appeal, specialShare, deliveryShare);
  const rates = skuRates(model);
  const facingUnits = facingUnitsFor(merchPolicy, layout, plan, rates, std, site);
  const merchEval = evaluateMerch(layout, plan, facingUnits, rates, std);
  if (scenario.merchandising) changes.push(`merchandising ${scenario.merchandising}`);

  const policy: InventoryPolicy = {
    forecast: scenario.forecast ?? DEFAULT_POLICY.forecast,
    serviceLevel: scenario.serviceLevel ?? DEFAULT_POLICY.serviceLevel,
  };
  if (scenario.forecast) changes.push(`forecast ${DEFAULT_POLICY.forecast} → ${scenario.forecast}`);
  if (scenario.serviceLevel !== undefined) override(changes, "service level", DEFAULT_POLICY.serviceLevel, scenario.serviceLevel, () => {}, (v) => `${(v * 100).toFixed(1)}%`);

  const scheduleOptions: ScheduleOptions = {
    targetUtilization: scenario.targetUtilization ?? DEFAULT_SCHEDULE_OPTIONS.targetUtilization,
    absenteeism: scenario.absenteeism ?? DEFAULT_SCHEDULE_OPTIONS.absenteeism,
  };

  const ctx: TwinContext = {
    site,
    layout,
    catalog,
    network,
    model,
    std,
    costs,
    workers,
    merchPolicy,
    plan,
    merchEval,
    facingUnits,
    rates,
    startWeek,
    policy,
    supplierDelays: (scenario.supplierDelays ?? []) as SupplierDelay[],
    workloadContext: { site, layout, model, catalog, std, startWeek, plan, facingUnits, rates },
    scheduleOptions,
    scenario,
    changes,
  };

  cache.set(key, ctx);
  while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string);
  return ctx;
}

// ---------------------------------------------------------------------------
// Scenario → run-time knobs
// ---------------------------------------------------------------------------

export function operationsOptions(ctx: TwinContext, days: number, seed: number): OperationsOptions {
  const s = ctx.scenario;
  const disruptions: Disruptions = {
    absenteeism: s.absenteeism ?? NO_DISRUPTIONS.absenteeism,
    registerOutages: s.registerOutages ?? [],
    counterOutages: s.counterOutages ?? [],
    dockOutages: s.dockOutages ?? [],
    vanOutages: s.vanOutages ?? [],
    posOutages: s.posOutages ?? [],
    workerLeave: s.workerLeave ?? [],
    inboundLatenessSdMin: s.inboundLatenessSdMin ?? NO_DISRUPTIONS.inboundLatenessSdMin,
    patience: s.patience ?? NO_DISRUPTIONS.patience,
  };
  return {
    days,
    seed,
    flex: s.flex ?? true,
    overtimeMaxHours: s.overtimeMaxHours ?? 2,
    disruptions,
    // Six weeks is enough for a shop's stock to settle; the distribution
    // center needs eight because its review cycles are longer.
    warmupWeeks: 6,
  };
}

/** Disruption fields never reach `ctx.changes`, so tools list them from here. */
export function describeDisruptions(s: TwinScenario): string[] {
  const out: string[] = [];
  const span = (x: { fromDay: number; toDay: number }) => `days ${x.fromDay}–${x.toDay}`;
  for (const o of s.registerOutages ?? []) out.push(`${o.count} register${o.count === 1 ? "" : "s"} down, ${span(o)}`);
  for (const o of s.counterOutages ?? []) out.push(`${o.count} counter station${o.count === 1 ? "" : "s"} closed, ${span(o)}`);
  for (const o of s.dockOutages ?? []) out.push(`${o.count} goods door${o.count === 1 ? "" : "s"} out, ${span(o)}`);
  for (const o of s.vanOutages ?? []) out.push(`${o.count} van${o.count === 1 ? "" : "s"} off the road, ${span(o)}`);
  for (const o of s.posOutages ?? []) out.push(`till network down day ${o.day} from ${o.start} for ${o.hours} h`);
  for (const l of s.workerLeave ?? []) out.push(`${l.worker ?? `${l.count ?? 1} × ${l.role}`} away, ${span(l)}`);
  for (const d of s.supplierDelays ?? []) out.push(`${d.supplier ?? d.category ?? "every supplier"} running ${d.extraDays} d late, ${span(d)}`);
  for (const sh of s.demandShocks ?? []) out.push(`${sh.category ?? "all"} demand × ${sh.factor}, ${span(sh)}`);
  if (s.patience !== undefined && s.patience !== 1) out.push(`shopper patience × ${s.patience}`);
  return out;
}
