import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Workspace packages are compiled by turbo (^build) to NodeNext ESM with `.js` import
  // specifiers, which Turbopack cannot map back to `.ts` sources. Consume the built output.
  turbopack: {
    resolveAlias: {
      "@ago/shared": "../../packages/shared/dist/index.js",
    },
  },
};

export default nextConfig;
