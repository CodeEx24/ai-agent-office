import type {
  FetchRunEventsArgs,
  OfficeEventSource,
  SubscribeHandlers,
} from "../../office/realtime/office-event-source";
import type { RunEventRow } from "./run-log";
import type { RunSummary } from "./run-view-format";

/** Test helpers for the run view (AGO-153). Synthetic data only; not imported by production code. */

export const WORKSPACE_ID = "15300000-0000-4000-8000-000000000001";
export const OTHER_WORKSPACE_ID = "15300000-0000-4000-8000-000000000002";
export const RUN_ID = "15300000-0000-4000-8000-0000000000a1";
export const OTHER_RUN_ID = "15300000-0000-4000-8000-0000000000a2";
export const AGENT_ID = "15300000-0000-4000-8000-0000000000b1";
const BASE_MS = Date.parse("2026-11-20T10:00:00.000Z");

export function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1_000).toISOString();
}

export function ev(
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
  seconds: number = seq,
  runId: string = RUN_ID,
  workspaceId: string = WORKSPACE_ID,
): RunEventRow {
  return {
    id: `15300000-0000-4000-8000-${String(seq).padStart(6, "0")}${runId.slice(-6)}`,
    workspace_id: workspaceId,
    run_id: runId,
    seq,
    type,
    payload: { version: 1, ...payload },
    created_at: at(seconds),
  };
}

export function usageEvent(
  seq: number,
  input: number,
  output: number,
  costCents?: number,
): RunEventRow {
  return ev(seq, "budget.usage", {
    input_tokens: input,
    output_tokens: output,
    ...(costCents === undefined ? {} : { cost_cents: costCents }),
  });
}

export const HASH = "ab".repeat(32);

export function baseRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentName: "Scout",
    status: "running",
    startedAt: at(1),
    finishedAt: null,
    createdAt: at(0),
    ...overrides,
  };
}

/** The cost in cents the worker settled against the AGO-40 ledger for each call of `stoppedByBudgetRows`. */
export const LEDGER_CENTS_BY_CALL = [7, 12] as const;

/** A run that made two model calls and one tool call, then was stopped by the budget. */
export function stoppedByBudgetRows(): RunEventRow[] {
  return [
    ev(1, "run.created", { agent_id: AGENT_ID, task_id: null }),
    ev(2, "run.started"),
    ev(3, "step.started", { step: 1 }),
    usageEvent(4, 1_200, 300, LEDGER_CENTS_BY_CALL[0]),
    ev(5, "tool_call.requested", {
      call_id: "c1",
      tool_name: "web.search",
      tier: 1,
      input_hash: HASH,
    }),
    ev(6, "policy.decision", {
      call_id: "c1",
      decision: "allow",
      tier: 1,
      reason_code: "tier_1_allowed",
    }),
    ev(7, "tool_call.started", { call_id: "c1" }),
    ev(8, "tool_call.completed", { call_id: "c1", duration_ms: 1_250, output_hash: HASH }),
    ev(9, "step.completed", { step: 1, outcome: "ok" }),
    ev(10, "step.started", { step: 2 }),
    usageEvent(11, 2_000, 500, LEDGER_CENTS_BY_CALL[1]),
    ev(12, "budget.exceeded", {
      scope: "run",
      reason: "run_token_limit_reached",
      limit: 4_000,
      used: 4_000,
    }),
    ev(13, "run.stopped", { stopped_by: "budget", reason: "run_token_limit_reached" }),
  ];
}

export interface FakeSource extends OfficeEventSource {
  /** Deliver a row on the live stream. */
  push(row: unknown): void;
  /** Report the channel state to the subscriber. */
  setStatus(status: "subscribed" | "closed" | "error"): void;
  /** Rows the database "holds", read by `fetchRunEvents`. */
  readonly stored: RunEventRow[];
  readonly fetches: FetchRunEventsArgs[];
  readonly subscribeCount: () => number;
  failNextFetch(): void;
}

export function makeFakeSource(stored: RunEventRow[] = []): FakeSource {
  let handlers: SubscribeHandlers | null = null;
  let subscribed = 0;
  let shouldFail = false;
  const fetches: FetchRunEventsArgs[] = [];
  return {
    stored,
    fetches,
    subscribeCount: () => subscribed,
    fetchEvents: () => Promise.resolve([]),
    fetchRunEvents(args) {
      fetches.push(args);
      if (shouldFail) {
        shouldFail = false;
        return Promise.reject(new Error("fetch failed"));
      }
      return Promise.resolve(
        stored
          .filter((row) => row.run_id === args.runId && row.seq > args.afterSeq)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, args.limit),
      );
    },
    subscribe(_workspaceId, next) {
      handlers = next;
      subscribed += 1;
      return () => {
        if (handlers === next) handlers = null;
      };
    },
    push(row) {
      handlers?.onRow(row);
    },
    setStatus(status) {
      handlers?.onStatus(status);
    },
    failNextFetch() {
      shouldFail = true;
    },
  };
}
