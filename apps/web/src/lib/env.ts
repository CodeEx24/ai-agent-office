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
  });
}

/**
 * Configured public origin of this app. Used for every URL sent to Supabase or emailed
 * (never derived from request headers). Set NEXT_PUBLIC_APP_URL to match the port you run on.
 */
export function getAppUrl(): string {
  return readPublicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  const env = readPublicEnv();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error("Invalid environment configuration: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anonKey };
}
