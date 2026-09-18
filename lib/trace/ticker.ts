/**
 * The ticker: one short sentence per notable event, with a severity the page
 * colours (0 information, 1 worth noticing, 2 a problem).
 *
 * The lines are written the way a shift lead would say them out loud, because
 * the point of the feed is to make the 3D scene legible — a customer walking
 * out of the register line, a shelf that has run dry, a van leaving late and
 * the till network going down are the four things that cost the shop money,
 * and all four are severity 2.
 *
 * The frequent events (every facing change, every customer arriving, every job
 * started) return null: a line a second is not a feed, it is noise. The one
 * job that does earn a line is a restock, because a cart going out is a
 * thirty-a-day event rather than a thousand-a-day one, and it is the shop's
 * answer to the empty shelves the feed has just been complaining about.
 *
 * Names come in through `TickerNames` rather than a catalog import, so the
 * compiler can resolve a SKU, a supplier, a purchase order and an order to
 * whatever the page knows about them and this module stays pure text.
 */

import { clock } from "../twin/standards";
import type { TraceEvent } from "./types";

export interface TickerNames {
  /** SKU id → display name (the id when unknown). */
  sku: (id: string) => string;
  /** Supplier id → name (the id when unknown). */
  supplier: (id: string) => string;
  /** PO id → its supplier's name (the PO id when the PO is unknown). */
  po: (po: string) => string;
  /** Order id → how the shop refers to it (the order id when unknown). */
  order: (id: string) => string;
}

const money = (d: number): string => `$${Math.round(d).toLocaleString("en-US")}`;
const mins = (m: number): string => `${Math.round(m)} min`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const units = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * How late an order has to be before the line turns red. Ten minutes past a
 * promised time is a shop being a shop; half an hour is the customer ringing
 * to ask where their box is, which is the same threshold a truck sitting on
 * the drive gets.
 */
const LATE_ENOUGH_MIN = 30;

