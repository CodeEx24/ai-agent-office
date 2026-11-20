import "server-only";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";
import type { CapabilityEnabler } from "./enable-capability";

/**
 * The real enabler. Both calls require the owner role first (`requireWorkspaceRole` verifies the signed-in user
 * and their membership, so an agent credential, which has no member, never gets here), and both queries are
 * scoped to the workspace and run under row-level security: the `capabilities_update_owner` policy lets only an
 * owner of that workspace change the row, and only `enabled` and `description` are updatable.
 *
 * Known gap (AGO-85 record, Known limitations): until the schema slot, an owner can still flip `enabled`
 * straight through the database API. The tool-call gate in the worker denies an enabled risky capability whose
 * checks fail, so that flag alone never lets a risky tool run.
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
    const { data, error } = await supabase
      .from("capabilities")
      .update({ enabled: true })
      .eq("workspace_id", access.workspaceId)
      .eq("id", input.capabilityId)
      .select("id");
    if (error || data.length !== 1) throw new Error("capability enable failed");
  },
};
