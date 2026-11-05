"use client";

import dynamic from "next/dynamic";

// three.js touches window and WebGL, so the crowd is client-only and never server-rendered.
const CrowdViewer = dynamic(() => import("./CrowdViewer").then((m) => m.CrowdViewer), {
  ssr: false,
  loading: () => <p>Loading crowd...</p>,
});

export function CrowdViewerLoader() {
  return <CrowdViewer />;
}
