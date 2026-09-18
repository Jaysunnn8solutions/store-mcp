/**
 * The simulation worker behind /store.
 *
 * The whole engine — the twin context, the discrete-event run, the trace
 * compiler and the committed data — lives in this chunk, so a run on the 3D
 * page never touches the server. The page spawns it with
 * `new Worker(new URL("../store.worker.ts", import.meta.url), { type: "module" })`;
 * that literal form is what the bundler resolves, so the URL must never be
 * computed.
 *
 * The data comes from lib/data/bundle.ts and never from lib/data/load.ts,
 * which is what keeps node:fs out of the chunk; scripts/assert-no-node-builtins.mjs
 * fails the build if it ever creeps in. The request loop itself is
 * lib/store-worker/run.ts, written against a `post` callback so the tests can
 * drive the same pipeline on Node with no Worker anywhere.
 */

import { installBundledData } from "../lib/data/bundle";
import { runInWorker } from "../lib/store-worker/run";
import type { TwinRequest, TwinResponse } from "../lib/trace/types";
import { setContextCacheLimit } from "../lib/twin/twin";

installBundledData();
// Two contexts: re-running the same scenario on another seed stays instant,
// while a user editing one field per run does not accumulate a context — each
// carrying a layout, a planogram and a demand model — for every run of the
// session.
setContextCacheLimit(2);

const post = (m: TwinResponse, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(m, transfer ?? []);

self.onmessage = (e: MessageEvent<TwinRequest>) => void runInWorker(e.data, post);
