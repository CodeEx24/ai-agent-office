import { afterEach, describe, expect, it, vi } from "vitest";

// AGO-104 fix round 1: an invalid NEXT_PUBLIC_SENTRY_DSN must never take the app down.
const SUPABASE = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key-no-stack",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
} as const;

async function loadEnv() {
  vi.resetModules();
  return import("./env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("shouldTrustProxyHeaders (AGO-201)", () => {
  it("is off unless TRUST_PROXY_HEADERS is exactly true", async () => {
    const { shouldTrustProxyHeaders } = await loadEnv();
    for (const value of ["", "false", "TRUE", "1", "yes"]) {
      vi.stubEnv("TRUST_PROXY_HEADERS", value);
      expect(shouldTrustProxyHeaders(), value).toBe(false);
    }
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    expect(shouldTrustProxyHeaders()).toBe(true);
  });
});

describe("getSentryDsn", () => {
  it("is undefined when the DSN is unset or empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const { getSentryDsn } = await loadEnv();
    expect(getSentryDsn()).toBeUndefined();
  });

  it("returns a valid DSN unchanged", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://publickey@o0.ingest.sentry.example.test/1");
    const { getSentryDsn } = await loadEnv();
    expect(getSentryDsn()).toBe("https://publickey@o0.ingest.sentry.example.test/1");
  });

  it("treats an invalid DSN as off, warns once, and never prints the value", async () => {
    const bad = "not a url at all";
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", bad);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getSentryDsn } = await loadEnv();

    expect(getSentryDsn()).toBeUndefined();
    expect(getSentryDsn()).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("NEXT_PUBLIC_SENTRY_DSN");
    expect(message).not.toContain(bad);
  });
});

describe("the rest of the public env with an invalid Sentry DSN", () => {
  it("still resolves the Supabase and app settings (no 500 on every route)", async () => {
    for (const [name, value] of Object.entries(SUPABASE)) vi.stubEnv(name, value);
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "not a url at all");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getSupabasePublicEnv, getSupabaseUrl, getAppUrl } = await loadEnv();

    expect(getSupabaseUrl()).toBe(SUPABASE.NEXT_PUBLIC_SUPABASE_URL);
    expect(getSupabasePublicEnv()).toEqual({
      url: SUPABASE.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: SUPABASE.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });
    expect(getAppUrl()).toBe(SUPABASE.NEXT_PUBLIC_APP_URL);
  });
});
