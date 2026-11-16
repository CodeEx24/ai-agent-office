import "server-only";

import { hasMinRole } from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";
import { buildApprovalCards, type ApprovalCardData, type StoredEventInput } from "./approval-card";

/**
 * Data for the approvals inbox (AGO-37): the workspace's pending approvals with what each card shows.
 * READ ONLY. It selects from `approvals`, `agents` and `run_events` on the caller's own session, so row-level
 * security applies (any member or viewer of the workspace may read). Deciding is a different path: the one
 * human-only decide route (AGO-58). Nothing here writes.
 *
 * Throws `WorkspaceAccessError` when the caller is signed out or not a member, and `ApprovalInboxError` when a
 * query fails.
 */

/** The most pending approvals one page loads; the oldest request comes first, so the longest wait is never cut. */
export const MAX_PENDING_APPROVALS = 50;
/**
 * The reads are batched by event type, so the number of queries is fixed (five) however many approvals are pending.
 * Each batch has a row cap, and the caps are sized for the page's own maximum so the common case is never cut.
 */
/** Recent steps shown per card; the step batch allows this many rows for each pending approval. */
const EVENTS_PER_RUN = 60;
/**
 * The decision events that name a card's call (`approval.requested` and `policy.decision`) are read apart from the
 * steps, so steps never push them out. Other runs' decision rows can, so a full batch falls back to per-run reads
 * (see `readNewestPerRun`), which keep this many newest decision rows for each pending run.
 */
const DECISION_EVENT_TYPES = ["policy.decision", "approval.requested"] as const;
export const DECISION_EVENT_LIMIT = 2_000;
const DECISION_EVENTS_PER_RUN = 100;
const STEP_EVENT_TYPES = [
  "step.started",
  "step.completed",
  "tool_call.requested",
  "tool_call.completed",
  "tool_call.failed",
  "approval.decided",
  "run.paused",
  "run.resumed",
] as const;
export const STEP_EVENT_LIMIT = EVENTS_PER_RUN * MAX_PENDING_APPROVALS;
/**
 * Usage events summed per run, read oldest first within each run (`seq` ascending, so the same events are always the
 * ones counted). One run keeps at most this many; a run with more is cut and its cost is marked partial.
 */
export const MAX_USAGE_EVENTS_PER_RUN = 2_000;
/**
 * Usage rows fetched in one batch for all pending runs. If the batch is cut, every card's cost is marked partial,
 * because the cut can leave any run short.
 */
export const MAX_USAGE_EVENTS_TOTAL = 5_000;

export class ApprovalInboxError extends Error {
  constructor(cause?: unknown) {
    super("Could not load the approvals inbox.", { cause });
    this.name = "ApprovalInboxError";
  }
}

export interface ApprovalInbox {
  readonly workspaceId: string;
  /** The server's clock when the list was read, so ages render the same on the server and the first client paint. */
  readonly generatedAtMs: number;
  /** Members and owners may decide; viewers see the inbox read-only. */
  readonly canDecide: boolean;
  readonly cards: readonly ApprovalCardData[];
}

/** What the page gets when the list could not be read this time (a query failed): the inbox keeps its last good list. */
export interface ApprovalInboxLoadFailure {
  readonly workspaceId: string;
  readonly generatedAtMs: number;
  readonly loadFailed: true;
}

/**
 * Like `listPendingApprovals`, but a failed READ comes back as a value instead of a throw. The page uses it so a
 * failed poll shows an inline "couldn't refresh, retrying" line rather than dropping to the route's error
 * boundary (which would stop the polling). Access errors still throw: signed out or not a member is not a retry.
 */
export async function loadApprovalInbox(
  workspaceId: string,
): Promise<ApprovalInbox | ApprovalInboxLoadFailure> {
  try {
    return await listPendingApprovals(workspaceId);
  } catch (error) {
    if (error instanceof ApprovalInboxError) {
      return { workspaceId, generatedAtMs: Date.now(), loadFailed: true };
    }
    throw error;
  }
}

