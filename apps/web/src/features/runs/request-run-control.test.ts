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

import { RunControlError, requestRunControl } from "./request-run-control";

const INPUT = {
  runId: "86000000-0000-4000-8000-0000000000b2",
  workspaceId: "86000000-0000-4000-8000-0000000000a1",
  action: "stop",
} as const;

describe("requestRunControl", () => {
  beforeEach(() => {
    rpc.mockReset();
    requireWorkspaceRole.mockReset();
    requireWorkspaceRole.mockResolvedValue({ userId: "u", workspaceId: INPUT.workspaceId });
    rpc.mockResolvedValue({ data: "accepted", error: null });
  });

  it("checks the member role first, then calls the one database function with the caller's session", async () => {
    await expect(requestRunControl(INPUT)).resolves.toBe("accepted");
    expect(requireWorkspaceRole).toHaveBeenCalledWith(INPUT.workspaceId, "member");
    expect(rpc).toHaveBeenCalledWith("request_run_control", {
      p_workspace_id: INPUT.workspaceId,
      p_run_id: INPUT.runId,
      p_action: "stop",
    });
  });

  it("does not reach the database when the caller is not a member", async () => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    await expect(requestRunControl(INPUT)).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes through not_applicable", async () => {
    rpc.mockResolvedValue({ data: "not_applicable", error: null });
    await expect(requestRunControl(INPUT)).resolves.toBe("not_applicable");
  });

  it("fails closed on a database error or an unexpected answer", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(requestRunControl(INPUT)).rejects.toBeInstanceOf(RunControlError);
    rpc.mockResolvedValue({ data: "done", error: null });
    await expect(requestRunControl(INPUT)).rejects.toBeInstanceOf(RunControlError);
  });
});
