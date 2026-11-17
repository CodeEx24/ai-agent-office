import type { RunEvent, RunEventType } from "../events/run-events.js";
import type { RunChannels } from "./office-state.js";

/**
 * The effect of every run event type on office state (AGO-124, AC1).
 *
 * An effect turns an event payload into a patch of run-view channels. A channel is overwritten by the
 * last event that writes it, and an effect reads ONLY its own payload (never the current state), so a
 * channel depends on its last event alone. That rule is what makes windows and snapshots exact.
 *
 * The table is a mapped type over `RunEventType`: when an event type is added to `RUN_EVENT_SCHEMAS`
 * this file stops compiling until the new type has an effect (use `NO_EFFECT` for "informational").
 * Agent text (`message`, `summary`) is copied as data only and never interpreted.
 */
export type ChannelPatch = Partial<RunChannels>;
type PayloadOf<T extends RunEventType> = Extract<RunEvent, { type: T }>["payload"];
export type OfficeEventEffect<T extends RunEventType> = (payload: PayloadOf<T>) => ChannelPatch;

/** Informational events: they advance the run's `last_seq` but change no channel. */
const NO_EFFECT = (): ChannelPatch => ({});

/** Channels a run that ended no longer needs (nothing is in flight, waiting or being handed off). */
const ENDED: ChannelPatch = { tool: null, approval: null, handoff: null };

export const OFFICE_EVENT_EFFECTS: { readonly [T in RunEventType]: OfficeEventEffect<T> } = {
  // Run lifecycle
  "run.created": () => ({ phase: { value: "queued", detail: null } }),
  "run.started": () => ({ phase: { value: "active", detail: null } }),
  "run.completed": () => ({ phase: { value: "completed", detail: null }, ...ENDED }),
  "run.failed": (p) => ({
    phase: { value: "failed", detail: p.reason },
    error: { code: p.reason, message: p.message, retryable: false },
    ...ENDED,
  }),
  "run.paused": (p) => ({ phase: { value: "paused", detail: p.reason } }),
  // A human (or a timeout that only produces a denial) resumes; an agent never resumes itself.
  "run.resumed": () => ({ phase: { value: "active", detail: null }, error: null }),
  // A retry picked the run up from its checkpoint: whatever was in flight is gone.
  "run.recovered": (p) => ({
    phase: { value: "active", detail: null },
    step: p.step >= 1 ? p.step : null,
    tool: null,
    error: null,
  }),
  "run.stopped": (p) => ({ phase: { value: "stopped", detail: p.reason }, ...ENDED }),
  // The run is about to stop (a later `run.stopped` / `run.failed` decides the phase): show why.
  "run.limit_reached": (p) => ({
    error: {
      code: `limit_${p.limit}`,
      message: `${p.limit} limit: ${String(p.observed)} of ${String(p.max)}`,
      retryable: false,
    },
  }),
  "run.loop_detected": (p) => ({
    error: {
      code: "loop_detected",
      message: `${p.tool_name} repeated ${String(p.repeat_count)} times`,
      retryable: false,
    },
  }),
  "context.cut": NO_EFFECT,
  // Steps
  "step.started": (p) => ({ step: p.step, handoff: null }),
  "step.completed": NO_EFFECT,
  // Tool calls: one call is in flight per run at a time
  "tool_call.requested": (p) => ({
    tool: { call_id: p.call_id, tool_name: p.tool_name },
    handoff: null,
  }),
  "tool_call.started": NO_EFFECT,
  "tool_call.completed": () => ({ tool: null }),
  "tool_call.failed": () => ({ tool: null }),
  // A denied call never runs; an allowed or approval-needing one is shown by the events that follow.
  "policy.decision": (p) => (p.decision === "deny" ? { tool: null } : {}),
  // Approvals (only a human decides; the office only displays the request)
  "approval.requested": (p) => ({
    approval: {
      approval_id: p.approval_id,
      call_id: p.call_id,
      tier: p.tier,
      expires_at: p.expires_at,
    },
  }),
  // Denied and expired (timeout means deny) cancel the waiting call; approved lets it proceed.
  "approval.decided": (p) =>
    p.outcome === "approved" ? { approval: null } : { approval: null, tool: null },
  // Budget
  "budget.usage": NO_EFFECT,
  "budget.exceeded": (p) => ({
    error: {
      code: `budget_${p.reason}`,
      message: `${p.scope} budget: used ${String(p.used)} of ${String(p.limit)}`,
      retryable: false,
    },
  }),
  // Handoffs
  "handoff.created": (p) => ({
    handoff: {
      handoff_id: p.handoff_id,
      to_agent_id: p.to_agent_id,
      by_agent_id: null,
      accepted: false,
    },
  }),
  "handoff.accepted": (p) => ({
    handoff: {
      handoff_id: p.handoff_id,
      to_agent_id: null,
      by_agent_id: p.by_agent_id,
      accepted: true,
    },
  }),
  // Errors and agent output (data only)
  "error.raised": (p) => ({ error: { code: p.code, message: p.message, retryable: p.retryable } }),
  "message.emitted": (p) => ({ message: { role: p.role, summary: p.summary } }),
};

/** The patch one validated event applies to its run view. */
export function effectOfEvent(event: RunEvent): ChannelPatch {
  const effect = OFFICE_EVENT_EFFECTS[event.type] as unknown as (payload: unknown) => ChannelPatch;
  return effect(event.payload);
}
