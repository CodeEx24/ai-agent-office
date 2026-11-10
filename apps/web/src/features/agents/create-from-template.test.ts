import { describe, expect, it, vi } from "vitest";
import { AGENT_TEMPLATES, STARTER_CAPABILITIES, resolveCapabilityGrants } from "@ago/shared";

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
import {
  createAgentFromTemplateWith,
  NAME_TAKEN_ERROR,
  UNKNOWN_TEMPLATE_ERROR,
} from "./create-from-template";

const WORKSPACE = "13600000-0000-4000-8000-0000000000a1";
const catalog = STARTER_CAPABILITIES.map((capability) => ({ ...capability, enabled: true }));

function recordingCreator(takenNames: readonly string[] = []) {
  const createAgent = vi.fn<AgentCreator["createAgent"]>((input) =>
    takenNames.includes(input.name)
      ? Promise.reject(new AgentLibraryError("name_taken", "name"))
      : Promise.resolve({ id: `agent-${input.name}` }),
  );
  return { creator: { createAgent } satisfies AgentCreator, createAgent };
}

describe("createAgentFromTemplateWith", () => {
  it.each(AGENT_TEMPLATES.map((template) => [template.id, template] as const))(
    "creates a valid agent from %s in one call (AC1)",
    async (_id, template) => {
      const { creator, createAgent } = recordingCreator();
      const result = await createAgentFromTemplateWith(creator, WORKSPACE, template.id);

      expect(result).toEqual({ createdId: `agent-${template.name}` });
      expect(createAgent).toHaveBeenCalledTimes(1);
      const input = createAgent.mock.calls[0]?.[0];
      expect(input).toMatchObject({
        workspaceId: WORKSPACE,
        name: template.name,
        role: template.role,
        model: template.model,
        dailyBudget: template.dailyBudgetCents,
        skillIds: [],
        capabilities: template.capabilities,
      });
      // The creator is the wizard's: its catalog check accepts every grant of the template.
      expect(resolveCapabilityGrants(input?.capabilities ?? [], catalog).ok).toBe(true);
      // The input has no mode, status or tier: the agent starts in Strict mode.
      expect(Object.keys(input ?? {})).not.toEqual(expect.arrayContaining(["mode"]));
    },
  );

  it("numbers the name when it is taken", async () => {
    const { creator, createAgent } = recordingCreator(["Researcher", "Researcher 2"]);
    const result = await createAgentFromTemplateWith(creator, WORKSPACE, "researcher");
    expect(result).toEqual({ createdId: "agent-Researcher 3" });
    expect(createAgent).toHaveBeenCalledTimes(3);
  });

  it("gives up with a clear message after 20 taken names", async () => {
    const taken = ["Manager", ...Array.from({ length: 25 }, (_, i) => `Manager ${String(i + 2)}`)];
    const { creator, createAgent } = recordingCreator(taken);
    const result = await createAgentFromTemplateWith(creator, WORKSPACE, "manager");
    expect(result).toEqual({ error: NAME_TAKEN_ERROR });
    expect(createAgent).toHaveBeenCalledTimes(20);
  });

  it("refuses an unknown template without calling the creator", async () => {
    const { creator, createAgent } = recordingCreator();
    for (const id of ["admin", "", "__proto__", "Manager"]) {
      expect(await createAgentFromTemplateWith(creator, WORKSPACE, id)).toEqual({
        error: UNKNOWN_TEMPLATE_ERROR,
      });
    }
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("blocks a member or viewer: the owner check of the creator is the only gate and it is not bypassed", async () => {
    const creator: AgentCreator = {
      createAgent: () => Promise.reject(new WorkspaceAccessError("forbidden")),
    };
    const result = await createAgentFromTemplateWith(creator, WORKSPACE, "writer");
    expect(result.createdId).toBeUndefined();
    expect(result.error).toBe("Only workspace owners can create agents.");
  });

  it("does not retry other failures", async () => {
    const createAgent = vi.fn<AgentCreator["createAgent"]>(() =>
      Promise.reject(new AgentLibraryError("failed")),
    );
    const result = await createAgentFromTemplateWith({ createAgent }, WORKSPACE, "analyst");
    expect(result.error).toBeDefined();
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("reports a capability the workspace does not offer instead of creating a weaker agent", async () => {
    const creator: AgentCreator = {
      createAgent: () => Promise.reject(new AgentLibraryError("not_found", "capabilities")),
    };
    const result = await createAgentFromTemplateWith(creator, WORKSPACE, "researcher");
    expect(result.createdId).toBeUndefined();
    expect(result.fieldErrors?.capabilities).toBeDefined();
  });
});
