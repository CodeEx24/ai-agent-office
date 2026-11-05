import { describe, expect, it } from "vitest";

import { isProtectedPath, signInPathFor } from "./routes";

describe("isProtectedPath", () => {
  it.each(["/app", "/app/", "/app/settings", "/app/a/b"])("protects %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each(["/", "/sign-in", "/auth/callback", "/approvals", "/application", "/apps"])(
    "leaves %s public",
    (path) => {
      expect(isProtectedPath(path)).toBe(false);
    },
  );
});

describe("signInPathFor", () => {
  it("encodes the return target", () => {
    expect(signInPathFor("/app?tab=a&b=1")).toBe("/sign-in?next=%2Fapp%3Ftab%3Da%26b%3D1");
  });
});
