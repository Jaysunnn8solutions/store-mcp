/**
 * The committed data as a registry, free of Node APIs, so the same engine runs
 * on the server (lib/data/load.ts registers a lazy fs provider at import time)
 * and in a Web Worker (the 3D page's worker calls setData with the JSON bundled
 * by lib/data/bundle.ts). Everything in lib/twin, lib/trace and lib/layout
 * imports the loaders from here, never from load.ts, which is what keeps
 * node:fs out of the browser bundle.
 *
 * The five shops are the unit of work in this project, so the ids that matter
 * are site ids (store-midtown, store-decatur, …). Each Site also carries a
 * `store` field naming the candystore store (s1…s5) whose dollar demand it
 * trades on; the two id spaces are deliberately kept apart.
 */

import type { Catalog, Network, Roster, Site } from "../twin/types";

/** What the data pipeline wrote, and where the market snapshot underneath it came from. */
export interface DataManifest {
  generatedAt: string;
  candystore: { source: string; fetchedAt: string };
  counts: { stores: number; sites: number; skus: number; suppliers: number; workers: number };
  seeds: { catalog: number; roster: number };
}

/** The five committed JSON files, in the shapes the engine wants them. */
export interface DataBundle {
  network: Network;
  sites: Site[];
  catalog: Catalog;
  roster: Roster;
  manifest: DataManifest;
}

/** An argument naming something that does not exist; tools turn it into an isError result. */
export class UnknownIdError extends Error {}

/** Nothing registered the data yet: import lib/data/load on Node, or call setData() in the browser. */
export class DataNotLoadedError extends Error {}

let bundle: DataBundle | null = null;
let provider: (() => DataBundle) | null = null;
let version = 0;

/** Browser and worker path: hand over the bundled JSON. Replaces any earlier bundle. */
export function setData(b: DataBundle): void {
  bundle = b;
  version++;
}

/**
 * Node path: register a lazy reader. It runs on the first loader call, not at
 * import time, so mcp/stdio.ts can still set STORE_DATA_DIR after its imports
 * evaluate and vitest's env applies before any test module reads.
 */
export function setDataProvider(p: () => DataBundle): void {
  provider = p;
  bundle = null;
  version++;
}

/** True once either path has registered data, so callers can fail early with a useful message. */
export function hasData(): boolean {
  return bundle !== null || provider !== null;
}

/** Increments on every setData/setDataProvider; buildTwin keys its context cache on it. */
export function dataVersion(): number {
  return version;
}

function data(): DataBundle {
  if (!bundle) {
    if (!provider) throw new DataNotLoadedError("Store data is not loaded: import lib/data/load on Node, or call setData() from lib/data/store in the browser first.");
    bundle = provider();
  }
  return bundle;
}

/** candystore_mcp's baseline network: centers, stores, annual dollars by category. */
export function loadNetwork(): Network {
  return data().network;
}

/** The five shops: building, fixtures, service counter, stockroom, doors, parking, hours. Mock. */
export function loadSites(): Site[] {
  return data().sites;
}

/** Suppliers and SKUs, with the price, pack and fixture family of every line. */
export function loadCatalog(): Catalog {
  return data().catalog;
}

/** Every shop's people: role, shift, skills, productivity and pay. */
export function loadRoster(): Roster {
  return data().roster;
}

/** Provenance and counts for the committed data, surfaced by the tools. */
export function loadManifest(): DataManifest {
  return data().manifest;
}

/** The site ids, in committed order; the order the tools list shops in. */
export function storeIds(): string[] {
  return loadSites().map((s) => s.id);
}

/**
 * The shop a tool argument names. Takes the site id (store-midtown), not the
 * candystore store id (s1), and names the valid ids when it misses so the
 * caller can fix the argument without a second round trip.
 */
export function findSite(store: string): Site {
  const site = loadSites().find((s) => s.id === store);
  if (!site) throw new UnknownIdError(`Unknown store "${store}". Known: ${storeIds().join(", ")}.`);
  return site;
}
