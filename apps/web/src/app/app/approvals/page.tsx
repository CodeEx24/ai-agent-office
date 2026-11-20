import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../../features/auth/current-user";
import { ApprovalInbox } from "../../../features/approvals/ApprovalInbox";
import { loadApprovalInbox } from "../../../features/approvals/inbox-data";
import { ApprovalLinkNotice, approvalLinkQuerySchema } from "../../../features/office/cards";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";
import { parseInput } from "../../../lib/validation/parse-input";

export const metadata: Metadata = { title: "Approvals · Agent Office" };

// The approvals inbox (AGO-37): what agents are waiting to do, until a person decides. The workspace comes from the
// signed-in user's membership. The only request input is the optional `approval` query an agent card adds (AGO-150),
// parsed below; it only decides whether to show a "no longer pending" cue. Decisions go through the human-only
// decide route.
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const query = parseInput(approvalLinkQuerySchema, (await searchParams) ?? {});
  const linkedApprovalId = query.success ? query.data.approval : undefined;
  const inbox = await loadApprovalInbox(workspace.id);
  const isLinkedApprovalGone =
    linkedApprovalId !== undefined &&
    !("loadFailed" in inbox) &&
    !inbox.cards.some((card) => card.id === linkedApprovalId);

  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Agents stop here before a risky action. Nothing runs until a person approves it, and a
          request nobody answers is denied when it times out.
        </p>
      </header>
      {isLinkedApprovalGone ? <ApprovalLinkNotice /> : null}
      {"loadFailed" in inbox ? (
        <ApprovalInbox
          workspaceId={inbox.workspaceId}
          cards={[]}
          canDecide={false}
          serverNowMs={inbox.generatedAtMs}
          loadFailed
        />
      ) : (
        <ApprovalInbox
          workspaceId={inbox.workspaceId}
          cards={inbox.cards}
          canDecide={inbox.canDecide}
          serverNowMs={inbox.generatedAtMs}
        />
      )}
    </main>
  );
}
