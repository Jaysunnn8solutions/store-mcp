import type { CostRates, LaborStandards } from "./types";

/**
 * Engineered labor standards in minutes, before a worker's productivity
 * factor. Placeholders in the range published for specialty food retail and
 * small-format grocery; edit them here, or override per call.
 */
export const DEFAULT_STANDARDS: LaborStandards = {
  // Receiving at the dock
  unloadPerPallet: 2.5,
  unloadPerCase: 0.15,
  unloadPerTruck: 10,
  receivePerCase: 0.25,
  labelPerImportCase: 0.6,
  putawayHandling: 1.8,

  // Stocking the sales floor, per display box worked
  restockPerTrip: 4,
  restockPerCase: 1.1,
  restockPerTray: 2.4,
  restockBendReachSec: 6,

  // Serving customers
  servePerCustomer: 1.9,
  servePerItem: 0.55,
  checkoutPerCustomer: 0.85,
  checkoutPerItem: 0.09,
  checkoutWeighSec: 8,
  giftWrapPerOrder: 3.5,

  // Orders that leave the store
  pickPerTour: 2,
  pickPerLine: 0.5,
  pickPerUnit: 0.06,
  packPerOrder: 4,
  packPerLine: 0.4,
  loadPerOrder: 1.2,
  loadPerVan: 6,
  deliverPerStop: 5,
  deliverPerMile: 2.6,

  // Travel and capacity
  walkFtPerMin: 180,
  cartCubeFt: 18,
  palletCubeFt: 55,
  shelfHeightFt: 1.25,
  facingDaysOfSupply: 4,
  routeBaseMiles: 6,
};

export const DEFAULT_COSTS: CostRates = {
  overtimeMultiplier: 1.5,
  tempHourly: 24,
  tempProductivity: 0.75,
  crossTrainCost: 700,
  crossTrainWeeks: 2,
  hireCost: 3200,
  hireWeeks: 3,
  costOfGoods: 0.45,
  vanWeekly: 310,
  registerWeekly: 55,
  counterWeekly: 90,
};

/** "HH:MM" to minutes after midnight. */
export function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes after midnight to "HH:MM", wrapping past midnight. */
export function clock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Paid length of a shift in hours, which is also what it costs. */
export function shiftPaidHours(start: string, end: string): number {
  let len = hhmm(end) - hhmm(start);
  if (len <= 0) len += 1440;
  return len / 60;
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
