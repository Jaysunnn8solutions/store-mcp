/**
 * The plain-data half of the worker's `done` message: everything the 3D page
 * needs to label the scene, lifted out of the TwinContext.
 *
 * The context itself must never cross postMessage — it holds Maps, the demand
 * model, the planogram and the schedule, and buildTwin caches and shares it
 * between runs — so this module picks out the fields the page reads and rebuilds
 * them as arrays and records. Every value here is structured-clone safe: no
 * Maps, no classes, no functions, no typed arrays. Only the playback owns
 * buffers, and only the playback is transferred.
 */

import type { SkuInfo, SupplierInfo, WorkerInfo, WorldPayload } from "../trace/types";
import type { TwinContext } from "../twin/twin";
import type { Catalog, CostRates, Worker } from "../twin/types";

/** How many distinct colours the renderer's SKU palette holds. */
export const SKU_COLORS = 12;

/**
 * Static SKU facts, in catalog order.
 *
 * `colorIdx` is by category, not by SKU, so a whole aisle of chocolate reads as
 * one family in the heat views. The categories are sorted before they are
 * numbered: a Map or a Set would hand them back in insertion order, which
 * depends on how the catalog happens to be written, and the colours have to be
 * the same on every machine that replays the same seed.
 */
export function skuInfos(catalog: Catalog): SkuInfo[] {
  const categories = [...new Set(catalog.skus.map((s) => s.category))].sort((a, b) => a.localeCompare(b));
  const colorOf = new Map(categories.map((c, i) => [c, i % SKU_COLORS]));
  return catalog.skus.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    supplier: s.supplier,
    unitRetail: s.unitRetail,
    sellBy: s.sellBy,
    unitsPerInner: s.unitsPerInner,
    innersPerCase: s.innersPerCase,
    fixture: s.fixture,
    colorIdx: colorOf.get(s.category) ?? 0,
  }));
}

/** Suppliers as the scene labels them: the name, and whether they come on the overnight trailer or their own box truck. */
export function supplierInfos(catalog: Catalog): SupplierInfo[] {
  return catalog.suppliers.map((s) => ({ id: s.id, name: s.name, channel: s.channel }));
}

/**
 * Workers as the engine sees them: the effective productivity, cost rate and
 * overtime multiplier operations.ts writes into the init event. A temp works at
 * `costs.tempProductivity` of standard, earns `tempHourly` and gets no overtime
 * premium. buildWorld is built from these, so the scene agrees with the trace by
 * construction rather than by a second calculation that could drift.
 */
export function workerInfos(workers: Worker[], costs: CostRates): WorkerInfo[] {
  return workers.map((w) => ({
    id: w.id,
    role: w.role,
    type: w.type,
    skills: [...w.skills],
    productivity: w.productivity * (w.type === "temp" ? costs.tempProductivity : 1),
    hourlyRate: w.type === "temp" ? costs.tempHourly : w.hourlyRate,
    overtimeMultiplier: w.type === "temp" ? 1 : costs.overtimeMultiplier,
  }));
}

/**
 * Everything the page needs besides the playback. The facings and stockroom
 * positions are narrowed to the fields the inspector reads, because the full
 * Layout carries the whole site and spec twice over.
 */
export function buildWorldPayload(ctx: TwinContext): WorldPayload {
  return {
    skus: skuInfos(ctx.catalog),
    suppliers: supplierInfos(ctx.catalog),
    facings: ctx.layout.facings.map((f) => ({ id: f.id, kind: f.kind, run: f.run, aisle: f.aisle, side: f.side, bay: f.bay, shelf: f.shelf, slot: f.slot, x: f.x, y: f.y, served: f.served })),
    storage: ctx.layout.storage.map((p) => ({ id: p.id, kind: p.kind, run: p.run, aisle: p.aisle, side: p.side, bay: p.bay, level: p.level, x: p.x, y: p.y })),
    layoutName: ctx.layout.spec.name,
    spec: ctx.layout.spec,
    changes: [...ctx.changes],
  };
}
