import { z } from "zod";

import {
  CLIENT_ENV_NAMES,
  LOCAL_SUPABASE_URL,
  clientEnvSchema,
  emptyToUndefined,
  httpUrlString,
  isSecretLikeEnvName,
  optionalString,
  stripPublicPrefix,
} from "./client-schema.js";
import { EnvValidationError, parseEnv, type EnvIssue, type EnvSource } from "./parse.js";

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
const HTTPS_WHEN_DEPLOYED = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
] as const;

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

/**
 * Server-only variables whose values are not secret and legitimately appear in bundles
 * (for example `production` or a public URL). Everything else server-only is treated as secret.
 */
export const NON_SECRET_SERVER_ENV_NAMES: readonly string[] = [
  "APP_ENV",
  "SUPABASE_URL",
  "LANGFUSE_HOST",
  "SENTRY_DSN",
];

/**
 * Deny by default: a NEXT_PUBLIC_ variable is forbidden unless it is declared public in
 * `clientEnvSchema` (case-insensitive). Anything undeclared would be bundled into the browser
 * unreviewed, whatever it is called (NEXT_PUBLIC_DATABASE_URL, NEXT_PUBLIC_ANTHROPIC_APIKEY, ...).
 * To expose a new variable on purpose, add it to `clientEnvSchema`.
 */
export function isForbiddenPublicEnvName(name: string): boolean {
  return stripPublicPrefix(name) !== undefined && !CLIENT_ENV_NAMES.includes(name.toUpperCase());
}
/** Message selection only: a forbidden public name that is secret-like or mirrors a server-only variable. */
function isSecretOrServerOnlyPublicName(name: string): boolean {
  const stripped = stripPublicPrefix(name);
  return (
    isSecretLikeEnvName(name) ||
    (stripped !== undefined && SERVER_ONLY_ENV_NAMES.includes(stripped))
  );
}

/**
 * Validate a server-side env source. Also rejects any NEXT_PUBLIC_ variable that is not declared
 * public in `clientEnvSchema` (it would be bundled into the browser), so that fails at startup too.
 */
export function parseServerEnv(source: EnvSource): ServerEnv {
  const publicSecrets: EnvIssue[] = Object.keys(source)
    .filter(isForbiddenPublicEnvName)
    .map((name) => ({
      name,
      kind: "invalid",
      reason: isSecretOrServerOnlyPublicName(name)
        ? "secret-like or server-only names must not be public; NEXT_PUBLIC_ variables are bundled into the browser"
        : `${name} is not declared. Add it to clientEnvSchema in packages/shared/src/env/client-schema.ts (public vars are deny-by-default)`,
    }));
  let env: ServerEnv | undefined;
  let schemaIssues: readonly EnvIssue[] = [];
  try {
    env = parseEnv(serverEnvSchema, source);
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    schemaIssues = error.issues;
  }
  const issues = [...schemaIssues, ...publicSecrets];
  if (issues.length > 0 || env === undefined) throw new EnvValidationError(issues);
  return env;
}
