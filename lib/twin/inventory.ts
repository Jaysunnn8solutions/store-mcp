/**
 * Inventory: what is on the shelf, what is in the stockroom, what is on order,
 * and when the buyer reorders.
 *
 * The buying policy is the distribution center's, because a shop buys the way
 * a warehouse does: periodic review, order-up-to, one review day a week per
 * supplier, quantities rounded up to master cases. What changes is where the
 * stock sits and who takes it. A distribution center has a pick face and a
 * reserve, and a picker serves both. A store has a shelf facing that customers
 * help themselves from and a stockroom behind a door they never open, so every
 * SKU's on-hand splits in two and somebody has to carry stock from the back to
 * the front.
 *
 * That split is what turns a cut into a lost sale. In the DC a line that could
 * not be filled is cut and the store buys short. Here it is a customer reaching
 * for an empty facing: nobody backorders a chocolate bar, so the sale is simply
 * lost, exactly as a cut is. The dollars are counted anyway, because they are
 * what a deeper facing or a bigger stockroom has to earn back.
 *
 * Quantities are selling units throughout — pieces for an `each` SKU, pounds
 * for a `weight` one. Buying stays in master cases, since that is what a
 * supplier ships and what a pallet is built from.
 *
 * The book is shared. `runInventory` at the bottom of this file drives it a day
 * at a time, for stock questions that run out to Halloween; operations.ts
 * drives the same object minute by minute, through restock trips, registers and
 * the pick bench.
 */

import { normal, normalQuantile, substream, type Rng } from "../util/random";
import { expectedDailyUnits, weekdayOf, type DemandModel } from "./demand";
import { calendarWeekOfDay } from "./season";
import { DEFAULT_STANDARDS } from "./standards";
import type { Catalog, Sku, Supplier } from "./types";

export type ForecastMethod = "seasonal" | "trailing";

export interface InventoryPolicy {
  forecast: ForecastMethod;
  /** Cycle service level behind the safety stock, 0.5–0.999. */
  serviceLevel: number;
}

/**
 * The buyer with a seasonal plan. "trailing" is the other kind of buyer — the
 * one who averages what just sold, and so meets Halloween with September's
 * order.
 */
export const DEFAULT_POLICY: InventoryPolicy = { forecast: "seasonal", serviceLevel: 0.97 };

/** Extra lead time for a supplier (or every supplier of a category) on orders placed in a window. */
export interface SupplierDelay {
  supplier?: string;
  category?: string;
  extraDays: number;
  fromDay: number;
  toDay: number;
}

export interface PurchaseOrder {
  id: string;
  supplier: string;
  /** How it arrives: "dc" on the overnight trailer, "direct" on a vendor's box truck in the trading day. */
  channel: "dc" | "direct";
  placedDay: number;
  arriveDay: number;
  lines: Array<{ sku: string; cases: number; units: number }>;
  cases: number;
  /** Pallets to break down; 0 on a direct delivery, which comes off the tailgate as loose cases. */
  pallets: number;
}

export interface InboundPallet {
  items: Array<{ sku: string; cases: number }>;
  mixed: boolean;
}

/**
 * How a shipment is built: full pallets of one SKU where the quantity allows,
 * and the remainders consolidated onto mixed pallets by cube (first fit, in PO
 * order). A mixed pallet is broken down at the dock and each SKU on it is put
 * away separately, which is why the flag is worth carrying.
 */
export function buildPallets(lines: ReadonlyArray<{ sku: string; cases: number }>, skus: Map<string, Sku>, palletCubeFt: number): InboundPallet[] {
  const pallets: InboundPallet[] = [];
  const mixed: Array<{ items: Array<{ sku: string; cases: number }>; cube: number }> = [];
  for (const l of lines) {
    const sku = skus.get(l.sku);
    if (!sku) continue;
    const full = Math.floor(l.cases / sku.casesPerPallet);
    for (let i = 0; i < full; i++) pallets.push({ items: [{ sku: l.sku, cases: sku.casesPerPallet }], mixed: false });
    const rest = l.cases - full * sku.casesPerPallet;
    if (rest <= 0) continue;
    const cube = rest * sku.innersPerCase * sku.innerCubeFt;
    const target = mixed.find((m) => m.cube + cube <= palletCubeFt);
    if (target) {
      target.items.push({ sku: l.sku, cases: rest });
      target.cube += cube;
    } else {
      mixed.push({ items: [{ sku: l.sku, cases: rest }], cube });
    }
  }
  for (const m of mixed) pallets.push({ items: m.items, mixed: m.items.length > 1 });
  return pallets;
}

