#!/usr/bin/env node
/**
 * Build check (AGO-70): fail if a secret reached the client bundle.
 *
 * Usage: node scripts/check-client-bundle.mjs [bundleDir]   (default: apps/web/.next/static)
 *
 * Flags a client bundle file when it contains:
 *  1. the NAME of a server-only variable (from @ago/shared SERVER_ONLY_ENV_NAMES);
 *  2. a `process.env.<SECRET_LIKE_NAME>` reference that is not `NEXT_PUBLIC_*`
 *     (names containing SECRET, TOKEN, PASSWORD, SERVICE_ROLE, PRIVATE_KEY, or ending in _KEY);
 *  3. the VALUE of a server-only or secret-named variable currently set in the environment.
 *
 * Output names the file and the variable only. Values are never printed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|SERVICE_ROLE|PRIVATE_KEY|_KEY$)/;
const PROCESS_ENV_REF = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g;
const MIN_SECRET_VALUE_LENGTH = 8;
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map", ".txt"]);

export function isSecretName(name) {
  return !name.startsWith("NEXT_PUBLIC_") && SECRET_NAME.test(name);
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
    const isSecretVar = serverNames.includes(name) || isSecretName(name);
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
      if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)) add(name, "server-only variable name");
    }
    for (const match of text.matchAll(PROCESS_ENV_REF)) {
      const name = match[1] ?? match[2];
      if (name && isSecretName(name)) add(name, "secret-named process.env reference");
    }
    for (const [name, value] of secretValues) {
      if (text.includes(value)) add(name, "secret value present");
    }
  }
  return findings;
}

async function loadServerNames() {
  const sharedEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/shared/dist/index.js");
  try {
    const shared = await import(pathToFileURL(sharedEntry).href);
    return shared.SERVER_ONLY_ENV_NAMES;
  } catch {
    console.error("check-client-bundle: build @ago/shared first (packages/shared/dist is missing).");
    process.exit(2);
  }
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

  const findings = scanBundle(bundleDir, { serverNames: await loadServerNames() });
  if (findings.length === 0) {
    console.log("check-client-bundle: OK, no secrets found in the client bundle.");
    return;
  }
  console.error("check-client-bundle: FAILED, secrets may have reached the client bundle (values are never printed):");
  for (const f of findings) console.error(`  - ${f.name} (${f.reason}) in ${f.file}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
