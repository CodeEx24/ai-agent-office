import { z } from "zod";

/**
 * Client-safe environment schema. This module MUST NOT import anything that knows about
 * server-only variables, because client components import it (via `@ago/shared/client-env`)
 * and everything it imports ends up in the browser bundle.
 */

/** Local Supabase stack ports are reserved as 44320-44329 (see AGO-78); 44321 is the API port. */
export const LOCAL_SUPABASE_URL = "http://127.0.0.1:44321";
export const LOCAL_APP_URL = "http://localhost:3000";

export const optionalString = z.string().min(1).optional();
export const httpUrlString = z.url({ protocol: /^https?$/ });

/** Treat an empty string (e.g. `FOO=` in a dotenv file) as unset. */
export function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

/** Variables that may be bundled into the browser. Must start with `NEXT_PUBLIC_`. */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.preprocess(emptyToUndefined, httpUrlString.default(LOCAL_APP_URL)),
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(
    emptyToUndefined,
    httpUrlString.default(LOCAL_SUPABASE_URL),
  ),
  /** Anon key is public by design; RLS is the protection. Required outside local. */
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, optionalString),
});
export type ClientEnv = z.infer<typeof clientEnvSchema>;

/** Names of the variables allowed in a client bundle. */
export const CLIENT_ENV_NAMES: readonly string[] = Object.keys(clientEnvSchema.shape);

const PUBLIC_PREFIX = "NEXT_PUBLIC_";
/** Whole-name fragments that make a variable secret wherever they appear (APIKEY, DB_PASSWORD, ...). */
const SECRET_FRAGMENTS = [
  "APIKEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PRIVATE",
  "CREDENTIAL",
  "AUTH",
  "SIGNING",
  "SERVICE_ROLE",
];
/** Whole `_`-separated tokens that make a variable secret (KEY, PWD). */
const SECRET_TOKENS = ["KEY", "PWD"];

/**
 * True when an env var name looks like a secret. Deliberately broad (deny by default): the name
 * is upper-cased, the NEXT_PUBLIC_ prefix is stripped, and it is secret when it contains a
 * secret fragment, has a secret token, or ends with KEY. Variables declared public in
 * `clientEnvSchema` (for example NEXT_PUBLIC_SUPABASE_ANON_KEY) are the only exception.
 */
export function isSecretLikeEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (CLIENT_ENV_NAMES.includes(upper)) return false;
  const stripped = upper.startsWith(PUBLIC_PREFIX) ? upper.slice(PUBLIC_PREFIX.length) : upper;
  if (SECRET_FRAGMENTS.some((fragment) => stripped.includes(fragment))) return true;
  if (stripped.endsWith("KEY")) return true;
  return stripped.split("_").some((token) => SECRET_TOKENS.includes(token));
}

/** The name without its NEXT_PUBLIC_ prefix (any case), upper-cased; undefined when not public. */
export function stripPublicPrefix(name: string): string | undefined {
  const upper = name.toUpperCase();
  return upper.startsWith(PUBLIC_PREFIX) ? upper.slice(PUBLIC_PREFIX.length) : undefined;
}

/** Names of NEXT_PUBLIC_ variables in `source` whose stripped name is secret-like. */
export function findSecretLikePublicVars(
  source: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.keys(source).filter(
    (name) => stripPublicPrefix(name) !== undefined && isSecretLikeEnvName(name),
  );
}
