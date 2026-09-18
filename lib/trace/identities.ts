/**
 * The identities the engine never has.
 *
 * The simulation counts registers, carts, jacks, vans and doors; it does not
 * say *which* one. Nor does it say which parking stall a car took, or which
 * shelf in the stockroom a case ended up on. The renderer needs all of that,
 * and every choice here is a pure function of the ordered event stream, so the
 * same seed places the same case on the same shelf every time.
 */

import type { StoragePosition } from "../twin/layout";

export interface Acquired {
  index: number;
  /** True when everything was taken and the index was handed out anyway. */
  overflow: boolean;
}

/**
 * Hand out one of n interchangeable things. Prefers the caller's hint, then
 * the lowest free index, so a two-register shop always uses register 1 first
 * and the pictures stay stable between runs.
 */
export class FreeList {
  private readonly taken: boolean[];
  private count = 0;

  constructor(readonly n: number) {
    this.taken = new Array(Math.max(0, n)).fill(false);
  }

  get busy(): number {
    return this.count;
  }

  isFree(i: number): boolean {
    return i >= 0 && i < this.n && !this.taken[i];
  }

  acquire(prefer?: number, skip?: (i: number) => boolean): Acquired {
    if (this.n <= 0) return { index: 0, overflow: true };
    if (prefer !== undefined && this.isFree(prefer) && !skip?.(prefer)) {
      this.taken[prefer] = true;
      this.count++;
      return { index: prefer, overflow: false };
    }
    for (let i = 0; i < this.n; i++) {
      if (this.taken[i] || skip?.(i)) continue;
      this.taken[i] = true;
      this.count++;
      return { index: i, overflow: false };
    }
    // The engine let more work start than there are things to do it with,
    // which means an outage window moved; draw it on the first one anyway.
    return { index: prefer !== undefined && prefer < this.n ? prefer : 0, overflow: true };
  }

  release(i: number): void {
    if (i < 0 || i >= this.n || !this.taken[i]) return;
    this.taken[i] = false;
    this.count--;
  }
}

export interface StorageChange {
  /** Index into the layout's storage positions. */
  pos: number;
  /** Cases now sitting there. */
  cases: number;
  /** Sku index occupying it, or -1. */
  sku: number;
}

/**
 * Where a SKU's backroom stock physically sits. Each SKU has a home position;
 * when it holds more than the home takes, the overflow spills onto the nearest
 * free positions and comes back off them last-in-first-out, which is how a
 * stockroom actually behaves.
 */
export class StorageAllocator {
  private readonly casesAt: number[];
  private readonly skuAt: number[];
  private readonly homes: number[];
  private readonly held: Map<number, number[]> = new Map();
  /** Cases one position holds, by index. */
  private readonly cap: number[];

  constructor(
    positions: StoragePosition[],
    homes: Array<[sku: number, pos: number]>,
    private readonly capacityOf: (p: StoragePosition) => number = (p) => (p.kind === "rack" ? 48 : 12)
  ) {
    this.casesAt = new Array(positions.length).fill(0);
    this.skuAt = new Array(positions.length).fill(-1);
    this.cap = positions.map((p) => Math.max(1, Math.round(this.capacityOf(p))));
    const maxSku = homes.reduce((a, [s]) => Math.max(a, s), -1);
    this.homes = new Array(maxSku + 1).fill(-1);
    for (const [sku, pos] of homes) this.homes[sku] = pos;
  }

  casesAtPos(pos: number): number {
    return this.casesAt[pos] ?? 0;
  }

  skuAtPos(pos: number): number {
    return this.skuAt[pos] ?? -1;
  }

  home(sku: number): number {
    return this.homes[sku] ?? -1;
  }

  placed(sku: number): number[] {
    return this.held.get(sku) ?? [];
  }

  /** Move a SKU's backroom stock to `want` cases, reporting every position that changed. */
  set(sku: number, want: number): StorageChange[] {
    const changes: StorageChange[] = [];
    const list = this.held.get(sku) ?? [];
    const home = this.home(sku);
    if (home < 0) return changes;
    if (list.length === 0) {
      list.push(home);
      this.held.set(sku, list);
    }

    let left = Math.max(0, Math.round(want));
    // Fill from the home outward, then free anything beyond what is needed.
    for (const pos of list) {
      const put = Math.min(left, this.cap[pos] ?? 1);
      if (this.casesAt[pos] !== put || (put > 0 && this.skuAt[pos] !== sku)) {
        this.casesAt[pos] = put;
        this.skuAt[pos] = put > 0 ? sku : -1;
        changes.push({ pos, cases: put, sku: this.skuAt[pos] });
      }
      left -= put;
    }

    // Still more to store: spill onto the nearest position nobody is using.
    while (left > 0) {
      let pick = -1;
      let best = Infinity;
      for (let i = 0; i < this.casesAt.length; i++) {
        if (this.skuAt[i] !== -1) continue;
        const d = Math.abs(i - home);
        if (d < best) {
          best = d;
          pick = i;
        }
      }
      if (pick < 0) break;
      const put = Math.min(left, this.cap[pick]);
      this.casesAt[pick] = put;
      this.skuAt[pick] = sku;
      list.push(pick);
      changes.push({ pos: pick, cases: put, sku });
      left -= put;
    }

    // Drop emptied overflow positions, keeping the home.
    while (list.length > 1 && this.casesAt[list[list.length - 1]] === 0) {
      const pos = list.pop()!;
      if (this.skuAt[pos] === sku) {
        this.skuAt[pos] = -1;
        changes.push({ pos, cases: 0, sku: -1 });
      }
    }
    return changes;
  }
}

/**
 * Parking. A shopper takes the free stall nearest the door they can use;
 * curbside bays are kept for order collections and accessible bays for the
 * customers entitled to them, so an ordinary car never blocks one.
 */
export class StallAllocator {
  private readonly taken: boolean[];

  constructor(private readonly kinds: Array<"standard" | "accessible" | "curbside">) {
    this.taken = new Array(kinds.length).fill(false);
  }

  /** -1 when the lot is full, which is a real thing that happens at Halloween. */
  take(want: "standard" | "accessible" | "curbside"): number {
    for (let i = 0; i < this.kinds.length; i++) {
      if (this.taken[i] || this.kinds[i] !== want) continue;
      this.taken[i] = true;
      return i;
    }
    if (want !== "standard") return -1;
    for (let i = 0; i < this.kinds.length; i++) {
      if (this.taken[i] || this.kinds[i] === "accessible") continue;
      this.taken[i] = true;
      return i;
    }
    return -1;
  }

  release(i: number): void {
    if (i >= 0 && i < this.taken.length) this.taken[i] = false;
  }
}
