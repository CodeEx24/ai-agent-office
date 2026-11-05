import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CrowdViewerLoader } from "../../../../features/dev-3d/crowd/CrowdViewerLoader";
import { isDev3dEnabled } from "../../../../features/dev-3d/is-dev-3d-enabled";

export const metadata: Metadata = {
  title: "3D crowd test page | Agent Office",
  robots: { index: false },
};

// Read the env at request time so a preview deployment can enable the page without a rebuild.
export const dynamic = "force-dynamic";

export default function Dev3dCrowdPage() {
  if (!isDev3dEnabled()) notFound();
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">3D crowd test page</h1>
      <p className="text-sm">
        Eight animated characters on one shared bone contract (AGO-64). Dev only, never linked from
        navigation.
      </p>
      <CrowdViewerLoader />
    </main>
  );
}
