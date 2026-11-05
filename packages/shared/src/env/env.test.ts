import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  CLIENT_ENV_NAMES,
  EnvValidationError,
  SERVER_ONLY_ENV_NAMES,
  clientEnvSchema,
  isForbiddenPublicEnvName,
  isSecretLikeEnvName,
  parseEnv,
  parseServerEnv,
  serverEnvSchema,
} from "./index.js";

const SENTINEL = "sentinel-secret-value-DO-NOT-PRINT";

type Source = Record<string, string | undefined>;

const deployed = (appEnv: string, overrides: Source = {}): Source => ({
  APP_ENV: appEnv,
  NEXT_PUBLIC_APP_URL: "https://app.example.test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-placeholder",
  SUPABASE_URL: "https://project.example.test",
  SUPABASE_SERVICE_ROLE_KEY: SENTINEL,
  DATABASE_URL: "postgres://placeholder",
  ...overrides,
});

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof EnvValidationError, "expected EnvValidationError");
    return error.message;
  }
  assert.fail("expected parseEnv to throw");
}

test("local environment starts with no variables set (safe dev defaults)", () => {
  const env = parseEnv(serverEnvSchema, {});
  assert.equal(env.APP_ENV, "local");
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, "http://127.0.0.1:55421");
});

test("empty string counts as unset", () => {
  const env = parseEnv(serverEnvSchema, { APP_ENV: "", ANTHROPIC_API_KEY: "" });
  assert.equal(env.APP_ENV, "local");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("AC1: missing required variable fails with a clear message naming it", () => {
  const source = deployed("production");
  delete source.SUPABASE_SERVICE_ROLE_KEY;
  delete source.DATABASE_URL;
  const message = messageOf(() => parseEnv(serverEnvSchema, source));
  assert.match(message, /SUPABASE_SERVICE_ROLE_KEY: missing/);
  assert.match(message, /DATABASE_URL: missing/);
  assert.match(message, /\.env\.example/);
});

test("preview and production both enforce required variables and https", () => {
  for (const appEnv of ["preview", "production"]) {
    assert.doesNotThrow(() => parseEnv(serverEnvSchema, deployed(appEnv)));
    const insecure = deployed(appEnv, { NEXT_PUBLIC_APP_URL: "http://app.example.test" });
    assert.match(
      messageOf(() => parseEnv(serverEnvSchema, insecure)),
      /NEXT_PUBLIC_APP_URL: invalid \(must use https/,
    );
  }
});

test("invalid APP_ENV and malformed URL are reported as invalid", () => {
  const message = messageOf(() =>
    parseEnv(serverEnvSchema, { APP_ENV: "staging", SUPABASE_URL: "not a url" }),
  );
  assert.match(message, /APP_ENV: invalid/);
  assert.match(message, /SUPABASE_URL: invalid/);
});

test("error messages never contain values", () => {
  const source = deployed("production", {
    SUPABASE_URL: SENTINEL,
    NEXT_PUBLIC_APP_URL: `http://${SENTINEL}`,
  });
  delete source.DATABASE_URL;
  const message = messageOf(() => parseEnv(serverEnvSchema, source));
  assert.ok(!message.includes(SENTINEL), "message leaked a value");
  assert.match(message, /SUPABASE_URL/);
});

test("client schema only knows NEXT_PUBLIC_ names; server-only names never overlap", () => {
  assert.ok(CLIENT_ENV_NAMES.every((name) => name.startsWith("NEXT_PUBLIC_")));
  assert.ok(SERVER_ONLY_ENV_NAMES.every((name) => !name.startsWith("NEXT_PUBLIC_")));
  const parsed = parseEnv(clientEnvSchema, { SUPABASE_SERVICE_ROLE_KEY: SENTINEL });
  assert.ok(
    !JSON.stringify(parsed).includes(SENTINEL),
    "client env must strip non-public variables",
  );
});

test("client entry (@ago/shared/client-env) never references a server-only variable name", async () => {
  const entry = await import("./client-entry.js");
  assert.ok("clientEnvSchema" in entry && !("serverEnvSchema" in entry));
  for (const file of ["client-entry", "client-schema", "parse"]) {
    const text = readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8");
    for (const name of SERVER_ONLY_ENV_NAMES) {
      assert.ok(
        !new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text),
        `${file}.js mentions ${name}`,
      );
    }
  }
});

test("isSecretLikeEnvName strips NEXT_PUBLIC_ before classifying", () => {
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_ANTHROPIC_API_KEY",
    "NEXT_PUBLIC_TELEGRAM_BOT_TOKEN",
    "NEXT_PUBLIC_LANGFUSE_SECRET_KEY",
    "NEXT_PUBLIC_DB_PASSWORD",
    "NEXT_PUBLIC_SIGNING_PRIVATE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SOME_VENDOR_KEY",
  ]) {
    assert.equal(isSecretLikeEnvName(name), true, name);
  }
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_APP_URL",
    "APP_ENV",
    "SUPABASE_URL",
  ]) {
    assert.equal(isSecretLikeEnvName(name), false, name);
  }
});

