import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError, requireWorkspaceRole: vi.fn() };
});

import {
  AGENT_MESSAGES,
  agentRefSchema,
  duplicateAgentSchema,
  updateAgentSchema,
  type UpdateAgentInput,
} from "@ago/shared";

import { parseInput } from "../../lib/validation/parse-input";
import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { GENERIC_ERROR, invalidInputState } from "./create-agent";
import {
  AgentEditError,
  ARCHIVED_ERROR,
  archiveAgentWith,
  duplicateAgentWith,
  NAME_TAKEN_FIELD_ERROR,
  NOT_FOUND_ERROR,
  OWNER_ONLY_EDIT_ERROR,
  STALE_ERROR,
  unarchiveAgentWith,
  updateAgentWith,
  type AgentEditor,
} from "./edit-agent";

const WORKSPACE = "89000000-0000-4000-8000-0000000000a1";
const AGENT = "89000000-0000-4000-8000-0000000000b1";

const record = {
  workspaceId: WORKSPACE,
  agentId: AGENT,
  expectedVersion: "2",
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5",
  thinkingEffort: "high",
  prompt: "Find sources.",
  dailyBudget: "7.50",
};

function updateInput(overrides: Partial<Record<string, string>> = {}): UpdateAgentInput {
  const parsed = parseInput(updateAgentSchema, { ...record, ...overrides });
  if (!parsed.success) throw new Error(parsed.message);
  return parsed.data;
}

function editor(overrides: Partial<AgentEditor> = {}): AgentEditor {
  return {
    updateAgent: vi.fn(() => Promise.resolve({ version: 3 })),
    duplicateAgent: vi.fn(() => Promise.resolve({ id: "copy-1" })),
    archiveAgent: vi.fn(() => Promise.resolve()),
    unarchiveAgent: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const rejecting = (error: Error) => () => Promise.reject(error);

describe("updateAgentWith", () => {
  it("saves valid input and passes cents and the expected version, not text", async () => {
    const updateAgent = vi.fn<AgentEditor["updateAgent"]>(() => Promise.resolve({ version: 3 }));
    const result = await updateAgentWith(editor({ updateAgent }), updateInput());
    expect(result).toEqual({ done: true, version: 3 });
    expect(updateAgent).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      expectedVersion: 2,
      name: "Scout",
      role: "Researcher",
      model: "claude-haiku-5-5",
      thinkingEffort: "high",
      prompt: "Find sources.",
      dailyBudget: 750,
    });
  });

  it("refuses a model off the allowlist without calling the editor", async () => {
    const updateAgent = vi.fn<AgentEditor["updateAgent"]>();
    const input = { ...updateInput(), model: "not-a-model" } as unknown as UpdateAgentInput;
    const result = await updateAgentWith(editor({ updateAgent }), input);
    expect(result.fieldErrors?.model).toBe(AGENT_MESSAGES.modelUnknown);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", { error: STALE_ERROR }],
    ["archived", { error: ARCHIVED_ERROR }],
    ["not_found", { error: NOT_FOUND_ERROR }],
    ["forbidden", { error: OWNER_ONLY_EDIT_ERROR }],
    ["failed", { error: GENERIC_ERROR }],
    ["name_taken", { fieldErrors: { name: NAME_TAKEN_FIELD_ERROR } }],
  ] as const)("maps a %s refusal to a safe message", async (code, expected) => {
    const result = await updateAgentWith(
      editor({ updateAgent: rejecting(new AgentEditError(code)) }),
      updateInput(),
    );
    expect(result).toEqual(expected);
  });

  it("maps a refused field to that field", async () => {
    const result = await updateAgentWith(
      editor({ updateAgent: rejecting(new AgentEditError("invalid", "dailyBudget")) }),
      updateInput(),
    );
    expect(result.fieldErrors?.dailyBudget).toBe(AGENT_MESSAGES.budgetTooHigh);
  });

  it("never shows the text of an unexpected error", async () => {
    const result = await updateAgentWith(
      editor({ updateAgent: rejecting(new Error("relation agents violates policy xyz")) }),
      updateInput(),
    );
    expect(result).toEqual({ error: GENERIC_ERROR });
  });

  it("tells a signed-out user to sign in and a non-owner that only owners can edit", async () => {
    const signedOut = await updateAgentWith(
      editor({
        updateAgent: rejecting(
          new (WorkspaceAccessError as unknown as new (code: string) => Error)("unauthenticated"),
        ),
      }),
      updateInput(),
    );
    expect(signedOut.error).toMatch(/sign in/i);
    const member = await updateAgentWith(
      editor({
        updateAgent: rejecting(
          new (WorkspaceAccessError as unknown as new (code: string) => Error)("forbidden"),
        ),
      }),
      updateInput(),
    );
    expect(member.error).toBe(OWNER_ONLY_EDIT_ERROR);
  });
});