/** Pallet counts on purchase orders are for reporting; operations.ts rebuilds them with the scenario's standards. */
const PALLET_CUBE_FT = DEFAULT_STANDARDS.palletCubeFt;

/** How long the history behind the trailing forecast is, days. */
const HISTORY_DAYS = 28;

export interface SkuState {
  sku: Sku;
  /** Selling units on the shelf, where a customer can take them. */
  onFacing: number;
  /** Selling units in the stockroom, which only staff can reach. */
  onHandBack: number;
  onOrder: number;
  /** Selling units sold per day, most recent last, capped at 28 entries. */
  history: number[];
  soldToday: number;
}

export interface InventoryTotals {
  soldUnits: number;
  soldDollars: number;
  /** Selling units a customer wanted and the shelf did not have. */
  lostUnits: number;
  /** Lines where nothing at all was there — the empty facing, not the short one. */
  lostLines: number;
  lostDollars: number;
  lines: number;
  receipts: number;
  receivedPallets: number;
  receivedCases: number;
}

export class InventoryBook {
  /**
   * Every SKU the store stocks, sorted by id. The order is fixed and data-led
   * rather than insertion-led, because passes over it place orders and draw
   * lead times, and a run has to replay.
   */
  readonly skus: SkuState[];
  readonly skuMap: Map<string, SkuState>;
  readonly suppliers: Map<string, Supplier>;
  readonly open: PurchaseOrder[] = [];
  readonly totals: InventoryTotals = {
    soldUnits: 0,
    soldDollars: 0,
    lostUnits: 0,
    lostLines: 0,
    lostDollars: 0,
    lines: 0,
    receipts: 0,
    receivedPallets: 0,
    receivedCases: 0,
  };
  /** Lost selling units by SKU, for stockout reports. */
  readonly lostBySku = new Map<string, number>();
  /** The catalog's SKU records, including ones this store does not carry, for pallet building. */
  private readonly catalogSkus: Map<string, Sku>;
  /** Suppliers in id order, for the same reason `skus` is sorted. */
  private readonly supplierList: Supplier[];
  private readonly rng: Rng;
  private poSeq = 0;

