import { z } from "zod";

/**
 * Environment model for Agent Office (AGO-70).
 *
 * Three environments are modelled here and documented in docs/environments.md.
 * No hosted resource is created by this code: Vercel and hosted Supabase are human-only.
 *
 * Rules:
 * - Only variables prefixed `NEXT_PUBLIC_` may reach a client bundle (`clientEnvSchema`).
 * - Everything else is server-only (`serverEnvSchema`) and is parsed behind `server-only`.
 * - Errors name the variable and never print its value (see `parseEnv`).
 */

export const APP_ENVIRONMENTS = ["local", "preview", "production"] as const;
export const appEnvironmentSchema = z.enum(APP_ENVIRONMENTS);
export type AppEnvironment = z.infer<typeof appEnvironmentSchema>;

/** Local Supabase stack ports are reserved as 55420-55429 (see AGO-78); 55421 is the API default. */
export const LOCAL_SUPABASE_URL = "http://127.0.0.1:55421";
export const LOCAL_APP_URL = "http://localhost:3000";

const optionalString = z.string().min(1).optional();
const httpUrlString = z.url({ protocol: /^https?$/ });

/** Treat an empty string (e.g. `FOO=` in a dotenv file) as unset. */
function emptyToUndefined(value: unknown): unknown {
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

/** Variables that must never reach a client bundle. */
export const serverOnlyEnvSchema = z.object({
  /** Which deployment this is. Set per environment by the human; defaults to local. */
  APP_ENV: z.preprocess(emptyToUndefined, appEnvironmentSchema.default("local")),
  SUPABASE_URL: z.preprocess(emptyToUndefined, httpUrlString.default(LOCAL_SUPABASE_URL)),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(emptyToUndefined, optionalString),
  /** Postgres connection string used by the worker and pg-boss. */
  DATABASE_URL: z.preprocess(emptyToUndefined, optionalString),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, optionalString),
  TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, optionalString),
  SENTRY_DSN: z.preprocess(emptyToUndefined, z.url().optional()),
  LANGFUSE_PUBLIC_KEY: z.preprocess(emptyToUndefined, optionalString),
  LANGFUSE_SECRET_KEY: z.preprocess(emptyToUndefined, optionalString),
  LANGFUSE_HOST: z.preprocess(emptyToUndefined, httpUrlString.optional()),
});

/** Variables that are required once the app is deployed (preview and production). */
const REQUIRED_WHEN_DEPLOYED = [
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
] as const;

/** Variables that additionally require https when deployed. */
const HTTPS_WHEN_DEPLOYED = ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"] as const;

const serverFullShape = serverOnlyEnvSchema.extend(clientEnvSchema.shape);

/**
 * Full server-side schema: server-only variables plus the public ones, with the
 * per-environment rules applied. Local is lenient (safe dev defaults); preview and
 * production require the Supabase keys and database URL and demand https.
 */
export const serverEnvSchema = serverFullShape.superRefine((env, ctx) => {
  if (env.APP_ENV === "local") return;

  for (const name of REQUIRED_WHEN_DEPLOYED) {
    if (env[name] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `required when APP_ENV is "${env.APP_ENV}"`,
      });
    }
  }
  for (const name of HTTPS_WHEN_DEPLOYED) {
    if (!env[name].startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `must use https when APP_ENV is "${env.APP_ENV}"`,
      });
    }
  }
});
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** The worker has no browser surface, so it only needs the server variables. */
export const workerEnvSchema = serverEnvSchema;
export type WorkerEnv = ServerEnv;

/** Names of every variable that must stay server-side. Used by the client bundle check. */
export const SERVER_ONLY_ENV_NAMES: readonly string[] = Object.keys(serverOnlyEnvSchema.shape);

/** Names of the variables allowed in a client bundle. */
export const CLIENT_ENV_NAMES: readonly string[] = Object.keys(clientEnvSchema.shape);
