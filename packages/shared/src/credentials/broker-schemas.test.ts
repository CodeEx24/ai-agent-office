import { describe, expect, it } from "vitest";

import { BROKER_DENIAL_REASONS, secretNameOf, secretRefSchema } from "./broker-schemas.js";

describe("secret references", () => {
  it("accepts a reference and returns its name", () => {
    expect(secretRefSchema.safeParse("secret:crm_api_key").success).toBe(true);
    expect(secretNameOf("secret:crm.api-key_2")).toBe("crm.api-key_2");
  });

  it.each([
    ["a raw key", ["sk", "live", "abcdefghijklmnop1234"].join("-")],
    ["an uppercase name", "secret:CRM"],
    ["a missing name", "secret:"],
    ["a leading digit", "secret:1abc"],
    ["whitespace", "secret:abc def"],
    ["a trailing newline", "secret:abc\n"],
    ["a 65 character name", `secret:a${"b".repeat(64)}`],
  ])("rejects %s", (_label, value) => {
    expect(secretRefSchema.safeParse(value).success).toBe(false);
    expect(secretNameOf(value)).toBeNull();
  });

  it("keeps the credential reasons and adds the broker's own", () => {
    expect(BROKER_DENIAL_REASONS).toContain("missing_capability");
    expect(BROKER_DENIAL_REASONS).toContain("secret_unavailable");
  });
});
