import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { getCurrentUser } from "../../../../features/auth/current-user";
import { RunView } from "../../../../features/runs/run-view/RunView";
import { loadRunView } from "../../../../features/runs/run-view/load-run-view";
import { getActiveWorkspace } from "../../../../features/workspaces/workspace-access";

import { getSupabasePublicEnv } from "../../../../lib/env";
import { parseInput } from "../../../../lib/validation/parse-input";

const paramsSchema = z.object({ runId: z.uuid() });

export const metadata: Metadata = { title: "Run · Agent Office" };

// The run view (AGO-153): the live log, steps, tool calls, tokens, cost and duration of one run. The workspace comes
// from the signed-in user's membership; the only request input is the run id, validated as a uuid in `loadRunView`.
// A missing run, a run of another workspace and a bad id all show the same not-found page, never any data.
export default async function RunPage({ params }: { readonly params: Promise<{ runId: string }> }) {
  const parsed = parseInput(paramsSchema, await params);
  if (!parsed.success) notFound();
  const { runId } = parsed.data;
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const result = await loadRunView(workspace.id, runId);
  if (result.kind === "not_found") notFound();

  const { url, anonKey } = getSupabasePublicEnv();

  return (
    <main className="mx-auto grid max-w-4xl gap-6 p-8 [&>*]:min-w-0">
      <RunView
        run={result.run}
        initialRows={result.rows}
        serverNowMs={result.serverNowMs}
        isCut={result.isCut}
        supabaseUrl={url}
        supabaseAnonKey={anonKey}
      />
    </main>
  );
}
