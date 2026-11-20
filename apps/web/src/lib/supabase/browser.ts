import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@ago/shared";

/**
 * Supabase client for Client Components (AGO-150). Shared infrastructure: later office tickets (the mobile
 * flat view, the 3D scene) build their event source from it too.
 *
 * It takes the PUBLIC settings as arguments, read on the server with `getSupabasePublicEnv()` (the anon key and
 * URL only), so this file never reads an environment variable itself and can never pick up a service-role key.
 * It acts as the signed-in user: row-level security decides what it can read, and callers still scope every
 * query to the active workspace.
 */
export function createSupabaseBrowserClient(url: string, anonKey: string) {
  return createBrowserClient<Database>(url, anonKey);
}
