/**
 * Mock catalog: suppliers and SKUs for every candystore category, generated
 * from a fixed seed so a rebuild reproduces the committed file exactly.
 * Product names are generic product types, never brands.
 *
 * The product list is deliberately digitaltwin_mcp's. The same four domestic
 * families and seven specialty importers, the same items, the same ids, and —
 * because the four draws inside `drawSku` happen in exactly the reference's
 * order — the same `innersPerCase`, `innerCubeFt`, `casesPerPallet` and
 * `velocityShare`. That means a pallet of T-0007 in the distribution-center
 * twin is a pallet of T-0007 here, and the two projects' numbers reconcile.
 * Everything a shop needs that a warehouse does not is derived afterwards from
 * per-SKU substreams, so adding a retail field never shifts the shared ones.
 *
 * The retail fields are the design work:
 *
 *   fixture      where the SKU merchandises. Allocated so the assortment's
 *                dollar mix matches FIXTURE_TARGET inside every category.
 *   sellBy       "weight" for whatever lands in the glass case or a gravity
 *                bin, "each" for everything else — see `looseHome` below.
 *   unitsPerInner  pieces in a display box, or pounds in a case.
 *   unitRetail   the shelf price of one selling unit.
 *   season       the holiday a SKU only sells around, where it has one.
 */

import { FIXTURE_KINDS, type FixtureKind } from "../lib/layout/spec";
import type { Catalog, Category, Holiday, Network, SellBy, Sku, Supplier } from "../lib/twin/types";
import { pick, randInt, seededRandom, substream, type Rng } from "../lib/util/random";

export const CATALOG_SEED = 20260913;

// ---------------------------------------------------------------------------
// The assortment, unchanged from digitaltwin_mcp
// ---------------------------------------------------------------------------

/**
 * The four domestic families. All of them arrive on the overnight trailer from
 * the distribution center, which is the whole point of the project upstream:
 * candystore's traditional dollars flow store → DC → domestic supplier.
 */
const TRADITIONAL_FAMILIES: Array<{ supplier: Supplier; items: string[] }> = [
  {
    supplier: { id: "SUP-CHOC", name: "Domestic chocolate supplier", kind: "domestic", leadDays: 5, leadSdDays: 1, orderDay: 1, channel: "dc" },
    items: ["Milk chocolate bar", "Dark chocolate bar", "Peanut butter cups", "Chocolate-covered pretzels", "Caramel chocolate bar", "Crispy rice chocolate bar", "Chocolate-covered raisins", "Mint chocolate patties", "Chocolate truffles", "Toffee chocolate bar", "Malted milk balls", "Chocolate coins"],
  },
  {
    supplier: { id: "SUP-GUMMY", name: "Domestic gummy and chewy supplier", kind: "domestic", leadDays: 6, leadSdDays: 1.5, orderDay: 2, channel: "dc" },
    items: ["Gummy bears", "Sour gummy worms", "Fruit chews", "Licorice twists", "Sour belts", "Gummy sharks", "Taffy assortment", "Fruit slices", "Jelly beans", "Sour watermelon gummies", "Cola bottle gummies", "Chewy caramels"],
  },
  {
    supplier: { id: "SUP-HARD", name: "Domestic hard candy and mint supplier", kind: "domestic", leadDays: 7, leadSdDays: 2, orderDay: 3, channel: "dc" },
    items: ["Butterscotch discs", "Peppermint starlights", "Cinnamon discs", "Lollipops", "Rock candy sticks", "Lemon drops", "Root beer barrels", "Sugar-free mints", "Candy canes", "Cinnamon jawbreakers", "Sour hard candy", "Spearmint leaves"],
  },
  {
    supplier: { id: "SUP-NOVEL", name: "Domestic novelty and nostalgia supplier", kind: "domestic", leadDays: 8, leadSdDays: 2, orderDay: 4, channel: "dc" },
    items: ["Candy necklaces", "Popping candy", "Candy buttons", "Wax bottles", "Candy sticks", "Peanut brittle", "Circus peanuts", "Candy dots", "Saltwater taffy", "Marshmallow chicks", "Chocolate-covered cherries", "Nougat bars"],
  },
];

