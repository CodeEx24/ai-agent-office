import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@ago/shared";

import { getSupabasePublicEnv } from "../env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * Server-only: it reads request cookies. Create one per request, never share it.
 */
export async function createSupabaseServerClient() {
  const { url, anonKey } = getSupabasePublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. The proxy refreshes the session on every
          // request, so ignoring this here is safe.
        }
      },
    },
  });
}
