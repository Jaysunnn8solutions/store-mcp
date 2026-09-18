/**
 * Types for the retail-store twin. The network (stores, their weekly dollar
 * demand by category, and which distribution center supplies each) comes from
 * candystore_mcp; the building, catalog, roster and standards are this
 * project's own mock inputs.
 *
 * Where digitaltwin_mcp runs the two distribution centers, this project runs
 * the five shops they ship to: the sales floor, the showcase counters, the
 * registers, the stockroom, the docks and the parking lot, minute by minute.
 */

import type { FixtureKind, ParkingSpec } from "../layout/spec";

export type { FixtureKind, ParkingSpec };

/** A candystore category: "traditional" or "specialty:<segment>". */
export type Category = string;

// ---------------------------------------------------------------------------
// Network snapshot from candystore_mcp
// ---------------------------------------------------------------------------

export interface NetworkStore {
  id: string;
  name: string;
  type: "general" | "specialty";
  /** The distribution center that supplies this store, from digitaltwin_mcp's network. */
  dc: string;
  lon: number;
  lat: number;
  segments: string[];
  /** Annual retail dollars by category, after candystore's supply caps. */
  revenueBy: Record<Category, number>;
}

export interface NetworkDc {
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** candystore's assumed weekly capacity, retail dollars by category. */
  capacity: Record<Category, number>;
  /** Average-week retail dollars routed here by category. */
  weeklyDemand: Record<Category, number>;
  stores: string[];
}

