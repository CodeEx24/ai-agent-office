import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireWorkspaceRole = vi.fn();
vi.mock("../workspaces/workspace-access", () => ({
  requireWorkspaceRole: (...args: unknown[]) => requireWorkspaceRole(...args) as unknown,
}));

const listCapabilities = vi.fn();
vi.mock("../capabilities/capability-catalog", () => ({
  listCapabilities: (...args: unknown[]) => listCapabilities(...args) as unknown,
}));
vi.mock("../skills/skill-library", () => ({ listSkills: vi.fn() }));

interface RpcResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}
let rpcResult: RpcResult = { data: "agent-1", error: null };
const rpc = vi.fn((_name: string, _args: Record<string, unknown>) => Promise.resolve(rpcResult));
vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc }),
}));

import { AgentLibraryError, agentCreator } from "./agent-library";

const WORKSPACE = "14100000-0000-4000-8000-0000000000a1";
const SKILL = "14100000-0000-4000-8000-0000000000b1";

const CATALOG = [
  { key: "vault.read", tier: 0, enabled: true },
  { key: "vault.read_private", tier: 0, enabled: true },
  { key: "web.search", tier: 1, enabled: true },
  { key: "message.send_outbound", tier: 3, enabled: true },
  { key: "email.send", tier: 3, enabled: true },
  { key: "old.thing", tier: 1, enabled: false },
];

const input = {
  workspaceId: WORKSPACE,
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5" as const,
  prompt: "Find sources.",
  skillIds: [SKILL],
  capabilities: [{ key: "vault.read", mode: "automatic" as const }],
  dailyBudget: 500,
};

beforeEach(() => {
  rpc.mockClear();
  rpcResult = { data: "agent-1", error: null };
  requireWorkspaceRole.mockReset();
  requireWorkspaceRole.mockResolvedValue({ userId: "u", workspaceId: WORKSPACE, role: "owner" });
  listCapabilities.mockReset();
  listCapabilities.mockResolvedValue(CATALOG);
});

describe("agentCreator.createAgent", () => {
  it("requires the owner role", async () => {
    await agentCreator.createAgent(input);
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE, "owner");
  });

  it("does nothing for a member or viewer", async () => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    await expect(agentCreator.createAgent(input)).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("creates the agent with one create_agent call and no mode or status argument", async () => {
    await expect(agentCreator.createAgent(input)).resolves.toEqual({ id: "agent-1" });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] ?? [];
    expect(name).toBe("create_agent");
    expect(args).toEqual({
      p_workspace_id: WORKSPACE,
      p_name: "Scout",
      p_role: "Researcher",
      p_model: "claude-haiku-5-5",
      p_prompt: "Find sources.",
      p_daily_budget_cents: 500,
      p_skill_ids: [SKILL],
      p_capabilities: [{ key: "vault.read", mode: "automatic" }],
    });
  });

  it("refuses an automatic tier 3 capability before the database is called (tampered request)", async () => {
    await expect(
      agentCreator.createAgent({
        ...input,
        capabilities: [{ key: "email.send", mode: "automatic" }],
      }),
    ).rejects.toMatchObject({ code: "invalid", field: "capabilities" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts a tier 3 capability that needs approval", async () => {
    await agentCreator.createAgent({
      ...input,
      capabilities: [{ key: "email.send", mode: "approval" }],
    });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_capabilities: [{ key: "email.send", mode: "approval" }],
    });
  });

  it("AGO-138: refuses untrusted content + private data + outbound with an explanation, before the database", async () => {
    const error = await agentCreator
      .createAgent({
        ...input,
        capabilities: [
          { key: "web.search", mode: "automatic" },
          { key: "vault.read_private", mode: "automatic" },
          { key: "message.send_outbound", mode: "approval" },
        ],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentLibraryError);
    expect(error).toMatchObject({ code: "invalid", field: "capabilities" });
    expect((error as Error).message).toMatch(/^Capabilities: this combination is blocked/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("AGO-138: accepts any two of the three", async () => {
    await agentCreator.createAgent({
      ...input,
      capabilities: [
        { key: "web.search", mode: "automatic" },
        { key: "vault.read_private", mode: "automatic" },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses unknown and disabled capabilities", async () => {
    for (const key of ["no.such", "old.thing"]) {
      await expect(
        agentCreator.createAgent({ ...input, capabilities: [{ key, mode: "approval" }] }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "forbidden"],
    ["23505", "name_taken"],
    ["22023", "invalid"],
    ["XX000", "failed"],
  ])("maps database error %s to %s", async (code, expected) => {
    rpcResult = { data: null, error: { code, message: "boom" } };
    const error = await agentCreator.createAgent(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentLibraryError);
    expect(error).toMatchObject({ code: expected });
  });

  it("maps a missing skill to the skills field and a missing capability to the capabilities field", async () => {
    rpcResult = { data: null, error: { code: "P0002", message: "a skill does not exist" } };
    await expect(agentCreator.createAgent(input)).rejects.toMatchObject({ field: "skillIds" });
    rpcResult = { data: null, error: { code: "P0002", message: "capability x is not available" } };
    await expect(agentCreator.createAgent(input)).rejects.toMatchObject({ field: "capabilities" });
  });
});
