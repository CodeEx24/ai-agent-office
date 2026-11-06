import type { Metadata } from "next";
import Link from "next/link";

import { getCurrentUser } from "../../features/auth/current-user";
import { OnboardingForm } from "../../features/workspaces/OnboardingForm";
import { getActiveWorkspace } from "../../features/workspaces/workspace-access";

export const metadata: Metadata = { title: "Workspace · Agent Office" };

/** "alex@example.com" becomes "alex's workspace": a starting point the user can edit. */
function defaultWorkspaceName(email: string | undefined): string {
  const local = email?.split("@")[0]?.trim();
  return local ? `${local}'s workspace` : "My workspace";
}

// Landing page after sign-in. Resolves the user's workspace (AGO-82); a user with no membership
// yet sees the onboarding form, and submitting it creates the workspace with them as owner.
export default async function WorkspaceHomePage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;

  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-8">
      <h1 className="text-2xl font-bold tracking-tight">Your workspace</h1>
      {workspace ? (
        <section className="grid gap-1" aria-label="Current workspace">
          <p className="text-xl font-semibold" data-testid="workspace-name">
            {workspace.name}
          </p>
          <p className="text-sm text-muted-foreground">
            Signed in as <strong>{user?.email}</strong> ·{" "}
            <span data-testid="workspace-role">{workspace.role}</span>
          </p>
          <p>
            <Link href="/app/skills" className="text-sm text-primary underline underline-offset-4">
              Skills
            </Link>
          </p>
        </section>
      ) : (
        <section className="grid gap-3" aria-label="Set up your workspace">
          <p className="text-muted-foreground">
            Welcome, <strong>{user?.email}</strong>. Name your workspace to get started. You will be
            its owner.
          </p>
          <OnboardingForm defaultName={defaultWorkspaceName(user?.email)} />
        </section>
      )}
    </main>
  );
}
