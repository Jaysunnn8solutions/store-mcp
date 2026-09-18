"use client";

import { NumField, SelectField, type FormContext, type StoreForm, type TabProps } from "../ScenarioPanel";

/**
 * The gondola block as the form would re-fixture it, and the first reason it
 * would not fit.
 *
 * The check is the one the building itself imposes: a run is `depthFt` across
 * and needs an aisle beside it, so N runs need N × (depth + aisle) feet of
 * sales floor. Saying so here, before the run, turns a LimitError from the
 * worker thirty seconds later into a sentence next to the field that caused it.
 *
 * Exported so the workbench can call it before every run — a tab owning its own
 * pre-flight is the only way the check and the fields stay in step.
 */
export function floorCheck(form: StoreForm, ctx: FormContext): { facings: number; error: string | null } {
  const g = ctx.gondolas;
  if (!g) return { facings: 0, error: null };
  const n = (text: string, fallback: number) => {
    const v = Number(text.trim());
    return text.trim() === "" || !Number.isFinite(v) ? fallback : v;
  };
  const runs = n(form.runs, g.runs);
  const bays = n(form.baysPerRun, g.baysPerRun);
  const shelves = n(form.shelves, g.shelves);
  const perBay = n(form.facingsPerBay, g.facingsPerBay);
  const aisle = n(form.aisleWidthFt, g.aisleWidthFt);
  // Both sides of a gondola sell, so a run carries twice its bays' worth.
  const facings = Math.max(0, Math.round(runs * bays * shelves * perBay * 2));
  const needed = runs * (g.depthFt + aisle);
  const room = ctx.site.widthFt - g.originX;
  if (needed > room) {
    return { facings, error: `${runs} runs ${g.depthFt} ft deep with ${aisle} ft aisles need ${Math.round(needed)} ft across the sales floor; there are ${Math.round(room)} ft. Take out a run, or narrow the aisles.` };
  }
  return { facings, error: null };
}

/**
 * The building: how the candy is merchandised, and how many of everything the
 * shop has.
 *
 * Merchandising is the quiet one. Eye level is buy level, so where a SKU sits
 * sets its share of the shop's dollars — but the model normalises that to a
 * mean of 1 across the assortment, so re-merchandising moves the *mix* and
 * never the total. Its value shows up as fewer lost sales: a facing sized to
 * four days of demand empties less often than one sized to the fixture.
 */
export default function Floor({ form, update, errors, ctx }: TabProps) {
  const set = <K extends keyof typeof form>(key: K, v: (typeof form)[K]) => update((f) => ({ ...f, [key]: v }));
  const check = floorCheck(form, ctx);
  return (
    <>
      <h3>Merchandising</h3>
      <div className="store-fields">
        <SelectField
          label="Planogram"
          value={form.merchandising}
          onChange={(v) => set("merchandising", v)}
          error={errors.merchandising}
          options={[
            { value: "", label: "leave as it is" },
            { value: "current", label: "current: the shop as merchandised" },
            { value: "optimized", label: "optimized: fastest movers at eye level" },
          ]}
        />
        <NumField label="Facing days" value={form.facingDays} onChange={(v) => set("facingDays", v)} error={errors.facingDays} placeholder="fixture's own" min={0.5} max={21} step={0.5} help="Days of demand a facing is sized to hold. Only bites with the optimized planogram: the shop as it is has whatever facing the fixture gives it." />
      </div>

      <h3>The counter and the tills</h3>
      <div className="store-fields">
        <NumField label="Registers" value={form.registers} onChange={(v) => set("registers", v)} error={errors.registers} placeholder={String(ctx.site.registers)} min={1} max={12} help="A lane with nobody standing at it only costs money." />
        <NumField label="Counter stations" value={form.counters} onChange={(v) => set("counters", v)} error={errors.counters} placeholder={String(ctx.site.counters)} min={0} max={8} help={ctx.site.counters === 0 ? "This shop has no showcase, so this is ignored." : "Serving positions behind the showcase glass."} />
      </div>

      <h3>Equipment and doors</h3>
      <div className="store-fields">
        <NumField label="Stock carts" value={form.stockCarts} onChange={(v) => set("stockCarts", v)} error={errors.stockCarts} placeholder={String(ctx.site.stockCarts)} min={1} max={20} help="A restock is a trip with a loaded cart, not one SKU at a time." />
        <NumField label="Pallet jacks" value={form.palletJacks} onChange={(v) => set("palletJacks", v)} error={errors.palletJacks} placeholder={String(ctx.site.palletJacks)} min={0} max={6} />
        <NumField label="Vans" value={form.vans} onChange={(v) => set("vans", v)} error={errors.vans} placeholder={String(ctx.site.vans)} min={0} max={6} />
        <NumField label="Raised docks" value={form.docks} onChange={(v) => set("docks", v)} error={errors.docks} placeholder={String(ctx.site.docks)} min={0} max={6} />
        <NumField label="Ground doors" value={form.groundDoors} onChange={(v) => set("groundDoors", v)} error={errors.groundDoors} placeholder={String(ctx.site.groundDoors)} min={0} max={6} help="The roll-up a vendor's box truck unloads through." />
      </div>

      <h3>The gondola block</h3>
      {ctx.imported ? (
        <p className="store-caveat">A plan was imported, so the drawing&apos;s own fixtures are used and these are ignored.</p>
      ) : (
        <>
          <div className="store-fields">
            <NumField label="Runs" value={form.runs} onChange={(v) => set("runs", v)} error={errors["fixtures.runs"]} placeholder={String(ctx.gondolas?.runs ?? "")} min={1} max={20} />
            <NumField label="Bays per run" value={form.baysPerRun} onChange={(v) => set("baysPerRun", v)} error={errors["fixtures.baysPerRun"]} placeholder={String(ctx.gondolas?.baysPerRun ?? "")} min={2} max={40} />
            <NumField label="Shelves" value={form.shelves} onChange={(v) => set("shelves", v)} error={errors["fixtures.shelves"]} placeholder={String(ctx.gondolas?.shelves ?? "")} min={2} max={8} />
            <NumField label="Facings per bay" value={form.facingsPerBay} onChange={(v) => set("facingsPerBay", v)} error={errors["fixtures.facingsPerBay"]} placeholder={String(ctx.gondolas?.facingsPerBay ?? "")} min={1} max={8} />
            <NumField label="Aisle width, ft" value={form.aisleWidthFt} onChange={(v) => set("aisleWidthFt", v)} error={errors["fixtures.aisleWidthFt"]} placeholder={String(ctx.gondolas?.aisleWidthFt ?? "")} min={2.5} max={14} step={0.5} />
          </div>
          <p className={check.error ? "store-err" : "sub"} style={{ margin: 0 }}>
            {check.error ?? `About ${check.facings.toLocaleString("en-US")} gondola facings, both sides, for ${ctx.skuCount.toLocaleString("en-US")} SKUs — plus the walls, the bulk bins, the endcaps, the tables and the showcase.`}
          </p>
        </>
      )}
    </>
  );
}
