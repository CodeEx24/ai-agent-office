import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireWorkspaceRole = vi.fn();
const order = vi.fn();
const eq = vi.fn();

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
vi.mock("../../lib/supabase/server", () => {
  // from().select().eq().order().order(): the chain listCapabilities builds.
  const chain = {
    select: () => chain,
    eq: (...args: unknown[]) => {
      eq(...args);
      return chain;
    },
    order: () => order() as unknown,
  };
  return { createSupabaseServerClient: () => Promise.resolve({ from: () => chain }) };
});

import { CapabilityCatalogError, listCapabilities } from "./capability-catalog";

const WORKSPACE_ID = "12500000-0000-4000-8000-0000000000a1";

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "12500000-0000-4000-8000-0000000000c1",
    workspace_id: WORKSPACE_ID,
    key: "vault.read",
    name: "Read shared notes",
    description: "Read notes in the shared vault.",
    tier: 0,
    scope: "workspace",
    default_mode: "automatic",
    enabled: true,
    created_at: "2026-11-06T00:00:00+00:00",
    updated_at: "2026-11-06T00:00:00+00:00",
    ...overrides,
  };
}

describe("listCapabilities", () => {
  beforeEach(() => {
    requireWorkspaceRole.mockResolvedValue({
      userId: "u",
      workspaceId: WORKSPACE_ID,
      role: "viewer",
    });
    order.mockReturnValue({ order: () => Promise.resolve({ data: [dbRow()], error: null }) });
  });

  it("requires at least the viewer role, so every member can read", async () => {
    await listCapabilities(WORKSPACE_ID);
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE_ID, "viewer");
  });

  it("scopes the query to the workspace the access check approved", async () => {
    await listCapabilities(WORKSPACE_ID);
    expect(eq).toHaveBeenCalledWith("workspace_id", WORKSPACE_ID);
  });

  it("maps rows to the API shape", async () => {
    await expect(listCapabilities(WORKSPACE_ID)).resolves.toEqual([
      {
        id: "12500000-0000-4000-8000-0000000000c1",
        workspaceId: WORKSPACE_ID,
        key: "vault.read",
        name: "Read shared notes",
        description: "Read notes in the shared vault.",
        tier: 0,
        scope: "workspace",
        defaultMode: "automatic",
        enabled: true,
        createdAt: "2026-11-06T00:00:00+00:00",
        updatedAt: "2026-11-06T00:00:00+00:00",
      },
    ]);
  });

  it("does not read the database when access is denied", async () => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    order.mockClear();
    await expect(listCapabilities(WORKSPACE_ID)).rejects.toThrow("forbidden");
    expect(order).not.toHaveBeenCalled();
  });

  it("fails closed on a database error", async () => {
    order.mockReturnValue({
      order: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    });
    await expect(listCapabilities(WORKSPACE_ID)).rejects.toBeInstanceOf(CapabilityCatalogError);
  });

  it("fails closed when a stored row breaks the schema (an automatic tier 4 row)", async () => {
    order.mockReturnValue({
      order: () =>
        Promise.resolve({ data: [dbRow({ tier: 4, default_mode: "automatic" })], error: null }),
    });
    await expect(listCapabilities(WORKSPACE_ID)).rejects.toBeInstanceOf(CapabilityCatalogError);
  });
});