/** Text and severity for an event, or null when the event is not worth a line. */
export function tickerLine(e: TraceEvent, names: TickerNames): { text: string; severity: 0 | 1 | 2 } | null {
  switch (e.k) {
    case "init":
      return { text: `Run starts: ${e.storeName}, week ${e.startWeek}, ${plural(e.days, "day")}, seed ${e.seed}.`, severity: 0 };
    case "day":
      return { text: `Day ${e.day + 1}, calendar week ${e.calendarWeek}${e.operating ? "" : " — closed"}.`, severity: 0 };
    case "doors":
      return e.open ? { text: "Doors open.", severity: 1 } : { text: "Doors closed for the day.", severity: 0 };

    case "poPlaced":
      return { text: `${names.supplier(e.supplier)}: ${plural(e.cases, "case")} ordered on ${e.po}, due day ${e.arriveDay + 1}.`, severity: 0 };
    case "truckScheduled":
      return {
        text: `${names.supplier(e.supplier)} ${e.mode === "overnight" ? "trailer" : "box truck"} (${e.po}) booked for ${clock(e.appointment)}, expected ${clock(e.eta)}.`,
        severity: 0,
      };
    case "truckArrive":
      return {
        text: `${names.supplier(e.supplier)} ${e.mode === "overnight" ? "overnight trailer" : "box truck"} (${e.po}) is on the drive with ${plural(e.pallets.length, "pallet")}.`,
        severity: 1,
      };
    case "truckDock":
      // Half an hour on the drive means the goods door was the constraint, not the truck.
      return {
        text: `${names.po(e.po)} truck backs onto ${e.door ?? "the dock"}${e.waitMin > 0.5 ? ` after ${mins(e.waitMin)} waiting` : ""}.`,
        severity: e.waitMin > 30 ? 2 : 0,
      };
    case "truckUndock":
      return { text: `${names.po(e.po)} truck is off and away from the dock.`, severity: 0 };

    case "jobQueued": {
      // The only job that earns a line, and it earns one because a restock is a
      // trip rather than a SKU: a stocker loads a cart with everything the floor
      // is short of and works a run of it, so what the feed wants to know is how
      // much of the floor that one walk puts right. Naming a single SKU would
      // make a cart of eleven facings read like eleven separate errands.
      const info = e.info;
      if (info.kind !== "restock") return null;
      // A hot job is the one-line dash a dry facing earns, so it is the one
      // restock worth naming: the shelf it is for has just been complained
      // about a line or two above.
      if (info.hot) {
        const sku = info.lines[0]?.sku;
        return { text: `${sku ? names.sku(sku) : "An empty facing"}: a stocker drops everything and fetches a box from the back.`, severity: 1 };
      }
      let fill = 0;
      for (const l of info.lines) fill += l.units;
      return { text: `Restock cart out: ${plural(info.lines.length, "facing")} to fill, ${units(fill)} units.`, severity: 0 };
    }

    case "short":
      return e.customer !== null
        ? {
            text: `${names.sku(e.sku)} empty on the shelf — a customer wanted ${units(e.units)} more${e.hot ? "; restock called" : ""}.`,
            severity: 2,
          }
        : {
            text: `${names.order(e.order ?? "")} cut ${units(e.units)} of ${names.sku(e.sku)}: none on the shelf or in the back.`,
            severity: 2,
          };

    case "counterDone":
      // Only a wait worth complaining about earns a line; the rest is the job.
      return e.waitMin >= 8 ? { text: `Showcase queue: ${mins(e.waitMin)} before a clerk got to them.`, severity: e.waitMin >= 15 ? 2 : 1 } : null;
    case "sale":
      return e.waitMin >= 8 ? { text: `Register queue: ${mins(e.waitMin)} to pay on a ${money(e.dollars)} basket.`, severity: e.waitMin >= 15 ? 2 : 1 } : null;
    case "abandon":
      return {
        text: `Customer left the ${e.at === "register" ? "register" : "showcase"} line after ${mins(e.waitMin)} — ${money(e.dollars)} basket.`,
        severity: 2,
      };

    case "orderPlaced":
      return {
        text: `${e.kind === "delivery" ? "Delivery" : "Collection"} order ${e.order} taken for day ${e.dueDay + 1}: ${plural(e.lines.length, "line")}, ${money(e.dollars)}.`,
        severity: 0,
      };
    case "orderPicked":
      return { text: `${names.order(e.order)} picked: ${plural(e.lines, "line")}, ${units(e.units)} units.`, severity: 0 };
    case "orderPacked":
      return { text: `${names.order(e.order)} packed${e.wrap ? " and gift-wrapped" : ""}.`, severity: 0 };
    case "orderCut":
      return { text: `${names.order(e.order)} short-shipped: ${plural(e.lines, "line")} cut, ${money(e.dollars)} of it.`, severity: 2 };
    case "orderLate":
      return {
        text: `${names.order(e.order)} is ${mins(e.lateMin)} late (${e.reason === "notPicked" ? "never picked" : e.reason === "notPacked" ? "not packed in time" : "missed the van"}).`,
        severity: 2,
      };
    case "vanDepart":
      return e.lateMin > 0
        ? { text: `Van round left ${mins(e.lateMin)} late with ${plural(e.orders.length, "order")}.`, severity: 2 }
        : { text: `Van round away on time with ${plural(e.orders.length, "order")}, ${plural(e.stops, "stop")}.`, severity: 1 };
    case "vanReturn":
      return { text: `Van back at the shop after ${mins(e.minutes)}.`, severity: 0 };
    case "orderOut": {
      // The one line that says what actually left the shop, and the only place
      // the feed can say it: `orderOut` is the engine's single statement of an
      // order's units, dollars and lateness. `orderLate` says why a promise was
      // missed; this says what the customer ended up with.
      const got = `${units(e.units)} units, ${money(e.dollars)}`;
      const late = e.lateMin > 0 ? `, ${mins(e.lateMin)} behind the promise` : "";
      return {
        text: `${names.order(e.order)} ${e.kind === "delivery" ? "away on the van" : "on the collection shelf"}: ${got}${late}.`,
        severity: e.lateMin >= LATE_ENOUGH_MIN ? 2 : e.lateMin > 0 ? 1 : 0,
      };
    }
    case "orderCollected":
      // The `orderOut` line lands in the same minute with the money on it, and
      // a feed that says the same thing twice is a feed nobody reads.
      return null;

    case "worker":
      switch (e.state) {
        case "in":
          return { text: `${e.id} clocks in${e.shift ? ` on ${e.shift}` : ""} as ${e.primary ?? "crew"}.`, severity: 0 };
        case "absent":
          return { text: `${e.id} is away today — the shift is a head short.`, severity: 2 };
        case "break":
          return { text: `${e.id} takes a ${Math.round(e.breakMin ?? 0)} min break.`, severity: 0 };
        case "out":
          return (e.overtimeMin ?? 0) > 0.5
            ? { text: `${e.id} clocks out ${mins(e.overtimeMin ?? 0)} past the end of the shift.`, severity: 1 }
            : { text: `${e.id} clocks out.`, severity: 0 };
        default:
          return null;
      }

    case "pos":
      return e.down
        ? { text: `Till network down until ${clock(e.until ?? e.t)} — nothing can be rung up.`, severity: 2 }
        : { text: "Till network back up.", severity: 1 };
    case "end":
      return { text: "Horizon reached.", severity: 0 };

    default:
      // jobStart/jobEnd, facing, putaway, customerArrive/Shop/Leave,
      // counterJoin, queueJoin and vanLoad happen hundreds of times a day.
      return null;
  }
}
