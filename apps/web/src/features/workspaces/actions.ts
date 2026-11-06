"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "../auth/current-user";
import { limitAction, RATE_LIMIT_RULES } from "../../lib/rate-limit";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { parseInput } from "../../lib/validation/parse-input";
import { createWorkspaceSchema } from "./schemas";

export interface OnboardingState {
  error?: string;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Onboarding: creates the user's workspace and their owner membership in one database
 * transaction (`onboard_current_user`). Safe to repeat: a second call returns the same workspace.
 * The database function only ever acts for the signed-in user, so no user id is sent from here.
 */
export async function createWorkspaceAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const rawName = formData.get("name");
  const parsed = parseInput(
    createWorkspaceSchema,
    { name: typeof rawName === "string" ? rawName : "" },
    GENERIC_ERROR,
  );
  if (!parsed.success) return { error: parsed.message };

  const user = await getCurrentUser();
  if (!user) return { error: "Your session has expired. Please sign in again." };

  const limit = await limitAction(`user:${user.id}`, RATE_LIMIT_RULES.onboardingUser);
  if (!limit.allowed) return { error: limit.message };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("onboard_current_user", {
      p_workspace_name: parsed.data.name,
    });
    if (error) return { error: GENERIC_ERROR };
  } catch {
    return { error: GENERIC_ERROR };
  }

  revalidatePath("/app");
  return {};
}
