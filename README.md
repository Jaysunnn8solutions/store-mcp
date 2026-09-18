# store_mcp

**A digital twin of a candy shop.** [candystore_mcp](https://github.com/Jaysunnn8solutions/candystore_mcp) decides what its five stores sell; [digitaltwin_mcp](https://github.com/Jaysunnn8solutions/digitaltwin_mcp) runs the two distribution centers that supply them. This project runs the shops themselves, minute by minute: the overnight trailer at the back door, the morning fill, the special orders picked and packed before ten, the van going out, and then customers — in off the car park, down the aisles, queueing at the glass counter, queueing at the till, and some of them walking out again. An [MCP](https://modelcontextprotocol.io) server over a discrete-event simulation, with a 3D web page.

**Live site:** `https://store-mcp.vercel.app` · **Bring your own shop:** `https://store-mcp.vercel.app/import`
**3D twin:** `https://store-mcp.vercel.app/store`
**Remote MCP endpoint:** `https://store-mcp.vercel.app/mcp`
**Local MCP server:** `npm run mcp:stdio` (adds `render_floor`, which writes the store plan to an HTML file, and imports files by path, IFC included)

This is the fifth project in a portfolio sequence: [census-mcp](https://github.com/Jaysunnn8solutions/census-mcp) (a stateless tool server), [atl-mcp](https://github.com/Jaysunnn8solutions/atl-mcp) (a spatial engine with scenarios), [candystore_mcp](https://github.com/Jaysunnn8solutions/candystore_mcp) (a market model with a supply chain), [digitaltwin_mcp](https://github.com/Jaysunnn8solutions/digitaltwin_mcp) (that supply chain on a warehouse floor), and this one, which takes it the last hundred feet to the customer's hand.

The company, its shops and its people are fictional. candystore's demand comes from real demographics.

---

## The question

candystore says Avalon Candy Co. sells $5.78M a year. That is a number on a spreadsheet. It assumes every customer who walks in finds what they came for and is willing to wait to pay for it.

The twin asks whether they do.

- How much of a shop's demand never becomes a sale — and is it an empty shelf or a queue?
- Is the shop ready for Halloween, when a week runs 2.1× an ordinary one?
- What actually fixes a peak: more people, more tills, or moving the candy?
- Who works which day on what, and where would one absence close the counter?
- Can the morning crew pick, pack and load the delivery van before the doors open at ten?

---

## What the twin found

Baseline data, mock standards, four weeks from week 36 (an ordinary September), seed 1.

**A quarter of the demand never becomes a sale.** Across the five shops, 18–29% of what walks in walks out again: 7–25% of shoppers abandon a queue, and 3–18% of the units they reach for are not on the shelf. A shop's takings are not what it stocks, they are what it stocks *in front of somebody*.

| Shop | Selling | Facings | Crew | Sales/week | Lost | On-shelf | Walk-outs | Utilization | Binds on |
|---|---|---|---|---|---|---|---|---|---|
| Marietta Square Confections | 3,770 sq ft | 1,119 | 7 | $32.4k | 18% | 91% | 7% | 39% | pick hours |
| Midtown Sweets | 4,340 sq ft | 1,413 | 8 | $39.4k | 21% | 91% | 14% | 44% | pick hours |
| Decatur Square Candy | 4,800 sq ft | 1,561 | 9 | $51.5k | 24% | 84% | 12% | 55% | stock hours |
| Avalon Candy Co. | 6,660 sq ft | 2,105 | 12 | $69.9k | 26% | 81% | 15% | 55% | stock hours |
| Buford Highway World Sweets | 2,070 sq ft | 579 | 4 | $7.5k | 29% | 97% | 25% | 20% | pick hours |

**Every shop is under-utilised and every shop is short.** Labour runs at 20–55% over the week and work still waits, because a shop does not need hours, it needs the right skill in the right half hour. The twin reports workload by half hour for exactly this reason: Midtown's floor is 44% busy across the week and still has days with one person on it at 06:30 who has to take the trailer, fill the shelves and pick the day's orders before ten.

**Halloween breaks all five, in two different ways.** In week 44 demand runs 2.1× an ordinary week. Avalon loses 50% of it and its on-shelf availability falls to 53% — it runs out of candy. Buford Highway loses 30% with its shelves still 94% full — it runs out of people, and 28% of its customers leave a queue. Same holiday, opposite failure.

**Moving the candy beats hiring for it.** At Avalon in week 44, re-merchandising alone — the fastest movers at eye level, every facing sized to days of demand rather than to the fixture — is worth **+$13.4k in one week** and takes on-shelf availability from 53% to 78%. Two seasonal temps are worth +$12.1k, and they do it by serving customers rather than by filling shelves. Everything together: +$31.0k, and the shop still loses 37%, because Halloween genuinely exceeds the building.

**A fifth till is worth less than nothing.** Adding a register at Avalon in week 44 returns **−$281**. The queue is not short of lanes, it is short of somebody to stand at one; the extra lane only costs money. Moving the pick start from 06:00 to 05:00 changes nothing at all, because nobody is on the floor to pick. Moving the shift to 05:00 as well is *worse* — it takes the crew off the evening peak to do work that was never the constraint. Telling those three apart is the whole job.

**The cheapest fix is usually smaller than you would guess.** `optimize_operations` searches the whole lever space rather than a menu, because the levers interact — a second counter clerk is worth little until somebody is cross-trained to cover their break. At Buford Highway in Halloween week it lands on *one* extra cashier on the closing shift and moving the van out half an hour later: together worth **$2.6k a week**, three quarters of the shop's net cost, and it cuts walk-outs from 29% to 18%.

**Buford Highway is one phone call from closing its counter.** Four people, one food handler's card. In Halloween week the glass counter needs 11.1 hours of service and the roster covers 1.5 of them, because the only person qualified is on the opening shift picking orders. `build_schedule` names them.

---

## Model

**Demand.** candystore's annual retail dollars for this shop, by category, ÷ 52 → an ordinary week; × the candy calendar (Halloween 2.1×, Christmas 1.7×, Valentine's 1.5×, Easter 1.2×, week 1 a trough) → this week; × a day-of-week share (Saturday pulls 2.4× a Tuesday) → today; × an hour-of-day shape (a lunch bump, the after-school hour, a commute peak at five) → this quarter hour; ÷ the average basket → customers, drawn Poisson. The average basket is *measured*, not assumed: a few hundred baskets of each kind are drawn on a fixed stream at model build and the mean is taken, because a basket filled with whole units overshoots the spend it was aimed at. That is what keeps the shop's dollars candystore's dollars.

**Customers.** Five kinds — grab-and-go, browser, counter, bulk, gift — each with its own spend, its own fixtures, its own dwell and its own patience. A shopper parks, walks the floor taking things off facings as they reach them, queues at the glass if they want chocolates weighed, queues at a till, and pays. If a facing is empty when they reach for it the sale is lost. If a queue outlasts their patience they put the basket down and leave, and that sale is lost too. **That is the model's whole point:** in a warehouse the work waits and the truck leaves late; in a shop the customer leaves.

**Merchandising.** Eye level is buy level. Where a SKU sits sets its share of the shop's dollars — an endcap steals from the shelf behind it — through a shelf-height curve and a fixture multiplier, normalised to mean 1 across the assortment so merchandising moves the *mix* and never the total. Its real value shows up as fewer lost sales: a facing sized to four days of demand empties less often than one sized to the fixture. Current, optimized and partial plans are all priced.

**The shop floor.** Gondola runs, wall shelving, a bulk-bin wall, endcaps, seasonal tables, impulse racks, and a glass showcase served from behind. Aisles are *found*, not declared: two runs whose shopping faces look at each other across a gap of aisle width make an aisle, and the corridor behind the counter stays staff space. Coordinates are feet, x across the shop and y from the storefront, so the car park is at negative y and the docks are at the back.

**Operations.** A discrete-event simulation by the minute over ten processes — unload, receive, putaway, restock, serve, checkout, pick, pack, load, deliver. Every unit of work is a job in a queue; every present, idle worker takes the most urgent job their skills allow. Urgency beats speciality, which is where a shop parts company with a warehouse: there is always another case to put out, so a stocker whose own queue never empties would never walk to an open till. A restock is a *trip*, not a SKU — a cart is loaded with everything the floor is short of and a run is worked — because modelling one trip per line is the difference between a morning fill taking three hours and seventeen.

**Stock.** Periodic review, order-up-to S = mean demand over review + lead time + z·σ. The shop buys in **display boxes**, not master cases: the distribution center breaks cases and picks inners, and a master case of a fast mover is a month of stock for one shop — order in cases and the shelves quietly run down. Direct vendors still deliver whole cases off a tailgate. Six weeks of warm-up. A customer who finds an empty facing does not backorder.

**Goods in.** Two streams. The distribution center's trailer arrives overnight inside a window before the doors open, on pallets, through a raised dock. Vendors' own box trucks call through the trading day, loose cases, through the ground-level roll-up. Both wait for a door and for somebody to sign for them.

**Orders out.** Delivery and collection orders are taken up to a cutoff the evening before, picked from the sales floor and the stockroom on an S-shape tour from the pick bench before opening, packed, gift-wrapped, and loaded onto the van for a morning round — and an afternoon one at the larger shops. A round holds for an order still on the packing bench, but only for an hour.

**Workforce.** Workload = expected volume × standards, reported by process, by skill, by shift **and by half hour of the trading day**, so a shop that is 46% utilised over the week still shows its 17:00 peak. Coverage comes before volume in the roster: every trading day gets somebody on its heaviest shift before any day gets a second person, because a shop that opens on Monday with an empty floor is not a staffing plan. Temps are never counter- or driving-qualified — a food handler's card and the store's insurance take longer than a season — so those two gaps can only be closed by cross-training or hiring.

**Optimizer.** A genetic search over the shop's levers (`lib/twin/optimize.ts`): people by role and shift, cross-training, flexing, the overtime cap and target utilization, registers and counter stations, carts, jacks and vans, merchandising and facing depth, service level and forecast, the pick start, the van's departures and the trading hours. Each candidate is a scenario the twin accepts, run on the floor and scored as one weekly figure: labour, amortised hiring and training, equipment beyond the shop's own, the carrying cost of the stock — **minus the gross margin on what it sells and plus the margin on what it does not.** That last term is where a shop differs from a warehouse: a late truck is a penalty somebody invents a price for, but a customer who walks out of a queue is a real, priced loss, and the three presets (service, balanced, cost first) disagree only about how much of it comes back next week. Generation 0 holds the shop as it is and every one-lever step from it, so an obvious single fix is found at once; then elites, tournament selection, crossover, mutation and an immigrant per generation, with early stopping and memoised candidates. Deterministic for a shop and seed, and every candidate is scored on engine seeds 1..n, so the winner replays exactly on the 3D page. The result is the best plan found, not a proof of optimality.

Everything is implemented from these rules in `lib/twin/` with tests.

---

## Tools

Fourteen tools on both transports; `render_floor` is a fifteenth that exists only on the local stdio server.

| Tool | Purpose |
|---|---|
| `describe_store` | The five shops, their floors, crews, hours, and a baseline week of each. Call first. |
| `import_layout` | A store plan — DXF, a planogram or location CSV, ArcGIS Indoors, IMDF, or IFC locally — into a layout every tool accepts, with a report of how it was read. |
| `get_layout` | Fixtures, aisles, facings, the counter, the stockroom, the lot; the fastest SKUs and where they sit. |
| `get_workforce` | Roster, skills, single points of failure, labor standards, wage rates. |
| `simulate_day` | Run the shop for up to 8 weeks: sales, lost sales, queues, availability, labor, the bottleneck, a day table. |
| `what_if` | A baseline against a scenario on the same random draws. |
| `stress_test` | No-shows, till outages, van breakdowns, supplier delays and demand surges over many runs. |
| `find_capacity` | The most demand the shop serves before the queue, the shelf or the van slips — and what breaks first. |
| `optimize_merchandising` | Current, partial and full re-merchandise: sales lift, lost sales avoided, restock labour, payback. |
| `optimize_operations` | A genetic search over crew, cross-training, overtime, tills and counters, merchandising, supply policy, hours and the van, for the cheapest plan by stated prices; service, balanced or cost first; the plan comes back as a scenario. |
| `stock_status` | Stock by category, open orders, a weekly projection, shortages, both forecast methods. |
| `plan_labor` | Week-by-week requirement, gaps, overtime, temps, cost, and a floor check of the peak week. |
| `build_schedule` | Who works which day on what; hours needed and covered; one-absence risks. |
| `peak_readiness` | Is this shop ready for Halloween — and if not, the cheapest fix. |
| `render_floor` | **Local only.** A self-contained HTML store plan, shaded by sales, restocks or merchandising value. |

Every simulation tool takes the same scenario fields, so a conversation can chain "plan the crew, test the fix, stress-test it" against one set of assumptions:

- **Building:** `layout` (from `import_layout` or the web page), `fixtures` (re-fixture the gondola block).
- **Demand:** `demandScale`, `demandShocks`, `candystore` (open or close stores in the market model), `specialShare`, `deliveryShare`.
- **Merchandising and stock:** `merchandising`, `facingDays`, `forecast`, `serviceLevel`, `supplierDelays`.
- **People:** `addWorkers`, `removeWorkers`, `crossTrain`, `workerOverrides`, `workerLeave`, `absenteeism`, `flex`, `overtimeMaxHours`, `targetUtilization`.
- **Facility:** `registers`, `counters`, `palletJacks`, `stockCarts`, `vans`, `docks`, `groundDoors`.
- **Calendar:** `hours`, `operatingDays`, `shifts`, `times` (order cutoff, pick start, van departures, delivery windows), `dcDeliveryDays`.
- **Disruptions:** `registerOutages`, `counterOutages`, `dockOutages`, `vanOutages`, `posOutages`, `patience`, `inboundLatenessSdMin`.
- **Engineering:** `standards`, `supplierOverrides`.

Days count from 0, the Monday of `startWeek`. Resources expose the manifest, the candystore snapshot, the shops and the method.

### Remote

```bash
claude mcp add --transport http store https://store-mcp.vercel.app/mcp
```

### Local, with the floor-plan renderer

```bash
git clone https://github.com/Jaysunnn8solutions/store-mcp.git
cd store-mcp && npm install
claude mcp add store-local -- npx tsx /absolute/path/to/store-mcp/mcp/stdio.ts
```

Then ask: *"Is Avalon ready for Halloween? If not, what's the cheapest fix?"*

---

## Data

| File | What | Source |
|---|---|---|
| `data/network.json` | Stores, their annual dollars by category, and which center supplies each | candystore_mcp live API (`npm run pipeline`) |
| `data/catalog.json` | 281 SKUs and 11 suppliers, with shelf prices, sell-by-unit or by-weight, fixture family and season | Generated, fixed seed; generic product types, no brands |
| `data/roster.json` | 40 workers by id, role, shift, skills, productivity, wage | Generated, fixed seed; no names |
| `data/sites.json` | The five shops: fixtures, counter, stockroom, doors, parking, hours, shifts | Hand-written |
| `lib/twin/standards.ts` | Labor standards and cost rates | Placeholders |

---

## Architecture

```
pipeline/         candystore snapshot, catalog and roster generators
data/             committed network, catalog, roster, sites, manifest
lib/util/         seeded random streams, event heap
lib/layout/       the layout spec and its limits; importers; the shared assembler
lib/twin/         season, layout (aisles and facings from a spec), demand and customer
                  traffic, merchandising, stock, workforce, operations (the DES, with
                  trace hooks), replicate, twin (scenario -> context)
lib/trace/        the engine's event contract and the compiler: world, routes,
                  identities, fit, running KPIs, cursor -> typed-array playback
lib/three/        the three.js renderer: building, fixtures, actors, cameras, walk
                  mode, picking, lighting, labels, viewer
lib/store-worker/ the browser run: bundled data, buildTwin, runOperations with a
                  tracer, compile, transfer
lib/store-ui/     the URL hash codec, formatters, inspector text, the report writer
lib/tools/        MCP tools, prompts, resources, one registration for both transports
lib/render/       the store plan as SVG, shared by page, import preview and render_floor
components/       the 3D workbench and its Web Worker; the import workbench
app/mcp/          remote MCP endpoint (mcp-handler)
app/api/store/    stateless simulation of an imported layout
app/page.tsx      the web page; app/import/ the upload page; app/store/ the 3D twin
mcp/stdio.ts      local MCP server (StdioServerTransport) + render_floor
```

---

## Running locally

```bash
npm install
npm run dev          # http://localhost:3000
npm test
npm run type-check && npm run lint
npm run pipeline     # refresh the candystore snapshot; CANDYSTORE_URL overrides the source
npm run test:client -- http://localhost:3000   # every tool over HTTP
npm run test:client -- stdio                   # every tool over stdio, plus render_floor
```

---

## Limitations

- The volumes are candystore's, and candystore is five shops, so these are small buildings with small crews. The dynamics — an intraday peak against a fixed roster, a facing that empties between fills, a queue somebody walks out of, one person with the only food handler's card — are what carry over to a real shop, not the headcounts.
- Standards, costs, the roster, the shop layouts and the prices are placeholders. Calibrate `lib/twin/standards.ts`, `data/sites.json` and the catalog generator before trusting a number.
- A shopper's patience is a single number per basket kind, scaled by a scenario field. Real balking depends on how fast the line is moving, not just how long it is.
- **A SKU holds one facing, not a block of them.** candystore's catalog is 281 SKUs and a shop sells only the categories it stocks, so Midtown merchandises 169 of them on fixtures that hold 1,413 facings. A real shop that size would carry several times the range and block each fast mover across four or five facings side by side. The twin sizes how much one facing *holds* instead, so the stock, the restocking and the lost sales are right and the shelf occupancy is not — which is also why the 3D shelves look emptier than a real shop's. Widening the planogram to facing blocks is the single biggest fidelity gain left in the model.
- Merchandising moves the mix, not the total. A better-merchandised shop sells the same dollars to the same people and simply loses fewer of them; it does not draw new customers off the street. That is deliberate — the alternative is inventing revenue — but it means the twin understates what a good planogram is worth.
- Customers take from a facing but never browse and put back, never substitute when a facing is empty, and never queue-jump. A substitution rate would soften every lost-sale number here.
- Shrink, spoilage, date codes and the seasonal mark-down after a holiday are not modelled. For a business whose stock is chocolate in August and candy canes in January, that is a real gap.
- The car park is modelled to the stall but never turns anybody away; a full lot on the Saturday before Halloween holds cars on the drive rather than losing them.
- One shop at a time. The twin does not model a customer choosing between two of the company's shops, which is candystore's job.