test("parseServerEnv rejects a secret-like NEXT_PUBLIC_ variable at startup, naming it but not its value", () => {
  const message = messageOf(() =>
    parseServerEnv({
      NEXT_PUBLIC_ANTHROPIC_API_KEY: SENTINEL,
      NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: SENTINEL,
    }),
  );
  assert.match(message, /NEXT_PUBLIC_ANTHROPIC_API_KEY: invalid/);
  assert.match(message, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: invalid/);
  assert.ok(!message.includes(SENTINEL), "message leaked a value");
});

test("parseServerEnv reports schema problems and secret-like public vars together", () => {
  const message = messageOf(() =>
    parseServerEnv({ APP_ENV: "staging", NEXT_PUBLIC_API_TOKEN: SENTINEL }),
  );
  assert.match(message, /APP_ENV: invalid/);
  assert.match(message, /NEXT_PUBLIC_API_TOKEN: invalid/);
});

test("parseServerEnv fails fast when NODE_ENV=production and APP_ENV is unset, on any host", () => {
  for (const host of [{}, { VERCEL: "1" }, { VERCEL_ENV: "production" }, { APP_ENV: "" }]) {
    const message = messageOf(() =>
      parseServerEnv({
        NODE_ENV: "production",
        ...host,
        DATABASE_URL: "x",
        SUPABASE_SERVICE_ROLE_KEY: SENTINEL,
      }),
    );
    assert.match(message, /APP_ENV: missing/);
    assert.match(message, /APP_ENV to preview or production/);
    assert.ok(!message.includes(SENTINEL), "message leaked a value");
  }
});

test("parseServerEnv defaults APP_ENV to local when NODE_ENV is not production", () => {
  for (const nodeEnv of ["development", "test", undefined]) {
    assert.equal(parseServerEnv({ NODE_ENV: nodeEnv }).APP_ENV, "local");
  }
  assert.equal(parseServerEnv({ VERCEL: "1" }).APP_ENV, "local");
  assert.equal(parseServerEnv({}).APP_ENV, "local");
});

test("parseServerEnv accepts a production build with APP_ENV=local", () => {
  assert.equal(parseServerEnv({ NODE_ENV: "production", APP_ENV: "local" }).APP_ENV, "local");
});

test("parseServerEnv with explicit APP_ENV=production still requires the deployed keys", () => {
  const message = messageOf(() =>
    parseServerEnv({ APP_ENV: "production", NODE_ENV: "production" }),
  );
  assert.match(message, /SUPABASE_SERVICE_ROLE_KEY: missing/);
  assert.match(message, /DATABASE_URL: missing/);
});

