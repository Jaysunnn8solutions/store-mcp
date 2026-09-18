import Link from "next/link";
import { loadNetwork, loadSites } from "@/lib/data/load";
import { storeFloorSvg } from "@/lib/render/store-floor";
import { SITE_URL } from "@/lib/tools/shared";
import { replicate } from "@/lib/twin/replicate";
import { buildTwin } from "@/lib/twin/twin";

const TOOLS: Array<[string, string]> = [
  ["describe_store", "The five shops, their floors, crews, hours and a baseline week. Call first."],
  ["import_layout", "Read a store plan — DXF, a planogram or location CSV, ArcGIS Indoors, IMDF or IFC — into a layout every tool accepts."],
  ["simulate_day", "Run the shop by the minute for up to eight weeks, with any scenario."],
  ["what_if", "A baseline against a scenario, on the same random draws."],
  ["stress_test", "No-shows, till outages, van breakdowns, supplier delays and surges over many runs."],
  ["find_capacity", "How much demand the shop really serves before the queue, the shelf or the van slips."],
  ["optimize_merchandising", "Eye-level slotting and facing sizes: moves, sales lift, restock labour, payback."],
  ["stock_status", "Stock by category, open orders, days of supply and projected shortages."],
  ["plan_labor", "Staffing through the candy season: gaps, overtime, temps, cost."],
  ["build_schedule", "Who works which day on what, and where one absence closes the counter."],
  ["peak_readiness", "Is this shop ready for Halloween, and if not the cheapest fix."],
  ["get_layout · get_workforce", "The floor, the planogram, the crew and the standards."],
];

/** The same origin the tools put in their links: Vercel's production domain at build time, locally the dev server's. */
const ENDPOINT = `${SITE_URL}/mcp`;

function money(d: number) {
  return d >= 1e6 ? `$${(d / 1e6).toFixed(2)}M` : `$${Math.round(d / 1e3)}k`;
}

