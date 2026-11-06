import * as Sentry from "@sentry/nextjs";

/**
 * Runs once when the Next.js server starts. Validating the environment here makes a
 * missing or invalid variable fail fast with a clear message instead of at first use.
 * It then starts server-side error tracking when a DSN is configured (AGO-104); with no
 * `SENTRY_DSN` the SDK is never initialised and nothing is sent.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerEnv } = await import("./lib/env/server");
  const env = getServerEnv();
  if (env.SENTRY_DSN === undefined) return;
  const { buildSentryOptions } = await import("./lib/sentry/options");
  Sentry.init(buildSentryOptions(env.SENTRY_DSN, env.APP_ENV));
}

/** Reports errors from Server Components, route handlers and actions; a no-op while the SDK is off. */
export const onRequestError = Sentry.captureRequestError;
