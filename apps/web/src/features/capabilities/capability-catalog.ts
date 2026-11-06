import "server-only";

import { capabilitySchema, type Capability } from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";

const COLUMNS =
  "id, workspace_id, key, name, description, tier, scope, default_mode, enabled, created_at, updated_at";

/** Thrown when the catalog cannot be read or a stored row breaks the schema. Never carries row data. */
export class CapabilityCatalogError extends Error {
  constructor() {
    super("The capability catalog could not be read.");
    this.name = "CapabilityCatalogError";
  }
}

/**
 * The workspace's capability catalog, lowest tier first. Read-only: the catalog changes by migration
 * (tier, scope, default) or by an owner through the database (enabled, description), never from here.
 *
 * Any member or viewer may read. `requireWorkspaceRole` throws `WorkspaceAccessError` for a signed-out
 * caller or a non-member; row-level security enforces the same rule in the database, so this is
 * defence in depth. Every row is parsed with `capabilitySchema` before it leaves the data layer.
 */
export async function listCapabilities(workspaceId: string): Promise<Capability[]> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("capabilities")
    .select(COLUMNS)
    .eq("workspace_id", access.workspaceId)
    .order("tier", { ascending: true })
    .order("key", { ascending: true });
  if (error) throw new CapabilityCatalogError();

  return data.map((row) => {
    const parsed = capabilitySchema.safeParse({
      id: row.id,
      workspaceId: row.workspace_id,
      key: row.key,
      name: row.name,
      description: row.description,
      tier: row.tier,
      scope: row.scope,
      defaultMode: row.default_mode,
      enabled: row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    if (!parsed.success) throw new CapabilityCatalogError();
    return parsed.data;
  });
}
