import { describe, expect, it } from "vitest";

import {
  AGENT_DAILY_BUDGET_MAX_CENTS,
  AGENT_FIELD_LABELS,
  AGENT_FIELDS,
  AGENT_MESSAGES,
  AGENT_MAX_TOKENS_MAX,
  AGENT_MAX_TOKENS_MIN,
  AGENT_MODELS,
  checkAgentDraft,
  createAgentSchema,
  fieldErrorsFromIssues,
  parseDailyBudget,
  parseMaxTokens,
  resolveCapabilityGrants,
  type AgentDraftText,
} from "./agent-schemas.js";
import { RUN_LIMIT_BOUNDS } from "./run-limits.js";

const WORKSPACE = "14100000-0000-4000-8000-0000000000a1";
const SKILL = "14100000-0000-4000-8000-0000000000b1";

const valid = {
  workspaceId: WORKSPACE,
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5",
  prompt: "Find sources and summarise them.",
  skillIds: [SKILL],
  capabilities: [{ key: "vault.read", mode: "automatic" }],
  dailyBudget: "5.00",
};

const draft: AgentDraftText = {
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5",
  prompt: "Find sources.",
  dailyBudget: "5",
  maxTokens: "",
};

describe("max tokens bounds", () => {
  it("equal the run-limit bounds the DB and the worker use", () => {
    expect(AGENT_MAX_TOKENS_MIN).toBe(RUN_LIMIT_BOUNDS.maxTokens.min);
    expect(AGENT_MAX_TOKENS_MAX).toBe(RUN_LIMIT_BOUNDS.maxTokens.max);
  });
});

describe("parseMaxTokens", () => {
  it.each([
    ["", null],
    ["   ", null],
    ["50000", 50_000],
    [" 1000 ", 1_000],
    ["5000000", 5_000_000],
  ])("accepts %j", (input, tokens) => {
    expect(parseMaxTokens(input)).toEqual({ ok: true, tokens });
  });

  it.each([
    ["999", AGENT_MESSAGES.maxTokensOutOfRange],
    ["0", AGENT_MESSAGES.maxTokensOutOfRange],
    ["5000001", AGENT_MESSAGES.maxTokensOutOfRange],
    ["12.5", AGENT_MESSAGES.maxTokensNotWhole],
    ["abc", AGENT_MESSAGES.maxTokensNotWhole],
    ["-3", AGENT_MESSAGES.maxTokensNotWhole],
    ["1e5", AGENT_MESSAGES.maxTokensNotWhole],
  ])("rejects %j", (input, message) => {
    expect(parseMaxTokens(input)).toEqual({ ok: false, message });
  });

  it("names the field and the range in its messages", () => {
    for (const message of [AGENT_MESSAGES.maxTokensNotWhole, AGENT_MESSAGES.maxTokensOutOfRange]) {
      expect(message).toContain(AGENT_FIELD_LABELS.maxTokens);
    }
    expect(AGENT_MESSAGES.maxTokensOutOfRange).toContain("1,000");
    expect(AGENT_MESSAGES.maxTokensOutOfRange).toContain("5,000,000");
  });
});

describe("parseDailyBudget", () => {
  it.each([
    ["5", 500],
    ["5.5", 550],
    ["5.05", 505],
    ["0.01", 1],
    [" 50.00 ", AGENT_DAILY_BUDGET_MAX_CENTS],
  ])("accepts %s", (input, cents) => {
    expect(parseDailyBudget(input)).toEqual({ ok: true, cents });
  });

  it.each([
    ["", AGENT_MESSAGES.budgetRequired],
    ["0", AGENT_MESSAGES.budgetNotPositive],
    ["0.00", AGENT_MESSAGES.budgetNotPositive],
    ["-1", AGENT_MESSAGES.budgetInvalid],
    ["1e3", AGENT_MESSAGES.budgetInvalid],
    ["5.001", AGENT_MESSAGES.budgetInvalid],
    ["abc", AGENT_MESSAGES.budgetInvalid],
    ["50.01", AGENT_MESSAGES.budgetTooHigh],
    ["9999999", AGENT_MESSAGES.budgetTooHigh],
  ])("rejects %j", (input, message) => {
    expect(parseDailyBudget(input)).toEqual({ ok: false, message });
  });
});

