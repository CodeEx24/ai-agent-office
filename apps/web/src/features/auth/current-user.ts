import type { User } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "../../lib/supabase/server";

/**
 * The verified signed-in user, or null. Uses getUser(), which asks the Auth server to validate
 * the token (a cookie alone is never trusted). Any failure, including an unreachable Supabase,
 * means signed out.
 */
export async function getCurrentUser(): Promise<User | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    return error ? null : data.user;
  } catch {
    return null;
  }
}
