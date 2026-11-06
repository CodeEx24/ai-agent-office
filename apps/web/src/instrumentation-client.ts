import * as Sentry from "@sentry/nextjs";

import { buildSentryOptions } from "./lib/sentry/options";

/**
 * Browser error tracking (AGO-104). Runs before the app hydrates. Entirely optional: with no
 * NEXT_PUBLIC_SENTRY_DSN (or an invalid one) the SDK is never initialised and nothing is sent.
 * NEXT_PUBLIC_ values are inlined at build time, so set the DSN when building.
 *
 * The literal `process.env` read is validated with `URL.canParse` rather than `getClientEnv()`:
 * that would ship the whole public env schema (and its variable names) into the browser bundle,
 * which the AGO-70 bundle guard forbids. The server applies the same rule in `lib/env.ts`
 * (`getSentryDsn`): an invalid value is logged once and treated as "off", never fatal.
 */
function initBrowserErrorTracking(): void {
  try {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (dsn === undefined || dsn === "" || !URL.canParse(dsn)) return;
    Sentry.init({
      // APP_ENV is server-only, so the browser reports the build mode instead.
      ...buildSentryOptions(dsn, process.env.NODE_ENV),
      // No Replay and no browser tracing: both are paid-plan territory or add data we do not need.
      integrations: (defaults) =>
        defaults.filter((integration) => !/replay|browsertracing/i.test(integration.name)),
    });
  } catch {
    // Error tracking must never take the page down.
  }
}

initBrowserErrorTracking();

/** Lets Sentry attach App Router navigations to events; a no-op while the SDK is off. */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
