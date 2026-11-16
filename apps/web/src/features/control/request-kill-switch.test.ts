import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const requireWorkspaceRole = vi.fn();

vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc }),
}));
vi.mock("../workspaces/workspace-access", () => ({
  requireWorkspaceRole: (...args: unknown[]) => requireWorkspaceRole(...args) as unknown,
}));

import { activateKillSwitch, KillSwitchError, releaseKillSwitch } from "./request-kill-switch";

const WORKSPACE_ID = "84000000-0000-4000-8000-0000000000a1";
const AGENT_ID = "84000000-0000-4000-8000-0000000000a2";
const WORKSPACE_SCOPE = { workspace_id: WORKSPACE_ID, scope: "workspace" } as const;

describe("request-kill-switch", () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({
      data: { runs_stopped: 2, credentials_revoked: 5 },
      error: null,
    });
    requireWorkspaceRole.mockReset().mockResolvedValue({ userId: "u", workspaceId: WORKSPACE_ID });
  });

  it("checks the OWNER role first, then calls the one database function with the caller's session", async () => {
    await expect(activateKillSwitch(WORKSPACE_SCOPE)).resolves.toEqual({
      runs_stopped: 2,
      credentials_revoked: 5,
    });
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE_ID, "owner");
    expect(rpc).toHaveBeenCalledWith("activate_kill_switch", {
      p_workspace_id: WORKSPACE_ID,
      p_scope: "workspace",
      p_agent_id: null,
    });
  });

  it("passes the agent for an agent scope and uses the release function to release", async () => {
    await releaseKillSwitch({ workspace_id: WORKSPACE_ID, scope: "agent", agent_id: AGENT_ID });
    expect(rpc).toHaveBeenCalledWith("release_kill_switch", {
      p_workspace_id: WORKSPACE_ID,
      p_scope: "agent",
      p_agent_id: AGENT_ID,
    });
  });

  it("never reaches the database when the caller is not an owner", async () => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    await expect(activateKillSwitch(WORKSPACE_SCOPE)).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("throws KillSwitchError when the database fails or answers an unexpected shape", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    await expect(activateKillSwitch(WORKSPACE_SCOPE)).rejects.toBeInstanceOf(KillSwitchError);
    rpc.mockResolvedValueOnce({ data: { runs_stopped: "many" }, error: null });
    await expect(activateKillSwitch(WORKSPACE_SCOPE)).rejects.toBeInstanceOf(KillSwitchError);
  });
});
