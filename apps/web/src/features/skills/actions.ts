"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assignSkillSchema, createSkillSchema, saveSkillSchema } from "@ago/shared";

import { formDataToRecord, parseInput } from "../../lib/validation/parse-input";
import { WorkspaceAccessError } from "../workspaces/workspace-access";
import {
  assignSkill,
  createSkill,
  saveSkill,
  SkillLibraryError,
  unassignSkill,
} from "./skill-library";

export interface SkillActionState {
  error?: string;
  /** Set after a successful save: the version the skill is at now. */
  savedVersion?: number;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
const OWNER_ONLY_ERROR = "Only workspace owners can change skills.";

/** One place that turns a thrown error into a message that is safe to show. */
function messageFor(error: unknown): string {
  if (error instanceof WorkspaceAccessError) {
    return error.code === "unauthenticated"
      ? "Your session has expired. Please sign in again."
      : OWNER_ONLY_ERROR;
  }
  if (error instanceof SkillLibraryError) {
    switch (error.code) {
      case "name_taken":
        return "A skill with that name already exists.";
      case "stale":
        return "Someone saved a newer version first. Reload the page to see it, then edit again.";
      case "not_found":
        return "That skill no longer exists.";
      case "failed":
        return GENERIC_ERROR;
    }
  }
  return GENERIC_ERROR;
}

/** Creates a skill and opens it. Owners only. */
export async function createSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const parsed = parseInput(createSkillSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return { error: parsed.message };

  let skillId: string;
  try {
    ({ id: skillId } = await createSkill(parsed.data));
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath("/app/skills");
  redirect(`/app/skills/${skillId}`);
}

/** Saves an edit: a changed text becomes a new version, the old versions stay. Owners only. */
export async function saveSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const parsed = parseInput(saveSkillSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return { error: parsed.message };

  try {
    const { version } = await saveSkill(parsed.data);
    revalidatePath(`/app/skills/${parsed.data.skillId}`);
    revalidatePath("/app/skills");
    return { savedVersion: version };
  } catch (error) {
    return { error: messageFor(error) };
  }
}

/** Assigns a skill to an agent. Owners only. */
export async function assignSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const parsed = parseInput(assignSkillSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return { error: parsed.message };

  try {
    await assignSkill(parsed.data);
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath(`/app/skills/${parsed.data.skillId}`);
  return {};
}

/** Removes a skill from an agent. Owners only. */
export async function unassignSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const parsed = parseInput(assignSkillSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return { error: parsed.message };

  try {
    await unassignSkill(parsed.data);
  } catch (error) {
    return { error: messageFor(error) };
  }
  revalidatePath(`/app/skills/${parsed.data.skillId}`);
  return {};
}