  constructor(
    readonly model: DemandModel,
    catalog: Catalog,
    readonly policy: InventoryPolicy,
    readonly startWeek: number,
    readonly delays: SupplierDelay[],
    seed: number,
    /** Selling units each SKU's facing holds when it is full; no entry means the SKU is not merchandised. */
    readonly facingCap: Map<string, number>
  ) {
    // A shop only stocks what it sells. A catalog SKU in a category this store
    // does not carry never reaches its shelves, so it is not in its book.
    const stocked = catalog.skus.filter((s) => model.skuById.has(s.id)).sort((a, b) => a.id.localeCompare(b.id));
    this.skus = stocked.map((sku) => ({ sku, onFacing: 0, onHandBack: 0, onOrder: 0, history: [], soldToday: 0 }));
    this.skuMap = new Map(this.skus.map((s) => [s.sku.id, s]));
    this.catalogSkus = new Map(catalog.skus.map((s) => [s.id, s]));
    this.suppliers = new Map(catalog.suppliers.map((s) => [s.id, s]));
    this.supplierList = [...catalog.suppliers].sort((a, b) => a.id.localeCompare(b.id));
    this.rng = substream(seed, `inventory-${model.site.id}`);
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  private stateFor(sku: string): SkuState {
    const s = this.skuMap.get(sku);
    if (!s) throw new Error(`SKU "${sku}" is not in this store's book. It sells: ${this.skus.length} SKUs from its own categories.`);
    return s;
  }

  private supplierFor(sku: Sku): Supplier {
    const s = this.suppliers.get(sku.supplier);
    if (!s) throw new Error(`SKU "${sku.id}" names supplier "${sku.supplier}", which is not in the catalog.`);
    return s;
  }

  /** Selling units in one master case: pieces for an "each" SKU, pounds for a "weight" one. */
  private unitsPerCase(sku: Sku): number {
    return sku.innersPerCase * sku.unitsPerInner;
  }

  private cap(sku: string): number {
    return this.facingCap.get(sku) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Buying
  // -------------------------------------------------------------------------

  /** Review interval plus lead time: everything the order placed today has to cover. */
  private protectionDays(supplier: Supplier): number {
    return 7 + supplier.leadDays;
  }

  /**
   * The quantity a shop buys in, in selling units.
   *
   * A distribution center buys master cases from the maker and breaks them; a
   * shop does not. The distribution center picks **display boxes** — inners —
   * and sends them on a mixed pallet, so one display box is the shop's order
   * increment. A vendor calling with their own box truck still hands down
   * whole cases off the tailgate.
   *
   * This matters far more than it looks. A master case of a fast mover is
   * eight display boxes, which at one shop's rate is a month of stock — more
   * than the order-up-to level itself. Rounding orders up to whole cases
   * therefore had the shop order almost nothing at all and run its shelves
   * quietly down, which is exactly what it did before this was fixed.
   */
  private buyUnit(sku: Sku, supplier: Supplier): number {
    return supplier.channel === "dc" ? Math.max(1, sku.unitsPerInner) : Math.max(1, this.unitsPerCase(sku));
  }

  /**
   * Order-up-to level for a SKU on horizon day `day`, in selling units.
   *
   * `seasonalDaily` is the forecast for this supplier's protection period,
   * computed once per review and handed in. Without it the forecast is rebuilt
   * for every SKU, which is fine for a one-off question and far too slow inside
   * a 26-week run.
   */
  orderUpTo(state: SkuState, day: number, seasonalDaily?: Map<string, number>): number {
    const supplier = this.supplierFor(state.sku);
    const P = this.protectionDays(supplier);
    let daily: number;
    if (this.policy.forecast === "trailing" && state.history.length >= 7) {
      daily = state.history.reduce((a, b) => a + b, 0) / state.history.length;
    } else {
      daily = (seasonalDaily ?? expectedDailyUnits(this.model, day, P, this.startWeek)).get(state.sku.id) ?? 0;
    }
    const mu = daily * P;
    const z = normalQuantile(this.policy.serviceLevel);
    // One SKU's retail demand is lumpier than Poisson — a birthday party clears
    // a bin, a display gets bought out for an office — so the variance carries
    // an index of dispersion of 2. It is a calibration choice against the
    // sampled baskets, not physics.
    const sigma = Math.sqrt(2 * mu + Math.pow(daily * supplier.leadSdDays, 2));
    return mu + z * sigma;
  }

  /**
   * The next day this supplier's goods can actually be taken in. The
   * distribution center's trailer calls only on the store's scheduled delivery
   * days; a vendor's own box truck comes any day the shop trades. Either way
   * somebody has to be there to sign for it, so a dark day pushes it on.
   */
  private nextDeliveryDay(supplier: Supplier, day: number): number {
    const site = this.model.site;
    for (let d = day; d < day + 14; d++) {
      const wd = weekdayOf(d);
      if (!site.operatingDays.includes(wd)) continue;
      if (supplier.channel === "dc" && !site.dcDeliveryDays.includes(wd)) continue;
      return d;
    }
    // A store with no receiving day in a fortnight is a data problem, not a
    // delivery problem. Take the day as given rather than search forever.
    return day;
  }

  private makePo(supplier: Supplier, placedDay: number, arriveDay: number, lines: PurchaseOrder["lines"]): PurchaseOrder {
    // A trailer from the distribution center comes palletized and is broken
    // down at the dock; a direct vendor hands cases down off a tailgate, so
    // there is nothing to count as a pallet.
    const pallets = supplier.channel === "dc" ? buildPallets(lines, this.catalogSkus, PALLET_CUBE_FT).length : 0;
    return {
      id: `PO-${this.model.site.id}-${++this.poSeq}`,
      supplier: supplier.id,
      channel: supplier.channel,
      placedDay,
      arriveDay,
      lines,
      cases: lines.reduce((a, l) => a + l.cases, 0),
      pallets,
    };
  }

  /**
   * Start in steady state rather than empty: stock at safety plus half a review
   * cycle, the facings filled from it and the rest put in the back, and the
   * weekly orders from earlier reviews still in transit, so a 21-day importer
   * does not open the horizon with three weeks of nothing arriving.
   */
  initialize(day: number) {
    for (const supplier of this.supplierList) {
      const daily = expectedDailyUnits(this.model, day, this.protectionDays(supplier), this.startWeek);
      const lines: PurchaseOrder["lines"] = [];
      const pipelineWeeks = Math.floor(supplier.leadDays / 7);
      for (const state of this.skus) {
        if (state.sku.supplier !== supplier.id) continue;
        const S = this.orderUpTo(state, day, daily);
        const d = daily.get(state.sku.id) ?? 0;
        const total = Math.max(0, Math.round(S - d * (supplier.leadDays + 3.5)));
        // The floor is stocked first. A full stockroom sells nothing on its
        // own, and a store that opened with empty facings would spend the
        // warm-up losing sales it would never really have lost.
        state.onFacing = Math.min(this.cap(state.sku.id), total);
        state.onHandBack = total - state.onFacing;
        const per = this.unitsPerCase(state.sku);
        const buy = this.buyUnit(state.sku, supplier);
        const weekly = per > 0 && buy > 0 ? Math.ceil((7 * d) / buy) * buy : 0;
        if (weekly > 0) lines.push({ sku: state.sku.id, cases: weekly / per, units: weekly });
      }
      if (lines.length === 0) continue;
      for (let k = 0; k < pipelineWeeks; k++) {
        const arrive = this.nextDeliveryDay(supplier, day + supplier.leadDays - 7 * k);
        const po = this.makePo(
          supplier,
          arrive - supplier.leadDays,
          arrive,
          lines.map((l) => ({ ...l }))
        );
        this.open.push(po);
        for (const l of po.lines) this.stateFor(l.sku).onOrder += l.units;
      }
    }
  }

  private extraLead(supplier: Supplier, day: number): number {
    let extra = 0;
    for (const d of this.delays) {
      if (day < d.fromDay || day > d.toDay) continue;
      if (d.supplier && d.supplier !== supplier.id) continue;
      if (d.category && !this.skus.some((s) => s.sku.supplier === supplier.id && s.sku.category === d.category)) continue;
      extra = Math.max(extra, d.extraDays);
    }
    return extra;
  }

  /** Place purchase orders for the suppliers whose order day this is. */
  review(day: number): PurchaseOrder[] {
    const wd = weekdayOf(day);
    const placed: PurchaseOrder[] = [];
    for (const supplier of this.supplierList) {
      if (supplier.orderDay !== wd) continue;
      // Computed for "trailing" too: it is the fallback until a SKU has a week of history.
      const daily = expectedDailyUnits(this.model, day, this.protectionDays(supplier), this.startWeek);
      const lines: PurchaseOrder["lines"] = [];
      for (const state of this.skus) {
        if (state.sku.supplier !== supplier.id) continue;
        const S = this.orderUpTo(state, day, daily);
        // Everything in the building counts against the target, shelf and
        // stockroom alike: a full facing is stock the buyer already owns.
        const position = state.onFacing + state.onHandBack + state.onOrder;
        if (position >= S) continue;
        const per = this.unitsPerCase(state.sku);
        const buy = this.buyUnit(state.sku, supplier);
        if (per <= 0 || buy <= 0) continue;
        const qty = Math.ceil((S - position) / buy);
        if (qty <= 0) continue;
        const units = qty * buy;
        // `cases` is master-case equivalents, so a shop's order is usually a
        // fraction of one. It is what sizes the pallet cube and the handling.
        lines.push({ sku: state.sku.id, cases: units / per, units });
        state.onOrder += units;
      }
      if (lines.length === 0) continue;
      const lead = Math.max(1, Math.round(normal(this.rng, supplier.leadDays, supplier.leadSdDays))) + this.extraLead(supplier, day);
      const po = this.makePo(supplier, day, this.nextDeliveryDay(supplier, day + lead), lines);
      this.open.push(po);
      placed.push(po);
    }
    return placed;
  }

  /** Purchase orders due to arrive on `day`, removed from the open list. */
  arrivals(day: number): PurchaseOrder[] {
    const due = this.open.filter((p) => p.arriveDay === day);
    for (const p of due) this.open.splice(this.open.indexOf(p), 1);
    return due;
  }

  // -------------------------------------------------------------------------
  // Moving stock
  // -------------------------------------------------------------------------

  /**
   * Goods land in the stockroom. Nothing is sellable until somebody carries it
   * out to a facing — in the day model that happens in the same tick, in
   * operations.ts it costs a trip and a pair of hands.
   */
  receive(sku: string, units: number) {
    const s = this.stateFor(sku);
    s.onHandBack += units;
    s.onOrder = Math.max(0, s.onOrder - units);
  }

  /** Selling units the facing is short of full, whether or not the back can cover them. */
  restockNeed(sku: string): number {
    const s = this.stateFor(sku);
    return Math.max(0, this.cap(sku) - s.onFacing);
  }

  /** Stockroom to facing, capped by the facing and by what is in the back. Returns the units moved. */
  restock(sku: string, units: number): number {
    const s = this.stateFor(sku);
    const room = Math.max(0, this.cap(sku) - s.onFacing);
    const want = Math.min(units, room, s.onHandBack);
    if (want <= 0) return 0;
    // Stock leaves the back by the case, so a trip carries whole cases wherever
    // the shelf has room for them. The last case is split rather than left
    // unopened: a stocker works what fits and takes the remainder back, which is
    // why a facing fills exactly to its cap and never past it.
    const per = this.unitsPerCase(s.sku);
    const moved = per > 0 ? Math.min(Math.ceil(want / per) * per, room, s.onHandBack) : want;
    s.onHandBack -= moved;
    s.onFacing += moved;
    return moved;
  }

  private record(s: SkuState, taken: number, lost: number) {
    this.totals.lines++;
    if (taken > 0) {
      s.soldToday += taken;
      this.totals.soldUnits += taken;
      this.totals.soldDollars += taken * s.sku.unitRetail;
    }
    if (lost > 0) {
      this.totals.lostUnits += lost;
      this.totals.lostDollars += lost * s.sku.unitRetail;
      if (taken <= 0) this.totals.lostLines++;
      this.lostBySku.set(s.sku.id, (this.lostBySku.get(s.sku.id) ?? 0) + lost);
    }
  }

  /**
   * A customer takes stock off the facing. Only what is on the shelf can be
   * sold; the shortfall is a lost sale. It is not a backorder and it is not
   * recovered later — the customer buys something else or walks out — so what
   * is in the stockroom does not help them, and is deliberately not touched.
   */
  sell(sku: string, units: number): { sold: number; lost: number } {
    const s = this.stateFor(sku);
    const sold = Math.min(units, s.onFacing);
    const lost = units - sold;
    s.onFacing -= sold;
    this.record(s, sold, lost);
    return { sold, lost };
  }

  /**
   * Picking a delivery or pickup order: the facing first, because it is on the
   * way, and then the stockroom for the rest. The asymmetry with `sell` is the
   * point of the pair — a member of staff can walk to the back, and a customer
   * cannot, so a special order is still filled on a morning when the shelf in
   * front of it is bare.
   */
  pick(sku: string, units: number): { picked: number; cut: number } {
    const s = this.stateFor(sku);
    const fromFacing = Math.min(units, s.onFacing);
    const fromBack = Math.min(units - fromFacing, s.onHandBack);
    s.onFacing -= fromFacing;
    s.onHandBack -= fromBack;
    const picked = fromFacing + fromBack;
    const cut = units - picked;
    this.record(s, picked, cut);
    return { picked, cut };
  }

  /**
   * A basket abandoned in the queue goes back on the shelf. The sale is unwound
   * rather than counted as lost: what was lost was a customer's patience, and
   * operations.ts counts those dollars where they belong. Putting them in
   * `lostUnits` would blur a staffing problem into an empty facing, which is
   * the one thing this book exists to tell apart. Units that no longer fit the
   * facing go to the stockroom, which is where a clerk would really put them.
   */
  returnToShelf(sku: string, units: number) {
    if (units <= 0) return;
    const s = this.stateFor(sku);
    const room = Math.max(0, this.cap(sku) - s.onFacing);
    const onShelf = Math.min(units, room);
    s.onFacing += onShelf;
    s.onHandBack += units - onShelf;
    s.soldToday = Math.max(0, s.soldToday - units);
    this.totals.soldUnits -= units;
    this.totals.soldDollars -= units * s.sku.unitRetail;
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * Share of merchandised facings with something on them right now: what a
   * customer walking the aisles would see. It moves before lost sales do, which
   * is what makes it worth watching — an empty facing costs nothing until
   * somebody reaches for it.
   */
  shelfShare(): number {
    let n = 0;
    let filled = 0;
    for (const s of this.skus) {
      if (this.cap(s.sku.id) <= 0) continue;
      n++;
      if (s.onFacing > 0) filled++;
    }
    return n > 0 ? filled / n : 1;
  }

  /** Roll the day's sales into the history the trailing forecast reads. */
  endDay() {
    for (const s of this.skus) {
      s.history.push(s.soldToday);
      if (s.history.length > HISTORY_DAYS) s.history.shift();
      s.soldToday = 0;
    }
  }

  /** Retail value of everything in the building, shelf and stockroom together. */
  retailValue(): number {
    let v = 0;
    for (const s of this.skus) v += (s.onFacing + s.onHandBack) * s.sku.unitRetail;
    return v;
  }

  /**
   * Master cases the stockroom is holding. Each SKU rounds up, because a part
   * case still takes a whole case's worth of shelf: this is a space number to
   * set against the backroom's capacity, not a quantity.
   */
  backroomCases(): number {
    let c = 0;
    for (const s of this.skus) {
      const per = this.unitsPerCase(s.sku);
      if (per > 0 && s.onHandBack > 0) c += Math.ceil(s.onHandBack / per);
    }
    return c;
  }
}

// ---------------------------------------------------------------------------
// Fast daily simulation
// ---------------------------------------------------------------------------

export interface DailyInventoryRow {
  day: number;
  weekday: number;
  calendarWeek: number;
  soldUnits: number;
  soldDollars: number;
  lostUnits: number;
  lostDollars: number;
  receivedCases: number;
  onHandRetail: number;
  backroomCases: number;
  shelfShare: number;
}

export interface InventoryRun {
  book: InventoryBook;
  daily: DailyInventoryRow[];
}

/**
 * Warm up from steady state for `warmupWeeks` before day 0, then run `days`.
 *
 * This is the day-resolution model, and it answers one kind of question: will
 * there be enough stock, week by week, through a season. So the day's demand is
 * its expected units rather than a draw of baskets, receipts are sellable the
 * day they arrive, and the morning restock is free. Whether anyone had the
 * hours to work the shelf, and what the queue did at 17:00, is operations.ts's
 * job on the same book.
 */
export function runInventory(
  model: DemandModel,
  catalog: Catalog,
  opts: {
    startWeek: number;
    days: number;
    warmupWeeks?: number;
    policy?: InventoryPolicy;
    delays?: SupplierDelay[];
    seed?: number;
    facingCap: Map<string, number>;
  }
): InventoryRun {
  const book = new InventoryBook(model, catalog, opts.policy ?? DEFAULT_POLICY, opts.startWeek, opts.delays ?? [], opts.seed ?? 1, opts.facingCap);
  const warm = -(opts.warmupWeeks ?? 6) * 7;
  book.initialize(warm);
  const daily: DailyInventoryRow[] = [];
  const snapshotTotals = () => ({ ...book.totals });
  let base = snapshotTotals();
  for (let d = warm; d < opts.days; d++) {
    if (d === 0) {
      // The warm-up only sets the stock position; its sales are not the horizon's.
      base = snapshotTotals();
      book.lostBySku.clear();
    }
    book.review(d);
    let cases = 0;
    for (const po of book.arrivals(d)) {
      for (const l of po.lines) book.receive(l.sku, l.units);
      cases += po.cases;
      book.totals.receipts++;
      book.totals.receivedPallets += po.pallets;
      book.totals.receivedCases += po.cases;
    }
    // Before the doors open, the night's receipt and yesterday's holes go onto
    // the shelf. Every facing is filled as far as the stockroom allows, so what
    // is left unfilled is a stock problem rather than a labor one.
    for (const s of book.skus) book.restock(s.sku.id, book.restockNeed(s.sku.id));

    const before = snapshotTotals();
    const units = expectedDailyUnits(model, d, 1, opts.startWeek);
    for (const s of book.skus) {
      const q = units.get(s.sku.id) ?? 0;
      if (q <= 0) continue;
      // Special orders are picked by staff, so they can reach the stockroom;
      // the walk-in share only ever sees the facing. Splitting the day's units
      // this way keeps an empty shelf from cutting an order a picker would in
      // fact have filled from the back.
      const special = q * model.specialShare;
      if (special > 0) book.pick(s.sku.id, special);
      if (q - special > 0) book.sell(s.sku.id, q - special);
    }
    book.endDay();
    if (d >= 0) {
      daily.push({
        day: d,
        weekday: weekdayOf(d),
        calendarWeek: calendarWeekOfDay(opts.startWeek, d),
        soldUnits: book.totals.soldUnits - before.soldUnits,
        soldDollars: book.totals.soldDollars - before.soldDollars,
        lostUnits: book.totals.lostUnits - before.lostUnits,
        lostDollars: book.totals.lostDollars - before.lostDollars,
        receivedCases: cases,
        onHandRetail: book.retailValue(),
        backroomCases: book.backroomCases(),
        shelfShare: book.shelfShare(),
      });
    }
  }
  // Report horizon totals only.
  for (const k of Object.keys(book.totals) as Array<keyof InventoryTotals>) book.totals[k] -= base[k];
  return { book, daily };
}
