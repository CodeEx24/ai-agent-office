import { createSupabaseBrowserClient } from "../../../lib/supabase/browser";
import type { OfficeEventSource } from "../../office/realtime/office-event-source";
import { createSupabaseOfficeSource } from "../../office/realtime/supabase-office-source";

/**
 * The stream source the run view uses in the browser (AGO-153): `createSupabaseOfficeSource` over the user-scoped
 * browser client from AGO-150. It takes the PUBLIC settings (URL and anon key) the server page read with
 * `getSupabasePublicEnv()`, so it acts as the signed-in user and row-level security decides what arrives.
 *
 * Never pass a service-role key: it would bypass RLS. Without settings there is no live source and the page shows the
 * log the server read, marked "Not live".
 */
export function createRunLiveSource(
  supabaseUrl: string | undefined,
  supabaseAnonKey: string | undefined,
): OfficeEventSource | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return createSupabaseOfficeSource(createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey));
}
