// Import from the client-only entry: the `@ago/shared` barrel also carries the server schema,
// whose variable names must never be bundled into the browser.
import { clientEnvSchema, parseEnv, type ClientEnv } from "@ago/shared/client-env";

let cached: ClientEnv | undefined;

/**
 * Validated public environment, safe for client bundles. Next.js only inlines literal
 * `process.env.NEXT_PUBLIC_*` accesses, so every variable is listed explicitly here
 * instead of passing `process.env`. Add new public variables to the schema and this list.
 */
export function getClientEnv(): ClientEnv {
  cached ??= parseEnv(clientEnvSchema, {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });
  return cached;
}
