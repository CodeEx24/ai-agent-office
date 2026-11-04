/**
 * The component gallery is a development tool. It is on in `next dev` and off in production
 * builds, unless a preview/test deployment sets ENABLE_UI_GALLERY=1. It is never linked from navigation.
 */
export function isUiGalleryEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_UI_GALLERY === "1";
}
