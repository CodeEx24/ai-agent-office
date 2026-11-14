import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const exportAgentPack = vi.fn();
const requireWorkspaceRole = vi.fn();
const createSupabaseServerClient = vi.fn();

vi.mock("../../../../features/packs/export-agent-pack", () => {
  class ExportAgentPackError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    ExportAgentPackError,
    exportAgentPack: (...args: unknown[]) => exportAgentPack(...args) as unknown,
  };
});
vi.mock("../../../../features/workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    readonly code: "unauthenticated" | "forbidden";
    constructor(code: "unauthenticated" | "forbidden") {
      super(code);
      this.code = code;
    }
  }
  return {
    WorkspaceAccessError,
    requireWorkspaceRole: (...args: unknown[]) => requireWorkspaceRole(...args) as unknown,
  };
});
vi.mock("../../../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => createSupabaseServerClient() as unknown,
}));

import type { NextRequest } from "next/server";

import { ExportAgentPackError } from "../../../../features/packs/export-agent-pack";
import { WorkspaceAccessError } from "../../../../features/workspaces/workspace-access";
import { POST } from "./route";

const WORKSPACE_ID = "19200000-0000-4000-8000-0000000000a1";
const AGENT_ID = "19200000-0000-4000-8000-0000000002a1";
const CHECKSUM = "ab".repeat(32);
const PACK_JSON = '{"agents":[]}\n';

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    headers: new Headers({ "content-type": "application/json", ...headers }),
    nextUrl: { pathname: "/api/agent-packs/export" },
    json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
  } as unknown as NextRequest;
}

describe("POST /api/agent-packs/export", () => {
  beforeEach(() => {
    exportAgentPack.mockReset();
    requireWorkspaceRole.mockReset();
    createSupabaseServerClient.mockReset();
    requireWorkspaceRole.mockResolvedValue(undefined);
    createSupabaseServerClient.mockResolvedValue({ tag: "client" });
    exportAgentPack.mockResolvedValue({
      json: PACK_JSON,
      checksum: CHECKSUM,
      fileName: "agent-pack-abababababab.json",
      pack: { agents: [], skills: [] },
      eventId: "19200000-0000-4000-8000-0000000017a1",
    });
  });

  it("returns the pack as an uncached download, for a member", async () => {
    const response = await POST(
      request({ workspace_id: WORKSPACE_ID, agent_ids: [AGENT_ID], name: "My pack" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PACK_JSON);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="agent-pack-abababababab.json"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-pack-checksum")).toBe(CHECKSUM);
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE_ID, "member");
    expect(exportAgentPack).toHaveBeenCalledWith(
      { tag: "client" },
      { workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID], name: "My pack" },
    );
  });

  it("exports every active agent when agent_ids is omitted", async () => {
    await POST(request({ workspace_id: WORKSPACE_ID }));
    expect(exportAgentPack).toHaveBeenCalledWith(
      { tag: "client" },
      { workspaceId: WORKSPACE_ID, agentIds: undefined, name: undefined },
    );
  });

  it("refuses an agent credential first, before any role check or read", async () => {
    // Built at runtime so no credential-looking literal sits in the repo.
    const agentToken = `ago_agt_${"x".repeat(32)}`;
    const response = await POST(
      request({ workspace_id: WORKSPACE_ID }, { authorization: `Bearer ${agentToken}` }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "agent_credential_not_allowed" });
    expect(requireWorkspaceRole).not.toHaveBeenCalled();
    expect(exportAgentPack).not.toHaveBeenCalled();
  });

  it("answers 415 for a body that is not JSON", async () => {
    const response = await POST(request({}, { "content-type": "text/plain" }));
    expect(response.status).toBe(415);
    expect(exportAgentPack).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that cannot be parsed", async () => {
    const response = await POST(request(new SyntaxError("bad json")));
    expect(response.status).toBe(400);
    expect(exportAgentPack).not.toHaveBeenCalled();
  });

  it.each([
    ["no workspace", {}],
    ["a bad workspace id", { workspace_id: "not-a-uuid" }],
    ["an unknown field", { workspace_id: WORKSPACE_ID, role: "owner" }],
    ["an empty agent list", { workspace_id: WORKSPACE_ID, agent_ids: [] }],
    ["a bad agent id", { workspace_id: WORKSPACE_ID, agent_ids: ["nope"] }],
    ["a blank name", { workspace_id: WORKSPACE_ID, name: "   " }],
  ])("answers 400 and exports nothing for %s", async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(requireWorkspaceRole).not.toHaveBeenCalled();
    expect(exportAgentPack).not.toHaveBeenCalled();
  });

  it("answers 401 for a signed-out caller and exports nothing", async () => {
    requireWorkspaceRole.mockRejectedValue(new WorkspaceAccessError("unauthenticated"));
    const response = await POST(request({ workspace_id: WORKSPACE_ID }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(exportAgentPack).not.toHaveBeenCalled();
  });

  it("answers 403 for a viewer or a non-member and exports nothing", async () => {
    requireWorkspaceRole.mockRejectedValue(new WorkspaceAccessError("forbidden"));
    const response = await POST(request({ workspace_id: WORKSPACE_ID }));
    expect(response.status).toBe(403);
    expect(exportAgentPack).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404],
    ["no_agents", 404],
    ["forbidden", 403],
    ["invalid_pack", 422],
    ["failed", 500],
  ])("maps the %s failure to %i and returns only the code", async (code, status) => {
    exportAgentPack.mockRejectedValue(new ExportAgentPackError(code as never));
    const response = await POST(request({ workspace_id: WORKSPACE_ID }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not swallow an unexpected error", async () => {
    exportAgentPack.mockRejectedValue(new Error("boom"));
    await expect(POST(request({ workspace_id: WORKSPACE_ID }))).rejects.toThrow("boom");
  });
});
