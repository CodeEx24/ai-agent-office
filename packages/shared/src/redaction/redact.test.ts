import { describe, expect, it } from "vitest";

import { isSecretLikeEnvName } from "../env/client-schema.js";

import { REDACTED, isSecretKey, scrubString, scrubTelemetryEvent, scrubValue } from "./redact.js";

// Synthetic values built at runtime so no real-looking secret sits in the source (secret-scan).
const GHP = `ghp_${"a1B2".repeat(9)}`;
const SB_SECRET = `sb_secret_${"Zy9x".repeat(8)}`;
const SK_PROJ = `sk-proj-${"Qw3r".repeat(8)}`;
const SK_ANT = `sk-ant-${"Mn7p".repeat(8)}`;
const JWT = `eyJ${"h".repeat(12)}.eyJ${"p".repeat(12)}.${"s".repeat(16)}`;

describe("scrubString", () => {
  it.each([
    ["GitHub token", GHP],
    ["Supabase secret key", SB_SECRET],
    ["OpenAI project key", SK_PROJ],
    ["Anthropic key", SK_ANT],
    ["JWT", JWT],
  ])("masks a %s inside free text", (_label, secret) => {
    const out = scrubString(`call failed for ${secret} while saving`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toContain("while saving");
  });

  it("masks credentials in URLs but keeps the host", () => {
    const out = scrubString("connect postgres://user:hunter2@db.example.test:5432/app failed");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("db.example.test");
  });

  it("masks Bearer and Basic values", () => {
    const out = scrubString("Authorization: Bearer abc123def456ghi and Basic dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("abc123def456ghi");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  it("masks apikey/token/password assignments in messages and query strings", () => {
    const out = scrubString(
      'GET /x?apikey=k3y-value&access_token=tok-value&ok=1 body {"password":"p4ss"} client_secret: s3cr3t',
    );
    for (const leaked of ["k3y-value", "tok-value", "p4ss", "s3cr3t"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("ok=1");
  });

  it("masks a private key block", () => {
    const out = scrubString(
      "key -----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY----- done",
    );
    expect(out).not.toContain("MIIBOgIBAAJBAK");
    expect(out).toContain("done");
  });

  it.each([
    ["service-account key", `sk-svcacct-${"Zk4m".repeat(12)}`],
    ["admin key", `sk-admin-${"Zk4m".repeat(12)}`],
    ["short plain sk- key", `sk-${"Zk4m".repeat(8)}`],
    ["minimum-length sk- key", `sk-${"a1B2".repeat(4)}`],
  ])("masks an OpenAI-style %s of any length", (_label, secret) => {
    const out = scrubString(`key ${secret} end`);
    expect(out).not.toContain(secret.slice(3));
    expect(out).toContain("end");
  });

  it("does not mistake words ending in sk- for a key", () => {
    expect(scrubString("task-list-item-checkbox-label and disk-usage-report-daily")).toBe(
      "task-list-item-checkbox-label and disk-usage-report-daily",
    );
  });

  it("masks Cookie and Set-Cookie header lines written into free text", () => {
    const body = "Ck4e".repeat(12);
    const out = scrubString(
      `Set-Cookie: session=${body}; Path=/; HttpOnly\nCookie: sb=${body}; theme=dark\nnext line`,
    );
    expect(out).not.toContain(body);
    expect(out).not.toContain("HttpOnly");
    expect(out).toContain("next line");
  });

  it.each([
    ["one dotted segment", `sk-${"Zk4m".repeat(5)}.${"Qw3r".repeat(4)}`],
    [
      "several dotted segments",
      `sk-proj-${"Zk4m".repeat(5)}.${"Qw3r".repeat(3)}.${"Ab9c".repeat(3)}`,
    ],
    ["an Anthropic key with a dotted tail", `sk-ant-${"Mn7p".repeat(6)}.${"Qw3r".repeat(4)}`],
  ])("masks the whole tail of an sk- key with %s", (_label, secret) => {
    const out = scrubString(`key ${secret} end`);
    expect(out).not.toContain("Qw3r");
    expect(out).not.toContain("Ab9c");
    expect(out).toContain("end");
  });

  it.each([
    ["/token/", "/api/token/"],
    ["/tokens/", "/v1/tokens/"],
    ["/secret/", "/hooks/secret/"],
    ["/password/", "/reset/password/"],
    ["/api-key/", "/v2/api-key/"],
    ["/credentials/", "/v2/credentials/"],
    ["/bearer/", "/svc/bearer/"],
    ["/otp/", "/verify/otp/"],
  ])("masks a bare token in a URL path after %s", (_label, prefix) => {
    const value = `Tk${"9xQ2".repeat(5)}`;
    const out = scrubString(`GET https://app.test${prefix}${value}?ok=1 failed`);
    expect(out).not.toContain(value);
    expect(out).toContain(prefix);
    expect(out).toContain("failed");
  });

  it("masks a path token that ends the text, a query-less path and a relative path", () => {
    const value = `Tk${"7mN3".repeat(4)}`;
    expect(scrubString(`/token/${value}`)).not.toContain(value);
    expect(scrubString(`fetch(/api/token/${value})`)).not.toContain(value);
  });

  it("keeps ordinary paths that merely look similar", () => {
    expect(scrubString("GET /api/tokenizer/status and /tokens/list and /keys")).toBe(
      "GET /api/tokenizer/status and /tokens/list and /keys",
    );
  });

  it.each([
    ["Bearer after a colon-less word", (v: string) => `request used Bearer ${v} and failed`],
    ["lower-case bearer", (v: string) => `header bearer ${v} rejected`],
    ["bearer with a colon", (v: string) => `bearer: ${v} rejected`],
    ["bearer with an equals sign", (v: string) => `auth=Bearer=${v} rejected`],
    ["quoted bearer", (v: string) => `sent "Bearer ${v}" upstream`],
    ["apikey followed by a space", (v: string) => `the apikey ${v} was rejected`],
    ["api key with a space", (v: string) => `api key: ${v} was rejected`],
    ["api_key in quotes", (v: string) => `api_key "${v}" was rejected`],
    ["x-api-key header", (v: string) => `x-api-key: ${v} was rejected`],
    ["api key is phrase", (v: string) => `api key is ${v} today`],
  ])("masks %s in a free-text message", (_label, build) => {
    for (const value of [`Vl${"4kQ8".repeat(4)}`, "s3cr3t"]) {
      const out = scrubString(build(value));
      expect(out, value).not.toContain(value);
      expect(out).toContain(REDACTED);
    }
  });

  it("leaves ordinary text alone", () => {
    expect(scrubString("agent finished run in 3 steps")).toBe("agent finished run in 3 steps");
  });
});

describe("isSecretKey", () => {
  it.each([
    "authorization",
    "Cookie",
    "set-cookie",
    "x-api-key",
    "apiKey",
    "access_token",
    "password",
  ])("flags %s", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });
  it.each(["run_id", "workspace_id", "url", "method", "filename"])("does not flag %s", (key) => {
    expect(isSecretKey(key)).toBe(false);
  });
});

describe("isSecretKey stays in step with isSecretLikeEnvName", () => {
  // redact.ts cannot import client-schema (browser bundle), so this test is the drift guard.
  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_APIKEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "TELEGRAM_BOT_TOKEN",
    "LANGFUSE_SECRET_KEY",
    "DB_PASSWORD",
    "DB_PASSWD",
    "REDIS_PWD",
    "GITHUB_AUTH_HEADER",
    "JWT_SIGNING_SALT",
    "CLOUD_CREDENTIALS",
    "VENDORKEY",
    "APP_ENV",
    "SUPABASE_URL",
    "DATABASE_URL",
    "LANGFUSE_HOST",
    "SENTRY_DSN",
    "NEXT_PUBLIC_APP_URL",
    "WORKER_PORT",
    "LOG_LEVEL",
  ])("agrees on %s", (name) => {
    expect(isSecretKey(name)).toBe(isSecretLikeEnvName(name));
  });
});

describe("scrubValue", () => {
  it("masks secret-named keys and string secrets, without mutating the input", () => {
    const input = { token: "t", nested: { note: `uses ${GHP}`, ok: 1 } };
    const out = scrubValue(input) as { token: string; nested: { note: string; ok: number } };
    expect(out.token).toBe(REDACTED);
    expect(out.nested.note).not.toContain(GHP);
    expect(out.nested.ok).toBe(1);
    expect(input.token).toBe("t");
  });

  it("survives circular references", () => {
    const loop: Record<string, unknown> = { name: "a" };
    loop.self = loop;
    expect(() => scrubValue(loop)).not.toThrow();
  });
});

describe("scrubTelemetryEvent", () => {
  it("scrubs message, exception, extra, request, breadcrumbs and keeps stack frames", () => {
    const event = {
      message: `boom ${SB_SECRET}`,
      exception: {
        values: [
          {
            type: "Error",
            value: `failed with Bearer ${"x".repeat(20)}`,
            stacktrace: { frames: [{ filename: "app.js", function: "run", lineno: 3 }] },
          },
        ],
      },
      extra: { apiKey: "k", detail: `url postgres://u:pw@h/db ${GHP}` },
      request: {
        url: "https://app.test/api?token=abc123xyz",
        headers: { authorization: "Bearer zzzzzzzzzz", cookie: "sid=1", "user-agent": "ua" },
        data: { password: "pw" },
      },
      breadcrumbs: [{ message: `saw ${SK_ANT}`, data: { secret: "s" } }],
      user: { id: "u1", email: "a@b.test", ip_address: "1.2.3.4" },
      tags: { run_id: "run-1" },
    };
    const out = scrubTelemetryEvent(event);
    const text = JSON.stringify(out);
    for (const leaked of [
      SB_SECRET,
      GHP,
      SK_ANT,
      "abc123xyz",
      "u:pw",
      "zzzzzzzzzz",
      "a@b.test",
      "1.2.3.4",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(out.exception.values[0]?.stacktrace.frames[0]).toEqual({
      filename: "app.js",
      function: "run",
      lineno: 3,
    });
    expect(out.request.headers["user-agent"]).toBe("ua");
    expect(out.user).toEqual({ id: "u1" });
    expect(out.tags.run_id).toBe("run-1");
  });
});