const SPECIALTY_ITEMS: Record<string, string[]> = {
  latam: ["Tamarind candy sticks", "Chili mango lollipops", "Dulce de leche chews", "Peanut marzipan rounds", "Chili watermelon gummies", "Coconut cocadas", "Guava paste bars", "Cajeta wafers", "Tamarind paste bars", "Mexican chocolate discs", "Chamoy gummy rings", "Obleas", "Alfajores", "Milk fudge squares", "Chili-lime lollipops", "Brigadeiro truffles"],
  caribbean: ["Tamarind balls", "Coconut drops", "Guava cheese", "Peppermint sticks", "Paradise plums", "Sugar cake", "Ginger candy", "Toolum", "Coconut toffee", "Tamarind stew candy", "Peanut drops", "Bustamante backbone", "Pawpaw candy", "Fudge squares", "Mint balls", "Grater cake"],
  eastasia: ["Milk candy chews", "Lychee jelly cups", "Matcha wafers", "Haw flakes", "Soft fruit chews", "Rice candy", "Sesame brittle", "Mochi bites", "Ginger chews", "Honey citron candy", "Red bean wafers", "Yuzu hard candy", "Peach gummies", "Black sugar candy", "Chocolate biscuit sticks", "Dried plum candy"],
  southasia: ["Mango toffee", "Cardamom sweets", "Cumin digestive candy", "Kulfi candy", "Jaggery chikki", "Coconut barfi", "Rose lollipops", "Tamarind pops", "Pan-flavored candy", "Milk peda", "Sesame gajak", "Imli candy", "Elaichi drops", "Soan papdi squares", "Coffee toffee", "Guava toffee"],
  mideast: ["Turkish delight", "Pistachio halva", "Sesame halva", "Pistachio nougat", "Date rolls", "Rosewater lokum", "Sugared almonds", "Mastic gum", "Sesame bars", "Apricot paste rolls", "Barazek cookies", "Qamar al-din sheets", "Tahini fudge", "Maamoul bites", "Honey sesame candy", "Saffron brittle"],
  africa: ["Coconut candy", "Chin chin", "Groundnut brittle", "Kola candy", "Tamarind sweets", "Milk toffee", "Ginger sweets", "Baobab candy", "Kulikuli crunch", "Plantain chips candy", "Honey drops", "Tiger nut sweets", "Sesame snaps", "Bobo candy", "Coconut toffee squares", "Hibiscus sweets"],
  easteurope: ["Cow candy (krowki)", "Chocolate marshmallows", "Honey cake bites", "Sour cherry jellies", "Halva bars", "Wafer bars", "Sesame kozinaki", "Plum chocolate candy", "Fudge toffee", "Poppy seed candy", "Chocolate-covered prunes", "Jelly in chocolate", "Bird's milk souffle", "Hazelnut wafers", "Barberry candy", "Rum-flavored truffles"],
};

const PACKS = ["12ct", "18ct", "24ct", "36ct"];

/** SKU id codes per segment. Spelled out: the first three letters of eastasia and easteurope collide. */
const SEGMENT_CODES: Record<string, string> = {
  latam: "LAT",
  caribbean: "CAR",
  eastasia: "EAS",
  southasia: "SAS",
  mideast: "MEA",
  africa: "AFR",
  easteurope: "EEU",
};

/**
 * Importers whose cases come off their own box truck through the trading day
 * rather than off the overnight trailer. Four of the seven, so both inbound
 * streams are live in every store's day. The split is named rather than drawn
 * so it is a decision and not an accident: Buford Highway's two segments are
 * one of each — its Latin American supplier drives its own cases up the road,
 * its East Asian one ships through Norcross — which is what gives the smallest
 * shop both a dock morning and a mid-afternoon interruption.
 */
const DIRECT_SEGMENTS = new Set(["latam", "mideast", "africa", "easteurope"]);

// ---------------------------------------------------------------------------
// Merchandising: which fixture family a SKU lives on
// ---------------------------------------------------------------------------

/**
 * The dollar mix a candy shop's floor is planned to. Gondolas carry the
 * everyday assortment, the glass case and the bulk wall together carry nearly a
 * third of the dollars on a third of the footprint, and the promotional
 * fixtures — endcaps, the seasonal tables, the racks at the register — earn
 * their space on velocity rather than square feet.
 *
 * Shares are of velocity dollars, and the allocation below hits them inside
 * every category, so the specialty-only shop on Buford Highway gets the same
 * shaped floor as the general stores rather than a case full of nothing.
 */
