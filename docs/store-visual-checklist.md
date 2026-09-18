# 3D twin: visual checklist and browser harnesses

Two scripts exercise the `/store` page in a real browser, and this page says what a reviewer looks for in the pictures they produce. Neither script needs a dependency: both drive a headless Chromium (Edge on the Windows dev box) over the DevTools protocol with the WebSocket client built into Node 22+.

- `scripts/screenshot-store.mjs` renders one PNG per camera preset and shop and fails only when a PNG is missing or too small to be a real frame. There is no golden-image diff on purpose: SwiftShader's software rasterizer drifts between machines and versions, so a person eyeballs the PNGs against the list below.
- `scripts/perf-store.mjs` plays the twin for 600 frames and reads the renderer's frame time, draw calls and triangles back from the page; the five committed shops must stay inside the budget.

A shop is a harder scene than the reference warehouse, and the checks below are written around the three reasons why: **the front wall is glass**, so half of what you are checking is visible from the car park and the label occluder has to let it through; **the customers are the point**, so most of what moves is short-lived and instanced rather than a pooled `Group`; and **there is a car park**, which is a second site plan in front of the first one.

## Running both

The page has to be built and served. `next start` serves the same chunks Vercel does; the dev server also works but is slower and not what ships.

```bash
npm run build                       # runs the postbuild guard against Node built-ins in browser chunks
npm run start -- --port 3100        # 3000 is the default; pick another port when it is taken
npm run store:shots -- --url http://localhost:3100
npm run store:perf -- --url http://localhost:3100
```

Both default to `--url http://localhost:3000`, check that `/store` answers before launching a browser, and find the browser the same way: the `BROWSER_BIN` environment variable, else Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, else `google-chrome` on the PATH. Every launch uses a throwaway profile (`--user-data-dir` under the temp folder), so an Edge window that is already open is never reused and nothing is left behind.

### Screenshots

`node scripts/screenshot-store.mjs [--url …] [--out <dir>] [--only <names>] [--t <minute>] [--days 2] [--week 36] [--seed 1] [--theme light|dark] [--size WxH] [--chrome] [--gpu] [--timeout <ms>]`

- Produces 21 PNGs: three buildings (`store-midtown`, `store-avalon`, `store-buford`) times seven presets (`overview`, `front`, `aisle`, `counter`, `stockroom`, `dock`, `lot`). Midtown is the hash default and a middling shop (70 × 90 ft, 1,413 facings, 5 service posts, 4 doors); Avalon is the biggest and busiest (90 × 110 ft, 2,105 facings, 8 posts, 5 doors, two vans, two entrances); Buford Highway is the smallest (45 × 65 ft, 579 facings, one register, one counter station, a lot of sixteen), which is where crowding shows first. The other two committed shops are an `--only` away and are shot by hand when something about them is in question.
- **No sample-drawing shot yet.** The reference project shoots its CSV sample here. This page takes an imported plan by hand-over from `/import` through sessionStorage (`src=session`) and has no path that fetches a committed sample and parses it for itself, so there is nothing to shoot that is not already one of the built-ins. Adding one is a worthwhile follow-up; see `components/store/ShopPicker.tsx`.
- Files are `<out>/<shop>-<preset>.png`, for example `store-avalon-counter.png`. `--out` defaults to `store-shots` under the OS temp folder (`%TEMP%\store-shots` on Windows, printed on the second line of the output). Pass `--out` to keep a set next to a review. A layout capture or a non-default viewport says so in the name: `store-avalon-counter-chrome.png`, `store-avalon-counter-chrome-1422x701.png`, `store-avalon-counter-400x800.png`.
- Each shot opens `/store#store=<id>&week=36&days=2&seed=1&t=<t>&cam=<preset>[&src=session]&shot=1[&chrome=1]` in a fresh tab. With `shot=1` the page auto-runs, seeks to `t`, applies the preset, renders one frame at device pixel ratio 1 with day/night lighting and shadows off, hides its chrome (unless `chrome=1` is also set), stops its animation loop and sets `document.title` to `store:ready`; the script waits for that title and captures the viewport with `Page.captureScreenshot`. The viewport is 1600 × 1000 unless `--size` says otherwise, and the colour scheme is emulated (`--theme light` by default), so the OS theme and display scaling of the machine do not change the pictures.
- Every time-driven effect in `lib/three/apply.ts` is a function of the simulated minute rather than of wall-clock time — the restock pulse, the late-departure strobe and even the walking bob — so the same `t` draws the same frame every run. A shot that differs between two runs at the same `t` is a bug, not noise.
- `--size WxH` sets the viewport in pixels (`--size 1422x701`), for checking the page at a real window size rather than the review default. `--chrome` adds `chrome=1` to the hash so the page keeps its top bar, camera toolbar, HUD strip, clock, ticker, minimap, side panel and timeline; the frame is still deterministic. Use both together to review the layout (see "The layout" below).
- Rendering is SwiftShader (software) by default so the script runs on a box without a GPU and gives the same pixels run after run on one machine; `--gpu` uses the machine's GPU instead.
- Pass: every PNG exists and is over 30 KB. A blank, black or still-loading frame is mostly one flat colour and compresses to about 7 KB. The script prints one line per PNG (`ok`/`FAIL`, path, size, seconds) and exits 1 on any failure, printing the browser's stderr tail and the page's own error notice when there is one. A DevTools request the browser never answers fails after 30 s (`REPLY_MS` in both scripts) instead of hanging the run past `--timeout`; the same file name is written for either theme, so keep `--theme dark` captures in their own `--out` folder.
- `--only store-avalon-counter,store-buford-lot` re-shoots a subset.

