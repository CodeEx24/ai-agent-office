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
