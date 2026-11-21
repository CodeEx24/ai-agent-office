import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireWorkspaceRole = vi.fn();
const rpc = vi.fn();
const update = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn();

vi.mock("../workspaces/workspace-access", () => ({
  requireWorkspaceRole: (...args: unknown[]) => requireWorkspaceRole(...args) as unknown,
}));
vi.mock("../../lib/supabase/server", () => {
  const chain = {
    select: () => chain,
    eq: (...args: unknown[]) => {
      eq(...args);
      return chain;
    },
    maybeSingle: () => maybeSingle() as unknown,
  };
  return {
    createSupabaseServerClient: () =>
      Promise.resolve({
        from: () => ({ ...chain, update }),
        rpc: (...args: unknown[]) => rpc(...args) as unknown,
      }),
  };
});

import { CapabilityRefusedError } from "./enable-capability";
import { capabilityEnabler } from "./capability-enabler";

const WORKSPACE_ID = "85500000-0000-4000-8000-0000000000a1";
const OTHER_WORKSPACE_ID = "85500000-0000-4000-8000-0000000000b1";
const CAPABILITY_ID = "85500000-0000-4000-8000-0000000000c1";
const INPUT = { workspaceId: WORKSPACE_ID, capabilityId: CAPABILITY_ID };

describe("AC1: capabilityEnabler.enable (the only write path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceRole.mockResolvedValue({
      userId: "u",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });
    rpc.mockResolvedValue({ error: null });
  });

  it("turns a capability on through the enable_capability function only, never a table update", async () => {
    await capabilityEnabler.enable(INPUT);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("enable_capability", {
      p_workspace_id: WORKSPACE_ID,
      p_capability_id: CAPABILITY_ID,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("requires the owner role before calling the database", async () => {
    await capabilityEnabler.enable(INPUT);
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE_ID, "owner");
  });

  it("does not call the database when the caller is not an owner", async () => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    await expect(capabilityEnabler.enable(INPUT)).rejects.toThrow("forbidden");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends the workspace id the access check approved, not the one in the input", async () => {
    requireWorkspaceRole.mockResolvedValue({
      userId: "u",
      workspaceId: OTHER_WORKSPACE_ID,
      role: "owner",
    });
    await capabilityEnabler.enable(INPUT);
    expect(rpc).toHaveBeenCalledWith("enable_capability", {
      p_workspace_id: OTHER_WORKSPACE_ID,
      p_capability_id: CAPABILITY_ID,
    });
  });

  it("raises CapabilityRefusedError when the database refuses on a prerequisite (55000)", async () => {
    rpc.mockResolvedValue({
      error: { code: "55000", message: "prerequisite check not passing: sandbox_hardened" },
    });
    await expect(capabilityEnabler.enable(INPUT)).rejects.toBeInstanceOf(CapabilityRefusedError);
  });

  it("raises a generic error that hides the database text on any other failure", async () => {
    rpc.mockResolvedValue({
      error: { code: "42501", message: "only workspace owners can enable" },
    });
    const failure: unknown = await capabilityEnabler.enable(INPUT).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CapabilityRefusedError);
    expect((failure as Error).message).toBe("capability enable failed");
  });
});

describe("AC1: capabilityEnabler.find", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceRole.mockResolvedValue({
      userId: "u",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });
  });

  it("scopes the lookup to the approved workspace and the capability id", async () => {
    maybeSingle.mockResolvedValue({ data: { key: "code.run", enabled: false }, error: null });
    const found = await capabilityEnabler.find(INPUT);
    expect(found).toEqual({ key: "code.run", isEnabled: false });
    expect(eq).toHaveBeenCalledWith("workspace_id", WORKSPACE_ID);
    expect(eq).toHaveBeenCalledWith("id", CAPABILITY_ID);
  });

  it("returns null when the capability is not in the workspace", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await capabilityEnabler.find(INPUT)).toBeNull();
  });

  it("fails closed when the lookup errors", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(capabilityEnabler.find(INPUT)).rejects.toThrow("capability lookup failed");
  });
});
