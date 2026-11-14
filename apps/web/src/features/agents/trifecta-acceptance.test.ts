import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireWorkspaceRole = vi.fn();
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return {
    WorkspaceAccessError,
    requireWorkspaceRole: (...args: unknown[]) => requireWorkspaceRole(...args) as unknown,
  };
});

const listCapabilities = vi.fn();
vi.mock("../capabilities/capability-catalog", () => ({
  listCapabilities: (...args: unknown[]) => listCapabilities(...args) as unknown,
}));
vi.mock("../skills/skill-library", () => ({ listSkills: vi.fn() }));

const rpc = vi.fn((_name: string, _args: Record<string, unknown>) =>
  Promise.resolve({ data: "agent-1", error: null }),
);
vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc }),
}));

import {
  AGENT_TEMPLATES,
  STARTER_CAPABILITIES,
  agentInputFromTemplate,
  createAgentSchema,
} from "@ago/shared";

import { parseInput } from "../../lib/validation/parse-input";
import { agentCreator } from "./agent-library";
import {
  agentFormRecord,
  createAgentWith,
  invalidInputState,
  type AgentWizardState,
} from "./create-agent";
import { createAgentFromTemplateWith } from "./create-from-template";

const WORKSPACE = "13800000-0000-4000-8000-0000000000a1";
const catalog = STARTER_CAPABILITIES.map((c) => ({ ...c, enabled: true }));
type Mode = "automatic" | "approval";
const grant = (key: string, mode: Mode = "approval") => ({ key, mode });

// One capability per leg, written out here rather than read from the lint.
const U = "web.search";
const P = "vault.read_private";
const O = "message.send_outbound";

const baseInput = {
  workspaceId: WORKSPACE,
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5" as const,
  prompt: "Find sources.",
  skillIds: [] as string[],
  dailyBudget: 500,
  maxTokens: null,
};

