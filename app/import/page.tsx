import type { Metadata } from "next";
import Link from "next/link";
import ImportWorkbench from "@/components/ImportWorkbench";
import { loadSites } from "@/lib/data/load";

export const metadata: Metadata = {
  title: "Run the twin in your own shop · store_mcp",
  description: "Read a DXF, a planogram or location CSV, ArcGIS Indoors GeoJSON, an IMDF archive or an IFC model into a shop the candy-store twin trades in. The file is parsed in your browser and never uploaded.",
};

/**
 * A thin server wrapper: the workbench itself is a client component, and the
 * shop list is the one thing it cannot read for itself — `lib/data/load` uses
 * node:fs, so the committed shops are loaded here and handed down as plain
 * `{ id, name }` pairs rather than restated in the browser bundle.
 */
export default function ImportPage() {
  const stores = loadSites().map((s) => ({ id: s.id, name: s.name }));
  return (
    <main>
      <p className="sub">
        <Link href="/">← A digital twin of a candy shop</Link>
      </p>
      <h1>Run the twin in your own shop</h1>
      <p className="lede">
        Bring a floor plan. The twin finds the gondola runs and their aisles, the bulk bins, the glass counter, the registers, the stockroom racking and the
        goods doors, tells you how it read every layer, and then trades a fortnight in it — customers down the aisles, the queue at the till, the overnight
        trailer, the van going out. The drawing is read in your browser and never uploaded.
      </p>
      <ImportWorkbench stores={stores} />
    </main>
  );
}
