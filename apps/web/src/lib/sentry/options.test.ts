import { describe, expect, it } from "vitest";

import { buildSentryOptions } from "./options";

// Synthetic secret shapes assembled at runtime so no real-looking secret sits in the source.
const GHP = `ghp_${"a1B2".repeat(9)}`;
const SB_SECRET = `sb_secret_${"Zy9x".repeat(8)}`;

describe("buildSentryOptions", () => {
  const options = buildSentryOptions("https://k@o0.ingest.sentry.example.test/1", "local");

  it("collects no PII, enables no tracing", () => {
    expect(options.tracesSampleRate).toBe(0);
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      httpBodies: [],
    });
  });

  it("scrubs secrets out of events before they are sent", () => {
    const event = options.beforeSend({
      message: `failed ${GHP}`,
      exception: { values: [{ value: `bad ${SB_SECRET}`, type: "Error" }] },
      request: { headers: { authorization: `Bearer ${"t".repeat(20)}`, cookie: "sid=1" } },
      extra: { token: "abc" },
      user: { id: "u1", email: "a@b.test" },
    });
    const text = JSON.stringify(event);

    for (const leaked of [GHP, SB_SECRET, "a@b.test", "sid=1", "abc"]) {
      expect(text).not.toContain(leaked);
    }
    expect(event.user).toEqual({ id: "u1" });
  });

  it("scrubs breadcrumbs", () => {
    const crumb = options.beforeBreadcrumb({
      category: "fetch",
      data: { url: "https://api.test/x?access_token=zzz111", apiKey: "k" },
      message: `saw ${GHP}`,
    });

    expect(JSON.stringify(crumb)).not.toMatch(/zzz111|ghp_/);
  });
});
