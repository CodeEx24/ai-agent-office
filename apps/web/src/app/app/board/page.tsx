import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../../features/auth/current-user";
import { TaskBoardLive } from "../../../features/work/board/TaskBoardLive";
import { loadBoardData } from "../../../features/work/board/load-board-data";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";
import { getSupabasePublicEnv } from "../../../lib/env";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

export const metadata: Metadata = { title: "Board · Agent Office" };

// The task board (AGO-146): Inbox, Assigned, In progress, In review, Waiting on you, Done. The first read runs here as
// the signed-in user (row-level security applies); run state then streams in the browser through the office store.
// A failed first read is not fatal: the board starts empty and its own polling retries. No request input is read here.
/** @no-input */
export default async function BoardPage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const initial = await loadBoardData(await createSupabaseServerClient(), workspace.id).catch(
    () => null,
  );
  const { url, anonKey } = getSupabasePublicEnv();

  return (
    <main className="mx-auto grid max-w-[96rem] gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Board</h1>
        <p className="text-sm text-muted-foreground">
          Every task by where it stands. Cards move as agents work. Anything blocked on an approval
          is listed first under Waiting on you; approving happens in the Approvals inbox.
        </p>
      </header>
      <TaskBoardLive
        workspaceId={workspace.id}
        initial={initial}
        supabaseUrl={url}
        supabaseAnonKey={anonKey}
      />
    </main>
  );
}
