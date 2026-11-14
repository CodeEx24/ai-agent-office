import {
  AGENT_DAILY_BUDGET_DEFAULT_CENTS,
  AGENT_DAILY_BUDGET_MAX_CENTS,
  type AgentModelId,
} from "../agents/agent-limits.js";

/**
 * Budgets and hard stops (AGO-40). Pure helpers and constants shared by the worker (enforcement) and, later, the web
 * app (display). No runtime imports beyond the agent limits, so the client can use it too.
 *
 * Money is counted in whole US cents. A call's cost is rounded UP, never down, so the ledger can only over-count.
 */

/**
 * The platform cap on a workspace's monthly spend, in US cents (owner decision, AGO-40 q3). A workspace that set no
 * monthly budget gets this value; an owner may lower it and can never raise it. Agents cannot change any budget.
 */
export const WORKSPACE_MONTHLY_BUDGET_CAP_CENTS = 100_000;

/** Price of one million tokens, in US cents. */
export interface ModelPrice {
  readonly inputCentsPerMillion: number;
  readonly outputCentsPerMillion: number;
}

/**
 * Price table for every model on the allowlist (`AGENT_MODELS`). The values are deliberately on the high side: a
 * stale low price would let a run overspend, a high one only stops it early. An owner reviews them when a
 * provider changes its prices; a test fails when a model joins the allowlist without a price.
 */
export const MODEL_PRICES: Readonly<Record<AgentModelId, ModelPrice>> = {
  "claude-haiku-5-5": { inputCentsPerMillion: 100, outputCentsPerMillion: 500 },
  "claude-sonnet-5-5": { inputCentsPerMillion: 300, outputCentsPerMillion: 1_500 },
  "claude-opus-5-5": { inputCentsPerMillion: 500, outputCentsPerMillion: 2_500 },
  "claude-fable-5-1": { inputCentsPerMillion: 1_500, outputCentsPerMillion: 7_500 },
};

/** The price of a model, or null when it is not in the table. Callers must DENY on null, never treat it as free. */
export function priceFor(model: string): ModelPrice | null {
  return Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model as AgentModelId] : null;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Cost of `usage` in whole cents, rounded up (a call that used any tokens costs at least 1 cent). Null: no price. */
export function costCents(model: string, usage: TokenUsage): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const microCents =
    Math.max(0, usage.inputTokens) * price.inputCentsPerMillion +
    Math.max(0, usage.outputTokens) * price.outputCentsPerMillion;
  return Math.ceil(microCents / 1_000_000);
}

/**
 * Units per token assumed when sizing a prompt before the call. The unit is UTF-8 BYTES, which tracks the real token
 * count far better than UTF-16 characters for CJK text and emoji. This is an ESTIMATE, not a proven upper bound: a
 * token can be as short as one byte (so the strict bound is bytes / 1), and the provider adds its own overhead. A call
 * that costs more than was held is settled at its real cost and recorded as `call_cost_overran_reservation`.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 3;

/** `characters` is the size of the request in UTF-8 bytes (see `utf8Length`). */
export function estimateInputTokens(characters: number): number {
  return Math.ceil(Math.max(0, characters) / ESTIMATE_CHARS_PER_TOKEN);
}

/** UTF-8 byte length of a string. Shared has no Node or DOM types, so it is counted by hand per code point. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The most a call can cost: the estimated prompt plus the whole output allowance. This is what is reserved before the
 * call; the real cost replaces it afterwards. Null: no price for the model.
 */
export function worstCaseCostCents(
  model: string,
  inputCharacters: number,
  maxOutputTokens: number,
): number | null {
  return costCents(model, {
    inputTokens: estimateInputTokens(inputCharacters),
    outputTokens: maxOutputTokens,
  });
}

/**
 * An agent's daily limit in cents. A value that is missing (an agent made before the wizard) gets the wizard default, so
 * there is always a limit; a value above the platform cap is pulled to it (the database also refuses one).
 */
export function effectiveDailyBudgetCents(stored: number | null | undefined): number {
  if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 1) {
    return AGENT_DAILY_BUDGET_DEFAULT_CENTS;
  }
  return Math.min(stored, AGENT_DAILY_BUDGET_MAX_CENTS);
}

/** A workspace's monthly limit in cents: the owner's setting when it is lower than the cap, otherwise the cap. */
export function effectiveMonthlyBudgetCents(ownerSetting: number | null | undefined): number {
  if (typeof ownerSetting !== "number" || !Number.isInteger(ownerSetting) || ownerSetting < 0) {
    return WORKSPACE_MONTHLY_BUDGET_CAP_CENTS;
  }
  return Math.min(ownerSetting, WORKSPACE_MONTHLY_BUDGET_CAP_CENTS);
}

/** Which budget an event is about. `pricing` and `ledger` are not limits: the check could not be made safely. */
export const BUDGET_SCOPES = [
  "run",
  "agent_daily",
  "workspace_monthly",
  "pricing",
  "ledger",
] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** Why a run was stopped or a call refused. Each one is a specific, human-readable reason code. */
export const BUDGET_STOP_REASONS = [
  "run_token_limit_reached",
  "agent_daily_limit_would_be_exceeded",
  "workspace_monthly_limit_would_be_exceeded",
  "model_not_priced",
  "budget_check_failed",
  "call_cost_overran_reservation",
  "call_outcome_unknown_charged",
] as const;
export type BudgetStopReason = (typeof BUDGET_STOP_REASONS)[number];

/** Plain-language text for each reason, for the run view and the docs. */
export const BUDGET_STOP_MESSAGES: Readonly<Record<BudgetStopReason, string>> = {
  run_token_limit_reached: "The run used its token budget, so the next model call was not made.",
  agent_daily_limit_would_be_exceeded:
    "The next model call could have taken the agent past its daily budget, so it was not made.",
  workspace_monthly_limit_would_be_exceeded:
    "The next model call could have taken the workspace past its monthly budget, so it was not made.",
  model_not_priced:
    "The agent's model has no known price, so its cost cannot be limited. The call was not made.",
  budget_check_failed:
    "The budget could not be checked, so the call was not made (no check means no spend).",
  call_cost_overran_reservation:
    "A model call cost more than was reserved for it, so the run was stopped.",
  call_outcome_unknown_charged:
    "A model call ended without a clear answer from the provider, so it may have been billed. Its full reserved cost was counted as spent.",
};
