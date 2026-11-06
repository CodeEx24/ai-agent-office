import { describe, expect, it } from "vitest";

import {
  assignedSkillSchema,
  builtContextSchema,
  contextBudgetSchema,
  DEFAULT_CONTEXT_MAX_CHARS,
  retrievedItemSchema,
  SKILL_BODY_MAX_LENGTH,
} from "../index.js";

const ID = "00000000-0000-4000-8000-000000000001";

const skill = {
  id: ID,
  workspaceId: ID,
  agentId: ID,
  name: "n",
  version: 1,
  origin: "owner",
  body: "b",
};

describe("context schemas", () => {
  it("requires an explicit skill origin: there is no trusted default", () => {
    const { origin: _origin, ...withoutOrigin } = skill;
    expect(assignedSkillSchema.safeParse(withoutOrigin).success).toBe(false);
    expect(assignedSkillSchema.safeParse({ ...skill, origin: "somewhere" }).success).toBe(false);
    expect(assignedSkillSchema.safeParse({ ...skill, origin: "pack" }).success).toBe(true);
  });

  it("rejects unknown keys and oversized skill text", () => {
    expect(assignedSkillSchema.safeParse({ ...skill, extra: 1 }).success).toBe(false);
    expect(
      assignedSkillSchema.safeParse({ ...skill, body: "x".repeat(SKILL_BODY_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it("bounds the budget and retrieved items", () => {
    expect(contextBudgetSchema.safeParse({ maxChars: DEFAULT_CONTEXT_MAX_CHARS }).success).toBe(
      true,
    );
    expect(contextBudgetSchema.safeParse({ maxChars: 10 }).success).toBe(false);
    expect(retrievedItemSchema.safeParse({ source: "", content: "x" }).success).toBe(false);
  });

  it("validates a built context", () => {
    const metadata = {
      run_id: ID,
      workspace_id: ID,
      agent_id: ID,
      task_id: null,
      budget_chars: 1000,
      used_chars: 10,
      skills: [],
      skills_rejected: 0,
      vault_entries_included: 0,
      vault_entries_total: 0,
      retrieved_included: 0,
      cuts: [],
    };
    const ok = { system: "s", messages: [{ role: "user", content: "c" }], metadata };
    expect(builtContextSchema.safeParse(ok).success).toBe(true);
    expect(builtContextSchema.safeParse({ ...ok, messages: [] }).success).toBe(false);
    expect(
      builtContextSchema.safeParse({ ...ok, messages: [{ role: "assistant", content: "c" }] })
        .success,
    ).toBe(false);
  });
});