Why not Chromium's own `--screenshot` with `--virtual-time-budget`: virtual time runs out the moment the page's main thread idles, which is while the engine is still running in the Web Worker, so it captures the loading frame every time. Waiting for the page's `store:ready` title over the DevTools protocol is what the page's shot mode was designed for.

#### Which minute to shoot

`t` is engine minutes from 00:00 on the Monday of `week`. The shops trade 10:00–20:00 (to 21:00 Friday and Saturday, 11:00–18:00 Sunday), pick the day's special orders from 06:30, load the van at 09:00 and take the distribution center's trailer inside an overnight window that closes at 07:30 — so there is **no one minute with both a full sales floor and a trailer on a dock**. The default shows the shop trading; shoot the morning separately for the goods doors.

Seed 1, week 36, `--days 2`, counted off the compiled playback:

| `--t` | Clock | What is on the floor | Good for |
|---|---|---|---|
| `2195` (default) | Tuesday 12:35 | The lunch peak, and the busiest minute of the run across all five shops: Midtown 9 shoppers with 4 in a line, Avalon 10 with 7, a car on most of the marked bays, a stocker on the floor at Midtown and two at Avalon, both vans at the kerb | `overview`, `front`, `aisle`, `counter`, `lot` |
| `480` | Monday 08:00 | Doors shut: the overnight trailer on a dock at both shops (Midtown 06:50–08:10, Avalon 04:00–11:40), Midtown's pallet jack running a pallet from the apron (07:55–09:10), staff in the stockroom picking and packing the day's orders | `dock`, `stockroom` |
| `690` | Monday 11:30 | Avalon's vendor box truck still on a goods door with the shop open, so the dock and the sales floor are both alive | `dock` with customers in shot |
| `1980` | Tuesday 09:00 | Midtown's van loading at the kerb and pulling off the lot (09:00–09:15) | `lot` with the van moving |
| `2460` | Tuesday 17:00 | The commute peak: Avalon 12 shoppers with 9 of them queueing, Midtown 6 | `counter`, queue pressure |
| `2610` | Tuesday 19:30 | Midtown 8 shoppers, 3 queueing and 2 walking out of the line; the lot down to its last cars | Abandonment, an emptying lot |

Buford Highway is a four-person shop with five stalls and is often genuinely empty — at the default minute it has nobody in it. Shoot it at `--t 2430` (Tuesday 16:30) if you want a customer in the frame.

### Performance

`node scripts/perf-store.mjs [--url …] [--only <names>] [--t 2195] [--days 7] [--week 36] [--seed 1] [--swiftshader] [--timeout <ms>]`

