import { clientEnvSchema, parseEnv } from "@ago/shared/client-env";

// Public Supabase settings and app origin for the auth flow, validated by AGO-70's
// `clientEnvSchema` so every NEXT_PUBLIC_ name is declared in one place. Keep every read behind
// these helpers.
//
// The values are read from a `process.env` alias on purpose. A literal `process.env.NEXT_PUBLIC_*`
// would be inlined at `next build`, which freezes whatever the build shell had. Reading at request
// time lets the same build run against any Supabase URL. Only the URL and the anon key are public;
// no service-role or provider secret is ever read here.
export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

// Auth keeps the loopback IP (not the schema's `localhost` default) so local cookies and
// redirect targets stay on the origin the sign-in flow was written against.
const AUTH_LOCAL_APP_URL = "http://127.0.0.1:3000";

function readPublicEnv() {
  const source = process.env;
  return parseEnv(clientEnvSchema, {
    NEXT_PUBLIC_APP_URL:
      source.NEXT_PUBLIC_APP_URL === undefined || source.NEXT_PUBLIC_APP_URL === ""
        ? AUTH_LOCAL_APP_URL
        : source.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    // NEXT_PUBLIC_SENTRY_DSN is deliberately not parsed here: it is optional, and a bad value must
    // never make this parse (and so every request) fail. See `getSentryDsn`.
  });
}

let hasWarnedAboutSentryDsn = false;

/**
 * Public Sentry DSN when error tracking is configured and valid, else undefined (AGO-104). Used to
 * allow the Sentry ingest origin in the CSP only when there is a DSN.
 *
 * Sentry is optional and must never take the app down, so an invalid value is treated as "off":
 * it is logged once (the variable name only, never the value) and this returns undefined.
 *
 * The literal `process.env.NEXT_PUBLIC_SENTRY_DSN` is inlined at build time (see next.config.ts),
 * exactly like the browser SDK's DSN, so the CSP and the browser always agree. Changing the DSN
 * therefore needs a rebuild.
 */
export function getSentryDsn(): string | undefined {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (dsn === undefined || dsn === "") return undefined;
  if (URL.canParse(dsn)) return dsn;
  if (!hasWarnedAboutSentryDsn) {
    hasWarnedAboutSentryDsn = true;
    console.warn("NEXT_PUBLIC_SENTRY_DSN is not a valid URL; error tracking is off.");
  }
  return undefined;
}

/**
 * Configured public origin of this app. Used for every URL sent to Supabase or emailed
 * (never derived from request headers). Set NEXT_PUBLIC_APP_URL to match the port you run on.
 */
export function getAppUrl(): string {
  return readPublicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
}

/** Validated public Supabase URL (no anon key needed); allowed in the CSP `connect-src`. */
export function getSupabaseUrl(): string {
  return readPublicEnv().NEXT_PUBLIC_SUPABASE_URL;
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  const env = readPublicEnv();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error("Invalid environment configuration: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anonKey };
}
