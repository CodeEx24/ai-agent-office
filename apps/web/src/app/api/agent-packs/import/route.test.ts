import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const applyAgentPackImport = vi.fn();
const requireWorkspaceRole = vi.fn();
const createSupabaseServerClient = vi.fn();

vi.mock("../../../../features/packs/apply-agent-pack-import", () => {
  class ApplyPackImportError extends Error {
    readonly code: "forbidden" | "stale" | "invalid" | "failed";
    constructor(code: "forbidden" | "stale" | "invalid" | "failed") {
      super(code);
      this.code = code;
    }
  }
  return {
    ApplyPackImportError,
    applyAgentPackImport: (...args: unknown[]) => applyAgentPackImport(...args) as unknown,
  };
});
vi.mock("../../../../features/packs/preview-agent-pack-import", () => {
  class PreviewPackImportError extends Error {
    readonly code = "failed";
  }
  return { PreviewPackImportError };
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

import { MAX_PACK_BYTES } from "@ago/shared/pack-import-preview";
import type { NextRequest } from "next/server";

import { ApplyPackImportError } from "../../../../features/packs/apply-agent-pack-import";
import { WorkspaceAccessError } from "../../../../features/workspaces/workspace-access";
import { POST } from "./route";

const WORKSPACE_ID = "19400000-0000-4000-8000-0000000000a1";
const PACK_TEXT = '{"packVersion":1}';

function request(
  options: { query?: string; body?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return {
    headers: new Headers({ "content-type": "application/json", ...options.headers }),
    nextUrl: {
      pathname: "/api/agent-packs/import",
      searchParams: new URLSearchParams(options.query ?? `workspace_id=${WORKSPACE_ID}`),
    },
    body: new Response(options.body ?? PACK_TEXT).body,
  } as unknown as NextRequest;
}

const REPORT = { importable: true, applied: true, eventId: "event-1" };

describe("POST /api/agent-packs/import", () => {
  beforeEach(() => {
    applyAgentPackImport.mockReset();
    requireWorkspaceRole.mockReset();
    createSupabaseServerClient.mockReset();
    requireWorkspaceRole.mockResolvedValue(undefined);
    createSupabaseServerClient.mockResolvedValue({ tag: "client" });
    applyAgentPackImport.mockResolvedValue({ ok: true, report: REPORT });
  });

  it("imports for an owner, uncached, with the default rule skip", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(REPORT);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE_ID, "owner");
    expect(applyAgentPackImport).toHaveBeenCalledWith(
      { tag: "client" },
      { workspaceId: WORKSPACE_ID, text: PACK_TEXT, conflictRule: "skip" },
    );
  });

  it.each(["skip", "rename", "new_version"])("passes the %s rule through", async (rule) => {
    await POST(request({ query: `workspace_id=${WORKSPACE_ID}&conflict=${rule}` }));
    expect(applyAgentPackImport).toHaveBeenCalledWith(
      { tag: "client" },
      expect.objectContaining({ conflictRule: rule }),
    );
  });

  it("refuses an agent credential first, before any role check, read or write", async () => {
    // Built at runtime so no credential-looking literal sits in the repo.
    const agentToken = `ago_agt_${"x".repeat(32)}`;
    const response = await POST(request({ headers: { authorization: `Bearer ${agentToken}` } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "agent_credential_not_allowed" });
    expect(requireWorkspaceRole).not.toHaveBeenCalled();
    expect(applyAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 415 for a body that is not declared as JSON", async () => {
    const response = await POST(request({ headers: { "content-type": "text/plain" } }));
    expect(response.status).toBe(415);
    expect(applyAgentPackImport).not.toHaveBeenCalled();
  });

  it.each([
    ["no workspace", ""],
    ["a workspace that is not a uuid", "workspace_id=nope"],
    ["an unknown rule", `workspace_id=${WORKSPACE_ID}&conflict=overwrite`],
    ["an unknown parameter", `workspace_id=${WORKSPACE_ID}&force=1`],
  ])("answers 400 for %s", async (_name, query) => {
    const response = await POST(request({ query }));
    expect(response.status).toBe(400);
    expect(requireWorkspaceRole).not.toHaveBeenCalled();
    expect(applyAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 403 for a member who is not an owner, before the body is read or anything is written", async () => {
    requireWorkspaceRole.mockRejectedValue(new WorkspaceAccessError("forbidden"));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
    expect(applyAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 401 when signed out", async () => {
    requireWorkspaceRole.mockRejectedValue(new WorkspaceAccessError("unauthenticated"));
    expect((await POST(request())).status).toBe(401);
    expect(applyAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over the size limit, before the apply", async () => {
    const response = await POST(request({ body: "x".repeat(MAX_PACK_BYTES + 1) }));
    expect(response.status).toBe(413);
    expect(applyAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 422 with the fixed rejection for a pack that is not valid", async () => {
    applyAgentPackImport.mockResolvedValue({
      ok: false,
      error: {
        code: "invalid_pack",
        message: "The file is not a valid agent pack (1 problem).",
        issues: [],
      },
    });
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_pack" });
  });

  it("answers 422 with the report for a pack that is blocked, and says nothing was written", async () => {
    applyAgentPackImport.mockResolvedValue({ ok: false, blocked: { importable: false } });
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "not_importable",
      report: { importable: false },
    });
  });

  it.each([
    ["forbidden", 403],
    ["stale", 409],
    ["invalid", 422],
    ["failed", 500],
  ] as const)("maps a database %s to %i with no database text", async (code, status) => {
    applyAgentPackImport.mockRejectedValue(new ApplyPackImportError(code));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
});
