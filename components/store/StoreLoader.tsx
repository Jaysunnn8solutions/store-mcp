"use client";

import dynamic from "next/dynamic";

// The workbench reads window.location.hash in a state initializer, spawns a
// worker and owns a WebGL canvas, so it must never render on the server.
// `ssr: false` is only legal from a Client Component, which is the entire
// reason this file sits between app/store/page.tsx and it.
const StoreWorkbench = dynamic(() => import("./StoreWorkbench"), {
  ssr: false,
  loading: () => (
    <p className="sub" style={{ padding: "40px 0" }}>
      Loading the 3D shop…
    </p>
  ),
});

export default function StoreLoader() {
  return <StoreWorkbench />;
}
