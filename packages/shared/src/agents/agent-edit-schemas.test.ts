import { describe, expect, it } from "vitest";

import {
  AGENT_EDITABLE_FIELDS,
  AGENT_MESSAGES,
  agentRefSchema,
  checkAgentEditDraft,
  DEFAULT_AGENT_THINKING_EFFORT,
  duplicateAgentSchema,
  isAgentThinkingEffort,
  updateAgentSchema,
} from "../index.js";

const WORKSPACE = "89000000-0000-4000-8000-0000000000a1";
const AGENT = "89000000-0000-4000-8000-0000000000b1";

const validUpdate = {
  workspaceId: WORKSPACE,
  agentId: AGENT,
  expectedVersion: "3",
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5",
  thinkingEffort: "high",
  prompt: "Find sources.",
  dailyBudget: "7.50",
};

describe("updateAgentSchema", () => {
  it("accepts valid input and converts the version to a number and the budget to cents", () => {
    const parsed = updateAgentSchema.parse(validUpdate);
    expect(parsed.expectedVersion).toBe(3);
    expect(parsed.dailyBudget).toBe(750);
    expect(parsed.thinkingEffort).toBe("high");
  });

  it.each(["mode", "status", "archivedAt", "tier", "changedBy", "version"])(
    "rejects a %s field: it cannot be set from a request",
    (key) => {
      expect(updateAgentSchema.safeParse({ ...validUpdate, [key]: "x" }).success).toBe(false);
    },
  );

  it("names the thinking effort field when it is missing or unknown", () => {
    const missing = updateAgentSchema.safeParse({ ...validUpdate, thinkingEffort: "" });
    expect(missing.error?.issues[0]?.message).toBe(AGENT_MESSAGES.thinkingEffortRequired);
    const unknown = updateAgentSchema.safeParse({ ...validUpdate, thinkingEffort: "extreme" });
    expect(unknown.error?.issues[0]?.message).toBe(AGENT_MESSAGES.thinkingEffortUnknown);
  });

  it.each(["0", "-1", "1.5", "abc", "", "1234567890"])("rejects expectedVersion %j", (value) => {
    expect(updateAgentSchema.safeParse({ ...validUpdate, expectedVersion: value }).success).toBe(
      false,
    );
  });

  it("rejects a model off the allowlist and a budget over the cap", () => {
    expect(updateAgentSchema.safeParse({ ...validUpdate, model: "gpt-x" }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ ...validUpdate, dailyBudget: "50.01" }).success).toBe(
      false,
    );
  });

  it("rejects ids that are not UUIDs", () => {
    expect(updateAgentSchema.safeParse({ ...validUpdate, agentId: "1" }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ ...validUpdate, workspaceId: "1" }).success).toBe(false);
  });
});

describe("agentRefSchema and duplicateAgentSchema", () => {
  it("archive and unarchive take only the two ids", () => {
    expect(agentRefSchema.safeParse({ workspaceId: WORKSPACE, agentId: AGENT }).success).toBe(true);
    expect(
      agentRefSchema.safeParse({ workspaceId: WORKSPACE, agentId: AGENT, archivedAt: "now" })
        .success,
    ).toBe(false);
  });

  it("duplicate needs a name and cannot carry a mode", () => {
    const base = { workspaceId: WORKSPACE, agentId: AGENT, name: " Scout copy " };
    expect(duplicateAgentSchema.parse(base).name).toBe("Scout copy");
    expect(duplicateAgentSchema.safeParse({ ...base, name: "  " }).success).toBe(false);
    expect(duplicateAgentSchema.safeParse({ ...base, mode: "autonomous" }).success).toBe(false);
    expect(duplicateAgentSchema.safeParse({ ...base, skillIds: [] }).success).toBe(false);
  });
});

describe("thinking effort and the edit draft checks", () => {
  it("knows the three levels and defaults to medium", () => {
    expect(["low", "medium", "high"].every(isAgentThinkingEffort)).toBe(true);
    expect(isAgentThinkingEffort("max")).toBe(false);
    expect(DEFAULT_AGENT_THINKING_EFFORT).toBe("medium");
  });

  it("checkAgentEditDraft agrees with the schema on the thinking effort messages", () => {
    const draft = {
      name: "Scout",
      role: "Researcher",
      model: "claude-haiku-5-5",
      prompt: "Find sources.",
      dailyBudget: "5.00",
      thinkingEffort: "medium",
    };
    expect(checkAgentEditDraft(draft)).toEqual({});
    expect(checkAgentEditDraft({ ...draft, thinkingEffort: "" }).thinkingEffort).toBe(
      AGENT_MESSAGES.thinkingEffortRequired,
    );
    expect(checkAgentEditDraft({ ...draft, thinkingEffort: "max" }).thinkingEffort).toBe(
      AGENT_MESSAGES.thinkingEffortUnknown,
    );
  });

  it("lists the six editable settings in database column names", () => {
    expect(AGENT_EDITABLE_FIELDS).toEqual([
      "name",
      "role",
      "model",
      "thinking_effort",
      "prompt",
      "daily_budget_cents",
    ]);
  });
});
