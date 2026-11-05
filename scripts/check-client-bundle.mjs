#!/usr/bin/env node
/**
 * Build check (AGO-70): fail if a secret reached the client bundle.
 *
 * Usage: node scripts/check-client-bundle.mjs [bundleDir]   (default: apps/web/.next/static)
 *
 * Flags a client bundle file when it contains:
 *  1. the NAME of a server-only variable (from @ago/shared SERVER_ONLY_ENV_NAMES);
 *  2. a `process.env.<NAME>` reference whose name is secret-like (broad, deny by default) or is a
 *     NEXT_PUBLIC_ variable not declared public in the schema (see @ago/shared);
 *  3. the VALUE of a server-only, secret-like or undeclared NEXT_PUBLIC_ variable set in the environment;
 *  4. a connection string with embedded credentials, or a well-known secret value shape
 *     (API keys, tokens, private keys, a service_role JWT), whatever the variable was called.
 *
 * Output names the file and the variable only. Values are never printed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROCESS_ENV_REF = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g;
const MIN_SECRET_VALUE_LENGTH = 8;
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map", ".txt"]);

const shared = await import(
  pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/shared/dist/index.js")).href
).catch(() => {
  console.error("check-client-bundle: build @ago/shared first (packages/shared/dist is missing).");
  process.exit(2);
});

/** Names that must never reach the browser, case-insensitive (see @ago/shared). */
export const isSecretName = (name) => shared.isSecretLikeEnvName(name) || shared.isForbiddenPublicEnvName(name);

const SERVER_NAME_SET = new Set(shared.SERVER_ONLY_ENV_NAMES);
const NON_SECRET_VALUE_NAMES = new Set(shared.NON_SECRET_SERVER_ENV_NAMES);

/**
 * Defence in depth: scheme://[user]:password@host, whatever the variable was called. The username
 * may be empty (redis://:pw@host) and the password needs only one character. Any scheme matches,
 * which covers redis, rediss, postgres(ql), mysql, mongodb(+srv), amqp(s) and http(s).
 */
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`\\]*:[^\s/@"'`\\]+@[^\s/"'`\\]+/i;

/** Well-known secret value shapes, flagged whatever the variable was called (mirrors .claude/hooks/guard.mjs). */
const SECRET_VALUE_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/, "OpenAI project key"],
  [/\bsk-[A-Za-z0-9]{48,}\b/, "OpenAI API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{22,}/, "GitHub fine-grained token"],
  [/\bsbp_[0-9a-f]{40}\b/, "Supabase access token"],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}/, "Supabase secret key"],
  [/\b(sk|rk)_live_[0-9a-zA-Z]{24,}/, "Stripe live key"],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}/, "Slack token"],
  [/\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/, "Telegram bot token"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "private key"],
];
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{6,})\.[A-Za-z0-9_-]{10,}/g;

/** True when a JWT in `text` carries the Supabase service_role role (the anon key's role is allowed). */
function hasServiceRoleJwt(text) {
  for (const match of text.matchAll(JWT)) {
    try {
      const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      if (payload?.role === "service_role") return true;
    } catch {
      // not a decodable JWT payload
    }
  }
  return false;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function extensionOf(file) {
  const i = file.lastIndexOf(".");
  return i === -1 ? "" : file.slice(i);
}

/**
 * Scan `bundleDir`. Returns findings: `{ file, name, reason }` (never the value).
 * @param {string} bundleDir
 * @param {{ serverNames?: readonly string[], env?: Record<string, string | undefined> }} [options]
 */
export function scanBundle(bundleDir, { serverNames = [], env = process.env } = {}) {
  const secretValues = new Map();
  for (const [name, value] of Object.entries(env)) {
    // Every server-only var's value is matched unless explicitly non-secret; secret-like names are
    // matched even under a NEXT_PUBLIC_ prefix. DATABASE_URL embeds credentials, so it stays matched.
    const upper = name.toUpperCase();
    const isSecretVar = isSecretName(name) || (SERVER_NAME_SET.has(upper) && !NON_SECRET_VALUE_NAMES.has(upper));
    if (isSecretVar && value && value.length >= MIN_SECRET_VALUE_LENGTH) secretValues.set(name, value);
  }

  const findings = [];
  for (const file of walk(bundleDir)) {
    if (!TEXT_EXTENSIONS.has(extensionOf(file))) continue;
    const text = readFileSync(file, "utf8");
    const rel = relative(bundleDir, file);
    const seen = new Set();
    const add = (name, reason) => {
      const key = `${name}|${reason}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ file: rel, name, reason });
      }
    };

    for (const name of serverNames) {
      if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "i").test(text)) add(name, "server-only variable name");
    }
    for (const match of text.matchAll(PROCESS_ENV_REF)) {
      const name = match[1] ?? match[2];
      if (name && isSecretName(name)) add(name, "secret-named process.env reference");
    }
    if (CREDENTIAL_URL.test(text)) add("CONNECTION_STRING", "URL with embedded credentials");
    for (const [pattern, label] of SECRET_VALUE_PATTERNS) {
      if (pattern.test(text)) add("SECRET_VALUE", label);
    }
    if (hasServiceRoleJwt(text)) add("SECRET_VALUE", "Supabase service_role JWT");
    for (const [name, value] of secretValues) {
      if (text.includes(value)) add(name, "secret value present");
    }
  }
  return findings;
}

function loadServerNames() {
  return shared.SERVER_ONLY_ENV_NAMES;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundleDir = resolve(process.argv[2] ?? join(root, "apps/web/.next/static"));
  try {
    statSync(bundleDir);
  } catch {
    console.error(`check-client-bundle: bundle directory not found: ${bundleDir}`);
    process.exit(2);
  }

  const findings = scanBundle(bundleDir, { serverNames: loadServerNames() });
  if (findings.length === 0) {
    console.log("check-client-bundle: OK, no secrets found in the client bundle.");
    return;
  }
  console.error("check-client-bundle: FAILED, secrets may have reached the client bundle (values are never printed):");
  for (const f of findings) console.error(`  - ${f.name} (${f.reason}) in ${f.file}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
