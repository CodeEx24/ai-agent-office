import { z } from "zod";

/** Workspace roles, least to most privileged. Mirrors `members_role_check` in the database. */
export const WORKSPACE_ROLES = ["viewer", "member", "owner"] as const;

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 1, member: 2, owner: 3 };

/** True when `role` is at least `minRole`. Same ordering as `private.role_rank` in SQL. */
export function hasMinRole(role: WorkspaceRole, minRole: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}