- Opens `/store#store=<id>&week=36&days=7&seed=1&t=<t>&perf=1` for all five committed shops. With `perf=1` the page auto-runs, plays at 300× from `t` for 600 frames, then publishes `window.__storePerf = { frameMs, drawCalls, triangles }` (frameMs is the mean of `viewer.stats().frameMs` over those frames, the other two are the last frame's `renderer.info`) and sets `document.title` to `store:perf`. Seven days so the 600 frames never reach the horizon **and** so the run passes through Saturday, which carries 2.4× a Tuesday's traffic and is the honest worst case for a shop.
- Budget: `frameMs <= 16` and `drawCalls <= 180` for the committed shops. An imported plan is printed but not judged, because its size is the user's. Exit 1 when a committed shop is over budget.
- Where 180 comes from. The static scene was counted off the built `Object3D` graphs with no browser involved (`buildBuilding` + `buildFixtures` + `buildEnvironment`): **59** drawable objects at Buford, **66** at Midtown, **76** at Avalon. Every facing in the shop is one `InstancedMesh` and every stockroom position is another, however many there are, so that count grows with service posts, goods doors and stockroom runs rather than with the planogram. On top sit the actors: three instanced pools (shoppers, cars, loose pallets) plus one pooled `Group` per member of staff (5 draws), stock cart (3), pallet jack (3), van and truck (5 each) — about 60 more at Avalon's worst minute, three trailers on the doors and five carts out. 180 covers that and still fails the moment something stops being merged or instanced.
- Runs on the machine's GPU by default (headless Chromium uses it) and **prints the unmasked WebGL renderer string per shop**, so a silent fallback to software rendering is visible in the log. This matters more here than it did for the warehouse: a shop puts dozens of short-lived customers and their cars through instanced pools, and a run that quietly lost the GPU looks like a slow shop rather than like a broken browser. `--swiftshader` forces software rendering for a box without a GPU; the frame time is then informational and only the draw-call budget can fail the run.
- Measured on the dev box (Intel UHD via ANGLE D3D11, 1600 × 1000, week 36, 7 days, seed 1, t = 2195, 600 frames at 300×):

  | shop | frameMs | draw calls | triangles |
  |---|---:|---:|---:|
  | store-buford | 1.11 | 104 | 26,092 |
  | store-marietta | 1.52 | 116 | 40,736 |
  | store-midtown | 1.71 | 116 | 47,858 |
  | store-decatur | 1.88 | 126 | 54,654 |
  | store-avalon | 2.43 | 137 | 68,946 |

  Every shop is inside the budget with room to spare, and the spread tracks size rather than anything accidental: Avalon is 2.6× Buford's triangles for 3.6× the facings. Re-run `perf-store.mjs` after any scene change and update this table. `frameMs` is the main-thread time of one `viewer.frame()` — sampling the playback, applying it to the scene, submitting the draw calls and projecting the labels — which is what the page can measure; the GPU's own time is not in it, so the number says the CPU side has room, not that a 4K canvas with shadows hits 60 fps.
- `frameMs` is the main-thread time of one `viewer.frame()` (sampling the playback, applying it to the scene, submitting the draw calls and projecting the labels), which is what the page can measure; the GPU's own time is not in it, so the number says the CPU side has room, not that a 4K canvas with shadows hits 60 fps.

## What to eyeball

Open the PNGs at 100 %. The same person should look at all twenty-one: most checks are "the same thing looks the same in every shop".

Keep the 2D plan open beside them. It is the same palette, value for value — `lib/three/palette.ts` is written from `lib/render/floor.ts` — so a colour that disagrees between the plan and the model is a bug in one of them. Get a plan with `npm run mcp:stdio` and the local `render_floor` tool, or from the shop's page.

### Every shot

- **Light theme, noon, no shadows.** The sales floor is a cream tile (`#f1efe8`), the stockroom behind the dashed line is grey sealed concrete (`#c8c4ba`), the receiving apron inside the goods doors is a warmer grey, the queue zone at the till and the staff corridor behind the counter are two shades of warm sand, the walls are warm grey (`#dedace`), the asphalt is mid-grey. No dim blue cast, no shadows (shot mode turns them off), and nothing glowing: the ceiling troffers over the sales floor, the strips over the stockroom, the pendants over the showcase and the four light-pole heads are all translucent and **unlit** at noon.
- **The site around the shop.** A blue-white sky gradient above (zenith `#6ea6dc` fading to a pale horizon, and the fog takes the horizon's colour so the ground dissolves into it with no seam); an olive ground plane (`#a4ae87`) past the asphalt; a green treeline down both sides and across the back; the public street beyond the lot with its dashed centre line; four 20 ft light poles, two in the lot, one at its far edge and one on the service drive. A black band where the ground should be means the environment did not build.
- **The kerb.** A raised walkway strip (`#9aa0a8`) 8 ft deep runs the whole width of the shopfront, a kerb above the asphalt, with a bollard either side of the entrance. Curbside bays face it; the van stands against it.
- **Nothing missing or black.** Four walls (three opaque, one glazed), every gondola run, the bulk wall, the showcase and counter, the stockroom racking, every door with its number plate, the lot and the service drive. A black frame, or black above the shop, means the page never reached `store:ready` — see "When a check fails" — not an expected void.
- **Without `--chrome`, the frame is the scene only**: no top bar, HUD tiles, side panel, timeline, camera pill, minimap or ticker. The canvas fills the viewport inside the page's stage frame.
- **Labels.** White pills with dark text: one over every member of staff on the floor (their worker id), one over every vehicle that is moving or on a door, named for the supplier or the round. Blue queue chips sit at the head of each line that has anybody in it, reading the post id and the count (`REG-1 3`, `CTR-2 2`), well above the heads of the people standing in it. Small `out` badges sit on a facing that has run out **with a restock still queued** — the shelf a shopper is about to walk away from. At most 24 pills are drawn, highest priority and nearest first; overlapping ones are pushed upward, so two may stack but none may be printed over another, clipped or upside down.
- **The glass is part of the occlusion test.** From a low camera outside the shop, a staff pill deep inside is hidden by the walls — but a shopper seen *through the glazed storefront* keeps their pill. That is the store-specific half of `wallsHide`, and the `front` and `lot` shots are where it shows.
- **Colours match the 2D plan.** Gondolas blue-grey, endcaps and seasonal tables orange, the bulk wall warm brown, wall shelving pale grey, the showcase amber, impulse racks pink, stockroom pallet rack tan with case shelving a paler tan, registers near-black, showcase stations amber, the gift-wrap station pink, the customer entrance blue, raised docks green, the ground-level roll-up orange, accessible bays blue and curbside bays green.
- **Fill colour never doubles back.** Every product block runs green (stocked) → amber (down to a case or less) → red (empty), and its height is the fill level. A facing with no SKU merchandised on it is hidden, not drawn empty; a facing with a restock queued breathes orange on a one-simulated-minute cycle, so at a fixed `t` it is caught somewhere between its fill colour and orange — that is expected, and it is the same phase every run.

### `overview` (three-quarter aerial from over the lot)

- The whole shop **and** the whole car park are in frame, with the service drive behind, at about a 35° elevation — the building fills the frame rather than sitting under a band of empty sky.
- The storefront reads as glass, not as a wall with a hole in it: a low bulkhead, a pale blue-tinted run of glazing to 11 ft with a mullion every 8 ft, then a dark slate fascia band to 16 ft carrying a pale sign panel across the middle, and a canopy over the walkway.
- The model is roofless, so the sales floor reads from above: the gondola runs with their aisles between them, an endcap at each run end, the bulk wall down one side, the seasonal tables inside the door, the showcase and service counter down the other side with the sand-coloured queue zone at the till and the staff corridor behind the counter, the dashed stockroom line and the racking behind it.
- The lot is striped: a line either side of every bay and a wheel stop near the head, drive lanes dashed down the middle, the bays nearest the door in green (curbside) then blue (accessible) with a white wheelchair symbol painted in each blue one. A bay with a car on it has its paint dimmed, so a full lot reads as a full lot.
- **The 3D lot and the 2D plan legitimately disagree on stall count.** The plan squeezes every declared stall in by growing the row count; the model stripes only the bays that fit the depth the site actually gives — 14 at Midtown against the 32 the site declares, 20 at Avalon, 5 at Buford. What must agree is the *order*: curbside nearest the door, accessible next.

### `front` (eye level on the walkway, looking in through the doors)

- The camera is at a person's height (5.6 ft minimum) on the walkway outside the entrance, about 22 ft either side of the door in frame.
- Through the glass: the seasonal tables just inside, the mouths of the gondola aisles, and the counter running down one side with the registers nearest the front. That is the whole reason the front wall is glazed — if you cannot see the sales floor from here, the glazing material is writing depth or the glass is opaque.
- The entrance itself: jambs and a head in blue, two sliding leaves, a transom of glazing above the doorway keeping the glazing line unbroken, and an entrance mat just inside. **The leaves are apart when somebody is within 7 ft of the door and shut otherwise** — at the default minute, with shoppers coming and going, expect at least one shop's doors open and be suspicious if every shop's doors are shut with a customer standing on the mat.
- Customers walking in from the lot, and the queue at the till visible behind them. A shopper's colour is their basket kind; somebody standing in a line is pushed toward grey-blue, somebody being served toward teal, somebody who has given up and walked out toward orange.
- A bollard either side of the door, the kerb underfoot, cars nose-in beyond it.

### `aisle` (down a gondola aisle, at a stocker's height)

- The camera looks down the **widest gap between two neighbouring gondola runs** — the aisle a shopper would really walk — from its front end, at 5.5 ft.
- Both walls of the aisle are shelving, not slabs: shelf decks at each shelf height with a shelf-edge strip on the face, an upright at every bay end, and the product blocks standing proud of the carcass. If a run reads as one smooth coloured extrusion, the decks or the uprights are missing.
- Facings are coloured blocks whose **height is the fill level**, running green through amber to red, four or so per bay per shelf with a small gap between them. A whole bay at one colour is suspicious; a whole run at one colour is a bug.
- Product is on the side of the run the shopper reaches from. On a double-sided gondola both faces carry product, each into half the run's depth. **Blocks sunk inside the carcass, or on the far side from the aisle, mean the facing `side` sign is inverted** — that merchandises the shop into the backs of its own gondolas.
- People in the aisle: shoppers reaching at a shelf, and at a restocking minute a stocker with a stock cart, the cart carrying a load box tinted by the category it is filling. A cart standing in its painted park stall at the end of a run is idle and correct.
- Bulk bins, if this shop's widest aisle runs beside them, have a deep lip on the shelf face rather than a thin strip.

### `counter` (standing at the showcase glass, on the shopper's side)

- This is the one preset meant to feel like a person rather than a plan: the camera is at 5.5 ft on the *customer's* side of the glass — whichever side of the showcase looks into the shop rather than into the staff corridor — about 13 ft of floor across.
- The showcase reads as a glass case: an amber base cabinet to 2.4 ft, then a pale blue translucent box to 3.6 ft with the **trays inside it** — the showcase's own facings, on three shelves, coloured by fill like any other facing. Pendants hang over it, one per bay, unlit at noon.
- A clerk stands behind the glass at a counter post, on the staff-corridor side. Posts are amber and slightly emissive while somebody is being served, dark while idle, grey while the post is closed by an outage.
- A queue in front of it: people 3 ft apart in a line running back from the post head, up to twelve deep, tinted toward grey-blue, with a blue chip above the head of the line giving the post id and the count.
- The registers are further forward down the same counter, near-black with a pale terminal on a stalk; the gift-wrap station is the pink post. The queue zone under the till line is the sand-coloured floor patch, and the staff corridor behind the counter is the matching band on the other side.
- Nobody is standing *inside* the counter, the showcase or the wrap bench.

### `stockroom` (over the racking, from its sales-floor corner)

- Tan pallet racking and paler case shelving, uprights at every bay end and beams down both sides of each level; 5 ft levels on the pallet rack, 1.6 ft on the shelving.
- Cases on them: one block per stockroom position, coloured by SKU **category**, its height the fill of that position. An empty position draws nothing — gaps in the racking are correct and are the story. A rack where every level is full to the beam at every hour is not.
- The pick-and-pack bench: a solid body 8 ft long, with up to three loose pallets set out in front of it while orders are being picked and packed.
- The receiving apron inside the goods doors is the warmer grey floor with a zebra hatch painted across it at 45°, one band per goods door, and a painted band along the apron line; the ten-foot floor grid is drawn **only** behind the stockroom line, where a pallet jack runs.
- A pallet jack in the aisle with a pallet on its forks during a putaway, and parked inside its painted stall between jobs; stock carts likewise in theirs.
- Loose pallets in the lane slots inside each goods door — 4.2 ft outlined squares — stacking a tier at a time when there are more pallets than slots, which is what a receiving apron looks like when the crew is behind.
- Staff: at `--t 480` expect somebody at the bench and somebody at the racking at both shops.

### `dock` (from the service drive, looking at the goods doors)

- The camera is out on the drive at 18 ft — high enough to see over a backed-on trailer — with every goods door in frame.
- A docked trailer sits with its **rear at the dock face and the tractor away from the building, wheels on the ground, no part of it inside the wall**. The rig is 63 ft long against a service road 55 ft out, so the tractor stands out over the road's centre line; that is right, not a mistake.
- Trailer colour says where it came from: the distribution center's overnight trailer is green, a vendor's box truck orange, the shop's own van blue.
- The raised docks have a leveller plate inside the opening, a canopy above it, two black rubber bumpers either side of the opening, and a green door lamp that is lit while something is on the door and dim when the door is free; the door's curtain is up exactly while a vehicle is on it.
- The **ground-level roll-up** is the orange door with no leveller — just a thickened threshold the van and the box truck drive up to — and it is the one the direct vendors use.
- Each door carries a lettered number plate on the outside face of the wall at 13.5 ft, readable from here (under Node the plates are blank, but in a browser capture they are lettered).
- The drive itself: a dashed centre line, and two outlined waiting spots per door 34 ft and 96 ft out. A truck waiting for a door stands in one; it must not overlap the docked trailer, the road or the next truck in line.
- At the default trading minute both shops' doors are empty — the doors, the hatch, the bumpers and the lamps are still all there to check. Use `--t 480` for a trailer.

### `lot` (over the customer parking, looking back at the shopfront)

- Cars are **nose-in** in their bays, pointed at the shop, one per occupied stall — never two in a bay, never one across the drive lane, never one on the grass.
- The drive lane runs across the lot between the walkway and the first row of bays, dashed down its middle; a car arriving or leaving is on it, not cutting across the stalls.
- The shop's van stands at the kerb at the far end of the storefront from the entrance, or is out on the lane at a departure minute (`--t 1980` for Midtown).
- The marked bays are nearest the door: green curbside first, then blue accessible with the wheelchair symbol. Their paint is dimmed where a car is standing on them.
- Light poles stand in the lot, masts in the kerb colour, heads dark at noon.
- Beyond the lot: the street with its dashed centre line, then the treeline, then the olive ground.
- The storefront closes the shot: glazing, mullions, fascia and sign, with the sales floor visible through the glass.

### The smallest shop (`store-buford-*`)

Same checks, on the shop where everything is tightest: 45 × 65 ft with its stockroom starting 46 ft in. Two double-sided gondola runs of six 4 ft bays with an endcap at each end, a bulk-bin wall and a front wall bay down the left, one seasonal table inside the door, a 24 ft showcase with a single serving station, one register with an impulse rack beside the queue, a gift-wrap station, one row of pallet rack and one run of back-stock shelving, and two goods doors on the back wall — one roll-up and one raised dock. The lot is sixteen stalls, one accessible and one curbside.

This is the shop that catches crowding. With one register and one counter station it queues in every busy shot, so the queue chips should be the first thing you see and the line should stand *along* the counter rather than through it. It is also the only shop where the lot fills: check that a car with nowhere to go holds on the drive lane and its driver walks in from the kerb, rather than parking on top of somebody.

### The layout (`--chrome`, one preset is enough)

The page is an app at 1000 px and wider and a document below that. Capture three sizes and look for these things.

```bash
node scripts/screenshot-store.mjs --url http://localhost:3100 --chrome --size 1422x701 --only store-avalon-overview
node scripts/screenshot-store.mjs --url http://localhost:3100 --chrome --size 1280x720 --only store-avalon-overview
node scripts/screenshot-store.mjs --url http://localhost:3100 --chrome --size 400x800 --only store-avalon-overview
```

- `1422x701` and `1280x720` (a laptop window): the page fills the viewport exactly, nothing below the fold and no page scrollbar. One compact top bar. The stage is the hero — every pixel between the top bar and the timeline — with the side panel to its right at 320 to 360 px, **scrolling inside itself** (a long tab is cut by the panel's own bottom edge, not by the page). Over the stage, top-left: the camera toolbar on one row — the three view modes (Orbit, Follow, Walk) and all **seven** presets (Overview, Front, Aisle, Counter, Stockroom, Dock, Lot) — with the HUD strip on its own row under it. Top-right: the clock pill with the day and time, the speed (`300×` on a fresh load, from the five the clock offers: 1, 10, 60, 300, 1800) and whether it is playing and skipping quiet hours. Bottom-left the ticker, bottom-right the minimap. The timeline is docked at the bottom with the transport, the speed row, the skip-quiet control, the clock and the playhead at `t`. Nothing overlaps anything.
- `1000x600` (the narrowest app-mode window, optional): the toolbar and the clock no longer fit side by side, so the clock drops under the toolbar; the toolbar itself never wraps and nothing overlaps.
- `400x800` (a phone): single column with 16 px gutters and **no horizontal scrollbar**. The top bar wraps, the stage is a fixed block showing the shop under a reduced toolbar, the HUD tiles wrap into a strip under it, the timeline's transport wraps, and the side panel is a bottom sheet whose tab row peeks up from the bottom edge. The page scrolls; the stage does not squash the shop out of frame — the presets are fitted to the viewport's aspect, so the same preset frames the same subject on a phone as on a monitor.
- What a capture cannot show, check by hand in a browser: clicking a toolbar button never orbits or picks on the canvas underneath; the keyboard still works after a mouse click on any control over the stage; picking a facing, a fixture, a stockroom position, a door, a service post, a parking stall or an actor puts the right thing in the inspector; Follow chases the actor you picked and Walk drops you on the floor; and the first drag or wheel releases the preset the camera was framing, while a resize re-fits it.

## When a check fails

- **A PNG under 30 KB, or a black canvas.** The page never reached `store:ready`. Run `node scripts/perf-store.mjs --only <shop>` for the WebGL renderer string (a `no WebGL` answer means the browser flags lost the SwiftShader fallback), and open the same hash in a normal browser to read the page's error notice; the script prints that notice when it can find one.
- **The screenshot script times out saying `page says: Simulating…`.** The worker did not finish. Open the hash in a browser and check the console for a worker error — a rejected scenario posts an error notice instead of running.
- **A knot of cars stacked on top of each other 90 ft off the end of the lot, on the drive-lane line, with none of them in a bay.** Car tracks have no leading `Off` keyframe: `PlaybackCursor` clamps to keyframe 0 before a track starts, so every car that has not yet arrived reads as `Drive` at the lot spawn point. Customers, workers and trucks all get that leading `Off` keyframe from the compiler; cars do not. Fix it in `lib/trace/compile.ts`, not in the renderer.
- **Shoppers or cars missing at a busy minute while others are drawn.** The instanced pool ran out of slots and `InstancedActors.overflow` is climbing. The pools are sized from the busiest minute of the run by `peakConcurrent`, so either the sizing input is wrong or something is claiming slots it should have released — the bug above does exactly that.
- **Product blocks inside a gondola, or on the far side of it from the aisle.** The `side` sign in `lib/three/fixtures.ts` (`blockX`) is inverted. `Facing.x` is the aisle centreline, not the fixture; the fixture is `spec.fixtures` found by `Facing.run`.
- **A trailer floating 25 ft off the dock, or nose-first into the wall.** The trailer pose: rear at the door origin, heading `-inward`. `lib/trace/compile.test.ts` pins it.
- **A shelf that is nearly empty reading greener than a full one.** The fill ramp doubled back; `lib/three/palette.test.ts` pins that it cannot.
- **Cases in the stockroom tinted a different category than the pallets that fed them.** The category `colorIdx` order drifted between `lib/store-worker/payload.ts` (which sorts the categories before numbering them) and `lib/three/apply.ts`.
- **Pills floating on a blank wall from the `dock` or `lot` camera.** `wallsHide` is not being given the occluder, or the glazed spans have swallowed the opaque walls too — the storefront is see-through, the other three walls are not.
- **The interior glowing like a lightbox, or fixtures in the wrong values.** The theme did not reach `building.setTheme` / `fixtures.setTheme`. Unlike the reference warehouse, a shop's own fixtures follow the UI theme, and the two ramps — fill and heat — deliberately do not.
- **Draw calls over 180 on a committed shop.** Something is no longer merged or instanced. Compare against the static counts above (59 / 66 / 76) to see whether the scene or the actors grew.
