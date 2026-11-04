import { describe, expect, it } from "vitest";

import { resolveOrigin } from "./request-origin";

const headers = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name.toLowerCase()] ?? null,
});

describe("resolveOrigin", () => {
  it("keeps 127.0.0.1 as 127.0.0.1 (cookies are host-scoped)", () => {
    expect(resolveOrigin(headers({ host: "127.0.0.1:3100" }))).toBe("http://127.0.0.1:3100");
  });

  it("uses https for a public host and ignores a spoofable x-forwarded-host", () => {
    expect(resolveOrigin(headers({ host: "app.example.com" }))).toBe("https://app.example.com");
    expect(
      resolveOrigin(
        headers({
          host: "app.example.com",
          "x-forwarded-host": "evil.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://app.example.com");
  });

  it.each(["evil.com/path", "user@evil.com", "evil.com\\x", "a b", "evil.com:99999999"])(
    "falls back to the app URL for a malformed host %s",
    (host) => {
      expect(resolveOrigin(headers({ host }))).toBe("http://127.0.0.1:3000");
    },
  );

  it("falls back for an unsupported protocol or a missing host", () => {
    expect(resolveOrigin(headers({ host: "a.com", "x-forwarded-proto": "javascript" }))).toBe(
      "http://127.0.0.1:3000",
    );
    expect(resolveOrigin(headers({}))).toBe("http://127.0.0.1:3000");
  });
});
