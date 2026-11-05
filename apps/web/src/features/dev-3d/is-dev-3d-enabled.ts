/**
 * The 3D model test page is a development tool, gated like the UI gallery: on in `next dev`,
 * off in production builds unless a preview/test deployment sets ENABLE_DEV_3D=1.
 * It is never linked from navigation.
 */
export function isDev3dEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_DEV_3D === "1";
}
