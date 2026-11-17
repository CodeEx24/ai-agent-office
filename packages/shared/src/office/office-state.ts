import { z } from "zod";

import { officeCursorSchema } from "./office-event-record.js";

/** Version of the serialized office state (a persisted snapshot with another version must be rebuilt). */
export const OFFICE_STATE_VERSION = 1 as const;

/** The six agent states shown on the office floor and on agent cards (AGO-150). */
export const AGENT_OFFICE_STATES = [
  "idle",
  "working",
  "thinking",
  "collaborating",
  "waiting_on_you",
  "error_or_paused",
] as const;
export const agentOfficeStateSchema = z.enum(AGENT_OFFICE_STATES);
export type AgentOfficeStateName = z.infer<typeof agentOfficeStateSchema>;

export const RUN_PHASES = ["queued", "active", "paused", "stopped", "failed", "completed"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
/** Phases a run never leaves (a later run of the same agent is a different run). */
export const TERMINAL_RUN_PHASES: readonly RunPhase[] = ["stopped", "failed", "completed"];

const id = z.string().min(1).max(128);
const uuid = z.uuid();
const code = z.string().min(1).max(100);

/**
 * Agent-supplied or error text. It is carried as DATA only: the reducer never interprets it, and
 * every consumer must render it as plain text (never as markup, a command or a prompt).
 */
const untrustedText = z.string().max(2_000);

/**
 * A run view is a set of independent channels. Each channel holds the value written by the LAST event
 * that writes it (and `null` when that event cleared it or no event wrote it yet), so a channel
 * depends on nothing but its own last event. That is what makes a window of the last N events exact
 * for every channel whose last event is inside the window.
 */
export const runViewSchema = z.object({
  run_id: uuid,
  agent_id: uuid,
  /** Highest `seq` applied. Duplicates (<=) are ignored; a larger jump is a gap. */
  last_seq: z.number().int().positive(),
  /** `created_at` of the event with `last_seq`. */
  last_event_at: z.iso.datetime({ offset: true }),
  /** True when the run was first seen mid-stream (a window); channels last written earlier are unknown. */
  partial: z.boolean(),
  phase: z.object({ value: z.enum(RUN_PHASES), detail: code.nullable() }).nullable(),
  tool: z.object({ call_id: id, tool_name: id }).nullable(),
  approval: z
    .object({
      approval_id: id,
      call_id: id,
      tier: z.number().int().min(0).max(4),
      expires_at: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  handoff: z
    .object({
      handoff_id: id,
      to_agent_id: uuid.nullable(),
      by_agent_id: uuid.nullable(),
      accepted: z.boolean(),
    })
    .nullable(),
  step: z.number().int().min(1).nullable(),
  error: z.object({ code, message: untrustedText, retryable: z.boolean().nullable() }).nullable(),
  message: z.object({ role: z.enum(["agent", "system"]), summary: untrustedText }).nullable(),
});
export type RunView = z.infer<typeof runViewSchema>;

/** The channels of a run view (every key of a run view except identity and bookkeeping). */
export type RunChannels = Omit<
  RunView,
  "run_id" | "agent_id" | "last_seq" | "last_event_at" | "partial"
>;
export type RunChannelName = keyof RunChannels;
export const RUN_CHANNEL_NAMES = [
  "phase",
  "tool",
  "approval",
  "handoff",
  "step",
  "error",
  "message",
] as const satisfies readonly RunChannelName[];

/** A run whose next rows were missed: fetch the run's events with `seq > after_seq`, then apply them. */
export const officeGapSchema = z.object({
  after_seq: z.number().int().nonnegative(),
  seen_seq: z.number().int().positive(),
});
export type OfficeGap = z.infer<typeof officeGapSchema>;

export const officeStateSchema = z.object({
  version: z.literal(OFFICE_STATE_VERSION),
  workspace_id: uuid,
  /** Last row applied, in feed order; null for an empty office. */
  cursor: officeCursorSchema.nullable(),
  runs: z.record(uuid, runViewSchema),
  /** Runs with missed rows, by run id. Empty when the state is complete up to the cursor. */
  gaps: z.record(uuid, officeGapSchema),
  /** Rows that did not change state, counted so a problem is visible. */
  anomalies: z.object({
    /** Unknown event type or version (a newer worker than this reader). */
    unsupported: z.number().int().nonnegative(),
    /** A row whose envelope or payload does not validate, or contradicts the run's agent. */
    invalid: z.number().int().nonnegative(),
    /** A row of another workspace (never applied). */
    foreign: z.number().int().nonnegative(),
  }),
});
export type OfficeState = z.infer<typeof officeStateSchema>;

/** An empty office for one workspace. */
export function createOfficeState(workspaceId: string): OfficeState {
  return {
    version: OFFICE_STATE_VERSION,
    workspace_id: workspaceId,
    cursor: null,
    runs: {},
    gaps: {},
    anomalies: { unsupported: 0, invalid: 0, foreign: 0 },
  };
}

/** Validate a persisted snapshot; null when it is not a valid state of this version (then rebuild). */
export function parseOfficeState(value: unknown): OfficeState | null {
  const parsed = officeStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What an agent card shows. Derived from the runs by `selectAgentStates`; not stored. */
export interface AgentOfficeState {
  readonly agent_id: string;
  readonly state: AgentOfficeStateName;
  /** Why (a reason code such as `user_pause`), or null. */
  readonly detail: string | null;
  /** The run that decides the state, or null for an idle agent with no run. */
  readonly run_id: string | null;
  /** Set when `waiting_on_you`: the approval the card opens. */
  readonly approval_id: string | null;
}
