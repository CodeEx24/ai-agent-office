import { describe, expect, it, vi } from "vitest";
import { AGENT_TEMPLATES, AGENT_MODES, NEW_AGENT_MODE, createAgentSchema } from "@ago/shared";

// AGO-99 AC1 functional QA: "New agents default to Strict" on the app-side create paths (wizard schema, template).
// The database default and insert guard are proved in supabase/tests/agent_mode*.test.sql; the wizard's RPC call
// carries no mode (agent-library.test.ts). Here: no app input can ask for another mode, every template creates
// an agent whose input names no mode, and the one starting-mode constant is Strict.
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

import type { AgentCreator } from "./agent-library";
import { createAgentFromTemplateWith } from "./create-from-template";

const WORKSPACE = "99000000-0000-4000-8000-0000000000a1";

const VALID_INPUT = {
  workspaceId: WORKSPACE,
  name: "Scout",
  role: "Researcher",
  model: "claude-sonnet-5-5",
  prompt: "Find sources.",
  dailyBudget: "5.00",
  skillIds: [],
  capabilities: [],
};

describe("AC1: the starting mode is Strict everywhere in the app", () => {
  it("has one starting mode constant, and it is a valid mode: strict", () => {
    expect(NEW_AGENT_MODE).toBe("strict");
    expect(AGENT_MODES).toContain(NEW_AGENT_MODE);
  });

  it("the wizard schema accepts a valid input that names no mode (control for the refusals below)", () => {
    expect(createAgentSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it.each(["standard", "relaxed", "strict", "Strict", ""])(
    "the wizard schema refuses an input that carries mode=%j",
    (mode) => {
      expect(createAgentSchema.safeParse({ ...VALID_INPUT, mode }).success).toBe(false);
    },
  );

  it.each(AGENT_TEMPLATES.map((template) => [template.id] as const))(
    "template %s creates an agent whose input names no mode",
    async (templateId) => {
      const createAgent = vi.fn<AgentCreator["createAgent"]>(() =>
        Promise.resolve({ id: "new-1" }),
      );
      const result = await createAgentFromTemplateWith({ createAgent }, WORKSPACE, templateId);
      expect(result.fieldErrors).toBeUndefined();
      expect(createAgent).toHaveBeenCalledTimes(1);
      expect(createAgent.mock.calls[0]?.[0]).not.toHaveProperty("mode");
    },
  );
});