/** The two steps the server action runs, from a posted form. */
async function postForm(
  capabilities: unknown,
  extra: Record<string, string> = {},
): Promise<AgentWizardState & { createdId?: string }> {
  const data = new FormData();
  const fields: Record<string, string> = {
    workspaceId: WORKSPACE,
    name: "Scout",
    role: "Researcher",
    model: "claude-haiku-5-5",
    prompt: "Find sources.",
    dailyBudget: "5.00",
    maxTokens: "",
    skillIds: "[]",
    capabilities: JSON.stringify(capabilities),
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  const parsed = parseInput(createAgentSchema, agentFormRecord(data));
  if (!parsed.success) return invalidInputState(parsed.issues);
  return createAgentWith(agentCreator, parsed.data);
}

beforeEach(() => {
  rpc.mockClear();
  requireWorkspaceRole.mockReset();
  requireWorkspaceRole.mockResolvedValue({ userId: "u", workspaceId: WORKSPACE, role: "owner" });
  listCapabilities.mockReset();
  listCapabilities.mockResolvedValue(catalog);
});

describe("AGO-138 AC1 server side: the block holds when the wizard UI is bypassed", () => {
  it.each<[string, Mode]>([
    ["approval", "approval"],
    ["automatic", "automatic"],
  ])(
    "agentCreator refuses the trifecta when the non-Tier-3 grants are %s, rpc never called",
    async (_label, mode) => {
      const error = await agentCreator
        .createAgent({
          ...baseInput,
          capabilities: [grant(U, mode), grant(P, mode), grant(O, "approval")],
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid", field: "capabilities" });
      expect((error as Error).message).toMatch(/^Capabilities: this combination is blocked/);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("agentCreator refuses the broader mapping (browse + shared notes + integration write)", async () => {
    await expect(
      agentCreator.createAgent({
        ...baseInput,
        capabilities: [
          grant("web.browse"),
          grant("vault.read", "automatic"),
          grant("integration.write", "approval"),
        ],
      }),
    ).rejects.toThrow(/^Capabilities: this combination is blocked/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("agentCreator refuses the trifecta even with an unrelated capability added", async () => {
    await expect(
      agentCreator.createAgent({
        ...baseInput,
        capabilities: [grant("tasks.manage", "automatic"), grant(U), grant(P), grant(O)],
      }),
    ).rejects.toMatchObject({ code: "invalid", field: "capabilities" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("createAgentWith turns the refusal into a capabilities field error carrying the explanation", async () => {
    const result = await createAgentWith(agentCreator, {
      ...baseInput,
      capabilities: [grant(U, "automatic"), grant(P, "automatic"), grant(O)],
    });
    expect(result.createdId).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.fieldErrors?.capabilities).toMatch(/^Capabilities: this combination is blocked/);
    expect(result.fieldErrors?.capabilities).toContain("Search the web");
    expect(result.fieldErrors?.capabilities).not.toMatch(/Tier 3 or 4/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a posted JSON capabilities field with all three is refused with the explanation", async () => {
    const result = await postForm([grant(U, "automatic"), grant(P, "automatic"), grant(O)]);
    expect(result.fieldErrors?.capabilities).toMatch(/this combination is blocked/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an extra posted field cannot act as an override", async () => {
    const result = await postForm([grant(U), grant(P), grant(O)], {
      override: "true",
      approvedBy: "security-admin",
    });
    expect(result.createdId).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a duplicated trifecta key in the posted list never creates an agent", async () => {
    const result = await postForm([grant(U), grant(U), grant(P), grant(O)]);
    expect(result.createdId).toBeUndefined();
    expect(result.fieldErrors?.capabilities).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a failed role check stops the request before the rpc", async () => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    await expect(
      agentCreator.createAgent({ ...baseInput, capabilities: [grant(U), grant(P), grant(O)] }),
    ).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a capability missing from the workspace catalog cannot be granted (refused, rpc not called)", async () => {
    listCapabilities.mockResolvedValue(catalog.filter((c) => c.key !== O));
    await expect(
      agentCreator.createAgent({ ...baseInput, capabilities: [grant(U), grant(P), grant(O)] }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a disabled outbound capability is refused too", async () => {
    listCapabilities.mockResolvedValue(
      catalog.map((c) => (c.key === O ? { ...c, enabled: false } : c)),
    );
    await expect(
      agentCreator.createAgent({ ...baseInput, capabilities: [grant(U), grant(P), grant(O)] }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("AGO-138 AC1 edge cases: fewer than three legs are created", () => {
  it.each([
    ["untrusted + private", [grant(U, "automatic"), grant(P, "automatic")]],
    ["untrusted + outbound", [grant(U, "automatic"), grant(O)]],
    ["private + outbound", [grant(P, "automatic"), grant(O)]],
    ["browse + shared notes", [grant("web.browse"), grant("vault.read", "automatic")]],
    ["no capabilities", []],
    ["a single leg", [grant(O)]],
  ])(
    "agentCreator creates the agent with %s: one rpc call with the grants",
    async (_name, capabilities) => {
      await expect(agentCreator.createAgent({ ...baseInput, capabilities })).resolves.toEqual({
        id: "agent-1",
      });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_capabilities: capabilities });
    },
  );

  it("the posted-form path creates an agent with two legs", async () => {
    const result = await postForm([grant(U, "automatic"), grant(O)]);
    expect(result).toEqual({ createdId: "agent-1" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("AGO-138 AC2 server side: the templates go through the real creator", () => {
  it.each(AGENT_TEMPLATES.map((t) => [t.id] as const))(
    "create from template %s reaches the database once and is not blocked",
    async (id) => {
      const result = await createAgentFromTemplateWith(agentCreator, WORKSPACE, id);
      expect(result).toEqual({ createdId: "agent-1" });
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["researcher", "analyst"])(
    "a %s extended to all three legs is refused (tampered template), rpc not called",
    async (id) => {
      const template = AGENT_TEMPLATES.find((t) => t.id === id);
      if (!template) throw new Error("template missing");
      const extended = {
        ...template,
        capabilities: [...template.capabilities, grant(U), grant(P), grant("integration.write")],
      };
      const result = await createAgentWith(
        agentCreator,
        agentInputFromTemplate(extended, WORKSPACE, "Tampered"),
      );
      expect(result.createdId).toBeUndefined();
      expect(result.fieldErrors?.capabilities).toMatch(/this combination is blocked/);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("a template reduced to two legs is still created", async () => {
    const template = AGENT_TEMPLATES.find((t) => t.id === "librarian");
    if (!template) throw new Error("template missing");
    const twoLegs = { ...template, capabilities: [grant(U, "automatic"), grant(P, "automatic")] };
    const result = await createAgentWith(
      agentCreator,
      agentInputFromTemplate(twoLegs, WORKSPACE, "Two legs"),
    );
    expect(result).toEqual({ createdId: "agent-1" });
  });
});
