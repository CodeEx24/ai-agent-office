import { z } from "zod";

/**
 * Typed run events (AGO-164, v1).
 *
 * The Master List event table was not found in the repo, Jira or Confluence, so this file is the
 * v1 source of truth for event types (decision recorded in docs/tickets/AGO-164.md). To amend the
 * list, add or edit ONE entry in `RUN_EVENT_SCHEMAS` below; the union, type list and tests follow.
 *
 * Storage mapping (public.run_events): `type` column = `type`; `payload` column = `{ version, ...payload }`.
 * `workspace_id`, `run_id` and the per-run `seq` are NOT part of an event: the emitter binds the
 * first two and the database assigns `seq` (AGO-102).
 *
 * Safety rules baked into the schemas: every payload is `.strict()` (unknown keys are rejected, so
 * a stray `api_key` field cannot ride along), tool inputs/outputs travel as hashes never as raw
 * values, and free text is length-bounded.
 */
export const RUN_EVENT_VERSION = 1 as const;

const MAX_TEXT = 2_000;
const id = z.string().min(1).max(128);
const uuid = z.uuid();
const text = z.string().max(MAX_TEXT);
const shortText = z.string().max(500);
const code = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase sha256 hex digest");
const count = z.number().int().nonnegative();
const tier = z.number().int().min(0).max(4);
const actor = z.enum(["human", "policy", "budget", "system"]);
const isoTime = z.iso.datetime({ offset: true });

function event<T extends string, P extends z.ZodRawShape>(type: T, payload: P) {
  return z.object({
    type: z.literal(type),
    version: z.literal(RUN_EVENT_VERSION),
    payload: z.object(payload).strict(),
  });
}

/** Every event type, grouped as in the epics: lifecycle, steps, tools, policy, approvals, budget, handoffs, errors. */
export const RUN_EVENT_SCHEMAS = [
  // Run lifecycle
  event("run.created", { agent_id: uuid, task_id: uuid.nullable() }),
  event("run.started", {}),
  event("run.completed", { steps: count, summary: shortText.optional() }),
  event("run.failed", { reason: code, message: shortText }),
  event("run.paused", { requested_by: actor, reason: code }),
  // Humans resume; an agent can never resume itself (human in the loop).
  event("run.resumed", { resumed_by: z.literal("human") }),
  event("run.stopped", { stopped_by: actor, reason: code }),
  event("run.limit_reached", {
    limit: z.enum(["steps", "tokens", "time"]),
    max: count,
    observed: count,
  }),
  event("run.loop_detected", {
    tool_name: id,
    call_hash: sha256,
    repeat_count: z.number().int().min(2),
  }),
  // Context (AGO-167): counts and source labels only, never the cut text
  event("context.cut", {
    section: z.enum(["task", "skills", "vault_map", "retrieved", "tool_result"]),
    source: shortText,
    action: z.enum(["dropped", "truncated"]),
    original_chars: count,
    kept_chars: count,
  }),
  // Steps
  event("step.started", { step: z.number().int().min(1) }),
  event("step.completed", { step: z.number().int().min(1), outcome: z.enum(["ok", "error"]) }),
  // Tool calls (inputs and outputs are hashes, never raw values)
  event("tool_call.requested", { call_id: id, tool_name: id, tier, input_hash: sha256 }),
  event("tool_call.started", { call_id: id }),
  event("tool_call.completed", { call_id: id, duration_ms: count, output_hash: sha256.optional() }),
  event("tool_call.failed", { call_id: id, error_code: code, message: shortText }),
  // Policy decision, taken before every tool call
  event("policy.decision", {
    call_id: id,
    decision: z.enum(["allow", "deny", "needs_approval"]),
    tier,
    reason_code: code,
    rule_id: id.optional(),
  }),
  // Approvals are bound to the payload hash of the call they cover
  event("approval.requested", {
    approval_id: id,
    call_id: id,
    payload_hash: sha256,
    tier,
    expires_at: isoTime,
  }),
  // `expired` is a DENY (timeout means deny). Only a human can approve or deny; only a timeout expires.
  event("approval.decided", {
    approval_id: id,
    outcome: z.enum(["approved", "denied", "expired"]),
    decided_by: z.enum(["human", "timeout"]),
    payload_hash: sha256,
  }),
  // Budget
  event("budget.usage", {
    input_tokens: count,
    output_tokens: count,
    cost_micros: count.optional(),
  }),
  event("budget.exceeded", {
    scope: z.enum(["run", "agent_daily", "workspace_monthly"]),
    limit: count,
    used: count,
  }),
  // Handoffs
  event("handoff.created", { handoff_id: id, to_agent_id: uuid, reason: shortText }),
  event("handoff.accepted", { handoff_id: id, by_agent_id: uuid }),
  // Errors and agent output
  event("error.raised", { code, message: shortText, retryable: z.boolean() }),
  event("message.emitted", { role: z.enum(["agent", "system"]), summary: text }),
] as const;

/** Discriminated union on `type`. Use this to validate any event before it is written. */
export const runEventSchema = z
  .discriminatedUnion("type", [...RUN_EVENT_SCHEMAS] as unknown as [
    (typeof RUN_EVENT_SCHEMAS)[number],
    ...(typeof RUN_EVENT_SCHEMAS)[number][],
  ])
  .superRefine((value, ctx) => {
    if (value.type !== "approval.decided") return;
    const { outcome, decided_by } = value.payload;
    const expected = outcome === "expired" ? "timeout" : "human";
    if (decided_by !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "decided_by"],
        message: `outcome "${outcome}" must be decided_by "${expected}"`,
      });
    }
  });

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];
type InputOf<E> = E extends RunEvent
  ? { readonly type: E["type"]; readonly payload: E["payload"] }
  : never;
/** What a caller passes to the emitter: type and payload; the emitter stamps the version. */
export type RunEventInput = InputOf<RunEvent>;

export const RUN_EVENT_TYPES = RUN_EVENT_SCHEMAS.map(
  (s) => s.shape.type.value,
) as readonly RunEventType[];

/** An approval counts as granted only when a human approved it. `expired` and `denied` are denials. */
export function isApprovalGranted(
  payload: Extract<RunEvent, { type: "approval.decided" }>["payload"],
): boolean {
  return payload.outcome === "approved";
}

/** The row columns an event maps to (the database adds workspace_id, run_id, seq, id, created_at). */
export function toRunEventColumns(event: RunEvent): {
  type: RunEventType;
  payload: Record<string, unknown>;
} {
  return { type: event.type, payload: { version: event.version, ...event.payload } };
}

const storedPayloadSchema = z.looseObject({ version: z.literal(RUN_EVENT_VERSION) });

/** Re-validate a stored row (type + payload columns) back into a typed event; null if it does not match. */
export function parseStoredRunEvent(row: { type: string; payload: unknown }): RunEvent | null {
  const stored = storedPayloadSchema.safeParse(row.payload);
  if (!stored.success) return null;
  const { version, ...payload } = stored.data;
  const parsed = runEventSchema.safeParse({ type: row.type, version, payload });
  return parsed.success ? parsed.data : null;
}
