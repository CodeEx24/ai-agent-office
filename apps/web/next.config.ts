import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // @ago/ui ships TypeScript source (no build step); Next compiles it.
  transpilePackages: ["@ago/ui"],
};

export default nextConfig;
