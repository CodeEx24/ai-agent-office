import { parseStoredRunEvent, type RunEvent } from "@ago/shared/run-events";

/**
 * The run view's log (AGO-153): a pure fold of one run's stored `run_events` rows.
 *
 * Two layers:
 *  - `RunLogState` holds the raw rows, deduplicated by `seq`. `applyRunRows` never throws and ignores a row that is
 *    malformed, of another run or workspace, or already held.
 *  - `buildRunLog` derives what the screen shows from the **contiguous** rows only (seq 1, 2, 3 with no hole).
 *    A row that arrives ahead of a missing one is kept but not shown until the hole is filled, so the log never
 *    displays events out of order or with a silent gap. `contiguousSeq` is what a catch-up continues from.
 *
 * Cost and tokens are the sum of the stored `budget.usage` events: the worker writes one right after it settles
 * each model call against the AGO-40 ledger, with the settled `cost_cents`. Nothing is estimated here.
 * Agent and tool text is untrusted data; this file only carries it, the components render it as plain text.
 * Tool call hashes are never carried into the view (they are not content).
 */

export interface RunEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly created_at: string;
}

export interface RunLogState {
  readonly workspaceId: string;
  readonly runId: string;
  readonly rows: ReadonlyMap<number, RunEventRow>;
  /** Highest `seq` such that every seq from 1 up to it is held. 0 when the run has no events yet. */
  readonly contiguousSeq: number;
  /** Highest `seq` seen at all (may be ahead of `contiguousSeq` while a hole is being filled). */
  readonly highestSeq: number;
  /** Rows dropped as malformed or foreign (a health signal, not shown as events). */
  readonly rejected: number;
}

export function createRunLogState(workspaceId: string, runId: string): RunLogState {
  return { workspaceId, runId, rows: new Map(), contiguousSeq: 0, highestSeq: 0, rejected: 0 };
}

function isRow(value: unknown): value is RunEventRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.workspace_id === "string" &&
    typeof row.run_id === "string" &&
    typeof row.seq === "number" &&
    Number.isInteger(row.seq) &&
    row.seq > 0 &&
    typeof row.type === "string" &&
    typeof row.created_at === "string" &&
    !Number.isNaN(Date.parse(row.created_at))
  );
}

/** Add rows (any order, duplicates allowed). Returns the same state object when nothing changed. */
export function applyRunRows(state: RunLogState, input: readonly unknown[]): RunLogState {
  let rows: Map<number, RunEventRow> | null = null;
  let rejected = state.rejected;
  for (const value of input) {
    if (!isRow(value) || value.run_id !== state.runId || value.workspace_id !== state.workspaceId) {
      rejected += 1;
      continue;
    }
    if ((rows ?? state.rows).has(value.seq)) continue;
    rows ??= new Map(state.rows);
    rows.set(value.seq, {
      id: value.id,
      workspace_id: value.workspace_id,
      run_id: value.run_id,
      seq: value.seq,
      type: value.type,
      payload: value.payload,
      created_at: value.created_at,
    });
  }
  if (rows === null) return rejected === state.rejected ? state : { ...state, rejected };
  let contiguousSeq = state.contiguousSeq;
  while (rows.has(contiguousSeq + 1)) contiguousSeq += 1;
  let highestSeq = state.highestSeq;
  for (const seq of rows.keys()) if (seq > highestSeq) highestSeq = seq;
  return { ...state, rows, contiguousSeq, highestSeq, rejected };
}

export type RunPhase = "queued" | "running" | "paused" | "completed" | "failed" | "stopped";

export type EntryTone = "neutral" | "good" | "warn" | "bad";

export interface TimelineEntry {
  readonly seq: number;
  readonly at: string;
  readonly label: string;
  /** Untrusted agent or system text; render as plain text only. */
  readonly detail: string | null;
  readonly tone: EntryTone;
}

export type ToolCallStatus =
  "requested" | "running" | "completed" | "failed" | "denied" | "awaiting_approval";

export interface ToolCallView {
  readonly callId: string;
  readonly seq: number;
  readonly toolName: string;
  readonly tier: number;
  readonly status: ToolCallStatus;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  /** Untrusted. */
  readonly errorMessage: string | null;
  readonly policy: { readonly decision: string; readonly reasonCode: string } | null;
}

export interface StepView {
  readonly step: number;
  readonly startedAt: string;
  readonly outcome: "ok" | "error" | null;
}

export interface UsageView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Millionths of a dollar; null when no usage event reported a cost. */
  readonly costMicros: number | null;
  readonly calls: number;
  readonly callsWithoutCost: number;
}

export interface BudgetStopView {
  readonly scope: string;
  readonly reason: string;
  readonly limit: number;
  readonly used: number;
}

export interface RunLogView {
  readonly phase: RunPhase | null;
  readonly phaseDetail: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** When the current pause began (only while `phase` is `paused`). */
  readonly pausedAt: string | null;
  readonly steps: readonly StepView[];
  readonly toolCalls: readonly ToolCallView[];
  readonly usage: UsageView;
  readonly budgetStop: BudgetStopView | null;
  readonly failure: { readonly reason: string; readonly message: string } | null;
  readonly timeline: readonly TimelineEntry[];
  readonly shownEvents: number;
  /** A row was seen ahead of a hole; the view waits for the missing rows. */
  readonly isCatchingUp: boolean;
  readonly unrecognised: number;
}