describe("the form boundary", () => {
  it("names the field for each invalid value", () => {
    const parsed = parseInput(updateAgentSchema, { ...record, name: " ", thinkingEffort: "max" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const state = invalidInputState(parsed.issues);
    expect(state.fieldErrors?.name).toBe(AGENT_MESSAGES.nameRequired);
    expect(state.fieldErrors?.thinkingEffort).toBe(AGENT_MESSAGES.thinkingEffortUnknown);
  });

  it("refuses a request that tries to set the mode or archive state", () => {
    expect(parseInput(updateAgentSchema, { ...record, mode: "autonomous" }).success).toBe(false);
    expect(
      parseInput(agentRefSchema, { workspaceId: WORKSPACE, agentId: AGENT, status: "x" }).success,
    ).toBe(false);
    expect(
      parseInput(duplicateAgentSchema, {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        name: "Copy",
        mode: "autonomous",
      }).success,
    ).toBe(false);
  });
});

describe("duplicateAgentWith", () => {
  const input = { workspaceId: WORKSPACE, agentId: AGENT, name: "Scout copy" };

  it("returns the id of the copy and passes only the ids and the name", async () => {
    const duplicateAgent = vi.fn<AgentEditor["duplicateAgent"]>(() =>
      Promise.resolve({ id: "copy-1" }),
    );
    const result = await duplicateAgentWith(editor({ duplicateAgent }), input);
    expect(result).toEqual({ done: true, createdId: "copy-1" });
    expect(duplicateAgent).toHaveBeenCalledWith(input);
  });

  it("reports a taken name against the name field and an archived source as an error", async () => {
    const taken = await duplicateAgentWith(
      editor({ duplicateAgent: rejecting(new AgentEditError("name_taken", "name")) }),
      input,
    );
    expect(taken.fieldErrors?.name).toBe(NAME_TAKEN_FIELD_ERROR);
    const archived = await duplicateAgentWith(
      editor({ duplicateAgent: rejecting(new AgentEditError("archived")) }),
      input,
    );
    expect(archived.error).toBe(ARCHIVED_ERROR);
  });
});

describe("archiveAgentWith and unarchiveAgentWith", () => {
  const input = { workspaceId: WORKSPACE, agentId: AGENT };

  it("archives and unarchives through the editor", async () => {
    const archiveAgent = vi.fn<AgentEditor["archiveAgent"]>(() => Promise.resolve());
    const unarchiveAgent = vi.fn<AgentEditor["unarchiveAgent"]>(() => Promise.resolve());
    const e = editor({ archiveAgent, unarchiveAgent });
    expect(await archiveAgentWith(e, input)).toEqual({ done: true });
    expect(await unarchiveAgentWith(e, input)).toEqual({ done: true });
    expect(archiveAgent).toHaveBeenCalledWith(input);
    expect(unarchiveAgent).toHaveBeenCalledWith(input);
  });

  it("shows a safe message when a member tries it", async () => {
    const result = await archiveAgentWith(
      editor({ archiveAgent: rejecting(new AgentEditError("forbidden")) }),
      input,
    );
    expect(result).toEqual({ error: OWNER_ONLY_EDIT_ERROR });
  });
});