export const FIXTURE_TARGET: Record<FixtureKind, number> = {
  gondola: 0.4,
  showcase: 0.18,
  bulk: 0.14,
  wall: 0.1,
  endcap: 0.08,
  seasonal: 0.06,
  impulse: 0.04,
};

/**
 * Words that say a confection is sold loose out of the glass: a clerk lifts it
 * from a tray, weighs it and boxes it. Chocolates by the piece, truffles,
 * brittle, fudge and the cut-and-weighed sweets of the specialty segments.
 */
const CASE_WORDS = [
  "truffle", "chocolate-covered", "chocolate marshmallow", "patties", "butter cups", "malted milk", "fudge", "brittle", "crunch", "chikki", "gajak", "kozinaki",
  "halva", "nougat", "marzipan", "toffee", "caramels", "barfi", "peda", "papdi", "cocada", "alfajor", "brigadeiro", "turkish delight", "lokum", "date roll",
  "maamoul", "mochi", "milk candy", "coconut candy", "cake",
];

/**
 * Words that say a candy lives in a gravity bin on the bulk wall and is
 * scooped into a bag: gummies, jellies, sours, chews, drops, discs and the
 * hard candy that a shop buys by the pail.
 */
const BIN_WORDS = [
  "gummy", "gummies", "jelly", "sour", "taffy", "chew", "drop", "disc", "mint", "lollipop", "pops", "licorice", "rock candy",
  "hard candy", "jawbreaker", "barrel", "slices", "ball", "leaves", "sweets", "plum", "flakes", "starlight", "snaps", "circus peanut",
];

/**
 * Items whose own name says which holiday they belong to. Everything else that
 * ends up on the seasonal tables gets a holiday drawn for it; see `holidayOf`.
 */
const HOLIDAY_WORDS: Array<[string, Holiday]> = [
  ["candy cane", "christmas"],
  ["chocolate coin", "christmas"],
  ["peppermint stick", "christmas"],
  ["marshmallow chick", "easter"],
  ["chocolate-covered cherries", "valentines"],
  ["wax bottle", "halloween"],
];

/**
 * Which holiday a seasonal SKU without a telling name is bought for. Weighted
 * the way the candy calendar in lib/twin/season.ts is: Halloween is the biggest
 * single week of the year, Christmas the longest run, then Valentine's, then
 * Easter.
 */
const HOLIDAY_WEIGHTS: Array<[Holiday, number]> = [
  ["halloween", 0.35],
  ["christmas", 0.3],
  ["valentines", 0.2],
  ["easter", 0.15],
];

/** A rack at the register holds cheap singles out of a big box, nothing else. */
const IMPULSE_MAX_PIECE_COST = 0.85;
const IMPULSE_MIN_PACK = 24;

function matches(name: string, words: readonly string[]): boolean {
  const n = name.toLowerCase();
  return words.some((w) => n.includes(w));
}

/**
 * Where a name says the item would be sold loose, if the floor has room for it:
 * the glass case, a bulk bin, or neither. Whether it actually gets that space
 * is the allocator's decision — a shop cannot put its whole assortment behind
 * glass — and an item that does not get it merchandises packaged instead. That
 * is why `sellBy` reads off the fixture rather than off the name: the same
 * chocolate-covered raisins are a pound in the case at one store and a bag on
 * the gondola at the next.
 */
function looseHome(name: string): "showcase" | "bulk" | null {
  if (matches(name, CASE_WORDS)) return "showcase";
  if (matches(name, BIN_WORDS)) return "bulk";
  return null;
}

function namedHoliday(name: string): Holiday | null {
  const n = name.toLowerCase();
  for (const [word, holiday] of HOLIDAY_WORDS) if (n.includes(word)) return holiday;
  return null;
}

