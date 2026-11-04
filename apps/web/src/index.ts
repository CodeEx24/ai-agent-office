import { ASSET_MANIFEST } from "@ago/assets";
import { describeWorkspace } from "@ago/shared";
import { UI_PACKAGE } from "@ago/ui";

/** Placeholder: the Next.js app replaces this in AGO-61. */
export const WEB_NAME = describeWorkspace("@ago/web");
export const WEB_DEPENDENCIES = [UI_PACKAGE, `${ASSET_MANIFEST.length} assets`] as const;
