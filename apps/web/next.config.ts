import type { NextConfig } from "next";

import { BASELINE_SECURITY_HEADERS } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // The browser Sentry DSN (AGO-104) is fixed at build time. Declaring it here makes Next always
  // inline it ("" when unset, which the client treats as "error tracking off"), so the variable's
  // name never lingers in the client bundle as a live `process.env` reference.
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "" },
  // Baseline security headers on every route, static assets included. The per-request CSP is
  // added in src/proxy.ts because it carries a nonce.
  headers() {
    return Promise.resolve([
      { source: "/:path*", headers: BASELINE_SECURITY_HEADERS.map((header) => ({ ...header })) },
    ]);
  },
  // @ago/ui ships TypeScript source (no build step); Next compiles it.
  transpilePackages: ["@ago/ui"],
  // @ago/shared is compiled by turbo (^build) to NodeNext ESM with `.js` import specifiers,
  // which Turbopack cannot map back to `.ts` sources. Consume the built output.
  turbopack: {
    resolveAlias: {
      "@ago/shared": "../../packages/shared/dist/index.js",
    },
  },
};

export default nextConfig;