function holidayOf(id: string): Holiday {
  let r = substream(CATALOG_SEED, `season:${id}`)();
  for (const [holiday, weight] of HOLIDAY_WEIGHTS) {
    r -= weight;
    if (r <= 0) return holiday;
  }
  return "christmas";
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Price points a confectioner's shelf talker actually carries, within each dollar. */
const EACH_ENDINGS = [0.29, 0.49, 0.79, 0.99];
const MIN_EACH = 0.99;
const MAX_EACH = 14.99;
/** Pounds in one case of loose confection, the inner a weight SKU ships in. */
const POUND_CASES = [5, 6, 8, 10, 12];
const MIN_POUND = 12;
const MAX_POUND = 46;

/** Nearest price point to `x`, clamped to the band a packaged candy sells in. */
function priceEach(x: number): number {
  const base = Math.floor(x);
  let best = MIN_EACH;
  let bestGap = Infinity;
  for (let d = Math.max(0, base - 1); d <= base + 1; d++) {
    for (const end of EACH_ENDINGS) {
      const gap = Math.abs(d + end - x);
      if (gap < bestGap) {
        best = Math.round((d + end) * 100) / 100;
        bestGap = gap;
      }
    }
  }
  return Math.min(MAX_EACH, Math.max(MIN_EACH, best));
}

/** The scale at the counter prints whole and half dollars a pound. */
function pricePound(x: number): number {
  return Math.min(MAX_POUND, Math.max(MIN_POUND, Math.round(x * 2) / 2));
}

// ---------------------------------------------------------------------------
// Drawing the assortment
// ---------------------------------------------------------------------------

/** One item as the distribution-center pipeline draws it, before any retail decision. */
interface Draw {
  id: string;
  /** The bare product type; the pack or case size is appended once it is known. */
  name: string;
  category: Category;
  supplier: string;
  innersPerCase: number;
  casesPerPallet: number;
  innerCubeFt: number;
  /**
   * What one inner — one display box — is worth to the trade, dollars. Not a
   * field of `Sku` here: a shop prices the selling unit, not the box. It is
   * kept because every retail price is derived from it, which is what keeps
   * this catalog commensurable with digitaltwin_mcp's.
   */
  innerRetail: number;
  /** "24ct" and the like, the pack the box is built in. */
  pack: string;
}

function zipfShares(n: number, s: number, order: number[]): number[] {
  const raw = order.map((rank) => 1 / Math.pow(rank + 1, s));
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => r / total);
}

