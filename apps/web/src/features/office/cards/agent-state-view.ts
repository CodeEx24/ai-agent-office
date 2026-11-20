import { AGENT_OFFICE_STATES, type AgentOfficeStateName } from "@ago/shared/office";

/** The shape each state is drawn with. Color is never the only signal: every state has its own shape and label. */
export type AgentStateShape = "circle-dash" | "gear" | "bubble" | "link" | "bell" | "triangle";

export type AgentStateTone = "neutral" | "active" | "info" | "alert" | "caution";

export interface AgentStateView {
  /** The visible text label (always shown next to the icon). */
  readonly label: string;
  /** One sentence for the card and assistive technology. */
  readonly description: string;
  readonly shape: AgentStateShape;
  readonly tone: AgentStateTone;
}

/** Exhaustive over the six states (AGO-124): a new state fails to compile until it has a view. */
export const AGENT_STATE_VIEWS = {
  idle: {
    label: "Idle",
    description: "Not working on anything right now.",
    shape: "circle-dash",
    tone: "neutral",
  },
  working: {
    label: "Working",
    description: "Running a tool or a step.",
    shape: "gear",
    tone: "active",
  },
  thinking: {
    label: "Thinking",
    description: "Planning its next step.",
    shape: "bubble",
    tone: "info",
  },
  collaborating: {
    label: "Collaborating",
    description: "Handing work to or from another agent.",
    shape: "link",
    tone: "info",
  },
  waiting_on_you: {
    label: "Waiting on you",
    description: "Needs your approval before it can continue.",
    shape: "bell",
    tone: "alert",
  },
  error_or_paused: {
    label: "Error or paused",
    description: "Stopped by an error or paused by a person.",
    shape: "triangle",
    tone: "caution",
  },
} as const satisfies Record<AgentOfficeStateName, AgentStateView>;

export function getAgentStateView(state: AgentOfficeStateName): AgentStateView {
  return AGENT_STATE_VIEWS[state];
}

/** The order the six are listed in wherever they appear together (a legend, a filter). */
export const AGENT_STATE_ORDER: readonly AgentOfficeStateName[] = AGENT_OFFICE_STATES;
