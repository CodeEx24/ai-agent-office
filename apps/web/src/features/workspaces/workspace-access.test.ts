import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock("../auth/current-user", () => ({ getCurrentUser: () => getCurrentUser() as unknown }));
vi.mock("../../lib/supabase/server", () => {
  // from().select().eq().eq().is().maybeSingle(): the chain requireWorkspaceRole builds.
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => maybeSingle() as unknown,
  };
  return { createSupabaseServerClient: () => Promise.resolve({ from: () => chain }) };
});

import { WorkspaceAccessError, requireWorkspaceRole } from "./workspace-access";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return error.code;
    throw error;
  }
  return "allowed";
}

describe("requireWorkspaceRole", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: "user-1" });
    maybeSingle.mockResolvedValue({ data: { role: "member" }, error: null });
  });

  it("returns the caller's access when the role is high enough", async () => {
    await expect(requireWorkspaceRole(WORKSPACE_ID, "member")).resolves.toEqual({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "member",
    });
    await expect(requireWorkspaceRole(WORKSPACE_ID, "viewer")).resolves.toMatchObject({
      role: "member",
    });
  });

  it("denies a role below the minimum", async () => {
    expect(await outcome(requireWorkspaceRole(WORKSPACE_ID, "owner"))).toBe("forbidden");
  });

  it("denies a viewer who asks for member", async () => {
    maybeSingle.mockResolvedValue({ data: { role: "viewer" }, error: null });
    expect(await outcome(requireWorkspaceRole(WORKSPACE_ID, "member"))).toBe("forbidden");
  });

  it("allows an owner at every level", async () => {
    maybeSingle.mockResolvedValue({ data: { role: "owner" }, error: null });
    expect(await outcome(requireWorkspaceRole(WORKSPACE_ID, "owner"))).toBe("allowed");
  });

  it("denies when the user has no membership in the workspace", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await outcome(requireWorkspaceRole(WORKSPACE_ID, "viewer"))).toBe("forbidden");
  });

  it("denies on a query error", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await outcome(requireWorkspaceRole(WORKSPACE_ID, "viewer"))).toBe("forbidden");
  });

  it("denies an unknown stored role instead of guessing", async () => {
    maybeSingle.mockResolvedValue({ data: { role: "superadmin" }, error: null });
    expect(await outcome(requireWorkspaceRole(WORKSPACE_ID, "viewer"))).toBe("forbidden");
  });

  it("denies a workspace id that is not a uuid, without querying", async () => {
    expect(await outcome(requireWorkspaceRole("not-a-uuid", "viewer"))).toBe("forbidden");
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("reports signed-out callers as unauthenticated", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect(await outcome(requireWorkspaceRole(WORKSPACE_ID, "viewer"))).toBe("unauthenticated");
    expect(maybeSingle).not.toHaveBeenCalled();
  });
});
