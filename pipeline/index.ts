/**
 * Rebuild the committed data:
 *   catalog.json  mock suppliers and SKUs for every candystore category
 *   roster.json   mock workers per shop
 *   manifest.json what was built, when, and from where
 *
 * network.json is candystore_mcp's baseline. Unlike digitaltwin_mcp's pipeline
 * this one reads the committed snapshot rather than fetching it, because the
 * store twin's numbers have to reconcile with the distribution-center twin's
 * and both are pinned to the same 2026-09-13 market run. `--refresh` pulls a
 * fresh one from CANDYSTORE_URL (set it to point at a local candystore running
 * `npm run dev`) and rewrites the file; that is a deliberate act, not the
 * default. Tools that need a *scenario* call fetchNetwork at request time
 * instead — see lib/twin/candystore.ts.
 *
 * sites.json (buildings, fixtures, doors, shifts, hours) is hand-written and
 * never touched here; it is read so the roster can be checked against the
 * shifts each shop actually declares.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CANDYSTORE_URL, fetchNetwork } from "../lib/twin/candystore";
import type { Category, Network } from "../lib/twin/types";
import { buildCatalog, fixtureMix } from "./catalog";
import { buildRoster, type RosterSite } from "./roster";

const DATA = path.resolve(import.meta.dirname, "..", "data");

function read<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(DATA, name), "utf8")) as T;
}

function write(name: string, value: unknown) {
  const file = path.join(DATA, name);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  console.log(`wrote ${file}`);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

async function main() {
  let network: Network;
  if (process.argv.includes("--refresh")) {
    console.log(`Fetching the baseline network from ${CANDYSTORE_URL} …`);
    network = await fetchNetwork({});
    write("network.json", network);
  } else {
    network = read<Network>("network.json");
    console.log(`network: ${network.stores.length} stores, ${network.dcs.length} DCs, snapshot of ${network.fetchedAt} (pass --refresh to pull a new one)`);
  }
  const sites = read<RosterSite[]>("sites.json");

  // Annual retail dollars by category across the whole network, so the mix
  // below is the one the five shops really sell rather than a flat average.
  const dollars = new Map<Category, number>();
  for (const store of network.stores) {
    for (const [cat, annual] of Object.entries(store.revenueBy)) dollars.set(cat, (dollars.get(cat) ?? 0) + annual);
  }

  const catalog = buildCatalog(network);
  const weight = catalog.skus.filter((s) => s.sellBy === "weight").length;
  const mix = fixtureMix(catalog.skus, (cat) => dollars.get(cat) ?? 0);
  const mixLine = Object.entries(mix)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, share]) => `${kind} ${pct(share)}`)
    .join(", ");
  console.log(`  catalog: ${catalog.skus.length} SKUs from ${catalog.suppliers.length} suppliers, ${catalog.skus.length - weight} by the piece and ${weight} by the pound`);
  console.log(`  fixtures by network dollars: ${mixLine}`);
  write("catalog.json", catalog);

  const roster = buildRoster(sites);
  const byStore = sites.map((s) => `${s.id.replace(/^store-/, "")} ${roster.workers.filter((w) => w.store === s.id).length}`).join(", ");
  console.log(`  roster: ${roster.workers.length} workers (${byStore})`);
  write("roster.json", roster);

  write("manifest.json", {
    generatedAt: new Date().toISOString(),
    candystore: { source: network.source, fetchedAt: network.fetchedAt },
    counts: {
      stores: network.stores.length,
      sites: sites.length,
      skus: catalog.skus.length,
      suppliers: catalog.suppliers.length,
      workers: roster.workers.length,
    },
    seeds: { catalog: catalog.seed, roster: roster.seed },
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
