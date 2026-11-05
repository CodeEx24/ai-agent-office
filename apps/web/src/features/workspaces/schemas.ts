import { z } from "zod";

/** Mirrors the 1 to 120 character check on `workspaces.name`. */
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, "Give your workspace a name.")
  .max(120, "Keep the name under 120 characters.");

export const createWorkspaceSchema = z.object({ name: workspaceNameSchema });