export interface Network {
  source: string;
  fetchedAt: string;
  /** The candystore scenario this snapshot describes; empty for the baseline. */
  scenario: Record<string, unknown>;
  dcs: NetworkDc[];
  stores: NetworkStore[];
  segments: Array<{ id: string; label: string }>;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface Supplier {
  id: string;
  name: string;
  kind: "domestic" | "importer";
  /** Mean and standard deviation of lead time, days. */
  leadDays: number;
  leadSdDays: number;
  /** Weekday the buyer places orders, 1 = Monday … 7 = Sunday. */
  orderDay: number;
  /**
   * How the store is served. "dc" arrives on the overnight trailer from the
   * distribution center; "direct" is a vendor's own box truck through the day.
   */
  channel: "dc" | "direct";
}

/**
 * How a customer buys a SKU. Packaged candy sells by the piece; bulk bins and
 * the showcase sell by the pound, scooped or trayed and weighed.
 */
export type SellBy = "each" | "weight";

/** Candy that only sells in its season, and comes off the floor after it. */
export type Holiday = "halloween" | "christmas" | "valentines" | "easter";

export interface Sku {
  id: string;
  name: string;
  category: Category;
  supplier: string;
  /**
   * Retail price of one selling unit: dollars each for "each" SKUs, dollars a
   * pound for "weight" SKUs.
   */
  unitRetail: number;
  sellBy: SellBy;
  /**
   * Selling units in one display box (the inner the distribution center picks
   * and ships): pieces for "each" SKUs, pounds for "weight" SKUs.
   */
  unitsPerInner: number;
  /** Suppliers ship master cases of inners, on single-SKU pallets. */
  innersPerCase: number;
  casesPerPallet: number;
  innerCubeFt: number;
  /** Share of the category's dollar demand, summing to 1 within a category. */
  velocityShare: number;
  /** The fixture family this SKU merchandises on. */
  fixture: FixtureKind;
  /** Set when the SKU only sells around one holiday. */
  season?: Holiday;
}

export interface Catalog {
  generatedAt: string;
  seed: number;
  suppliers: Supplier[];
  skus: Sku[];
}

// ---------------------------------------------------------------------------
// Site: the building, its fixtures, service points, doors and hours
// ---------------------------------------------------------------------------

/**
 * The block of double-sided gondola runs down the middle of the sales floor.
 * Runs are parallel to y, so a shopper walks away from the door along them.
 */
export interface GondolaBlock {
  /** Centre of the first run's footprint. */
  originX: number;
  /** Front end of every run, feet from the storefront. */
  originY: number;
  runs: number;
  baysPerRun: number;
  /** Selling shelves per side. */
  shelves: number;
  bayWidthFt: number;
  aisleWidthFt: number;
  /** Total footprint depth of a run, both sides together. */
  depthFt: number;
  facingsPerBay: number;
  /** Promotional shelves on the end of each run; 0 leaves the ends plain. */
  endcapShelves: number;
}

/** Perimeter shelving, or a wall of gravity bulk bins, down one side wall. */
export interface WallRunSpec {
  id: string;
  side: "left" | "right";
  kind: "wall" | "bulk";
  y0: number;
  y1: number;
  shelves: number;
  bays: number;
  depthFt: number;
  facingsPerBay: number;
}

/** The glass counter: trays of confections a clerk weighs and boxes to order. */
export interface ShowcaseBlock {
  /** Centre of the glass, across the store. */
  x: number;
  y0: number;
  y1: number;
  bays: number;
  /** Tray shelves visible through the glass. */
  shelves: number;
  depthFt: number;
  facingsPerBay: number;
  /** Serving positions behind the glass; each is one worker at a time. */
  stations: number;
  /** Clear working corridor behind the glass, feet. */
  backCorridorFt: number;
}

/**
 * The register end of the service counter. It runs in y like the showcase,
 * usually in line with it: registers at the front where the customers pay, the
 * glass behind them. Staff work the corridor between the counter and the wall.
 */
export interface CheckoutBlock {
  registers: number;
  /** Centre of the counter across its depth, and the front end of the run. */
  x: number;
  y: number;
  depthFt: number;
  /** Spacing between registers along the counter. */
  pitchFt: number;
  /** A gift-wrap station at the end of the counter. */
  wrap: boolean;
  /** Impulse bays on the customer side of the counter. */
  impulseBays: number;
  shelves: number;
  facingsPerBay: number;
}

/** Free-standing seasonal tables inside the door. */
export interface SeasonalBlock {
  tables: number;
  originX: number;
  originY: number;
  widthFt: number;
  lengthFt: number;
  /** Tiers on a table. */
  shelves: number;
  facingsPerBay: number;
  /** Gap between tables, across the store. */
  pitchFt: number;
}

/** A block of back-of-house storage: pallet rack, or hand-stacked shelving. */
export interface StorageZone {
  kind: "rack" | "shelving";
  originX: number;
  originY: number;
  aisles: number;
  baysPerSide: number;
  levels: number;
  bayWidthFt: number;
  aisleWidthFt: number;
  depthFt: number;
}

export interface Shift {
  id: string;
  /** "HH:MM", local. */
  start: string;
  end: string;
  /** Unpaid meal break, taken mid-shift. */
  breakMin: number;
  /** Paid but not selling or stocking: huddle, counts, cleaning, cash-up. */
  indirectMin: number;
}

/** Trading hours for one weekday. A weekday with no entry is dark. */
export interface OpeningHours {
  /** 1 = Monday … 7 = Sunday. */
  day: number;
  open: string;
  close: string;
}

export interface Site {
  id: string;
  name: string;
  /** The candystore store this building is, so demand and category mix follow it. */
  store: string;
  building: { widthFt: number; depthFt: number };
  /** Where the sales floor ends and the stockroom begins, feet from the storefront. */
  backroomY: number;
  gondolas: GondolaBlock;
  walls: WallRunSpec[];
  /** null for a shop with no served counter. */
  showcase: ShowcaseBlock | null;
  seasonal: SeasonalBlock;
  checkout: CheckoutBlock;
  backroom: StorageZone[];
  doors: {
    /** Raised dock positions at the back, for a trailer. */
    docks: number;
    /** Ground-level roll-up doors, for a box truck or a van. */
    ground: number;
    /** Customer entrances at the storefront. */
    entrances: number;
  };
  parking: ParkingSpec;
  equipment: {
    /** Pallet jacks for the dock and the stockroom. */
    palletJacks: number;
    /** U-boats and flat carts that carry a restock to the floor. */
    stockCarts: number;
    /** The store's own delivery vehicles. */
    vans: number;
  };
  hours: OpeningHours[];
  times: {
    /** Delivery and pickup orders for the next day close at this time. */
    orderCutoff: string;
    /** The pre-open pick starts here, before the doors open. */
    pickStart: string;
    /** The morning delivery van leaves at this time, before opening. */
    vanDeparture: string;
    /** A second afternoon run, or null when the store makes one round a day. */
    vanSecondDeparture: string | null;
    /** The overnight trailer from the distribution center is due inside this window. */
    overnightWindow: [string, string];
    /** Vendors' own box trucks call inside this window, through the trading day. */
    directWindow: [string, string];
  };
  /** Weekdays the distribution center's trailer calls, 1 = Monday. */
  dcDeliveryDays: number[];
  shifts: Shift[];
  /** Days the store trades, 1 = Monday. */
  operatingDays: number[];
}

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

/**
 * What the store's people spend their minutes on. `serve` and `checkout` are
 * customer-facing and have a customer waiting; the rest are floor work that
 * queues.
 */
export type Process =
  | "unload"
  | "receive"
  | "putaway"
  | "restock"
  | "serve"
  | "checkout"
  | "pick"
  | "pack"
  | "load"
  | "deliver";

export const PROCESSES: Process[] = ["unload", "receive", "putaway", "restock", "serve", "checkout", "pick", "pack", "load", "deliver"];

/** The customer-facing processes: a person is waiting while they run. */
export const SERVICE_PROCESSES: Process[] = ["serve", "checkout"];

/**
 * Skills a worker can hold. `counter` needs a food handler's card, `drive`
 * needs a licence and the insurance to go with it: both are the store's usual
 * single points of failure.
 */
export type Skill = "receive" | "stock" | "counter" | "register" | "pick" | "drive";
export const SKILLS: Skill[] = ["receive", "stock", "counter", "register", "pick", "drive"];

export const PROCESS_SKILL: Record<Process, Skill> = {
  unload: "receive",
  receive: "receive",
  putaway: "receive",
  restock: "stock",
  serve: "counter",
  checkout: "register",
  pick: "pick",
  pack: "pick",
  load: "drive",
  deliver: "drive",
};

export interface Worker {
  id: string;
  /** The site id this worker belongs to. */
  store: string;
  role: string;
  type: "full-time" | "part-time" | "temp";
  homeShift: string;
  skills: Skill[];
  /** Multiplier on engineered standards; 1.1 works 10% faster. */
  productivity: number;
  hourlyRate: number;
  maxWeeklyHours: number;
}

export interface Roster {
  generatedAt: string;
  seed: number;
  workers: Worker[];
}

/** Engineered labor standards, minutes unless the name says otherwise. */
export interface LaborStandards {
  // Receiving at the dock
  unloadPerPallet: number;
  unloadPerCase: number;
  unloadPerTruck: number;
  receivePerCase: number;
  /** Compliance labels on imported specialty candy, per master case at receipt. */
  labelPerImportCase: number;
  putawayHandling: number;

