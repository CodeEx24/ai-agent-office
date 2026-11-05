import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Dev3dViewerLoader } from "../../../features/dev-3d/Dev3dViewerLoader";
import { isDev3dEnabled } from "../../../features/dev-3d/is-dev-3d-enabled";

export const metadata: Metadata = {
  title: "3D test page | Agent Office",
  robots: { index: false },
};

// Read the env at request time so a preview deployment can enable the page without a rebuild.
export const dynamic = "force-dynamic";

export default function Dev3dPage() {
  if (!isDev3dEnabled()) notFound();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">3D model test page</h1>
      <Dev3dViewerLoader modelUrl="/models/pixel-v1.glb" />
    </main>
  );
}
