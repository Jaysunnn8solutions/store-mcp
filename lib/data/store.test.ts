/**
 * The data seam: the pure store, the Node provider registered by load.ts, and
 * the JSON bundle the browser worker installs. The two paths must serve the
 * same bytes, because the 3D page replays on the bundle what the tools compute
 * on the fs read, and a divergence there would show up as a twin that does not
 * match its own numbers.
 *
 * vitest.setup.ts has already registered the fs provider in this file's module
 * registry, so the cases that need an empty store (or an independent one to
 * call setData on) use vi.resetModules() and dynamic imports.
 */
import { describe, expect, it, vi } from "vitest";
import { UnknownIdError as UnknownIdErrorFromLoad } from "./load";
import { findSite, loadCatalog, loadManifest, loadNetwork, loadRoster, loadSites, storeIds, UnknownIdError } from "./store";

/** A fresh module registry: a store with nothing registered, and the bundle on top of it. */
async function freshModules() {
  vi.resetModules();
  const store = await import("./store");
  const bundle = await import("./bundle");
  return { store, bundle };
}

describe("store", () => {
  it("throws DataNotLoadedError until something registers the data", async () => {
    vi.resetModules();
    const store = await import("./store");
    expect(store.hasData()).toBe(false);
    expect(() => store.loadSites()).toThrow(store.DataNotLoadedError);
    expect(() => store.findSite("store-midtown")).toThrow(/not loaded/);
  });

  it("serves the bundle after setData and bumps the data version", async () => {
    const { store, bundle } = await freshModules();
    const before = store.dataVersion();
    store.setData(bundle.BUNDLE);
    expect(store.hasData()).toBe(true);
    expect(store.dataVersion()).toBe(before + 1);
    // A second install has to bump again: buildTwin keys its context cache on
    // this number, and a stale context would silently outlive new data.
    store.setData(bundle.BUNDLE);
    expect(store.dataVersion()).toBe(before + 2);
  });

  it("exports one UnknownIdError from load.ts and store.ts, so instanceof checks keep working", () => {
    expect(UnknownIdErrorFromLoad).toBe(UnknownIdError);
    expect(new UnknownIdErrorFromLoad("x")).toBeInstanceOf(UnknownIdError);
  });

  it("registers the fs provider lazily, so mcp/stdio.ts can set STORE_DATA_DIR after its imports", async () => {
    const dataDir = process.env.STORE_DATA_DIR;
    expect(dataDir).toBeTruthy();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/nowhere");
    try {
      vi.resetModules();
      delete process.env.STORE_DATA_DIR;
      // Import with no override and a useless cwd: an eager reader would throw here.
      const load = await import("./load");
      expect(load.hasData()).toBe(true);
      process.env.STORE_DATA_DIR = dataDir;
      expect(load.storeIds()).toEqual(storeIds());
    } finally {
      process.env.STORE_DATA_DIR = dataDir;
      cwd.mockRestore();
    }
  });
});

describe("findSite", () => {
  it("returns the shop whose site id is given", () => {
    const first = loadSites()[0];
    expect(findSite(first.id)).toBe(first);
  });

  it("throws UnknownIdError naming the valid ids", () => {
    // The candystore store id is deliberately not an accepted argument: the
    // tools address shops by site id, and s1 would otherwise half-work.
    const bad = loadSites()[0].store;
    expect(() => findSite(bad)).toThrow(UnknownIdError);
    let message = "";
    try {
      findSite("store-nowhere");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('Unknown store "store-nowhere"');
    for (const id of storeIds()) expect(message).toContain(id);
  });
});

describe("bundle", () => {
  it("agrees with the fs provider on sites, SKUs and workers", async () => {
    const { store, bundle } = await freshModules();
    // Nothing is registered until setData: the bundle must not drag lib/data/load in.
    expect(store.hasData()).toBe(false);
    store.setData(bundle.BUNDLE);

    expect(store.storeIds()).toEqual(storeIds());
    expect(store.loadCatalog().skus).toHaveLength(loadCatalog().skus.length);
    expect(store.loadCatalog().suppliers).toHaveLength(loadCatalog().suppliers.length);
    expect(store.loadRoster().workers).toHaveLength(loadRoster().workers.length);
    // Deep equality on the whole bundle, not just the counts: same seeds, same
    // prices, same shifts, so a run on either path is the same run.
    expect(bundle.BUNDLE.sites).toEqual(loadSites());
    expect(bundle.BUNDLE.catalog).toEqual(loadCatalog());
    expect(bundle.BUNDLE.roster).toEqual(loadRoster());
    expect(bundle.BUNDLE.network).toEqual(loadNetwork());
    expect(bundle.BUNDLE.manifest).toEqual(loadManifest());
  });

  it("installs itself through installBundledData, the way the worker starts up", async () => {
    const { store, bundle } = await freshModules();
    bundle.installBundledData();
    expect(store.hasData()).toBe(true);
    expect(store.loadSites().map((s) => s.id)).toEqual(storeIds());
  });
});

describe("manifest", () => {
  it("counts what the other four files actually contain", () => {
    const counts = loadManifest().counts;
    expect(counts.sites).toBe(loadSites().length);
    expect(counts.stores).toBe(loadNetwork().stores.length);
    expect(counts.skus).toBe(loadCatalog().skus.length);
    expect(counts.suppliers).toBe(loadCatalog().suppliers.length);
    expect(counts.workers).toBe(loadRoster().workers.length);
  });

  it("carries the provenance of the candystore snapshot underneath it", () => {
    const manifest = loadManifest();
    const network = loadNetwork();
    expect(manifest.candystore.source).toBe(network.source);
    expect(manifest.candystore.fetchedAt).toBe(network.fetchedAt);
  });
});
