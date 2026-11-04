import { z } from "zod";

/**
 * Client-safe environment schema. This module MUST NOT import anything that knows about
 * server-only variables, because client components import it (via `@ago/shared/client-env`)
 * and everything it imports ends up in the browser bundle.
 */

/** Local Supabase stack ports are reserved as 55420-55429 (see AGO-78); 55421 is the API port. */
export const LOCAL_SUPABASE_URL = "http://127.0.0.1:55421";
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
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(emptyToUndefined, httpUrlString.default(LOCAL_SUPABASE_URL)),
  /** Anon key is public by design; RLS is the protection. Required outside local. */
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, optionalString),
});
export type ClientEnv = z.infer<typeof clientEnvSchema>;

/** Names of the variables allowed in a client bundle. */
export const CLIENT_ENV_NAMES: readonly string[] = Object.keys(clientEnvSchema.shape);

const PUBLIC_PREFIX = "NEXT_PUBLIC_";
/** Never allowed to be public, with or without the NEXT_PUBLIC_ prefix. */
const ALWAYS_SECRET = /(SECRET|PRIVATE|TOKEN|PASSWORD|SERVICE_ROLE|API_KEY)/;
/** Server-side names ending in _KEY are treated as secret too (public keys use the prefix + ANON). */
const SECRET_KEY_SUFFIX = /_KEY$/;

/**
 * True when an env var name looks like a secret. The NEXT_PUBLIC_ prefix is stripped before
 * classifying, so it cannot launder a secret into the browser. A prefixed `..._ANON_KEY` stays
 * allowed because it is public by design; any other prefixed name needs ALWAYS_SECRET to match.
 */
export function isSecretLikeEnvName(name: string): boolean {
  const isPublic = name.startsWith(PUBLIC_PREFIX);
  const stripped = isPublic ? name.slice(PUBLIC_PREFIX.length) : name;
  if (ALWAYS_SECRET.test(stripped)) return true;
  return !isPublic && SECRET_KEY_SUFFIX.test(stripped);
}

/** Names of NEXT_PUBLIC_ variables in `source` whose stripped name is secret-like. */
export function findSecretLikePublicVars(source: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(source).filter((name) => name.startsWith(PUBLIC_PREFIX) && isSecretLikeEnvName(name));
}