const MICROS_PER_CENT = 10_000;

/** A usage event's cost in micros: `cost_micros` when present, else `cost_cents` converted. */
function costMicrosOf(payload: { cost_micros?: number; cost_cents?: number }): number | null {
  if (payload.cost_micros !== undefined) return payload.cost_micros;
  if (payload.cost_cents !== undefined) return payload.cost_cents * MICROS_PER_CENT;
  return null;
}

function readable(code: string): string {
  return code.replaceAll("_", " ").replaceAll(".", " ");
}

type Described = Omit<TimelineEntry, "seq" | "at">;

function describe(event: RunEvent): Described | null {
  switch (event.type) {
    case "run.created":
      return { label: "Run queued", detail: null, tone: "neutral" };
    case "run.started":
      return { label: "Run started", detail: null, tone: "neutral" };
    case "run.completed":
      return {
        label: `Run completed after ${String(event.payload.steps)} steps`,
        detail: event.payload.summary ?? null,
        tone: "good",
      };
    case "run.failed":
      return {
        label: `Run failed: ${readable(event.payload.reason)}`,
        detail: event.payload.message,
        tone: "bad",
      };
    case "run.paused":
      return {
        label: `Run paused (${readable(event.payload.reason)})`,
        detail: null,
        tone: "warn",
      };
    case "run.resumed":
      return { label: "Run resumed", detail: null, tone: "neutral" };
    case "run.recovered":
      return {
        label: `Run recovered from a checkpoint at step ${String(event.payload.step)}`,
        detail: null,
        tone: "warn",
      };
    case "run.stopped":
      return {
        label: `Run stopped (${readable(event.payload.reason)})`,
        detail: null,
        tone: "warn",
      };
    case "run.limit_reached":
      return {
        label: `Limit reached: ${event.payload.limit} (${String(event.payload.observed)} of ${String(event.payload.max)})`,
        detail: null,
        tone: "warn",
      };
    case "run.loop_detected":
      return {
        label: `Loop detected on ${event.payload.tool_name} (${String(event.payload.repeat_count)} repeats)`,
        detail: null,
        tone: "warn",
      };
    case "context.cut":
      return {
        label: `Context ${event.payload.action}: ${readable(event.payload.section)}`,
        detail: null,
        tone: "neutral",
      };
    case "step.started":
      return { label: `Step ${String(event.payload.step)} started`, detail: null, tone: "neutral" };
    case "step.completed":
      return {
        label: `Step ${String(event.payload.step)} ${event.payload.outcome === "ok" ? "completed" : "failed"}`,
        detail: null,
        tone: event.payload.outcome === "ok" ? "good" : "bad",
      };
    case "tool_call.requested":
      return {
        label: `Tool requested: ${event.payload.tool_name} (tier ${String(event.payload.tier)})`,
        detail: null,
        tone: "neutral",
      };
    case "tool_call.started":
      return { label: "Tool running", detail: null, tone: "neutral" };
    case "tool_call.completed":
      return {
        label: `Tool completed in ${String(event.payload.duration_ms)} ms`,
        detail: null,
        tone: "good",
      };
    case "tool_call.failed":
      return {
        label: `Tool failed: ${event.payload.error_code}`,
        detail: event.payload.message,
        tone: "bad",
      };
    case "policy.decision":
      return {
        label: `Policy: ${readable(event.payload.decision)} (${event.payload.reason_code})`,
        detail: null,
        tone: event.payload.decision === "deny" ? "bad" : "neutral",
      };
    case "approval.requested":
      return { label: "Approval requested", detail: null, tone: "warn" };
    case "approval.decided":
      return {
        label: `Approval ${event.payload.outcome}`,
        detail: null,
        tone: event.payload.outcome === "approved" ? "good" : "warn",
      };
    case "budget.usage":
      return {
        label: `Model call: ${String(event.payload.input_tokens)} in, ${String(event.payload.output_tokens)} out`,
        detail: null,
        tone: "neutral",
      };
    case "budget.exceeded":
      return {
        label: `Budget stop (${readable(event.payload.scope)}): ${readable(event.payload.reason)}`,
        detail: null,
        tone: "bad",
      };
    case "handoff.created":
      return { label: "Handoff created", detail: event.payload.reason, tone: "neutral" };
    case "handoff.accepted":
      return { label: "Handoff accepted", detail: null, tone: "neutral" };
    case "error.raised":
      return {
        label: `Error: ${event.payload.code}${event.payload.retryable ? " (will retry)" : ""}`,
        detail: event.payload.message,
        tone: "bad",
      };
    case "message.emitted":
      return {
        label: event.payload.role === "agent" ? "Agent message" : "System message",
        detail: event.payload.summary,
        tone: "neutral",
      };
    default:
      return null;
  }
}

