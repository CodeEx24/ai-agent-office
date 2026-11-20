import "server-only";

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";

import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { requireWorkspaceRole } from "../../workspaces/workspace-access";
import type { RunEventRow } from "./run-log";
import type { RunSummary } from "./run-view-format";

/**
 * Data for the run view (AGO-153). READ ONLY, on the caller's own session, so row-level security applies; no service
 * role, no writes, no migration. Every query names the `workspace_id`.
 *
 * A malformed id, a missing run and a run of another workspace all give `not_found` (RLS hides the foreign row, so
 * the three cannot be told apart, and none returns data). A failed query throws `RunViewLoadError`.
 *
 * The run's events are read oldest first by `seq`, in pages. A run with more events than `MAX_RUN_VIEW_EVENTS` is
 * cut (`isCut`); the live feed continues from the last contiguous `seq`, so the rest still loads in the browser.
 * Cost and tokens are derived from these stored `budget.usage` events (see `run-log.ts`), never estimated.
 */

export const RUN_VIEW_PAGE_SIZE = 1_000;
export const MAX_RUN_VIEW_EVENTS = 5_000;

export class RunViewLoadError extends Error {
  constructor(cause?: unknown) {
    super("Could not load the run.", { cause });
    this.name = "RunViewLoadError";
  }
}

export type LoadRunViewResult =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "ok";
      readonly run: RunSummary;
      readonly rows: readonly RunEventRow[];
      readonly isCut: boolean;
      readonly serverNowMs: number;
    };

const runIdSchema = z.uuid();

export async function loadRunView(
  workspaceId: string,
  runId: string,
  client?: SupabaseClient<Database>,
): Promise<LoadRunViewResult> {
  const parsedRunId = runIdSchema.safeParse(runId);
  if (!parsedRunId.success) return { kind: "not_found" };
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = client ?? (await createSupabaseServerClient());

  const { data: run, error: runError } = await supabase
    .from("runs")
    .select("id, workspace_id, agent_id, status, started_at, finished_at, created_at")
    .eq("workspace_id", access.workspaceId)
    .eq("id", parsedRunId.data)
    .maybeSingle();
  if (runError) throw new RunViewLoadError(runError);
  if (!run) return { kind: "not_found" };

  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("name")
    .eq("workspace_id", access.workspaceId)
    .eq("id", run.agent_id)
    .maybeSingle();
  if (agentError) throw new RunViewLoadError(agentError);

  const rows: RunEventRow[] = [];
  let isCut = false;
  while (rows.length < MAX_RUN_VIEW_EVENTS) {
    const { data, error } = await supabase
      .from("run_events")
      .select("id, workspace_id, run_id, seq, type, payload, created_at")
      .eq("workspace_id", access.workspaceId)
      .eq("run_id", run.id)
      .gt("seq", rows.at(-1)?.seq ?? 0)
      .order("seq", { ascending: true })
      .limit(RUN_VIEW_PAGE_SIZE);
    if (error) throw new RunViewLoadError(error);
    rows.push(...data);
    if (data.length < RUN_VIEW_PAGE_SIZE) break;
    if (rows.length >= MAX_RUN_VIEW_EVENTS) isCut = true;
  }

  return {
    kind: "ok",
    run: {
      id: run.id,
      workspaceId: run.workspace_id,
      agentId: run.agent_id,
      agentName: agent?.name ?? null,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      createdAt: run.created_at,
    },
    rows,
    isCut,
    serverNowMs: Date.now(),
  };
}
