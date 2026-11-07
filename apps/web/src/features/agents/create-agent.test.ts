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

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { AgentLibraryError, type AgentCreator } from "./agent-library";
import { createAgentSchema } from "@ago/shared";

import { parseInput } from "../../lib/validation/parse-input";
import {
  agentFormRecord,
  createAgentWith as createWith,
  invalidInputState,
  type AgentWizardState,
} from "./create-agent";

/** The same two steps the server action runs: validate the form, then create. */
async function createAgentWith(
  creator: AgentCreator,
  formData: FormData,
): Promise<AgentWizardState & { createdId?: string }> {
  const parsed = parseInput(createAgentSchema, agentFormRecord(formData));
  if (!parsed.success) return invalidInputState(parsed.issues);
  return createWith(creator, parsed.data);
}

const WORKSPACE = "14100000-0000-4000-8000-0000000000a1";
const SKILL = "14100000-0000-4000-8000-0000000000b1";

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    workspaceId: WORKSPACE,
    name: "Scout",
    role: "Researcher",
    model: "claude-haiku-5-5",
    prompt: "Find sources.",
    dailyBudget: "5.00",
    skillIds: JSON.stringify([SKILL]),
    capabilities: JSON.stringify([{ key: "vault.read", mode: "automatic" }]),
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function creatorThatReturns(id = "agent-1") {
  const createAgent = vi.fn<AgentCreator["createAgent"]>(() => Promise.resolve({ id }));
  return { creator: { createAgent } satisfies AgentCreator, createAgent };
}

function creatorThatThrows(error: Error): AgentCreator {
  return { createAgent: () => Promise.reject(error) };
}

describe("createAgentWith", () => {
  it("creates the agent from valid input and passes cents, not dollars", async () => {
    const { creator, createAgent } = creatorThatReturns();
    const result = await createAgentWith(creator, form());
    expect(result).toEqual({ createdId: "agent-1" });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Scout",
        dailyBudget: 500,
        skillIds: [SKILL],
        capabilities: [{ key: "vault.read", mode: "automatic" }],
      }),
    );
  });

  it("names the field in each validation error and never calls the creator", async () => {
    const { creator, createAgent } = creatorThatReturns();
    const result = await createAgentWith(
      creator,
      form({ name: " ", role: "", model: "", prompt: "", dailyBudget: "0" }),
    );
    expect(createAgent).not.toHaveBeenCalled();
    expect(result.fieldErrors?.name).toContain("Name");
    expect(result.fieldErrors?.role).toContain("Role");
    expect(result.fieldErrors?.model).toContain("Model");
    expect(result.fieldErrors?.prompt).toContain("Prompt");
    expect(result.fieldErrors?.dailyBudget).toContain("Daily budget");
  });

  it("rejects an unknown model name at save time and never calls the creator (AGO-94)", async () => {
    const { creator, createAgent } = creatorThatReturns();
    for (const model of ["gpt-9", "claude-sonnet-4", "CLAUDE-SONNET-5-5", " claude-opus-5-5 x"]) {
      const result = await createAgentWith(creator, form({ model }));
      expect(result.createdId).toBeUndefined();
      expect(result.fieldErrors?.model).toContain("Model");
    }
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("accepts each routed model: Sonnet, Opus and Fable (AGO-94)", async () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) {
      const { creator, createAgent } = creatorThatReturns();
      const result = await createAgentWith(creator, form({ model }));
      expect(result.createdId).toBe("agent-1");
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ model }));
    }
  });

  it("refuses a mode, a status or any other field the wizard does not have", async () => {
    const { creator, createAgent } = creatorThatReturns();
    const extras: Record<string, string>[] = [
      { mode: "autonomous" },
      { status: "busy" },
      { tier: "0" },
    ];
    for (const extra of extras) {
      const result = await createAgentWith(creator, form(extra));
      expect(result.createdId).toBeUndefined();
      expect(result.error).toBeDefined();
    }
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("treats malformed JSON in skills or capabilities as invalid input for that field", async () => {
    const { creator, createAgent } = creatorThatReturns();
    const skills = await createAgentWith(creator, form({ skillIds: "{nope" }));
    expect(skills.fieldErrors?.skillIds).toBeDefined();
    const caps = await createAgentWith(creator, form({ capabilities: "[{" }));
    expect(caps.fieldErrors?.capabilities).toBeDefined();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("maps a taken name to the name field", async () => {
    const result = await createAgentWith(
      creatorThatThrows(new AgentLibraryError("name_taken", "name")),
      form(),
    );
    expect(result.fieldErrors?.name).toContain("Name");
  });

  it("maps a foreign skill to the skills field and a refused capability to the capabilities field", async () => {
    const skill = await createAgentWith(
      creatorThatThrows(new AgentLibraryError("not_found", "skillIds")),
      form(),
    );
    expect(skill.fieldErrors?.skillIds).toContain("Skills");
    const cap = await createAgentWith(
      creatorThatThrows(new AgentLibraryError("invalid", "capabilities")),
      form(),
    );
    expect(cap.fieldErrors?.capabilities).toContain("approval");
  });

  it("tells a member or viewer that only owners can create agents", async () => {
    const result = await createAgentWith(
      creatorThatThrows(new WorkspaceAccessError("forbidden")),
      form(),
    );
    expect(result.error).toBe("Only workspace owners can create agents.");
    const database = await createAgentWith(
      creatorThatThrows(new AgentLibraryError("forbidden")),
      form(),
    );
    expect(database.error).toBe("Only workspace owners can create agents.");
  });

  it("shows a generic message for anything unexpected, with no details", async () => {
    const result = await createAgentWith(
      creatorThatThrows(new Error("db password leaked")),
      form(),
    );
    expect(result.error).toBe("Something went wrong. Please try again.");
  });
});
