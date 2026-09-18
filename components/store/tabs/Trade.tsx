"use client";

import { NumField, RowList, TextField, WeekdayPicker, type Column, type HoursRow, type ShockRow, type TabProps } from "../ScenarioPanel";

const shockCols: Array<Column<ShockRow>> = [
  { key: "fromDay", label: "from day", type: "number", min: 0, placeholder: "0" },
  { key: "toDay", label: "to day", type: "number", min: 0, placeholder: "6" },
  { key: "factor", label: "×", type: "number", min: 0, placeholder: "2.1" },
  { key: "category", label: "category", type: "text", list: "store-categories", placeholder: "all" },
];

const hoursCols: Array<Column<HoursRow>> = [
  { key: "day", label: "weekday", type: "number", min: 1, max: 7, placeholder: "1–7" },
  { key: "open", label: "open", type: "time" },
  { key: "close", label: "close", type: "time" },
];

/**
 * What walks through the door, and when the door is open.
 *
 * Demand is candystore's annual dollars for this shop put through the candy
 * calendar, the day of the week and the hour of the day; `demandScale`
 * multiplies the lot, and a shock multiplies one window of days, optionally one
 * category — which is what a Halloween run on chocolate actually looks like.
 * Patience is the one number standing between a long queue and a lost sale.
 */
export default function Trade({ form, update, errors, ctx }: TabProps) {
  const set = <K extends keyof typeof form>(key: K, v: (typeof form)[K]) => update((f) => ({ ...f, [key]: v }));
  return (
    <>
      <h3>Demand</h3>
      <div className="store-fields">
        <NumField label="Demand ×" value={form.demandScale} onChange={(v) => set("demandScale", v)} error={errors.demandScale} placeholder="1" min={0.1} max={5} help="Every shopper's spend and the number of them. 1.2 is a fifth busier." />
        <NumField label="Patience ×" value={form.patience} onChange={(v) => set("patience", v)} error={errors.patience} placeholder="1" min={0.2} max={3} help="How long a shopper stands in a queue before putting the basket down. 0.5 halves it." />
      </div>
      <RowList
        title="Demand shocks"
        help="A run on one category, or a quiet fortnight. Days count from 0, the Monday of the start week."
        rows={form.demandShocks}
        onChange={(rows) => set("demandShocks", rows)}
        blank={{ fromDay: "", toDay: "", factor: "", category: "" }}
        columns={shockCols}
        errors={errors}
        prefix="demandShocks"
        max={20}
        addLabel="Add a shock"
      />

      <h3>Special orders</h3>
      <div className="store-fields">
        <NumField label="Order share" value={form.specialShare} onChange={(v) => set("specialShare", v)} error={errors.specialShare} placeholder="shop's own" min={0} max={0.5} step={0.01} help="Share of the shop's dollars taken as delivery and pickup orders rather than over the counter." />
        <NumField
          label="Delivered share"
          value={form.deliveryShare}
          onChange={(v) => set("deliveryShare", v)}
          error={errors.deliveryShare}
          placeholder="shop's own"
          min={0}
          max={1}
          step={0.05}
          help={ctx.site.vans === 0 ? "This shop has no van: every order is collected whatever this says." : "Share of those orders that ride the van rather than being collected."}
        />
      </div>

      <h3>The clock</h3>
      <div className="store-fields">
        <TextField label="Order cutoff" type="time" value={form.orderCutoff} onChange={(v) => set("orderCutoff", v)} error={errors["times.orderCutoff"]} help="Last minute an order can be taken for the next day." />
        <TextField label="Pick starts" type="time" value={form.pickStart} onChange={(v) => set("pickStart", v)} error={errors["times.pickStart"]} help="When the morning crew starts picking the day's orders. Moving it earlier does nothing unless a shift starts earlier too." />
        <TextField label="Van leaves" type="time" value={form.vanDeparture} onChange={(v) => set("vanDeparture", v)} error={errors["times.vanDeparture"]} />
        <TextField label="Second round" value={form.vanSecondDeparture} onChange={(v) => set("vanSecondDeparture", v)} error={errors["times.vanSecondDeparture"]} placeholder="hh:mm or none" help="An afternoon round; type none to drop it." />
      </div>

      <h3>Trading hours</h3>
      <WeekdayPicker label="Trading days" value={form.operatingDays} onChange={(days) => set("operatingDays", days)} error={errors.operatingDays} help={`The shop trades ${ctx.site.operatingDays.length} days as it stands; leave this blank for its own.`} />
      <RowList title="Hours" help={`As it stands: ${ctx.site.hours}. A row replaces one weekday.`} rows={form.hours} onChange={(rows) => set("hours", rows)} blank={{ day: "", open: "", close: "" }} columns={hoursCols} errors={errors} prefix="hours" max={7} addLabel="Change a day" />
    </>
  );
}
