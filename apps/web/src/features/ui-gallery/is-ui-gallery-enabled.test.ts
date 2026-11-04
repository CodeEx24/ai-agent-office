import { describe, expect, it, vi } from "vitest";

import { isUiGalleryEnabled } from "./is-ui-gallery-enabled";

describe("isUiGalleryEnabled", () => {
  it("is on outside production builds", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isUiGalleryEnabled()).toBe(true);
  });

  it("is off in production unless ENABLE_UI_GALLERY=1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_UI_GALLERY", "");
    expect(isUiGalleryEnabled()).toBe(false);
    vi.stubEnv("ENABLE_UI_GALLERY", "1");
    expect(isUiGalleryEnabled()).toBe(true);
  });
});