describe("createAgentSchema", () => {
  it("accepts valid input and turns dollars into cents", () => {
    const result = createAgentSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.dailyBudget).toBe(500);
  });

  it("has no field that could pick a mode other than strict", () => {
    expect(createAgentSchema.safeParse({ ...valid, mode: "autonomous" }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...valid, status: "busy" }).success).toBe(false);
  });

  it("trims text and normalises CRLF", () => {
    const result = createAgentSchema.safeParse({ ...valid, name: "  Scout ", prompt: "a\r\nb " });
    expect(result.success && result.data.prompt).toBe("a\nb");
    expect(result.success && result.data.name).toBe("Scout");
  });

  it("turns an empty or missing max tokens into null and a number into an integer", () => {
    const empty = createAgentSchema.safeParse({ ...valid, maxTokens: "" });
    expect(empty.success && empty.data.maxTokens).toBeNull();
    const missing = createAgentSchema.safeParse(valid);
    expect(missing.success && missing.data.maxTokens).toBeNull();
    const set = createAgentSchema.safeParse({ ...valid, maxTokens: "50000" });
    expect(set.success && set.data.maxTokens).toBe(50_000);
  });

  it("refuses an out-of-range or non-integer max tokens against its field", () => {
    for (const maxTokens of ["999", "5000001", "12.5", "abc", "-3"]) {
      const result = createAgentSchema.safeParse({ ...valid, maxTokens });
      expect(result.success, maxTokens).toBe(false);
      if (result.success) continue;
      expect(fieldErrorsFromIssues(result.error.issues).maxTokens, maxTokens).toContain(
        AGENT_FIELD_LABELS.maxTokens,
      );
    }
  });

  it("names the field in every error", () => {
    const result = createAgentSchema.safeParse({
      ...valid,
      name: " ",
      role: "",
      model: "gpt-9",
      prompt: "",
      dailyBudget: "0",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const errors = fieldErrorsFromIssues(result.error.issues);
    for (const field of ["name", "role", "model", "prompt", "dailyBudget"] as const) {
      expect(errors[field], field).toContain(AGENT_FIELD_LABELS[field]);
    }
  });

  it("asks for a model when none was chosen, and refuses one outside the allowlist", () => {
    const missing = createAgentSchema.safeParse({ ...valid, model: "" });
    expect(!missing.success && missing.error.issues[0]?.message).toBe(AGENT_MESSAGES.modelRequired);
    const unknown = createAgentSchema.safeParse({ ...valid, model: "gpt-9" });
    expect(!unknown.success && unknown.error.issues[0]?.message).toBe(AGENT_MESSAGES.modelUnknown);
  });

  it("rejects a bad skill id, a bad capability key and a client-sent tier", () => {
    expect(createAgentSchema.safeParse({ ...valid, skillIds: ["nope"] }).success).toBe(false);
    expect(
      createAgentSchema.safeParse({
        ...valid,
        capabilities: [{ key: "Bad Key", mode: "approval" }],
      }).success,
    ).toBe(false);
    expect(
      createAgentSchema.safeParse({
        ...valid,
        capabilities: [{ key: "vault.read", mode: "approval", tier: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("client checks match the server schema", () => {
  const cases: Partial<AgentDraftText>[] = [
    {},
    { name: "" },
    { name: "x".repeat(121) },
    { role: "  " },
    { role: "x".repeat(121) },
    { model: "" },
    { model: "gpt-9" },
    { prompt: "" },
    { prompt: "x".repeat(20_001) },
    { dailyBudget: "" },
    { dailyBudget: "0" },
    { dailyBudget: "abc" },
    { dailyBudget: "50.01" },
    { maxTokens: "50000" },
    { maxTokens: "999" },
    { maxTokens: "5000001" },
    { maxTokens: "12.5" },
    { maxTokens: "-3" },
  ];

  it.each(cases)("agrees on %j", (override) => {
    const input = { ...draft, ...override };
    const client = checkAgentDraft(input);
    const server = createAgentSchema.safeParse({
      workspaceId: WORKSPACE,
      ...input,
      skillIds: [],
      capabilities: [],
    });
    const serverErrors = server.success ? {} : fieldErrorsFromIssues(server.error.issues);
    expect(client).toEqual(serverErrors);
  });

  it("labels every field and offers models", () => {
    expect(AGENT_FIELDS.every((field) => AGENT_FIELD_LABELS[field].length > 0)).toBe(true);
    expect(AGENT_MODELS.length).toBeGreaterThan(0);
  });
});

describe("resolveCapabilityGrants", () => {
  const catalog = [
    { key: "vault.read", tier: 0, enabled: true },
    { key: "web.search", tier: 1, enabled: true },
    { key: "email.send", tier: 3, enabled: true },
    { key: "money.spend", tier: 4, enabled: true },
    { key: "old.thing", tier: 1, enabled: false },
  ] as const;

  it("grants low tiers automatic or approval", () => {
    const result = resolveCapabilityGrants(
      [
        { key: "vault.read", mode: "automatic" },
        { key: "web.search", mode: "approval" },
      ],
      catalog,
    );
    expect(result).toEqual({
      ok: true,
      grants: [
        { key: "vault.read", mode: "automatic" },
        { key: "web.search", mode: "approval" },
      ],
    });
  });

  it.each(["email.send", "money.spend"])("never lets %s be automatic", (key) => {
    const result = resolveCapabilityGrants([{ key, mode: "automatic" }], catalog);
    expect(result).toEqual({
      ok: false,
      field: "capabilities",
      message: AGENT_MESSAGES.capabilityApproval,
    });
    expect(resolveCapabilityGrants([{ key, mode: "approval" }], catalog).ok).toBe(true);
  });

  it("refuses unknown and disabled capabilities and collapses repeats", () => {
    expect(resolveCapabilityGrants([{ key: "no.such", mode: "approval" }], catalog).ok).toBe(false);
    expect(resolveCapabilityGrants([{ key: "old.thing", mode: "approval" }], catalog).ok).toBe(
      false,
    );
    const twice = resolveCapabilityGrants(
      [
        { key: "vault.read", mode: "approval" },
        { key: "vault.read", mode: "automatic" },
      ],
      catalog,
    );
    expect(twice.ok && twice.grants).toEqual([{ key: "vault.read", mode: "automatic" }]);
  });
});
