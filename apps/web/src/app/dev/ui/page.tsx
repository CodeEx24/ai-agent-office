import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { UiGallery } from "../../../features/ui-gallery/UiGallery";
import { isUiGalleryEnabled } from "../../../features/ui-gallery/is-ui-gallery-enabled";

export const metadata: Metadata = { title: "UI gallery | Agent Office", robots: { index: false } };

// Read the env at request time so a preview deployment can enable the gallery without a rebuild.
export const dynamic = "force-dynamic";

export default function UiGalleryPage() {
  if (!isUiGalleryEnabled()) notFound();
  return <UiGallery />;
}
