import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { evaluatePrerequisites, hasMinRole, isGatedCapability } from "@ago/shared";

import { getCurrentUser } from "../../../features/auth/current-user";
import { listCapabilities } from "../../../features/capabilities/capability-catalog";
import { EnableCapabilityControl } from "../../../features/capabilities/EnableCapabilityControl";
import { fetchPrerequisiteReport } from "../../../features/capabilities/prerequisite-report";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";

export const metadata: Metadata = { title: "Capabilities · Agent Office" };

// The capability catalog (AGO-125) with the AGO-85 enable control. Everyone in the workspace can read it; only
// owners can turn a capability on, and a risky one stays off until its prerequisites pass. No request input is
// read here: the workspace comes from the signed-in user's membership.
/** @no-input */
export default async function CapabilitiesPage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const capabilities = await listCapabilities(workspace.id);
  const canEdit = hasMinRole(workspace.role, "owner");
  // One report per page view; a missing or invalid report leaves every risky capability blocked.
  const hasGated = capabilities.some((capability) => isGatedCapability(capability.key));
  const report = hasGated ? await fetchPrerequisiteReport() : [];

  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Capabilities</h1>
        <p className="text-sm text-muted-foreground">
          What agents can be allowed to do. Running code, browsing the web and sending messages stay
          off until the sandbox, the egress deny-list, the credential broker and payload-bound
          approvals all pass their checks.
        </p>
      </header>

      <ul className="grid min-w-0 gap-2" data-testid="capability-list">
        {capabilities.map((capability) => {
          const blockedBy = isGatedCapability(capability.key)
            ? evaluatePrerequisites(capability.key, report).failures.map((failure) => failure.label)
            : [];
          return (
            <li
              key={capability.id}
              className="flex min-w-0 items-start justify-between gap-3 rounded-md border px-3 py-2"
            >
              <span className="min-w-0">
                <span className="font-medium [overflow-wrap:anywhere]">{capability.name}</span>
                <span className="block text-xs text-muted-foreground">
                  Tier {capability.tier} · {capability.key}
                </span>
                {capability.description ? (
                  <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {capability.description}
                  </span>
                ) : null}
              </span>
              {canEdit ? (
                <EnableCapabilityControl
                  workspaceId={workspace.id}
                  capabilityId={capability.id}
                  name={capability.name}
                  isEnabled={capability.enabled}
                  blockedBy={blockedBy}
                />
              ) : (
                <span className="text-sm text-muted-foreground">
                  {capability.enabled ? "Enabled" : "Off"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
