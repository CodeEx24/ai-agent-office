"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "../auth/current-user";
import { limitAction, RATE_LIMIT_RULES } from "../../lib/rate-limit";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { parseInput } from "../../lib/validation/parse-input";
import { createWorkspaceSchema } from "./schemas";

export interface OnboardingState {
  error?: string;
  /** What the user typed, handed back after a failed submit so the form keeps their input. */
  name?: string;
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
  const name = typeof rawName === "string" ? rawName : "";
  // Every failure hands the input back (React resets an uncontrolled form after an action).
  const parsed = parseInput(createWorkspaceSchema, { name }, GENERIC_ERROR);
  if (!parsed.success) return { error: parsed.message, name };

  const user = await getCurrentUser();
  if (!user) return { error: "Your session has expired. Please sign in again.", name };

  const limit = await limitAction(`user:${user.id}`, RATE_LIMIT_RULES.onboardingUser);
  if (!limit.allowed) return { error: limit.message, name };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("onboard_current_user", {
      p_workspace_name: parsed.data.name,
    });
    if (error) return { error: GENERIC_ERROR, name };
  } catch {
    return { error: GENERIC_ERROR, name };
  }

  revalidatePath("/app");
  return {};
}
