import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Candy shop twin",
  description:
    "A discrete-event digital twin of candystore_mcp's five candy shops: the sales floor and its planogram, the showcase counter and the tills, the stockroom and the docks, the delivery van, and the customers who queue and sometimes leave — served as an MCP server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
