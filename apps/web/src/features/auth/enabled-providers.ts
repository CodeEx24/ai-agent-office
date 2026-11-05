import { z } from "zod";

import { getSupabasePublicEnv } from "../../lib/env";
import { OAUTH_PROVIDERS, type OAuthProvider } from "./schemas";

const settingsSchema = z.object({ external: z.record(z.string(), z.boolean()).default({}) });

/**
 * Which OAuth providers the Auth server has enabled (its public /auth/v1/settings). A provider
 * that is not configured would otherwise end on a raw JSON 400 page. Only an explicit
 * `false` from the server disables a button; if the lookup fails the state is unknown, so every
 * provider is reported enabled (the previous behaviour).
 */
export async function getEnabledOAuthProviders(): Promise<Record<OAuthProvider, boolean>> {
  const unknown = Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, true])) as Record<
    OAuthProvider,
    boolean
  >;
  try {
    const { url, anonKey } = getSupabasePublicEnv();
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!response.ok) return unknown;
    const { external } = settingsSchema.parse(await response.json());
    return Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, external[p] !== false])) as Record<
      OAuthProvider,
      boolean
    >;
  } catch {
    return unknown;
  }
}
