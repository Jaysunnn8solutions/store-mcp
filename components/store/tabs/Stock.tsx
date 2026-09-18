"use client";

import { NumField, RowList, SelectField, TextField, WeekdayPicker, type Column, type SupplierDelayRow, type SupplierOverrideRow, type TabProps } from "../ScenarioPanel";

const delayCols: Array<Column<SupplierDelayRow>> = [
  { key: "fromDay", label: "from day", type: "number", min: 0 },
  { key: "toDay", label: "to day", type: "number", min: 0 },
  { key: "supplier", label: "supplier", type: "text", list: "store-suppliers", placeholder: "any" },
  { key: "category", label: "or category", type: "text", list: "store-categories", placeholder: "any" },
  { key: "extraDays", label: "+days", type: "number", min: 1, max: 60, placeholder: "3" },
];

const overrideCols: Array<Column<SupplierOverrideRow>> = [
  { key: "supplier", label: "supplier", type: "text", list: "store-suppliers" },
  { key: "leadDays", label: "lead", type: "number", min: 0, max: 120 },
  { key: "leadSdDays", label: "sd", type: "number", min: 0, max: 60 },
  { key: "orderDay", label: "order day", type: "number", min: 1, max: 7 },
  {
    key: "channel",
    label: "channel",
    type: "select",
    options: [
      { value: "dc", label: "through the DC" },
      { value: "direct", label: "direct from the vendor" },
    ],
  },
];

/**
 * What the shop buys and when it turns up.
 *
 * The buy is periodic review to an order-up-to level: mean demand over the
 * review and the lead time, plus a safety term set by the service level. The
 * shop orders in display boxes rather than master cases, because a master case
 * of a fast mover is a month of stock for one shop and ordering in cases is how
 * shelves quietly run down.
 */
export default function Stock({ form, update, errors, ctx }: TabProps) {
  const set = <K extends keyof typeof form>(key: K, v: (typeof form)[K]) => update((f) => ({ ...f, [key]: v }));
  return (
    <>
      <h3>Buying policy</h3>
      <div className="store-fields">
        <SelectField
          label="Forecast"
          value={form.forecast}
          onChange={(v) => set("forecast", v)}
          error={errors.forecast}
          options={[
            { value: "", label: "leave as it is" },
            { value: "seasonal", label: "seasonal: the candy calendar" },
            { value: "trailing", label: "trailing: recent weeks only" },
          ]}
          help="Trailing is what a shop without a calendar does — and why it is short the week before Halloween."
        />
        <NumField label="Service level" value={form.serviceLevel} onChange={(v) => set("serviceLevel", v)} error={errors.serviceLevel} placeholder="0.95" min={0.5} max={0.999} step={0.01} help="Cover against a late trailer and a busy week. It costs carrying; check the stockroom before keeping it." />
      </div>

      <h3>Suppliers</h3>
      <RowList title="Delays" help={`${ctx.supplierIds.length || "–"} suppliers. A window of days where deliveries take longer; leave both names blank for all of them.`} rows={form.supplierDelays} onChange={(rows) => set("supplierDelays", rows)} blank={{ fromDay: "", toDay: "", supplier: "", category: "", extraDays: "" }} columns={delayCols} errors={errors} prefix="supplierDelays" max={20} addLabel="Delay a supplier" />
      <RowList title="Overrides" help="Lead time, its variability, the day of the week an order goes out, and whether the goods come through the distribution center or off a vendor's own tailgate." rows={form.supplierOverrides} onChange={(rows) => set("supplierOverrides", rows)} blank={{ supplier: "", leadDays: "", leadSdDays: "", orderDay: "", channel: "" }} columns={overrideCols} errors={errors} prefix="supplierOverrides" max={20} addLabel="Override a supplier" />

      <h3>Goods in</h3>
      <WeekdayPicker label="Trailer days" value={form.dcDeliveryDays} onChange={(days) => set("dcDeliveryDays", days)} error={errors.dcDeliveryDays} help="Which days the distribution center's trailer calls. Blank leaves the shop's own." />
      <div className="store-fields">
        <TextField label="Overnight from" type="time" value={form.overnightFrom} onChange={(v) => set("overnightFrom", v)} error={errors["times.overnightWindow"]} help="The window the trailer may arrive in, before the doors open." />
        <TextField label="Overnight to" type="time" value={form.overnightTo} onChange={(v) => set("overnightTo", v)} />
        <TextField label="Vendors from" type="time" value={form.directFrom} onChange={(v) => set("directFrom", v)} error={errors["times.directWindow"]} help="When a vendor's own box truck may call, during the trading day." />
        <TextField label="Vendors to" type="time" value={form.directTo} onChange={(v) => set("directTo", v)} />
      </div>
      <p className="store-caveat">Both ends of a window are needed for it to count; one alone is ignored.</p>
    </>
  );
}
