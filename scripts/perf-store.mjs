// Performance check of the /store page in a real browser: launches a headless
// Chromium (Edge on the Windows dev box) with the DevTools protocol on a local
// port, opens /store with perf=1 and reads the numbers back over a raw
// WebSocket (Node 22+ has one built in; no dependency). With perf=1 the page
// auto-runs, plays at 300x from t for 600 frames, then publishes
// window.__storePerf = { frameMs, drawCalls, triangles } from viewer.stats()
// and sets document.title to "store:perf". All five committed shops must stay
// inside the budget below. An imported plan is reported but never enforced,
// because its size is the user's — hand one over from /import and re-run with
// --only to measure it.
//
//   npm run build && npm run start -- --port 3100     # in another terminal
//   node scripts/perf-store.mjs --url http://localhost:3100
//
// Options: --url <server> (default http://localhost:3000), --only <name,...>
// (store-midtown, store-avalon, ...), --t <minute> (default 2195, Tuesday
// 12:35, the lunch peak), --days (default 7, so 600 frames at 300x never reach
// the horizon and the run passes through Saturday, the heaviest trading day),
// --week, --seed, --swiftshader (software rendering for a machine without a
// GPU: the frame time is then informational and only the draw-call budget fails
// the run), --timeout <real ms>. BROWSER_BIN overrides the browser. Headless
// Chromium uses the machine's GPU by default; the unmasked WebGL renderer is
// printed per shop so a silent fallback to software rendering is visible in the
// log — a shop is a harder scene than a warehouse (a car park, glazing, and
// dozens of short-lived customers and their cars in instanced pools), so a run
// that quietly lost the GPU would otherwise just look like a slow shop.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SHOPS = [
  { name: "store-midtown", store: "store-midtown", src: null, enforce: true },
  { name: "store-decatur", store: "store-decatur", src: null, enforce: true },
  { name: "store-marietta", store: "store-marietta", src: null, enforce: true },
  { name: "store-avalon", store: "store-avalon", src: null, enforce: true },
  { name: "store-buford", store: "store-buford", src: null, enforce: true },
];
const FRAME_MS_MAX = 16;
// A shop draws more objects than the reference warehouse did, so its budget is
// higher. The floor is the static scene, counted off the built Object3D graphs
// (buildBuilding + buildFixtures + buildEnvironment) with no browser involved:
// 59 drawable objects at Buford, 66 at Midtown, 76 at Avalon — the facings and
// the stockroom positions are two InstancedMeshes however many there are, and
// the growth between shops is service posts, goods doors and stockroom runs. On
// top of that come the actors: three instanced pools (shoppers, cars, loose
// pallets) plus a pooled Group per member of staff, stock cart, pallet jack,
// van and truck, which is at most about 60 more draw calls at Avalon with three
// trailers on the doors and five carts out. 180 leaves room for that worst
// minute and still fails if something stops being merged or instanced.
const DRAW_CALLS_MAX = 180;
const WIDTH = 1600;
const HEIGHT = 1000;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const POLL_MS = 500;

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  const inline = argv[i].indexOf("=");
  return inline >= 0 ? argv[i].slice(inline + 1) : (argv[i + 1] ?? fallback);
}
const url = String(arg("url", "http://localhost:3000")).replace(/\/+$/, "");
const only = arg("only", null);
const week = Number(arg("week", 36));
const days = Number(arg("days", 7));
const seed = Number(arg("seed", 1));
const t = Number(arg("t", 2195));
const timeoutMs = Number(arg("timeout", 180_000));
const swiftshader = argv.includes("--swiftshader");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browserBin() {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  if (existsSync(EDGE)) return EDGE;
  return "google-chrome";
}

/** Fails fast with the fix when nothing serves /store, instead of a browser tab timing out on an error page. */
async function checkServer(tag) {
  let why = "";
  try {
    const r = await fetch(`${url}/store`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) why = `answers ${r.status}`;
  } catch (err) {
    // undici wraps the socket error in `cause`; its `code` (ECONNREFUSED, ...) is the useful part.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
    why = `is not answering (${code || (cause instanceof Error && cause.message) || String(err)})`;
  }
  if (why) {
    console.error(`${tag}: ${url}/store ${why}. Build and start the server first: npm run build, then npm run start -- --port 3100 and pass --url http://localhost:3100.`);
    process.exit(1);
  }
}

