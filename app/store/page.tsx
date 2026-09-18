import type { Metadata } from "next";
import StoreLoader from "@/components/store/StoreLoader";
import "./store.css";

export const metadata: Metadata = {
  title: "3D twin · Candy shop twin",
  description: "Watch a candy shop trade: the overnight trailer, the morning fill, the orders picked and loaded onto the van, then shoppers down the aisles, at the glass and at the till — simulated in your browser and played back in 3D.",
};

// A Server Component with no request-time APIs, so /store prerenders as a
// static shell; everything interactive lives behind the client-only loader.
export default function StorePage() {
  return (
    <main className="store-main">
      <StoreLoader />
    </main>
  );
}
