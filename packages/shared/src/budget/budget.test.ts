import { describe, expect, it } from "vitest";

import {
  AGENT_DAILY_BUDGET_DEFAULT_CENTS,
  AGENT_DAILY_BUDGET_MAX_CENTS,
  AGENT_MODELS,
} from "../agents/agent-limits.js";
import { runEventSchema } from "../events/run-events.js";
import {
  BUDGET_STOP_MESSAGES,
  BUDGET_STOP_REASONS,
  MODEL_PRICES,
  WORKSPACE_MONTHLY_BUDGET_CAP_CENTS,
  costCents,
  effectiveDailyBudgetCents,
  effectiveMonthlyBudgetCents,
  estimateInputTokens,
  priceFor,
  utf8Length,
  worstCaseCostCents,
} from "./budget.js";

describe("utf8Length", () => {
  it.each(["", "abc", "é", "日本語", "😀", "a日😀é", "\ud800"])(
    "matches the real UTF-8 size of %j",
    (text) => {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
    },
  );
});

describe("price table", () => {
  it("prices every model on the allowlist", () => {
    for (const model of AGENT_MODELS) expect(priceFor(model.id)).not.toBeNull();
    expect(Object.keys(MODEL_PRICES).sort()).toEqual(AGENT_MODELS.map((m) => m.id).sort());
  });

  it.each(["", "gpt-4", "claude-unknown-9", "toString", "__proto__", "constructor"])(
    "has no price for %j, so the caller must deny",
    (model) => {
      expect(priceFor(model)).toBeNull();
      expect(costCents(model, { inputTokens: 1, outputTokens: 1 })).toBeNull();
      expect(worstCaseCostCents(model, 10, 10)).toBeNull();
    },
  );
});

describe("costCents", () => {
  it("rounds up, never down", () => {
    // 1 input token on haiku is 100 / 1,000,000 of a cent: still 1 cent.
    expect(costCents("claude-haiku-5-5", { inputTokens: 1, outputTokens: 0 })).toBe(1);
    // 1,000,000 input tokens = exactly 100 cents; one more token tips it to 101.
    expect(costCents("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(100);
    expect(costCents("claude-haiku-5-5", { inputTokens: 1_000_001, outputTokens: 0 })).toBe(101);
  });

  it("costs nothing only for zero usage", () => {
    expect(costCents("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("adds input and output at their own prices", () => {
    expect(
      costCents("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(300 + 1_500);
  });

  it("ignores negative counts instead of crediting money", () => {
    expect(costCents("claude-haiku-5-5", { inputTokens: -5_000_000, outputTokens: 0 })).toBe(0);
  });
});

describe("worst-case estimate", () => {
  it("sizes the prompt at 3 characters per token, rounded up", () => {
    expect(estimateInputTokens(0)).toBe(0);
    expect(estimateInputTokens(1)).toBe(1);
    expect(estimateInputTokens(3)).toBe(1);
    expect(estimateInputTokens(4)).toBe(2);
  });

  it("always includes the full output allowance", () => {
    const withOutput = worstCaseCostCents("claude-haiku-5-5", 0, 1_000_000);
    expect(withOutput).toBe(500);
    expect(worstCaseCostCents("claude-haiku-5-5", 300_000, 1_000_000)).toBe(500 + 10);
  });
});

describe("effective limits", () => {
  it("gives an agent with no stored budget the wizard default, so there is always a limit", () => {
    expect(effectiveDailyBudgetCents(null)).toBe(AGENT_DAILY_BUDGET_DEFAULT_CENTS);
    expect(effectiveDailyBudgetCents(undefined)).toBe(AGENT_DAILY_BUDGET_DEFAULT_CENTS);
    expect(effectiveDailyBudgetCents(0)).toBe(AGENT_DAILY_BUDGET_DEFAULT_CENTS);
    expect(effectiveDailyBudgetCents(-4)).toBe(AGENT_DAILY_BUDGET_DEFAULT_CENTS);
    expect(effectiveDailyBudgetCents(2.5)).toBe(AGENT_DAILY_BUDGET_DEFAULT_CENTS);
  });

  it("uses the stored daily budget but never above the platform cap", () => {
    expect(effectiveDailyBudgetCents(250)).toBe(250);
    expect(effectiveDailyBudgetCents(AGENT_DAILY_BUDGET_MAX_CENTS + 1)).toBe(
      AGENT_DAILY_BUDGET_MAX_CENTS,
    );
  });

  it("uses the platform cap when a workspace set no monthly budget", () => {
    expect(WORKSPACE_MONTHLY_BUDGET_CAP_CENTS).toBe(100_000);
    expect(effectiveMonthlyBudgetCents(null)).toBe(100_000);
    expect(effectiveMonthlyBudgetCents(undefined)).toBe(100_000);
    expect(effectiveMonthlyBudgetCents(-1)).toBe(100_000);
  });

  it("lets an owner lower the monthly budget but never raise it above the cap", () => {
    expect(effectiveMonthlyBudgetCents(5_000)).toBe(5_000);
    expect(effectiveMonthlyBudgetCents(0)).toBe(0);
    expect(effectiveMonthlyBudgetCents(100_001)).toBe(100_000);
    expect(effectiveMonthlyBudgetCents(Number.MAX_SAFE_INTEGER)).toBe(100_000);
  });
});

describe("stop reasons", () => {
  it("has a plain-language message for every reason code", () => {
    for (const reason of BUDGET_STOP_REASONS) {
      expect(BUDGET_STOP_MESSAGES[reason].length).toBeGreaterThan(10);
    }
  });

  it("every reason code is accepted by the budget.exceeded event, and unknown ones are not", () => {
    for (const reason of BUDGET_STOP_REASONS) {
      const parsed = runEventSchema.safeParse({
        type: "budget.exceeded",
        version: 1,
        payload: { scope: "ledger", reason, limit: 1, used: 2, estimate: 3 },
      });
      expect(parsed.success).toBe(true);
    }
    const unknown = runEventSchema.safeParse({
      type: "budget.exceeded",
      version: 1,
      payload: { scope: "run", reason: "because", limit: 1, used: 2 },
    });
    expect(unknown.success).toBe(false);
  });

  it("budget.usage carries the cost in cents", () => {
    const parsed = runEventSchema.safeParse({
      type: "budget.usage",
      version: 1,
      payload: { input_tokens: 10, output_tokens: 5, cost_cents: 1 },
    });
    expect(parsed.success).toBe(true);
  });
});
