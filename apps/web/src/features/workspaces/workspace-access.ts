import { z } from "zod";
import { hasMinRole, workspaceRoleSchema, type WorkspaceRole } from "@ago/shared";

import { getCurrentUser } from "../auth/current-user";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export interface WorkspaceAccess {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export interface ActiveWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
}

export type WorkspaceAccessErrorCode = "unauthenticated" | "forbidden";

/** Thrown when the caller is signed out or lacks the role. Never carries row data. */
export class WorkspaceAccessError extends Error {
  constructor(readonly code: WorkspaceAccessErrorCode) {
    super(
      code === "unauthenticated"
        ? "Sign in required."
        : "You do not have access to this workspace.",
    );
    this.name = "WorkspaceAccessError";
  }
}

const workspaceIdSchema = z.uuid();

/**
 * The one server-side role gate for workspace-scoped code. Call it before reading or writing
 * workspace data in a server component, action or route handler:
 *
 *   const { role } = await requireWorkspaceRole(workspaceId, "member");
 *
 * It verifies the user with the Auth server, then reads the caller's own active membership
 * through RLS. Any doubt (bad id, no membership, removed, unknown role, query error) is a deny.
 * The database enforces the same ordering in `private.is_member`, so this is defence in depth,
 * not the only gate.
 */
export async function requireWorkspaceRole(
  workspaceId: string,
  minRole: WorkspaceRole,
): Promise<WorkspaceAccess> {
  const user = await getCurrentUser();
  if (!user) throw new WorkspaceAccessError("unauthenticated");

  const parsedId = workspaceIdSchema.safeParse(workspaceId);
  if (!parsedId.success) throw new WorkspaceAccessError("forbidden");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("members")
    .select("role")
    .eq("workspace_id", parsedId.data)
    .eq("user_id", user.id)
    .is("removed_at", null)
    .maybeSingle();
  if (error || !data) throw new WorkspaceAccessError("forbidden");

  const role = workspaceRoleSchema.safeParse(data.role);
  if (!role.success || !hasMinRole(role.data, minRole)) throw new WorkspaceAccessError("forbidden");

  return { userId: user.id, workspaceId: parsedId.data, role: role.data };
}

/**
 * The signed-in user's workspace (their oldest active membership), or null before onboarding.
 * RLS already limits rows to workspaces the user belongs to; the user_id filter picks their own.
 */
export async function getActiveWorkspace(userId: string): Promise<ActiveWorkspace | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("members")
    .select("role, workspaces!inner(id, name)")
    .eq("user_id", userId)
    .is("removed_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const role = workspaceRoleSchema.safeParse(data.role);
  if (!role.success) return null;
  return { id: data.workspaces.id, name: data.workspaces.name, role: role.data };
}
