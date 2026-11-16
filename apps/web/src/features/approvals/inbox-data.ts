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
 * The reads are batched by event type, so the number of queries per poll is bounded however many approvals are
 * pending: the page count below, never one query per run. The API returns at most 1,000 rows per request
 * (`max_rows` in `supabase/config.toml`; the hosted default is the same), so each read is paged in rows of
 * `EVENT_PAGE_SIZE` and ends at its row budget. A read that reaches its budget with rows left is "cut", and the
 * cards say their history may be incomplete rather than show an empty history as fact.
 */
export const EVENT_PAGE_SIZE = 1_000;
/** Recent steps shown per card; the step read allows this many rows for each pending approval. */
const EVENTS_PER_RUN = 60;
/**
 * The decision events that name a card's call (`approval.requested` and `policy.decision`) are read apart from the
 * steps, so steps never push them out. Newest first across all runs: one busy run's rows can still fill the budget
 * ahead of a quiet run's, and then the read is cut and the quiet card is marked "may be incomplete".
 */
const DECISION_EVENT_TYPES = ["policy.decision", "approval.requested"] as const;
export const DECISION_EVENT_LIMIT = 2_000;
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

interface EventRow {
  readonly run_id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

interface EventRead {
  /** At most the row budget. */
  readonly rows: readonly EventRow[];
  /** True when rows beyond the budget exist, so `rows` is only the first part of what is stored. */
  readonly isCut: boolean;
}

/**
 * Reads up to `maxRows` rows page by page, plus one extra row to learn whether anything lies beyond the budget.
 * A page shorter than `EVENT_PAGE_SIZE` is the last one.
 */
async function readEventPages(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: readonly EventRow[] | null; error: unknown }>,
  maxRows: number,
): Promise<EventRead> {
  const wanted = maxRows + 1;
  const rows: EventRow[] = [];
  while (rows.length < wanted) {
    const from = rows.length;
    const to = Math.min(from + EVENT_PAGE_SIZE, wanted) - 1;
    const result = await page(from, to);
    if (result.error || result.data === null) throw new ApprovalInboxError(result.error);
    rows.push(...result.data);
    if (result.data.length < to - from + 1) break;
  }
  return { rows: rows.slice(0, maxRows), isCut: rows.length > maxRows };
}

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

  // Three reads for all pending runs at once (decision events, recent steps, usage), plus the agent names above.
  // None of them is per run, so the query count does not grow with the number of pending approvals. Each read is
  // paged in `EVENT_PAGE_SIZE` rows, because the API returns at most that many rows per request, and a read that
  // reaches its row budget reports `isCut` instead of passing a short list off as the whole history.
  // The pages are ordered by a total order (the sort columns, then `run_id`, then `seq`), so no row is skipped or
  // repeated between pages.
  const eventPages =
    (types: readonly string[], order: "newest" | "usage") => (from: number, to: number) => {
      const query = supabase
        .from("run_events")
        .select("run_id, seq, type, payload")
        .eq("workspace_id", access.workspaceId)
        .in("run_id", runIds)
        .in("type", [...types]);
      const ordered =
        order === "newest"
          ? query.order("seq", { ascending: false }).order("run_id", { ascending: true })
          : query.order("run_id", { ascending: true }).order("seq", { ascending: true });
      return ordered.range(from, to);
    };

  const readRunEvents = async () => {
    const [decisions, steps, usage] = await Promise.all([
      readEventPages(eventPages(DECISION_EVENT_TYPES, "newest"), DECISION_EVENT_LIMIT),
      readEventPages(eventPages(STEP_EVENT_TYPES, "newest"), STEP_EVENT_LIMIT),
      readEventPages(eventPages(["budget.usage"], "usage"), MAX_USAGE_EVENTS_TOTAL),
    ]);
    return { decisions, steps, usage };
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
  const emptyRead: EventRead = { rows: [], isCut: false };
  const { decisions, steps, usage } = eventReads ?? {
    decisions: emptyRead,
    steps: emptyRead,
    usage: emptyRead,
  };

  const usageBatchCut = usage.isCut;
  const usageRows = usage.rows;
  const usageByRun = new Map<string, typeof usageRows>();
  for (const row of usageRows) {
    usageByRun.set(row.run_id, [...(usageByRun.get(row.run_id) ?? []), row]);
  }
  const partialCostRunIds = new Set<string>(usageBatchCut ? runIds : []);
  const keptUsage = [...usageByRun].flatMap(([runId, rows]) => {
    if (rows.length > MAX_USAGE_EVENTS_PER_RUN) partialCostRunIds.add(runId);
    return rows.slice(0, MAX_USAGE_EVENTS_PER_RUN);
  });

  const events: StoredEventInput[] = [...decisions.rows, ...steps.rows, ...keptUsage].map(
    (row) => ({
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      payload: row.payload,
    }),
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
      isHistoryCut: decisions.isCut || steps.isCut,
    }),
  };
}
