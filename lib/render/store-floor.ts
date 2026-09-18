/**
 * The one place that decides what a store plan should be shaded by, so the web
 * page, the import workbench and the local `render_floor` tool all draw the
 * same picture from the same numbers.
 *
 * It sits here rather than in floor.ts because floor.ts knows only geometry: it
 * takes a bag of per-facing values and paints them. What those values mean —
 * dollars off a bay, trips to fill it, the merchandising worth of its shelves —
 * is a domain question, and this is the seam where the twin answers it. The
 * reference project's twin-floor.ts plays exactly this part for the DC.
 */

import { FIXTURE_APPEAL, shelfAppeal, type Layout } from "../twin/layout";
import { renderFloorHtml, renderFloorSvg, type FloorOptions } from "./floor";

/**
 * What the wrapper needs to draw a store. Only `layout` is required; a caller
 * that has not run the twin yet — the import workbench, looking at a drawing it
 * has just parsed — passes the layout alone and gets the appeal shading, which
 * is a property of the building and needs no simulation.
 */
export interface StoreFloorInput {
  layout: Layout;
  /** Retail dollars taken off each facing over the run, by `Facing.id`. */
  salesByFacing?: Map<string, number>;
  /** How many times each facing was filled over the run, by `Facing.id`. */
  restocksByFacing?: Map<string, number>;
  /** Heading above the plan; the store's own name when omitted. */
  title?: string;
}

/**
 * The merchandising worth of every facing in the layout: what the fixture
 * family does to a SKU's sales, times what the shelf height does to it. It is
 * the quantity `optimize_merchandising` ranks slots by, so shading a plan with
 * it shows at a glance which bays are worth arguing over.
 */
export function appealByFacing(layout: Layout): Map<string, number> {
  const shelvesByRun = new Map<string, number>();
  for (const run of layout.spec.fixtures) shelvesByRun.set(run.id, run.shelves);
  const out = new Map<string, number>();
  for (const f of layout.facings) {
    const shelves = shelvesByRun.get(f.run) ?? f.shelf;
    out.set(f.id, FIXTURE_APPEAL[f.kind] * shelfAppeal(f.shelf, shelves));
  }
  return out;
}

/**
 * Pick the shading, and the numbers behind it.
 *
 * With no run behind it the plan is left unshaded, because shading every bay
 * buries the thing a store plan is mostly for — which fixture is which. Sales
 * win over restocks when both are in hand, since dollars are what a merchandiser
 * argues about. A caller who explicitly asks for `shadeBy: "appeal"` gets the
 * appeal map computed for them, because that one needs no simulation.
 */
function shading(input: StoreFloorInput, opts: FloorOptions): Pick<FloorOptions, "shadeBy" | "values"> {
  if (opts.shadeBy === "appeal" && !opts.values) return { shadeBy: "appeal", values: appealByFacing(input.layout) };
  if (opts.shadeBy !== undefined) return {};
  if (input.salesByFacing && input.salesByFacing.size > 0) return { shadeBy: "sales", values: input.salesByFacing };
  if (input.restocksByFacing && input.restocksByFacing.size > 0) return { shadeBy: "restocks", values: input.restocksByFacing };
  return {};
}

/** The store's plan, shaded by the best value the caller has. */
export function storeFloorSvg(input: StoreFloorInput, opts: FloorOptions = {}): string {
  return renderFloorSvg(input.layout, { width: 640, title: input.title, ...opts, ...shading(input, opts) });
}

/** The same plan as a standalone HTML file, for the local `render_floor` tool. */
export function storeFloorHtml(input: StoreFloorInput, opts: FloorOptions = {}): string {
  return renderFloorHtml(input.layout, { width: 1040, title: input.title, ...opts, ...shading(input, opts) });
}
