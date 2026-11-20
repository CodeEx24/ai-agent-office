import type { OfficeEventSource } from "../../office/realtime/office-event-source";

/**
 * The stream source the run view uses in the browser (AGO-153).
 *
 * It must be `createSupabaseOfficeSource(<user-scoped browser client>)`. The browser client
 * (`apps/web/src/lib/supabase/browser.ts`) arrives with AGO-150 (PR 87); until that merges this returns `null`, and the
 * page shows the log the server read, marked "Not live". Wiring it is one line once the file exists, and AC1 ("log
 * updates live") is proven against the real client at that point (owner decision, ticket record).
 *
 * Never pass a service-role client: it would bypass RLS.
 */
export function createRunLiveSource(): OfficeEventSource | null {
  return null;
}
