import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, generateNonce } from "./csp";
import { BASELINE_SECURITY_HEADERS } from "./headers";

function directive(csp: string, name: string): string[] {
  const found = csp.split("; ").find((part) => part.startsWith(`${name} `));
  return found ? found.split(" ").slice(1) : [];
}

describe("buildContentSecurityPolicy", () => {
  const base = { nonce: "abc123", isDevelopment: false, supabaseUrl: "http://127.0.0.1:44321" };

  it("production scripts are nonce-based with no unsafe-inline and no unsafe-eval", () => {
    const scripts = directive(buildContentSecurityPolicy(base), "script-src");

    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain("'strict-dynamic'");
    // WebAssembly only (meshopt-compressed GLBs); not eval().
    expect(scripts).toContain("'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it("allows unsafe-eval only in development", () => {
    const dev = buildContentSecurityPolicy({ ...base, isDevelopment: true });

    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("allows the configured Supabase origin and its websocket, nothing hard-coded", () => {
    const local = directive(buildContentSecurityPolicy(base), "connect-src");
    const hosted = directive(
      buildContentSecurityPolicy({ ...base, supabaseUrl: "https://abc.supabase.co" }),
      "connect-src",
    );

    expect(local).toEqual(
      expect.arrayContaining(["http://127.0.0.1:44321", "ws://127.0.0.1:44321"]),
    );
    expect(hosted).toEqual(
      expect.arrayContaining(["https://abc.supabase.co", "wss://abc.supabase.co"]),
    );
    expect(hosted).not.toContain("http://127.0.0.1:44321");
  });

  it("omits Supabase sources when the URL is missing or not a URL", () => {
    for (const supabaseUrl of [undefined, "not a url"]) {
      const connect = directive(
        buildContentSecurityPolicy({ ...base, supabaseUrl }),
        "connect-src",
      );
      expect(connect).toEqual(["'self'", "blob:", "data:"]);
    }
  });

  it("allows the Sentry ingest origin only when a DSN is configured, never the DSN key", () => {
    const dsn = "https://publickey123@o42.ingest.sentry.example.test/7";
    const withDsn = buildContentSecurityPolicy({ ...base, sentryDsn: dsn });

    expect(directive(withDsn, "connect-src")).toContain("https://o42.ingest.sentry.example.test");
    expect(withDsn).not.toContain("publickey123");
    // Nothing else changes: the other directives stay identical.
    expect(directive(withDsn, "script-src")).toEqual(
      directive(buildContentSecurityPolicy(base), "script-src"),
    );
  });

  it("adds no Sentry source without a usable DSN", () => {
    for (const sentryDsn of [undefined, "", "not a url", "ftp://k@host/1"]) {
      expect(directive(buildContentSecurityPolicy({ ...base, sentryDsn }), "connect-src")).toEqual(
        directive(buildContentSecurityPolicy(base), "connect-src"),
      );
    }
  });

  it("sets the hardening directives", () => {
    const csp = buildContentSecurityPolicy(base);

    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(directive(csp, "worker-src")).toEqual(["'self'", "blob:"]);
  });
});

describe("generateNonce", () => {
  it("is unique per call and header-safe base64", () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));

    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("BASELINE_SECURITY_HEADERS", () => {
  const byKey = new Map(BASELINE_SECURITY_HEADERS.map((h) => [h.key, h.value]));

  it("includes nosniff, referrer and permissions policy and framing denial", () => {
    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey.get("Permissions-Policy")).toContain("camera=()");
    expect(byKey.get("X-Frame-Options")).toBe("DENY");
  });
});
