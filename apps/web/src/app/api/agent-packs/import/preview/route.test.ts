import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const previewAgentPackImport = vi.fn();
const requireWorkspaceRole = vi.fn();
const createSupabaseServerClient = vi.fn();

vi.mock("../../../../../features/packs/preview-agent-pack-import", () => {
  class PreviewPackImportError extends Error {
    readonly code = "failed";
  }
  return {
    PreviewPackImportError,
    previewAgentPackImport: (...args: unknown[]) => previewAgentPackImport(...args) as unknown,
  };
});
vi.mock("../../../../../features/workspaces/workspace-access", () => {
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
vi.mock("../../../../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => createSupabaseServerClient() as unknown,
}));

import { MAX_PACK_BYTES } from "@ago/shared/pack-import-preview";
import type { NextRequest } from "next/server";

import { PreviewPackImportError } from "../../../../../features/packs/preview-agent-pack-import";
import { WorkspaceAccessError } from "../../../../../features/workspaces/workspace-access";
import { POST } from "./route";

const WORKSPACE_ID = "19300000-0000-4000-8000-0000000000a1";
const OTHER_WORKSPACE_ID = "19300000-0000-4000-8000-0000000000b1";
const PACK_TEXT = '{"packVersion":1}';

function bodyOf(body: string | ReadableStream<Uint8Array> | null | undefined) {
  if (body === undefined) return new Response(PACK_TEXT).body;
  if (typeof body === "string") return new Response(body).body;
  return body;
}

function request(
  options: {
    query?: string;
    body?: string | ReadableStream<Uint8Array> | null;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const query = options.query ?? `workspace_id=${WORKSPACE_ID}`;
  return {
    headers: new Headers({ "content-type": "application/json", ...options.headers }),
    nextUrl: {
      pathname: "/api/agent-packs/import/preview",
      searchParams: new URLSearchParams(query),
    },
    body: bodyOf(options.body),
  } as unknown as NextRequest;
}

const PREVIEW = { importable: true, agents: [], skills: [] };

describe("POST /api/agent-packs/import/preview", () => {
  beforeEach(() => {
    previewAgentPackImport.mockReset();
    requireWorkspaceRole.mockReset();
    createSupabaseServerClient.mockReset();
    requireWorkspaceRole.mockResolvedValue(undefined);
    createSupabaseServerClient.mockResolvedValue({ tag: "client" });
    previewAgentPackImport.mockResolvedValue({ ok: true, preview: PREVIEW });
  });

  it("returns the preview, uncached, for an owner of the workspace", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PREVIEW);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WORKSPACE_ID, "owner");
    expect(previewAgentPackImport).toHaveBeenCalledWith(
      { tag: "client" },
      { workspaceId: WORKSPACE_ID, text: PACK_TEXT },
    );
  });

  it("refuses an agent credential first, before any role check or read", async () => {
    // Built at runtime so no credential-looking literal sits in the repo.
    const agentToken = `ago_agt_${"x".repeat(32)}`;
    const response = await POST(request({ headers: { authorization: `Bearer ${agentToken}` } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "agent_credential_not_allowed" });
    expect(requireWorkspaceRole).not.toHaveBeenCalled();
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 415 for a body that is not declared as JSON", async () => {
    const response = await POST(request({ headers: { "content-type": "text/plain" } }));
    expect(response.status).toBe(415);
    expect(requireWorkspaceRole).not.toHaveBeenCalled();
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it.each([
    ["no workspace", ""],
    ["a bad workspace id", "workspace_id=not-a-uuid"],
    ["an unknown parameter", `workspace_id=${WORKSPACE_ID}&role=owner`],
  ])("answers 400 for %s", async (_label, query) => {
    const response = await POST(request({ query }));
    expect(response.status).toBe(400);
    expect(requireWorkspaceRole).not.toHaveBeenCalled();
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 401 for a signed-out caller and reads nothing", async () => {
    requireWorkspaceRole.mockRejectedValue(new WorkspaceAccessError("unauthenticated"));
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 403 for a member or viewer and for another workspace's owner, reading nothing", async () => {
    requireWorkspaceRole.mockRejectedValue(new WorkspaceAccessError("forbidden"));
    const response = await POST(request({ query: `workspace_id=${OTHER_WORKSPACE_ID}` }));
    expect(response.status).toBe(403);
    expect(requireWorkspaceRole).toHaveBeenCalledWith(OTHER_WORKSPACE_ID, "owner");
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it("authorizes before it reads the body", async () => {
    requireWorkspaceRole.mockRejectedValue(new WorkspaceAccessError("forbidden"));
    let pulled = false;
    // highWaterMark 0: a stream otherwise pulls one chunk as soon as it is built.
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await POST(request({ body }));
    expect(pulled).toBe(false);
  });

  it("answers 413 for a declared length over the limit without reading the body", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await POST(
      request({ body, headers: { "content-length": String(MAX_PACK_BYTES + 1) } }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "too_large" });
    expect(pulled).toBe(false);
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it("answers 413 when the streamed body passes the limit despite a false length", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 8) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await POST(request({ body, headers: { "content-length": "10" } }));
    expect(response.status).toBe(413);
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_json", 422],
    ["too_many_agents", 422],
    ["too_deep", 422],
    ["invalid_pack", 422],
  ])("maps the %s rejection to %i with its fixed message and issues", async (code, status) => {
    previewAgentPackImport.mockResolvedValue({
      ok: false,
      error: { code, message: "fixed message", issues: [{ path: "agents.0", message: "bad" }] },
    });
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: code,
      message: "fixed message",
      issues: [{ path: "agents.0", message: "bad" }],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns 200 with importable false for a blocked preview", async () => {
    previewAgentPackImport.mockResolvedValue({
      ok: true,
      preview: { ...PREVIEW, importable: false },
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ importable: false });
  });

  it("answers 500 with only a code when the workspace read fails", async () => {
    previewAgentPackImport.mockRejectedValue(new PreviewPackImportError());
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "failed" });
  });

  it("does not swallow an unexpected error", async () => {
    previewAgentPackImport.mockRejectedValue(new Error("boom"));
    await expect(POST(request())).rejects.toThrow("boom");
  });
});
