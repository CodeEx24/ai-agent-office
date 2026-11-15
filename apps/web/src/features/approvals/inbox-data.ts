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
/** Latest non-usage events read per run: enough for the card's recent steps and the policy reason. */
const EVENTS_PER_RUN = 60;
/**
 * Usage events summed per run, read oldest first (`seq` ascending, so the same events are always the ones counted).
 * One more row than this is fetched to tell whether the run was cut short; a cut run's cost is marked partial.
 */
export const MAX_USAGE_EVENTS_PER_RUN = 2_000;

const STEP_EVENT_TYPES = [
  "step.started",
  "step.completed",
  "tool_call.requested",
  "tool_call.completed",
  "tool_call.failed",
  "policy.decision",
  "approval.requested",
  "approval.decided",
  "run.paused",
  "run.resumed",
] as const;

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

  // Each run is read on its own, so one busy run can never push another run's events out of the read (a single
  // limit across runs would). The reads run in parallel: one step query and one usage query per run.
  const readRun = async (runId: string) => {
    const [steps, usage] = await Promise.all([
      supabase
        .from("run_events")
        .select("run_id, seq, type, payload")
        .eq("workspace_id", access.workspaceId)
        .eq("run_id", runId)
        .in("type", [...STEP_EVENT_TYPES])
        .order("seq", { ascending: false })
        .limit(EVENTS_PER_RUN),
      supabase
        .from("run_events")
        .select("run_id, seq, type, payload")
        .eq("workspace_id", access.workspaceId)
        .eq("run_id", runId)
        .eq("type", "budget.usage")
        .order("seq", { ascending: true })
        .limit(MAX_USAGE_EVENTS_PER_RUN + 1),
    ]);
    if (steps.error) throw new ApprovalInboxError(steps.error);
    if (usage.error) throw new ApprovalInboxError(usage.error);
    return {
      runId,
      steps: steps.data,
      usage: usage.data.slice(0, MAX_USAGE_EVENTS_PER_RUN),
      usageTruncated: usage.data.length > MAX_USAGE_EVENTS_PER_RUN,
    };
  };

  const [agents, runReads] = await Promise.all([
    supabase
      .from("agents")
      .select("id, name")
      .eq("workspace_id", access.workspaceId)
      .in("id", agentIds),
    Promise.all(runIds.map((runId) => readRun(runId))),
  ]);
  if (agents.error) throw new ApprovalInboxError(agents.error);

  const events: StoredEventInput[] = runReads.flatMap((read) =>
    [...read.steps, ...read.usage].map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      payload: row.payload,
    })),
  );
  const partialCostRunIds = new Set(
    runReads.filter((read) => read.usageTruncated).map((read) => read.runId),
  );

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
