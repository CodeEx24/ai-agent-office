import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const listCapabilities = vi.fn();

vi.mock("../../../features/capabilities/capability-catalog", () => {
  class CapabilityCatalogError extends Error {}
  return {
    CapabilityCatalogError,
    listCapabilities: (...args: unknown[]) => listCapabilities(...args) as unknown,
  };
});
vi.mock("../../../features/workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError };
});

import type { NextRequest } from "next/server";

import { CapabilityCatalogError } from "../../../features/capabilities/capability-catalog";
import { WorkspaceAccessError } from "../../../features/workspaces/workspace-access";
import { GET } from "./route";

const WORKSPACE_ID = "12500000-0000-4000-8000-0000000000a1";

function request(search: string): NextRequest {
  const url = new URL(`http://localhost/api/capabilities${search}`);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

describe("GET /api/capabilities", () => {
  beforeEach(() => {
    listCapabilities.mockResolvedValue([]);
  });

  it("returns the catalog, uncached", async () => {
    listCapabilities.mockResolvedValue([{ key: "vault.read" }]);
    const response = await GET(request(`?workspace_id=${WORKSPACE_ID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ capabilities: [{ key: "vault.read" }] });
    expect(listCapabilities).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it.each(["", "?workspace_id=not-a-uuid", `?workspace_id=${WORKSPACE_ID}&extra=1`])(
    "answers 400 and reads nothing for bad input %j",
    async (search) => {
      listCapabilities.mockClear();
      const response = await GET(request(search));
      expect(response.status).toBe(400);
      expect(listCapabilities).not.toHaveBeenCalled();
    },
  );

  it("answers 401 for a signed-out caller", async () => {
    listCapabilities.mockRejectedValue(new WorkspaceAccessError("unauthenticated"));
    const response = await GET(request(`?workspace_id=${WORKSPACE_ID}`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("answers 403 for a caller who is not a member", async () => {
    listCapabilities.mockRejectedValue(new WorkspaceAccessError("forbidden"));
    const response = await GET(request(`?workspace_id=${WORKSPACE_ID}`));
    expect(response.status).toBe(403);
  });

  it("answers 500 with no detail when the catalog is unavailable", async () => {
    listCapabilities.mockRejectedValue(new CapabilityCatalogError());
    const response = await GET(request(`?workspace_id=${WORKSPACE_ID}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "catalog_unavailable" });
  });
});
