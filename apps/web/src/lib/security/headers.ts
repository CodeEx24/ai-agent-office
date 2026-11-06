/**
 * Baseline security headers that do not depend on the request. Applied to every route by
 * `next.config.ts` `headers()` (so static assets get them too); the per-request CSP is set in
 * `proxy.ts`. HSTS is left to the host (Vercel sets it on https deployments).
 */
export const BASELINE_SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing in the app uses these browser features; deny them for the page and any embed.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  // Legacy equivalent of CSP frame-ancestors 'none' for browsers that ignore the CSP directive.
  { key: "X-Frame-Options", value: "DENY" },
];