export async function listPendingApprovals(workspaceId: string): Promise<ApprovalInbox> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = await createSupabaseServerClient();

  const approvals = await supabase
    .from("approvals")
    .select("id, run_id, agent_id, action, payload_hash, created_at, expires_at")
    .eq("workspace_id", access.workspaceId)
    .eq("status", "pending")
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(MAX_PENDING_APPROVALS);
  if (approvals.error) throw new ApprovalInboxError(approvals.error);

  const canDecide = hasMinRole(access.role, "member");
  if (approvals.data.length === 0) {
    return { workspaceId: access.workspaceId, generatedAtMs: Date.now(), canDecide, cards: [] };
  }

  const agentIds = [...new Set(approvals.data.map((row) => row.agent_id))];
  const runIds = [
    ...new Set(approvals.data.flatMap((row) => (row.run_id === null ? [] : [row.run_id]))),
  ];

  // Four batches for all pending runs at once: decision events, recent steps and usage, plus the agent names above.
  // None of them is per run, so the query count does not grow with the number of pending approvals.
  // `seq` is per run, so a row window shared by several runs can be filled by one busy run. Each read below is
  // therefore either one batch over all runs (when it is not cut) or one bounded read per run (when it is).
  const newestEvents = (ids: string[], types: readonly string[], limit: number) =>
    supabase
      .from("run_events")
      .select("run_id, seq, type, payload")
      .eq("workspace_id", access.workspaceId)
      .in("run_id", ids)
      .in("type", [...types])
      .order("seq", { ascending: false })
      .limit(limit);

  /**
   * Newest events of the given types. One query for all runs; if it came back full it may have been filled by a few
   * busy runs, so every run is read on its own with a per-run cap and each card keeps its own reason and steps.
   * The per-run reads only happen when the batch was cut, so the common poll stays at five queries.
   */
  const readNewestPerRun = async (
    types: readonly string[],
    batchLimit: number,
    perRunLimit: number,
  ) => {
    const batch = await newestEvents(runIds, types, batchLimit);
    if (batch.error || batch.data.length < batchLimit) return batch;
    const perRun = await Promise.all(runIds.map((id) => newestEvents([id], types, perRunLimit)));
    const failed = perRun.find((result) => result.error);
    if (failed?.error) return { data: null, error: failed.error };
    return { data: perRun.flatMap((result) => result.data ?? []), error: null };
  };

  const readRunEvents = async () => {
    const [decisions, steps, usage] = await Promise.all([
      readNewestPerRun(DECISION_EVENT_TYPES, DECISION_EVENT_LIMIT, DECISION_EVENTS_PER_RUN),
      readNewestPerRun(STEP_EVENT_TYPES, STEP_EVENT_LIMIT, EVENTS_PER_RUN),
      supabase
        .from("run_events")
        .select("run_id, seq, type, payload")
        .eq("workspace_id", access.workspaceId)
        .in("run_id", runIds)
        .eq("type", "budget.usage")
        .order("run_id", { ascending: true })
        .order("seq", { ascending: true })
        .limit(MAX_USAGE_EVENTS_TOTAL + 1),
    ]);
    if (decisions.error) throw new ApprovalInboxError(decisions.error);
    if (steps.error) throw new ApprovalInboxError(steps.error);
    if (usage.error) throw new ApprovalInboxError(usage.error);
    return { decisions: decisions.data, steps: steps.data, usage: usage.data };
  };

  // With no pending run there is nothing to read, so the event batches are not sent at all.
  const [agents, eventReads] = await Promise.all([
    supabase
      .from("agents")
      .select("id, name")
      .eq("workspace_id", access.workspaceId)
      .in("id", agentIds),
    runIds.length === 0 ? null : readRunEvents(),
  ]);
  if (agents.error) throw new ApprovalInboxError(agents.error);
  const { decisions, steps, usage } = eventReads ?? { decisions: [], steps: [], usage: [] };

  const usageBatchCut = usage.length > MAX_USAGE_EVENTS_TOTAL;
  const usageRows = usage.slice(0, MAX_USAGE_EVENTS_TOTAL);
  const usageByRun = new Map<string, typeof usageRows>();
  for (const row of usageRows) {
    usageByRun.set(row.run_id, [...(usageByRun.get(row.run_id) ?? []), row]);
  }
  const partialCostRunIds = new Set<string>(usageBatchCut ? runIds : []);
  const keptUsage = [...usageByRun].flatMap(([runId, rows]) => {
    if (rows.length > MAX_USAGE_EVENTS_PER_RUN) partialCostRunIds.add(runId);
    return rows.slice(0, MAX_USAGE_EVENTS_PER_RUN);
  });

  const events: StoredEventInput[] = [...decisions, ...steps, ...keptUsage].map((row) => ({
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
  }));

  return {
    workspaceId: access.workspaceId,
    generatedAtMs: Date.now(),
    canDecide,
    cards: buildApprovalCards({
      approvals: approvals.data.map((row) => ({
        id: row.id,
        runId: row.run_id,
        agentId: row.agent_id,
        action: row.action,
        payloadHash: row.payload_hash,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
      agentNames: new Map(agents.data.map((agent) => [agent.id, agent.name])),
      events,
      partialCostRunIds,
    }),
  };
}