test("parseServerEnv accepts the allowed public variables", () => {
  assert.doesNotThrow(() => parseServerEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-placeholder" }));
});

test("isForbiddenPublicEnvName denies by default: only NEXT_PUBLIC_ vars declared in clientEnvSchema pass, case-insensitively", () => {
  for (const name of [
    "NEXT_PUBLIC_DATABASE_URL",
    "next_public_database_url",
    "Next_Public_Anthropic_Api_Key",
    "NEXT_PUBLIC_ANTHROPIC_APIKEY",
    "NEXT_PUBLIC_REDIS_URL",
    "NEXT_PUBLIC_APP_ENV",
    "NEXT_PUBLIC_SENTRY_DSN",
    "NEXT_PUBLIC_ANYTHING_ELSE",
  ]) {
    assert.equal(isForbiddenPublicEnvName(name), true, name);
  }
  for (const name of CLIENT_ENV_NAMES) assert.equal(isForbiddenPublicEnvName(name), false, name);
  assert.equal(isForbiddenPublicEnvName("next_public_supabase_anon_key"), false);
  // Not public at all: this rule does not apply to server-side names.
  for (const name of ["DATABASE_URL", "APP_ENV"])
    assert.equal(isForbiddenPublicEnvName(name), false, name);
});

test("isSecretLikeEnvName is broad: fragments, tokens and trailing KEY, with or without the prefix", () => {
  for (const name of [
    "ANTHROPIC_APIKEY",
    "NEXT_PUBLIC_ANTHROPIC_APIKEY",
    "DB_PASSWD",
    "REDIS_PWD",
    "GITHUB_AUTH_HEADER",
    "JWT_SIGNING_SALT",
    "CLOUD_CREDENTIALS",
    "STRIPE_WEBHOOK_SECRET",
    "VENDORKEY",
    "SOME_KEY_ID",
  ]) {
    assert.equal(isSecretLikeEnvName(name), true, name);
  }
  for (const name of [
    "APP_ENV",
    "SUPABASE_URL",
    "DATABASE_URL",
    "LANGFUSE_HOST",
    "SENTRY_DSN",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ]) {
    assert.equal(isSecretLikeEnvName(name), false, name);
  }
});

test("parseServerEnv rejects undeclared NEXT_PUBLIC_ vars (typo-like APIKEY and REDIS_URL) without printing values", () => {
  const message = messageOf(() =>
    parseServerEnv({
      NEXT_PUBLIC_ANTHROPIC_APIKEY: SENTINEL,
      NEXT_PUBLIC_REDIS_URL: `redis://:${SENTINEL}@h:6379`,
    }),
  );
  assert.match(message, /NEXT_PUBLIC_ANTHROPIC_APIKEY: invalid/);
  assert.match(message, /NEXT_PUBLIC_REDIS_URL: invalid/);
  assert.ok(!message.includes(SENTINEL), "message leaked a value");
});

test("parseServerEnv rejects NEXT_PUBLIC_DATABASE_URL (any case) and never prints its value", () => {
  for (const key of ["NEXT_PUBLIC_DATABASE_URL", "next_public_database_url"]) {
    const message = messageOf(() => parseServerEnv({ [key]: `postgres://u:${SENTINEL}@h/db` }));
    assert.ok(message.includes(key), "names the variable");
    assert.ok(!message.includes(SENTINEL), "message leaked a value");
  }
});

test("parseServerEnv tells the developer what to do about an undeclared public var", () => {
  const message = messageOf(() => parseServerEnv({ NEXT_PUBLIC_FEATURE_X: SENTINEL }));
  assert.match(message, /NEXT_PUBLIC_FEATURE_X: invalid/);
  assert.match(
    message,
    /NEXT_PUBLIC_FEATURE_X is not declared\. Add it to clientEnvSchema in packages\/shared\/src\/env\/client-schema\.ts \(public vars are deny-by-default\)/,
  );
  assert.ok(
    !message.includes("must not be public"),
    "undeclared var must not get the secret message",
  );
  assert.ok(!message.includes(SENTINEL), "message leaked a value");
});

test("parseServerEnv says secret-like and server-only public names must not be public", () => {
  for (const name of ["NEXT_PUBLIC_ANTHROPIC_APIKEY", "NEXT_PUBLIC_DATABASE_URL"]) {
    const message = messageOf(() => parseServerEnv({ [name]: SENTINEL }));
    assert.match(
      message,
      new RegExp(`${name}: invalid \\(secret-like or server-only names must not be public`),
    );
    assert.ok(!message.includes("is not declared"), `${name} must not get the undeclared message`);
    assert.ok(!message.includes(SENTINEL), "message leaked a value");
  }
});
