import "server-only";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";
import { CapabilityRefusedError, type CapabilityEnabler } from "./enable-capability";

/** `enable_capability` raises this SQLSTATE when a required prerequisite check is not passing (fresh) in the database. */
const PREREQUISITE_REFUSED_SQLSTATE = "55000";

/**
 * The real enabler. Both calls require the owner role first (`requireWorkspaceRole` verifies the signed-in user
 * and their membership, so an agent credential, which has no member, never gets here). `find` reads the row under
 * row-level security. `enable` makes ONE database call: `enable_capability` (SECURITY DEFINER, owner only, with
 * its own check on `auth.uid()`) re-checks the worker's attested prerequisite results and fails closed on a
 * missing, failing or stale row. `capabilities.enabled` is no longer updatable through the API at all, so this
 * function is the only way a capability turns on (AGO-85).
 */
export const capabilityEnabler: CapabilityEnabler = {
  async find(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("capabilities")
      .select("key, enabled")
      .eq("workspace_id", access.workspaceId)
      .eq("id", input.capabilityId)
      .maybeSingle();
    if (error) throw new Error("capability lookup failed");
    return data ? { key: data.key, isEnabled: data.enabled } : null;
  },

  async enable(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("enable_capability", {
      p_workspace_id: access.workspaceId,
      p_capability_id: input.capabilityId,
    });
    if (error?.code === PREREQUISITE_REFUSED_SQLSTATE) throw new CapabilityRefusedError();
    if (error) throw new Error("capability enable failed");
  },
};
