import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasMinRole } from "@ago/shared";

import { getCurrentUser } from "../../../features/auth/current-user";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";
import { listGoals } from "../../../features/work/goal-inbox";
import { GoalInboxForm } from "../../../features/work/GoalInboxForm";
import { GoalList } from "../../../features/work/GoalList";

export const metadata: Metadata = { title: "Goals · Agent Office" };

// The goal inbox (AGO-113). Members and owners see the form; viewers see the list only. No request input is read
// here: the workspace comes from the session, and the server action checks the role again.
/** @no-input */
export default async function GoalsPage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const goals = await listGoals(workspace.id);
  const canSubmit = hasMinRole(workspace.role, "member");

  return (
    <main className="mx-auto grid max-w-3xl gap-8 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Goals</h1>
        <p className="text-sm text-muted-foreground">
          Tell the team what you want done. The Manager turns each goal into tasks.
        </p>
      </header>
      {canSubmit ? (
        <section aria-labelledby="new-goal-heading" className="grid gap-3">
          <h2 id="new-goal-heading" className="text-lg font-semibold">
            New goal
          </h2>
          <GoalInboxForm workspaceId={workspace.id} />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          You can read goals here. Only members can submit them.
        </p>
      )}
      <section aria-labelledby="goal-list-heading" className="grid gap-3">
        <h2 id="goal-list-heading" className="text-lg font-semibold">
          Recent goals
        </h2>
        <GoalList goals={goals} />
      </section>
    </main>
  );
}