function shuffled(rng: Rng, n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Four draws in this exact order — pack count, cube, box value, pack label —
 * because that is digitaltwin_mcp's order and the two catalogs have to agree
 * item for item. Nothing retail is drawn here.
 */
function drawSku(rng: Rng, id: string, name: string, category: Category, supplier: string, retailRange: [number, number]): Draw {
  const innersPerCase = pick(rng, [6, 8, 12]);
  const innerCubeFt = Math.round((0.12 + rng() * 0.33) * 100) / 100;
  const casesPerPallet = Math.max(20, Math.min(120, Math.floor(55 / (innersPerCase * innerCubeFt))));
  const innerRetail = Math.round((retailRange[0] + rng() * (retailRange[1] - retailRange[0])) * 4) / 4;
  const pack = pick(rng, PACKS);
  return { id, name, category, supplier, innersPerCase, casesPerPallet, innerCubeFt, innerRetail, pack };
}

// ---------------------------------------------------------------------------
// Allocating fixtures
// ---------------------------------------------------------------------------

interface Row {
  draw: Draw;
  velocityShare: number;
  /** Set when the item's own name says which holiday it is bought for. */
  named: Holiday | null;
  /** The loose home the name suggests, if the floor has room for it. */
  loose: "showcase" | "bulk" | null;
  /** Cheap enough, and enough to a box, to earn a slot at the register. */
  cheap: boolean;
  fixture: FixtureKind;
}

function zeroMix(): Record<FixtureKind, number> {
  return { gondola: 0, wall: 0, endcap: 0, bulk: 0, showcase: 0, impulse: 0, seasonal: 0 };
}

function makeRow(draw: Draw, velocityShare: number): Row {
  const pieces = Number(draw.pack.replace("ct", ""));
  return {
    draw,
    velocityShare,
    named: namedHoliday(draw.name),
    loose: looseHome(draw.name),
    cheap: pieces >= IMPULSE_MIN_PACK && draw.innerRetail / pieces <= IMPULSE_MAX_PIECE_COST,
    fixture: "gondola",
  };
}

function eligible(row: Row, kind: FixtureKind): boolean {
  switch (kind) {
    // The glass and the bins both sell by the pound, and both will take either
    // kind of loose candy: chocolate-covered raisins scoop as happily as sours,
    // and the jars of jellies along the top of the case are as old as the trade.
    // The preferences below decide which goes where; this only decides what a
    // shop could plausibly weigh out at all.
    case "showcase":
    case "bulk":
      return row.loose !== null;
    // Nobody impulse-buys a half pound of truffles on the way out.
    case "impulse":
      return row.cheap && row.loose !== "showcase";
    default:
      return true;
  }
}

/**
 * How much a SKU wants a fixture, before the fixture's remaining space is
 * considered. Confections go behind glass and scoopables go in the bins; a
 * holiday item wants a seasonal table. These only steer — the deficit below is
 * what actually decides, so a preference can never push a fixture family past
 * its share of the dollars.
 */
function preference(row: Row, kind: FixtureKind): number {
  if (kind === "showcase") return row.loose === "showcase" ? 2 : 0.6;
  if (kind === "bulk") return row.loose === "bulk" ? 2 : 1;
  if (kind === "impulse") return 1.6;
  if (kind === "seasonal") return row.named ? 3 : 1;
  return 1;
}

/**
 * Give every SKU in one category a fixture, so that the category's velocity
 * dollars land on FIXTURE_TARGET. Biggest sellers first, each one taking the
 * eligible fixture with the most unspent share left; the long tail then fills
 * whatever the head could not.
 *
 * The consequence worth knowing: a holiday item is not guaranteed a seasonal
 * table. If the candy canes alone would be a fifth of the store's dollars they
 * cannot all live on two tables inside the door, so the ones that do not fit
 * merchandise on the gondola and the endcaps like anything else — and keep
 * their `season`, because they still only sell in December.
 */
function assignFixtures(rows: Row[]): void {
  const used = zeroMix();
  // Sorted by share, then by id: a Map or an object would iterate in insertion
  // order, and this has to be stable whatever order the draws arrived in.
  const order = [...rows].sort((a, b) => b.velocityShare - a.velocityShare || (a.draw.id < b.draw.id ? -1 : 1));
  for (const row of order) {
    let best: FixtureKind = "gondola";
    let bestScore = -Infinity;
    for (const kind of FIXTURE_KINDS) {
      if (!eligible(row, kind)) continue;
      const score = (FIXTURE_TARGET[kind] - used[kind]) * preference(row, kind);
      if (score > bestScore) {
        best = kind;
        bestScore = score;
      }
    }
    row.fixture = best;
    used[best] += row.velocityShare;
  }
}

// ---------------------------------------------------------------------------
// Rows into SKUs
// ---------------------------------------------------------------------------

function toSku(row: Row): Sku {
  const { draw } = row;
  // Loose is what the case and the bins are for; everything else is packaged.
  const sellBy: SellBy = row.fixture === "showcase" || row.fixture === "bulk" ? "weight" : "each";
  // Its own stream, so a retail field can be added later without moving the
  // shared warehouse numbers by a cent.
  const rng = substream(CATALOG_SEED, `retail:${draw.id}`);
  const markup = 2.1 + rng() * 0.5;

  let unitsPerInner: number;
  let unitRetail: number;
  let name: string;
  if (sellBy === "each") {
    // A display box worth $10–$36 to the trade holds 12–36 pieces, so a piece
    // costs the shop $0.28–$3.00. Marked up 2.1–2.6× and put on the nearest
    // price point: a $27.00 box of 24 is $1.13 a piece, ×2.4 is $2.70, and the
    // shelf talker reads $2.79.
    unitsPerInner = Number(draw.pack.replace("ct", ""));
    unitRetail = priceEach((draw.innerRetail / unitsPerInner) * markup);
    name = `${draw.name}, ${draw.pack} display box`;
  } else {
    // A weight SKU's inner is pounds of loose confection, not a box of counted
    // pieces, and a pound of hand-boxed chocolate is worth several boxes of
    // wrapped bars. So the same draw is read on its own scale: half the box
    // value is what one POUND costs the shop, $5–$18, which the same 2.1–2.6×
    // markup turns into the $12–$46 a pound the case and the bulk wall charge.
    unitsPerInner = pick(rng, POUND_CASES);
    unitRetail = pricePound((draw.innerRetail / 2) * markup);
    name = `${draw.name}, ${unitsPerInner} lb case`;
  }

  const sku: Sku = {
    id: draw.id,
    name,
    category: draw.category,
    supplier: draw.supplier,
    unitRetail,
    sellBy,
    unitsPerInner,
    innersPerCase: draw.innersPerCase,
    casesPerPallet: draw.casesPerPallet,
    innerCubeFt: draw.innerCubeFt,
    velocityShare: row.velocityShare,
    fixture: row.fixture,
  };
  const season = row.named ?? (row.fixture === "seasonal" ? holidayOf(draw.id) : null);
  if (season) sku.season = season;
  return sku;
}

// ---------------------------------------------------------------------------
// Building the catalog
// ---------------------------------------------------------------------------

export function buildCatalog(network: Network): Catalog {
  const rng = seededRandom(CATALOG_SEED);
  const suppliers: Supplier[] = [];
  const categories: Row[][] = [];

  // Traditional: four families of twelve product types in a few pack sizes each.
  const trad: Draw[] = [];
  for (const fam of TRADITIONAL_FAMILIES) {
    suppliers.push(fam.supplier);
    for (const item of fam.items) {
      const variants = randInt(rng, 3, 4);
      for (let v = 0; v < variants; v++) {
        trad.push(drawSku(rng, `T-${String(trad.length + 1).padStart(4, "0")}`, item, "traditional", fam.supplier.id, [14, 36]));
      }
    }
  }
  const tradShares = zipfShares(trad.length, 1.0, shuffled(rng, trad.length));
  categories.push(trad.map((d, i) => makeRow(d, tradShares[i])));

  // Specialty: one importer per segment, sixteen products each, long lead times.
  network.segments.forEach((seg, i) => {
    const items = SPECIALTY_ITEMS[seg.id];
    if (!items) return;
    const supplier: Supplier = {
      id: `SUP-IMP-${seg.id.toUpperCase()}`,
      name: `${seg.label} candy importer`,
      kind: "importer",
      leadDays: 24 + randInt(rng, 0, 10),
      leadSdDays: 5,
      orderDay: (i % 5) + 1,
      channel: DIRECT_SEGMENTS.has(seg.id) ? "direct" : "dc",
    };
    suppliers.push(supplier);
    const cat = `specialty:${seg.id}`;
    const code = SEGMENT_CODES[seg.id] ?? seg.id.toUpperCase();
    const made = items.map((item, k) => drawSku(rng, `S-${code}-${String(k + 1).padStart(2, "0")}`, item, cat, supplier.id, [10, 28]));
    const shares = zipfShares(made.length, 0.8, shuffled(rng, made.length));
    categories.push(made.map((d, k) => makeRow(d, shares[k])));
  });

  const skus: Sku[] = [];
  for (const rows of categories) {
    assignFixtures(rows);
    for (const row of rows) skus.push(toSku(row));
  }

  const ids = new Set(skus.map((s) => s.id));
  if (ids.size !== skus.length) throw new Error(`Duplicate SKU ids in the generated catalog (${skus.length - ids.size}).`);
  return { generatedAt: new Date().toISOString(), seed: CATALOG_SEED, suppliers, skus };
}

/**
 * The assortment's dollar-weighted fixture mix, for checking the allocation and
 * for the pipeline's summary line. `categoryWeight` says what a category's
 * velocity dollars are worth: the default weighs every category the same, which
 * is what the allocation targets, and passing candystore's revenue by category
 * gives the mix the network actually sells.
 */
export function fixtureMix(skus: Sku[], categoryWeight: (category: Category) => number = () => 1): Record<FixtureKind, number> {
  const mix = zeroMix();
  let total = 0;
  for (const s of skus) {
    const dollars = s.velocityShare * categoryWeight(s.category);
    mix[s.fixture] += dollars;
    total += dollars;
  }
  if (total > 0) for (const kind of FIXTURE_KINDS) mix[kind] /= total;
  return mix;
}