/** Derive the screen's data from the contiguous rows. Pure. */
export function buildRunLog(state: RunLogState): RunLogView {
  let phase: RunPhase | null = null;
  let phaseDetail: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let pausedAt: string | null = null;
  const steps = new Map<number, StepView>();
  const calls = new Map<string, ToolCallView>();
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros: number | null = null;
  let usageCalls = 0;
  let callsWithoutCost = 0;
  let budgetStop: BudgetStopView | null = null;
  let failure: RunLogView["failure"] = null;
  const timeline: TimelineEntry[] = [];
  let unrecognised = 0;

  const patchCall = (callId: string, patch: Partial<ToolCallView>, seq: number): void => {
    const current: ToolCallView = calls.get(callId) ?? {
      callId,
      seq,
      toolName: "unknown tool",
      tier: 0,
      status: "requested",
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      policy: null,
    };
    calls.set(callId, { ...current, ...patch });
  };

  for (let seq = 1; seq <= state.contiguousSeq; seq += 1) {
    const row = state.rows.get(seq);
    if (row === undefined) break;
    const event = parseStoredRunEvent({ type: row.type, payload: row.payload });
    if (event === null) {
      unrecognised += 1;
      timeline.push({
        seq,
        at: row.created_at,
        label: `Unrecognised event (${row.type.slice(0, 60)})`,
        detail: null,
        tone: "warn",
      });
      continue;
    }
    const entry = describe(event);
    if (entry !== null) timeline.push({ seq, at: row.created_at, ...entry });

    switch (event.type) {
      case "run.created":
        phase = "queued";
        break;
      case "run.started":
        phase = "running";
        phaseDetail = null;
        startedAt ??= row.created_at;
        break;
      case "run.resumed":
      case "run.recovered":
        phase = "running";
        phaseDetail = null;
        pausedAt = null;
        break;
      case "run.paused":
        phase = "paused";
        phaseDetail = event.payload.reason;
        pausedAt = row.created_at;
        break;
      case "run.completed":
        phase = "completed";
        endedAt = row.created_at;
        break;
      case "run.failed":
        phase = "failed";
        phaseDetail = event.payload.reason;
        endedAt = row.created_at;
        failure = { reason: event.payload.reason, message: event.payload.message };
        break;
      case "run.stopped":
        phase = "stopped";
        phaseDetail = event.payload.reason;
        endedAt = row.created_at;
        break;
      case "step.started":
        steps.set(event.payload.step, {
          step: event.payload.step,
          startedAt: row.created_at,
          outcome: steps.get(event.payload.step)?.outcome ?? null,
        });
        break;
      case "step.completed": {
        const previous = steps.get(event.payload.step);
        steps.set(event.payload.step, {
          step: event.payload.step,
          startedAt: previous?.startedAt ?? row.created_at,
          outcome: event.payload.outcome,
        });
        break;
      }
      case "tool_call.requested":
        patchCall(
          event.payload.call_id,
          { toolName: event.payload.tool_name, tier: event.payload.tier, status: "requested" },
          seq,
        );
        break;
      case "tool_call.started":
        patchCall(event.payload.call_id, { status: "running" }, seq);
        break;
      case "tool_call.completed":
        patchCall(
          event.payload.call_id,
          { status: "completed", durationMs: event.payload.duration_ms },
          seq,
        );
        break;
      case "tool_call.failed":
        patchCall(
          event.payload.call_id,
          {
            status: "failed",
            errorCode: event.payload.error_code,
            errorMessage: event.payload.message,
          },
          seq,
        );
        break;
      case "policy.decision": {
        const decision = event.payload.decision;
        patchCall(
          event.payload.call_id,
          {
            policy: { decision, reasonCode: event.payload.reason_code },
            ...(decision === "deny" ? { status: "denied" as const } : {}),
            ...(decision === "needs_approval" ? { status: "awaiting_approval" as const } : {}),
          },
          seq,
        );
        break;
      }
      case "budget.usage": {
        usageCalls += 1;
        inputTokens += event.payload.input_tokens;
        outputTokens += event.payload.output_tokens;
        const micros = costMicrosOf(event.payload);
        if (micros === null) callsWithoutCost += 1;
        else costMicros = (costMicros ?? 0) + micros;
        break;
      }
      case "budget.exceeded":
        budgetStop = {
          scope: event.payload.scope,
          reason: event.payload.reason,
          limit: event.payload.limit,
          used: event.payload.used,
        };
        break;
      default:
        break;
    }
  }

  return {
    phase,
    phaseDetail,
    startedAt,
    endedAt,
    pausedAt,
    steps: [...steps.values()].sort((a, b) => a.step - b.step),
    toolCalls: [...calls.values()].sort((a, b) => a.seq - b.seq),
    usage: { inputTokens, outputTokens, costMicros, calls: usageCalls, callsWithoutCost },
    budgetStop,
    failure,
    timeline,
    shownEvents: state.contiguousSeq,
    isCatchingUp: state.highestSeq > state.contiguousSeq,
    unrecognised,
  };
}