function perfUrl(b) {
  const hash = [`store=${b.store}`, `week=${week}`, `days=${days}`, `seed=${seed}`, `t=${t}`, ...(b.src ? [`src=${b.src}`] : []), "perf=1"];
  return `${url}/store#${hash.join("&")}`;
}

// ---------------------------------------------------------------------------
// DevTools protocol over the built-in WebSocket: numbered requests, matched
// replies; events are not needed, the page's title is polled instead.
// ---------------------------------------------------------------------------

// A request the browser never answers (seen on the dev box with the screenshot
// script: browser and tab up, renderers running, no reply, no close) would
// otherwise wait forever, past every --timeout, since only the title poll has a
// deadline. A bounded wait per request and per handshake turns that into a
// failed measurement instead.
const REPLY_MS = 30_000;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    const handshake = setTimeout(() => {
      ws.close();
      reject(new Error(`no DevTools handshake from ${wsUrl} in ${REPLY_MS} ms`));
    }, REPLY_MS);
    ws.addEventListener("open", () => {
      clearTimeout(handshake);
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`no reply to ${method} in ${REPLY_MS} ms`));
            }, REPLY_MS);
            pending.set(id, { res, rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.rej(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.res(msg.result);
    });
    ws.addEventListener("error", () => {
      clearTimeout(handshake);
      reject(new Error(`could not connect to ${wsUrl}`));
    });
    ws.addEventListener("close", () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.rej(new Error("DevTools connection closed"));
      }
      pending.clear();
    });
  });
}

