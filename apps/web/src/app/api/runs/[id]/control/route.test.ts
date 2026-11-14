import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requestRunControl = vi.fn();
const recordAgentRouteRejection = vi.fn();

vi.mock("../../../../../features/runs/request-run-control", () => {
  class RunControlError extends Error {}
  return {
    RunControlError,
    requestRunControl: (...args: unknown[]) => requestRunControl(...args) as unknown,
  };
});
vi.mock("../../../../../features/approvals/record-agent-rejection", () => ({
  recordAgentRouteRejection: (...args: unknown[]) => recordAgentRouteRejection(...args) as unknown,
}));
vi.mock("../../../../../features/workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError };
});

import type { NextRequest } from "next/server";

import { RunControlError } from "../../../../../features/runs/request-run-control";
import { WorkspaceAccessError } from "../../../../../features/workspaces/workspace-access";
import { POST } from "./route";

const WORKSPACE_ID = "86000000-0000-4000-8000-0000000000a1";
const RUN_ID = "86000000-0000-4000-8000-0000000000b2";
// Built at runtime: the prefix is what the guard looks at, the rest is not a real token.
const AGENT_BEARER = `Bearer ${["ago", "agt", ""].join("_")}fake.fake.fake`;

function request(body: unknown, authorization?: string): NextRequest {
  const headers = new Headers(authorization ? { authorization } : {});
  return {
    nextUrl: new URL(`http://localhost/api/runs/${RUN_ID}/control`),
    method: "POST",
    headers,
    json: () =>
      body === undefined ? Promise.reject(new SyntaxError("no body")) : Promise.resolve(body),
  } as unknown as NextRequest;
}

const context = (id = RUN_ID) => ({ params: Promise.resolve({ id }) });
const GOOD = { workspace_id: WORKSPACE_ID, action: "pause" };

describe("POST /api/runs/[id]/control", () => {
  beforeEach(() => {
    requestRunControl.mockReset();
    recordAgentRouteRejection.mockReset();
    requestRunControl.mockResolvedValue("accepted");
    recordAgentRouteRejection.mockResolvedValue("recorded");
  });

  it.each(["pause", "resume", "stop"])(
    "AC2: an agent token gets 403 and the rejection is recorded for %s, before anything else runs",
    async (action) => {
      const response = await POST(request({ ...GOOD, action }, AGENT_BEARER), context());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "agent_credential_not_allowed" });
      expect(recordAgentRouteRejection).toHaveBeenCalledWith(
        expect.objectContaining({ pathname: `/api/runs/${RUN_ID}/control`, method: "POST" }),
      );
      expect(requestRunControl).not.toHaveBeenCalled();
    },
  );

  it("refuses an agent token even when the body is invalid (the guard is first)", async () => {
    const response = await POST(request({ nonsense: true }, AGENT_BEARER), context("not-a-uuid"));
    expect(response.status).toBe(403);
    expect(requestRunControl).not.toHaveBeenCalled();
  });

  it.each(["pause", "resume", "stop"])("lets a person %s a run", async (action) => {
    const response = await POST(request({ ...GOOD, action }), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ id: RUN_ID, action, status: "accepted" });
    expect(requestRunControl).toHaveBeenCalledWith({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      action,
    });
    expect(recordAgentRouteRejection).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown action", { ...GOOD, action: "kill" }],
    ["a status", { ...GOOD, status: "stopped" }],
    ["an actor", { ...GOOD, actor: "agent" }],
    ["a missing workspace", { action: "pause" }],
    ["a bad workspace", { ...GOOD, workspace_id: "nope" }],
  ])("answers 400 and records nothing for %s", async (_name, body) => {
    const response = await POST(request(body), context());
    expect(response.status).toBe(400);
    expect(requestRunControl).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON and for a bad run id", async () => {
    expect((await POST(request(undefined), context())).status).toBe(400);
    expect((await POST(request(GOOD), context("not-a-uuid"))).status).toBe(400);
    expect(requestRunControl).not.toHaveBeenCalled();
  });

  it("answers 401 for a signed-out caller and 403 for a non-member", async () => {
    requestRunControl.mockRejectedValueOnce(new WorkspaceAccessError("unauthenticated"));
    expect((await POST(request(GOOD), context())).status).toBe(401);
    requestRunControl.mockRejectedValueOnce(new WorkspaceAccessError("forbidden"));
    expect((await POST(request(GOOD), context())).status).toBe(403);
  });

  it("answers 404 when the request cannot apply (missing run, other workspace, wrong state, stopped)", async () => {
    requestRunControl.mockResolvedValue("not_applicable");
    const response = await POST(request(GOOD), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers 500 with a fixed code when the database call fails, without leaking the cause", async () => {
    requestRunControl.mockRejectedValue(new RunControlError("pg: relation secret"));
    const response = await POST(request(GOOD), context());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
