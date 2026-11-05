import { describe, expect, it } from "vitest";

import { DEFAULT_SIGNED_IN_PATH, safeNextPath } from "./safe-next-path";

describe("safeNextPath", () => {
  it.each(["/app", "/app/settings", "/app?tab=agents", "/approvals#top"])(
    "keeps the local path %s",
    (path) => {
      expect(safeNextPath(path)).toBe(path);
    },
  );

  it.each([
    ["protocol-relative", "//evil.com"],
    ["backslash host", "/\\evil.com"],
    ["absolute https", "https://evil.com"],
    ["absolute http", "http://evil.com/app"],
    ["encoded protocol-relative", "/%2F%2Fevil.com"],
    ["encoded leading slashes", "%2F%2Fevil.com"],
    ["encoded backslash", "/%5Cevil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,hi"],
    ["relative without slash", "app"],
    ["tab inside the host", "/\t/evil.com"],
    ["newline", "/app\n//evil.com"],
    ["empty", ""],
    ["dot-dot then double slash", "/..//evil.example"],
    ["double slash host", "//evil.example"],
    ["backslash host", "/\\evil.example"],
    ["encoded double slash", "%2F%2Fevil.example"],
    ["absolute https host", "https://evil.example"],
    ["javascript scheme void", "javascript:void(0)"],
    ["encoded dot-dot double slash", "/%2e%2e//evil"],
    ["encoded dot-dot segments", "/app/%2e%2e/%2e%2e/x"],
    ["dot-dot inside app", "/app/../settings"],
    ["path outside the allowlist", "/sign-in"],
    ["allowlist prefix without segment boundary", "/application"],
  ])("falls back for %s", (_label, value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_SIGNED_IN_PATH);
  });

  it("falls back for missing values and uses the first array entry", () => {
    expect(safeNextPath(undefined)).toBe(DEFAULT_SIGNED_IN_PATH);
    expect(safeNextPath(null)).toBe(DEFAULT_SIGNED_IN_PATH);
    expect(safeNextPath(["/app/a", "//evil.com"])).toBe("/app/a");
    expect(safeNextPath(["//evil.com", "/app/a"])).toBe(DEFAULT_SIGNED_IN_PATH);
  });

  it("honours a custom fallback", () => {
    expect(safeNextPath("//evil.com", "/sign-in")).toBe("/sign-in");
  });
});
