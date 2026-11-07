/**
 * Agent wizard limits, model allowlist and field checks (AGO-141). Free of runtime imports (no zod) so the
 * client wizard can import it without pulling zod, whose JIT feature detection needs `unsafe-eval`, into the
 * browser bundle (same reason as `skill-limits.ts`, AGO-128). The server validates with the zod schemas in
 * `agent-schemas.ts`, which reuse every constant and message here; a test keeps the two in step.
 */

export const AGENT_NAME_MAX_LENGTH = 120;
export const AGENT_ROLE_MAX_LENGTH = 120;
export const AGENT_PROMPT_MAX_LENGTH = 20_000;

/**
 * Daily budget, in US cents. The default is deliberately small. There is no per-workspace cap row yet, so the
 * platform cap below is the ceiling; a budget above it is refused, never silently lowered.
 */
export const AGENT_DAILY_BUDGET_DEFAULT_CENTS = 500;
export const AGENT_DAILY_BUDGET_MAX_CENTS = 5_000;

/**
 * Models an owner can pick. A small static list: no API call, and no model is preselected, so the wizard
 * never makes a paid choice for the user.
 */
export const AGENT_MODELS = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, lowest cost)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable, highest cost)" },
] as const;
export type AgentModelId = (typeof AGENT_MODELS)[number]["id"];
export const AGENT_MODEL_IDS = AGENT_MODELS.map((model) => model.id) as [
  AgentModelId,
  ...AgentModelId[],
];

/** Where an agent starts. Always the lowest autonomy: the wizard has no way to pick another. */
export const NEW_AGENT_MODE = "strict";

/** The wizard fields, in step order. Error messages are keyed by these names. */
export const AGENT_FIELDS = [
  "name",
  "role",
  "model",
  "prompt",
  "skillIds",
  "capabilities",
  "dailyBudget",
] as const;
export type AgentField = (typeof AGENT_FIELDS)[number];

export const AGENT_FIELD_LABELS: Record<AgentField, string> = {
  name: "Name",
  role: "Role",
  model: "Model",
  prompt: "Prompt",
  skillIds: "Skills",
  capabilities: "Capabilities",
  dailyBudget: "Daily budget",
};

/** One message per rule. Each names the field, so the error is clear even away from its input. */
export const AGENT_MESSAGES = {
  nameRequired: "Name is required. Give the agent a name.",
  nameTooLong: `Name can be at most ${String(AGENT_NAME_MAX_LENGTH)} characters.`,
  roleRequired: "Role is required. Say what the agent does, for example Researcher.",
  roleTooLong: `Role can be at most ${String(AGENT_ROLE_MAX_LENGTH)} characters.`,
  modelRequired: "Model is required. Choose one from the list.",
  modelUnknown: "Model is not one of the available models. Choose one from the list.",
  promptRequired: "Prompt is required. Tell the agent how to behave.",
  promptTooLong: `Prompt can be at most ${AGENT_PROMPT_MAX_LENGTH.toLocaleString("en-US")} characters.`,
  budgetRequired: "Daily budget is required. Enter an amount in dollars, for example 5.00.",
  budgetInvalid:
    "Daily budget must be a number of dollars with at most two decimals, for example 5.00.",
  budgetNotPositive: "Daily budget must be more than $0.",
  budgetTooHigh: `Daily budget can be at most $${(AGENT_DAILY_BUDGET_MAX_CENTS / 100).toFixed(2)}.`,
  capabilityApproval:
    "Capabilities: a Tier 3 or 4 capability always needs a person's approval; it cannot run automatically.",
} as const;

/** Normalises text the way the server does: CRLF (browser textareas) to LF, then trims. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export function isAgentModelId(value: string): value is AgentModelId {
  return AGENT_MODELS.some((model) => model.id === value);
}

export type DailyBudgetParse = { ok: true; cents: number } | { ok: false; message: string };

/** "5", "5.5" or "5.50" (dollars) to whole cents. Nothing else is accepted, so no float rounding is involved. */
export function parseDailyBudget(text: string): DailyBudgetParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: AGENT_MESSAGES.budgetRequired };
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return { ok: false, message: AGENT_MESSAGES.budgetInvalid };
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (cents <= 0) return { ok: false, message: AGENT_MESSAGES.budgetNotPositive };
  if (cents > AGENT_DAILY_BUDGET_MAX_CENTS) {
    return { ok: false, message: AGENT_MESSAGES.budgetTooHigh };
  }
  return { ok: true, cents };
}

export type AgentFieldErrors = Partial<Record<AgentField, string>>;

/** The text fields of a draft, as typed. Skills and capabilities are checked on the server and by the DB. */
export interface AgentDraftText {
  name: string;
  role: string;
  model: string;
  prompt: string;
  dailyBudget: string;
}

/** Zod-free field checks for the client. Returns a message per invalid field; empty means valid. */
export function checkAgentDraft(draft: AgentDraftText): AgentFieldErrors {
  const errors: AgentFieldErrors = {};
  const name = normalizeText(draft.name);
  if (name === "") errors.name = AGENT_MESSAGES.nameRequired;
  else if (name.length > AGENT_NAME_MAX_LENGTH) errors.name = AGENT_MESSAGES.nameTooLong;

  const role = normalizeText(draft.role);
  if (role === "") errors.role = AGENT_MESSAGES.roleRequired;
  else if (role.length > AGENT_ROLE_MAX_LENGTH) errors.role = AGENT_MESSAGES.roleTooLong;

  if (draft.model === "") errors.model = AGENT_MESSAGES.modelRequired;
  else if (!isAgentModelId(draft.model)) errors.model = AGENT_MESSAGES.modelUnknown;

  const prompt = normalizeText(draft.prompt);
  if (prompt === "") errors.prompt = AGENT_MESSAGES.promptRequired;
  else if (prompt.length > AGENT_PROMPT_MAX_LENGTH) errors.prompt = AGENT_MESSAGES.promptTooLong;

  const budget = parseDailyBudget(draft.dailyBudget);
  if (!budget.ok) errors.dailyBudget = budget.message;
  return errors;
}

/** The wizard steps in order, with the fields each one owns (used to focus the first invalid field). */
export const AGENT_WIZARD_STEPS = [
  { id: "basics", title: "Basics", fields: ["name", "role", "model", "prompt"] },
  { id: "skills", title: "Skills", fields: ["skillIds"] },
  { id: "capabilities", title: "Capabilities", fields: ["capabilities"] },
  { id: "budget", title: "Budget", fields: ["dailyBudget"] },
  { id: "review", title: "Review", fields: [] },
] as const satisfies readonly { id: string; title: string; fields: readonly AgentField[] }[];
