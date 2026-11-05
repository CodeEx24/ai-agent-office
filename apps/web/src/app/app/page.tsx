import type { Metadata } from "next";

import { getCurrentUser } from "../../features/auth/current-user";

export const metadata: Metadata = { title: "Workspace · Agent Office" };

// Landing page after sign-in. AGO-82 (workspaces and memberships) will resolve the user's
// workspace here; until then it shows who is signed in.
export default async function WorkspaceHomePage() {
  const user = await getCurrentUser();

  return (
    <main className="mx-auto grid max-w-2xl gap-2 p-8">
      <h1 className="text-2xl font-bold tracking-tight">Your workspace</h1>
      <p className="text-muted-foreground">
        Signed in as <strong>{user?.email}</strong>. Workspace selection arrives with workspaces and
        memberships.
      </p>
    </main>
  );
}
