import { beforeEach, describe, expect, it, vi } from "vitest";

// AGO-99: the real editors, with the Supabase client replaced. Pins that (a) a mode change is ONE set_agent_mode
// call whose arguments carry no actor and no timestamp, owner role first, (b) every database error maps to a
// safe code, and (c) a duplicate asks for no mode at all, so the copy lands in the column default: Strict.
const rpc = vi.hoisted(() => vi.fn());
const requireWorkspaceRole = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc }),
}));
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError, requireWorkspaceRole };
});

import { agentEditor } from "./agent-editor";
import { agentModeEditor } from "./agent-mode-editor";

const WORKSPACE = "99000000-0000-4000-8000-0000000000a1";
const AGENT = "99000000-0000-4000-8000-0000000000b1";

describe("agentModeEditor.setAgentMode", () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ error: null });
    requireWorkspaceRole.mockReset().mockResolvedValue({ workspaceId: WORKSPACE, userId: "u1" });
  });

  it("requires the owner role and makes one set_agent_mode call with no actor or time", async () => {
    await agentModeEditor.setAgentMode({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      mode: "standard",
      confirm: "on",
    });
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE, "owner");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_agent_mode", {
      p_workspace_id: WORKSPACE,
      p_agent_id: AGENT,
      p_mode: "standard",
    });
  });

  it("does not touch the database for a member or viewer", async () => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    await expect(
      agentModeEditor.setAgentMode({
        workspaceId: WORKSPACE,
        agentId: AGENT,
        mode: "relaxed",
        confirm: "on",
      }),
    ).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "forbidden"],
    ["P0002", "not_found"],
    ["55000", "archived"],
    ["AGM01", "unchanged"],
    ["22023", "invalid"],
    ["XX000", "failed"],
    [undefined, "failed"],
  ])("maps database error %s to %s", async (sqlState, code) => {
    rpc.mockResolvedValue({ error: { code: sqlState, message: "secret database text" } });
    await expect(
      agentModeEditor.setAgentMode({
        workspaceId: WORKSPACE,
        agentId: AGENT,
        mode: "relaxed",
        confirm: "on",
      }),
    ).rejects.toMatchObject({ name: "AgentModeError", code, message: `Agent mode error: ${code}` });
  });
});

describe("a duplicate starts in Strict (AGO-99 AC1)", () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: "copy-1", error: null });
    requireWorkspaceRole.mockReset().mockResolvedValue({ workspaceId: WORKSPACE, userId: "u1" });
  });

  it("calls duplicate_agent with no mode argument, so the database default (strict) applies", async () => {
    await agentEditor.duplicateAgent({ workspaceId: WORKSPACE, agentId: AGENT, name: "Copy" });
    expect(rpc).toHaveBeenCalledWith("duplicate_agent", {
      p_workspace_id: WORKSPACE,
      p_agent_id: AGENT,
      p_name: "Copy",
    });
    const call = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(call[1]).some((key) => /mode/i.test(key))).toBe(false);
  });
});
