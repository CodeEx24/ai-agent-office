"use client";

import dynamic from "next/dynamic";

import type { Dev3dViewerProps } from "./Dev3dViewer";

// three.js touches `window`/WebGL, so the viewer is client-only and never server-rendered.
const Dev3dViewer = dynamic(() => import("./Dev3dViewer").then((m) => m.Dev3dViewer), {
  ssr: false,
  loading: () => <p>Loading 3D viewer...</p>,
});

export function Dev3dViewerLoader(props: Dev3dViewerProps) {
  return <Dev3dViewer {...props} />;
}