  // Stocking the sales floor
  /**
   * Loading the cart in the stockroom and putting it away again, per trip. A
   * trip carries as many display boxes as the cart's cube allows, which is why
   * this is charged once however many facings it fills.
   */
  restockPerTrip: number;
  /**
   * Cutting the display box open, pricing it and facing the shelf, per box. A
   * shop works in display boxes, not master cases: the box is the thing that
   * comes off the cart.
   */
  restockPerCase: number;
  /** Decanting a display box into a showcase tray or a bulk bin, per box. */
  restockPerTray: number;
  /** Extra seconds a shelf below the knee or above the shoulder costs, per box. */
  restockBendReachSec: number;

  // Serving customers
  /** Greeting, the order, and wrapping the box at the showcase. */
  servePerCustomer: number;
  /** Each item chosen from the case, weighed and boxed. */
  servePerItem: number;
  /** Opening the transaction, tender and bagging. */
  checkoutPerCustomer: number;
  checkoutPerItem: number;
  /** A weighed item has to go on the scale at the register. */
  checkoutWeighSec: number;
  giftWrapPerOrder: number;

  // Orders that leave the store
  pickPerTour: number;
  pickPerLine: number;
  pickPerUnit: number;
  packPerOrder: number;
  packPerLine: number;
  loadPerOrder: number;
  loadPerVan: number;
  /** Door to door on the route, per stop. */
  deliverPerStop: number;
  /** Driving between stops, per mile. */
  deliverPerMile: number;

  // Travel and capacity
  walkFtPerMin: number;
  cartCubeFt: number;
  palletCubeFt: number;
  /** Clear height of one selling shelf, which with bay width and depth caps a facing. */
  shelfHeightFt: number;
  /** Optimized merchandising sizes each facing to hold this many days of the SKU's demand. */
  facingDaysOfSupply: number;
  /** Miles on an average delivery round, before the per-stop legs. */
  routeBaseMiles: number;
}

export interface CostRates {
  overtimeMultiplier: number;
  tempHourly: number;
  /** Temps are slower while they learn the store. */
  tempProductivity: number;
  crossTrainCost: number;
  crossTrainWeeks: number;
  hireCost: number;
  hireWeeks: number;
  /** Share of retail value that is cost of goods, for inventory valuation and margin. */
  costOfGoods: number;
  /** What a van costs the store a week, standing plus running. */
  vanWeekly: number;
  /** A register lane, amortized weekly: the terminal, the counter and its maintenance. */
  registerWeekly: number;
  /** A showcase station, amortized weekly. */
  counterWeekly: number;
}