async function evaluate(page, expression) {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** Chromium writes "<port>\n<browser endpoint path>" to DevToolsActivePort in the profile once it listens. */
async function devtoolsEndpoint(profile, child, deadline) {
  const file = path.join(profile, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the browser exited with code ${child.exitCode} before DevTools came up`);
    if (existsSync(file)) {
      const [port, browserPath] = readFileSync(file, "utf8").split(/\r?\n/);
      if (Number(port) > 0 && browserPath?.startsWith("/")) return { wsBase: `ws://127.0.0.1:${port}`, browserPath };
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for the DevTools port");
}

/** A private profile per launch: without one the launch is handed to any Edge window already open and exits at once. */
async function launch(bin) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "store-perf-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    ...(swiftshader ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : []),
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  let browser = null;
  let wsBase = "";
  try {
    const endpoint = await devtoolsEndpoint(profile, child, Date.now() + 30_000);
    wsBase = endpoint.wsBase;
    browser = await connect(`${wsBase}${endpoint.browserPath}`);
  } catch (err) {
    child.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${stderr.trim()}`);
  }
  return {
    browser,
    wsBase,
    async close() {
      await browser.send("Browser.close").catch(() => {});
      browser.close();
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        await Promise.race([exited, sleep(5000)]);
        if (child.exitCode === null) child.kill();
        await exited;
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** A fresh tab with an exact viewport and a fixed colour scheme, navigated to the page. */
async function openPage(b, pageUrl) {
  const { targetId } = await b.browser.send("Target.createTarget", { url: "about:blank" });
  const page = await connect(`${b.wsBase}/devtools/page/${targetId}`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.send("Page.navigate", { url: pageUrl });
  return {
    page,
    async close() {
      page.close();
      await b.browser.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

// The page's own error notice; best effort, and the timeout message prints the
// body text anyway. Kept the same as screenshot-store.mjs on purpose.
const ERROR_SELECTOR = ".store-notice.error, .notice.error, .store .error, [role=alert]";
const STATE_JS = `JSON.stringify({ title: document.title, error: document.querySelector(${JSON.stringify(ERROR_SELECTOR)})?.textContent ?? "" })`;

/** Polls until document.title is `want`; fails early on the page's own error notice. */
async function waitForTitle(page, want, deadline) {
  let title = "";
  while (Date.now() < deadline) {
    let state = null;
    try {
      // Right after Page.navigate the old document may still answer, or none; treat that as not ready.
      state = JSON.parse(await evaluate(page, STATE_JS));
    } catch {
      state = null;
    }
    if (state) {
      title = state.title;
      if (title === want) return;
      if (state.error) throw new Error(`the page reported an error: ${state.error.replace(/Dismiss$/, "").trim()}`);
    }
    await sleep(POLL_MS);
  }
  const text = await evaluate(page, "document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300)").catch(() => "");
  throw new Error(`timed out after ${timeoutMs} ms waiting for document.title "${want}" (title "${title}"; page says: ${text})`);
}

// The unmasked WebGL renderer, so a run that silently fell back to software rendering says so.
const RENDERER_JS = `(() => {
  const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
  if (!gl) return "no WebGL";
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
})()`;

async function measure(b, shop) {
  const started = Date.now();
  const tab = await openPage(b, perfUrl(shop));
  try {
    await waitForTitle(tab.page, "store:perf", started + timeoutMs);
    const raw = await evaluate(tab.page, "JSON.stringify(window.__storePerf)");
    const stats = JSON.parse(raw ?? "null");
    if (!stats || typeof stats.frameMs !== "number" || typeof stats.drawCalls !== "number" || typeof stats.triangles !== "number") {
      throw new Error(`window.__storePerf is not { frameMs, drawCalls, triangles }: ${raw}`);
    }
    const renderer = await evaluate(tab.page, RENDERER_JS);
    return { ...stats, renderer, seconds: (Date.now() - started) / 1000 };
  } finally {
    await tab.close();
  }
}

async function main() {
  const bin = browserBin();
  if (bin !== "google-chrome" && !existsSync(bin)) {
    console.error(`perf-store: browser not found at ${bin}; set BROWSER_BIN to a Chromium binary.`);
    process.exit(1);
  }
  const wanted = only
    ? new Set(
        String(only)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;
  const shops = SHOPS.filter((s) => !wanted || wanted.has(s.name));
  if (shops.length === 0) {
    console.error(`perf-store: --only matched nothing; names are ${SHOPS.map((s) => s.name).join(", ")}.`);
    process.exit(1);
  }
  await checkServer("perf-store");
  console.log(`perf-store: ${url}/store at t=${t} (week ${week}, ${days} days, seed ${seed}), 600 frames at 300x, ${WIDTH}x${HEIGHT}, ${swiftshader ? "SwiftShader" : "GPU"} with ${bin}`);
  const b = await launch(bin);
  let failed = 0;
  try {
    // One tab at a time, so no other page's rendering shares the GPU during a measurement.
    for (const shop of shops) {
      let s;
      try {
        s = await measure(b, shop);
      } catch (err) {
        failed++;
        console.log(`FAIL ${shop.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const frameOk = s.frameMs <= FRAME_MS_MAX;
      const callsOk = s.drawCalls <= DRAW_CALLS_MAX;
      // Software rendering cannot hit 16 ms at this size; report it, judge only the draw calls.
      const pass = !shop.enforce || (swiftshader ? callsOk : frameOk && callsOk);
      if (!pass) failed++;
      const verdict = !shop.enforce ? "reported only (an import)" : pass ? "ok" : "OVER BUDGET";
      console.log(
        `${pass ? "ok  " : "FAIL"} ${shop.name}: frameMs ${s.frameMs.toFixed(2)} (max ${FRAME_MS_MAX}${swiftshader ? ", informational under SwiftShader" : ""}), drawCalls ${s.drawCalls} (max ${DRAW_CALLS_MAX}), triangles ${s.triangles.toLocaleString("en-US")}, ${s.seconds.toFixed(1)}s, ${verdict}`
      );
      console.log(`      renderer: ${s.renderer}`);
    }
  } finally {
    await b.close();
  }
  if (failed > 0) {
    console.error(`perf-store: ${failed} of ${shops.length} shop(s) failed.`);
    process.exit(1);
  }
  console.log("perf-store: every committed shop is inside the frame-time and draw-call budget.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
