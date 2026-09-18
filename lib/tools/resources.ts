/**
 * The committed data, readable without a tool call, plus the method document —
 * the one place that says how every number in this server is arrived at.
 *
 * The method text is written out by hand rather than generated, because it is
 * the part a reader needs when a figure looks wrong: not what the code does but
 * why it is allowed to do it.
 */

import { loadManifest, loadNetwork, loadSites } from "../data/load";

export const METHOD_MARKDOWN = `# Candy shop twin — method

**Market.** candystore_mcp decides what each shop sells in a year by category (traditional, and specialty candy for heritage segments) and which distribution center supplies it. This twin takes that as given: a committed snapshot of candystore's baseline, or its live API when a tool is given a \`candystore\` store scenario. Nothing here invents revenue. Everything here decides whether the shop manages to take it.

**Demand.** Annual category dollars ÷ 52 give an average week. That is multiplied by candystore's seasonal factor for the calendar week — the index for that week (Halloween week 44 is 2.4 against an ordinary, holiday-free week, Christmas 1.9, Valentine's 1.7) divided by its own 52-week mean, so the year's dollars are redistributed rather than marked up, and week 44 comes out at about 2.1× the average week — by a day-of-week share (a sweet shop's week ends heavy: Saturday pulls 1.8 against Monday's 0.75), by the scenario's \`demandScale\` and any \`demandShocks\`, and by an hour-of-day shape with a lunch bump, an after-school hour and a commute peak. Dividing by the mean basket gives customers per quarter hour, and each bin is a Poisson draw. A share of the dollars — \`specialShare\`, 12% by default — is taken as delivery and pickup orders instead, placed the evening before.

**Baskets.** Five kinds of shopper: quick, browse, counter, bulk and gift. Each has a share of customers, a mean spend with a long right tail, the fixtures it shops, a chance of gift wrap, a dwell time and a patience. The counter and gift baskets are a quarter of the customers and nearly half the dollars, and both need a person behind glass. Lines are drawn from the fixtures that kind shops, weighted by each SKU's weekly dollars; packaged candy goes in ones and twos, bulk and showcase candy in quarter pounds. One multiplier per fixture family is calibrated so the drawn baskets reproduce the assortment's own dollar mix.

**Building.** Feet, with x across the shop and y from the storefront to the back wall. Gondola runs are parallel to y so a shopper walks the aisles away from the door. Aisles are found rather than declared: two runs whose shopping faces look at each other across a gap make an aisle; a wall run, a bulk-bin wall and the showcase are shopped from one side only, so the corridor behind the glass stays staff space. Endcaps, seasonal tables and the register racks are reached from open floor. Walking is along aisles and out to the nearer cross aisle; an order pick follows an S-shape route through the aisles that hold a line.

**Merchandising.** This is the store's answer to a warehouse's slotting, with the sign flipped. In a warehouse the best slot is the one the picker walks least to reach; in a shop the best facing is the one the customer sees, and the shelf a stocker would choose is roughly the opposite of the shelf that sells. A facing is worth its fixture family's pull × its shelf height (eye level is buy level) × how near the door it is, decaying with walking distance. The current plan is the catalog in id order onto the facings of its own family, every facing one display box — what a shop ends up with when the range grew one delivery at a time. The optimized plan ranks each family by units a week onto its best facings, promotes the fastest movers in the shop onto spare endcap and seasonal space (up to a fifth of the range), and sizes each facing to a few days of that SKU's demand within what the shelf physically holds. A SKU may only sit on the fixture family it belongs to: a bulk SKU cannot live on a gondola shelf. The appeal map is normalised to mean 1 across the assortment, so merchandising moves the mix and never the total.

**Operations.** A discrete-event simulation by the minute, over a heap of events keyed on minutes from 00:00 of horizon day 0. Every unit of work is a job in one of ten queues — unload, receive, putaway, restock, serve, checkout, pick, pack, load, deliver — and after each event every present, idle, off-break worker takes the most urgent job their skills allow, using their primary only to break ties between jobs that are equally pressing (\`flex\` off restricts them to their primary). Urgency beating speciality is where a shop parts company with a warehouse: there is always another case to put out, so a stocker whose own queue can never run dry would never once walk over to an open till. A customer at the till or the glass outranks everything, because a person is standing there.

**Walking out.** Unlike a pallet, a person leaves. Each shopper carries a patience drawn with their basket; a queue longer than it and the basket goes back on the shelf and the sale is lost. That is the store's version of a truck going out late, and it is the number the whole model exists to put a figure on. A shopper who abandons the showcase queue still pays for what they picked up themselves.

**The shelf is the pick face.** Customers help themselves, so only what is on the facing can be sold: a facing that runs out between restocks is a lost sale even with a full stockroom, and nobody backorders a chocolate bar. Staff can walk to the back, so a special order is still filled on a morning when the shelf in front of it is bare. A facing down to a third of its capacity gets a routine top-up; one that hits zero gets a hot one, ahead of everything but the customers. A restock is a **trip**, not a SKU: what the floor is short of is collected, sorted into floor order and loaded onto a cart until its cube is full, and a run is worked in one go. Modelling one trip per line is the difference between a morning fill taking three hours and seventeen.

**The day has two halves.** Before the doors open the crew takes in the overnight trailer from the distribution center, fills the shelves and picks, packs and loads the delivery and pickup orders the van takes out. After ten it is almost all service. The pre-open window is what binds, the way the pick window before the afternoon truck binds in a warehouse. Vendors' own box trucks call through the trading day instead, hand-stacked as loose cases rather than broken down off pallets.

**Inventory.** Periodic review on each supplier's order day, order-up-to S = mean demand over review plus lead time + z·σ, with σ combining demand (index of dispersion 2, because a birthday party clears a bin) and lead-time variance. The shop buys by the **display box** from the distribution center and by the case from a vendor's own truck — a master case of a fast mover is a month of stock for one shop, and ordering in cases would have it reorder almost nothing and run its shelves quietly down. The seasonal forecast looks ahead through the candy calendar; the trailing forecast averages the last four weeks and so meets Halloween with September's order. Every SKU's on-hand splits in two — the facing a customer can reach and the stockroom they cannot — and somebody has to carry stock between them. Trailer shipments are built into full single-SKU pallets with the remainders consolidated by cube. Every run warms up six weeks from steady state, with the floor stocked before the back.

**Workforce.** Workload is expected volume × standard, laid out on a half-hour grid across the whole working day and attributed to the shifts standing on the floor for it; work in a half hour nobody covers — the 04:00 trailer — is charged to the nearest shift, where it shows up as a requirement. Requirement hours = workload ÷ productivity ÷ target utilization ÷ (1 − absenteeism). The week's schedule puts coverage before volume: every trading day gets somebody on its heaviest shift before any day gets a second person, because left to sort themselves by how busy a day looks everybody picks Saturday and the shop opens on Monday with nobody behind the till. Hours left over then go where the load is. It assigns primaries scarcest-skill-first to the least flexible people, and then lets the spare hours of cross-trained people cover short skills — which is what a floor really does. The season plan closes what is left with overtime, then agency temps. Two skills it cannot: \`counter\` needs a food handler's card and \`drive\` needs a licence and the store's insurance, so those gaps are named with the cross-training and hiring lead times instead. A shop can be under-utilised across the week and still have a ten-minute queue at 17:30 on the Saturday before Halloween, which is why \`peakHalfHour\` measures the counter rather than the whole floor.

**Capacity.** find_capacity scales candystore's demand until one of five targets gives — the checkout queue, the showcase queue, walk-outs, on-shelf availability or the van's rounds — and reports which gave first, because the answer changes what you would buy. A queue ceiling is a person or a till; a shelf ceiling is facing depth or a restock trip; a van ceiling is the clock.

**Peak readiness.** peak_readiness runs the peak week as it stands, then again with each fix in turn on the same seeds, and prices them against the store's own cost rates: a register lane and a showcase station by the week, an agency temp by the shift, cross-training spread over six months, a planogram reset over a quarter. The benefit is lost sales recovered at gross margin. Every fix is written in the same scenario vocabulary any other tool accepts, so the winner can be handed to what_if or watched in 3D.

**Imported buildings.** A layout spec — fixture runs with bays and shelves, storage runs, service points, doors, zones, outline and parking — can be passed as \`layout\` to any tool. Demand, crew and equipment still come from the shop the tool was asked about.

**3D shop.** The /store page runs this same engine in a Web Worker in the browser and plays the run back in three dimensions: every customer along their aisles, every queue, every restock trip, truck and van at the minute the engine put it there. The engine's numbers are the truth; what it does not decide — which register, which parking stall, the walk between two jobs — is derived deterministically from its event stream, so the same seed plays back the same way and nothing feeds back into the results. \`replicate\` runs seeds 1..runs and the page runs seed 1, so a tool's first run and the shop on the screen are the same days. simulate_day and what_if end with the link.

**Determinism.** Nothing in the engine or the renderer reads the clock or calls Math.random. Every random draw comes from a named substream of the run's seed, salted with the shop, so adding a draw in one process never shifts the numbers in another. Anywhere a Map is iterated to decide a number, its keys are sorted first.

**Mock inputs.** The five buildings, the catalog, the suppliers, the roster, the labor standards and the cost rates are placeholders in the ranges published for specialty food retail, put there to be edited. candystore's demand is its own model over real demographics; its shops and centers are fictional too.
`;

export const manifestResource = {
  name: "manifest",
  uri: "store://data/manifest",
  config: { title: "Data manifest", description: "When the data was built, from which candystore snapshot, and the counts behind it.", mimeType: "application/json" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadManifest(), null, 2) }] }),
};

export const networkResource = {
  name: "network",
  uri: "store://data/network",
  config: { title: "candystore market snapshot", description: "The shops, their annual retail dollars by category, and the distribution center that supplies each, from candystore_mcp.", mimeType: "application/json" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadNetwork(), null, 2) }] }),
};

export const sitesResource = {
  name: "shops",
  uri: "store://data/shops",
  config: { title: "The five shops", description: "Building, gondolas, wall and bulk runs, showcase, registers, stockroom, doors, parking, equipment, trading hours and shifts for each shop.", mimeType: "application/json" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadSites(), null, 2) }] }),
};

export const methodResource = {
  name: "method",
  uri: "store://method",
  config: { title: "Method", description: "How demand, baskets, the floor, merchandising, operations, inventory, workforce and capacity are modeled.", mimeType: "text/markdown" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: METHOD_MARKDOWN }] }),
};
