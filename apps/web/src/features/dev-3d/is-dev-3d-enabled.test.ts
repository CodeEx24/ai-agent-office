import { describe, expect, it, vi } from "vitest";

import { isDev3dEnabled } from "./is-dev-3d-enabled";

describe("isDev3dEnabled", () => {
  it("is on outside production builds", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDev3dEnabled()).toBe(true);
  });

  it("is off in production unless ENABLE_DEV_3D=1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_DEV_3D", "");
    expect(isDev3dEnabled()).toBe(false);
    vi.stubEnv("ENABLE_DEV_3D", "1");
    expect(isDev3dEnabled()).toBe(true);
  });
});