export default async function Home() {
  const network = loadNetwork();
  const panels = await Promise.all(
    loadSites().map(async (site) => {
      const ctx = await buildTwin(site.id, 36, {});
      const rep = replicate(ctx, 14, 2);
      const store = network.stores.find((s) => s.id === site.store)!;
      const annual = Object.values(store.revenueBy).reduce((a, b) => a + b, 0);
      return { site, ctx, k: rep.mean, bottleneck: rep.bottleneck, store, annual };
    })
  );

  return (
    <main>
      <h1>A digital twin of a candy shop</h1>
      <p className="lede">
        candystore_mcp decides what five candy shops sell; digitaltwin_mcp runs the two warehouses that supply them. This twin runs the shops themselves,
        minute by minute: the overnight trailer at the back door, the morning fill, the special orders picked and packed before ten, the van going out — and
        then the customers, down the aisles, at the glass counter, at the till, and some of them walking out again. Ask it through MCP how much of a day&rsquo;s
        demand never becomes a sale, whether the shop is ready for Halloween, or who to put on the counter next Saturday.
      </p>
      <pre>claude mcp add --transport http store {ENDPOINT}</pre>
      <p>
        <Link href="/store">
          <b>Watch a shop trade in 3D →</b>
        </Link>{" "}
        <span className="sub">
          The same engine in your browser: customers, queues, restocks, the van and the trailer, minute by minute, with every scenario field.
        </span>
      </p>
      <p>
        <Link href="/import">
          <b>Run the twin in your own shop →</b>
        </Link>{" "}
        <span className="sub">Upload a store plan (DXF), a planogram or location list, ArcGIS Indoors or IMDF data, or an IFC model.</span>
      </p>

      <div className="grid">
        {panels.map(({ site, ctx, k, bottleneck, store, annual }) => (
          <section className="panel" key={site.id}>
            <h2>{site.name}</h2>
            <div className="sub">
              {site.id} · {money(annual)} a year of candystore demand · {ctx.workers.length} people, {ctx.layout.service.filter((s) => s.kind === "register").length}{" "}
              register{ctx.layout.service.filter((s) => s.kind === "register").length > 1 ? "s" : ""},{" "}
              {ctx.layout.service.filter((s) => s.kind === "counter").length} counter station
              {ctx.layout.service.filter((s) => s.kind === "counter").length > 1 ? "s" : ""}, {ctx.layout.facings.length.toLocaleString("en-US")} facings ·{" "}
              {store.type === "specialty" ? "specialty" : "general"}
            </div>
            <div dangerouslySetInnerHTML={{ __html: storeFloorSvg({ layout: ctx.layout }, { width: 520, shadeBy: "appeal" }) }} />
            <div className="tiles">
              <div className="tile">
                <b>{money(k.salesDollars / 2)}</b>
                <span>sales a week</span>
              </div>
              <div className="tile">
                <b>{(k.lostSalesShare * 100).toFixed(0)}%</b>
                <span>of demand lost</span>
              </div>
              <div className="tile">
                <b>{(k.onShelfShare * 100).toFixed(0)}%</b>
                <span>on the shelf</span>
              </div>
              <div className="tile">
                <b>{(k.abandonRate * 100).toFixed(0)}%</b>
                <span>walk out of a queue</span>
              </div>
              <div className="tile">
                <b>{(k.utilization * 100).toFixed(0)}%</b>
                <span>labour utilization</span>
              </div>
            </div>
            <p className="sub" style={{ marginTop: 10 }}>
              Weeks 36–37, mean of 2 runs. Busiest queue: {bottleneck.process ?? "none"}
              {bottleneck.process ? ` (${bottleneck.constraint})` : ""}.
            </p>
          </section>
        ))}
      </div>

      <h3>What the plans show</h3>
      <p className="sub">
        Shaded by merchandising value — how much a facing is worth to whatever sits in it, from the fixture family and the height of the shelf.{" "}
        <span className="swatch" style={{ background: "var(--gondola)" }} />
        gondola{" "}
        <span className="swatch" style={{ background: "var(--showcase)" }} />
        showcase{" "}
        <span className="swatch" style={{ background: "var(--bulk)" }} />
        bulk bins{" "}
        <span className="swatch" style={{ background: "var(--endcap)" }} />
        endcaps and seasonal{" "}
        <span className="swatch" style={{ background: "var(--impulse)" }} />
        impulse{" "}
        <span className="swatch" style={{ background: "var(--wall)" }} />
        wall{" "}
        <span className="swatch" style={{ background: "var(--rack)" }} />
        stockroom{" "}
        <span className="swatch" style={{ background: "var(--entrance)" }} />
        entrance{" "}
        <span className="swatch" style={{ background: "var(--dock)" }} />
        dock{" "}
        <span className="swatch" style={{ background: "var(--ground)" }} />
        roll-up
      </p>

      <h3>Tools</h3>
      <ul className="tools">
        {TOOLS.map(([name, what]) => (
          <li key={name}>
            <code>{name}</code> — {what}
          </li>
        ))}
      </ul>

      <h3>Run it locally</h3>
      <pre>{`git clone https://github.com/Jaysunnn8solutions/store-mcp.git
cd store-mcp && npm install
claude mcp add store-local -- npx tsx /absolute/path/to/store-mcp/mcp/stdio.ts`}</pre>

      <footer>
        Demand from <a href="https://github.com/Jaysunnn8solutions/candystore_mcp">candystore_mcp</a>; the warehouses that supply these shops are{" "}
        <a href="https://github.com/Jaysunnn8solutions/digitaltwin_mcp">digitaltwin_mcp</a>. Shops, catalog, roster and labour standards are mock inputs. Source
        on <a href="https://github.com/Jaysunnn8solutions/store-mcp">GitHub</a>.
      </footer>
    </main>
  );
}
