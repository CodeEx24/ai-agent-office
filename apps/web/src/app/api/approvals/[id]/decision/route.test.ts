import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const decideApproval = vi.fn();
const recordAgentRouteRejection = vi.fn();

vi.mock("../../../../../features/approvals/decide-approval", () => {
  class ApprovalDecisionError extends Error {}
  return {
    ApprovalDecisionError,
    decideApproval: (...args: unknown[]) => decideApproval(...args) as unknown,
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

import { ApprovalDecisionError } from "../../../../../features/approvals/decide-approval";
import { WorkspaceAccessError } from "../../../../../features/workspaces/workspace-access";
import { POST } from "./route";

const WORKSPACE_ID = "12500000-0000-4000-8000-0000000000a1";
const APPROVAL_ID = "12500000-0000-4000-8000-0000000000b2";
// Built at runtime: the prefix is what the guard looks at, the rest is not a real token.
const AGENT_BEARER = `Bearer ${["ago", "agt", ""].join("_")}fake.fake.fake`;

function request(body: unknown, authorization?: string): NextRequest {
  const headers = new Headers(authorization ? { authorization } : {});
  return {
    nextUrl: new URL(`http://localhost/api/approvals/${APPROVAL_ID}/decision`),
    method: "POST",
    headers,
    json: () =>
      body === undefined ? Promise.reject(new SyntaxError("no body")) : Promise.resolve(body),
  } as unknown as NextRequest;
}

const context = (id = APPROVAL_ID) => ({ params: Promise.resolve({ id }) });
const GOOD = { workspace_id: WORKSPACE_ID, decision: "approved" };

describe("POST /api/approvals/[id]/decision", () => {
  beforeEach(() => {
    decideApproval.mockReset();
    recordAgentRouteRejection.mockReset();
    decideApproval.mockResolvedValue({ outcome: "decided", id: APPROVAL_ID, status: "approved" });
    recordAgentRouteRejection.mockResolvedValue("recorded");
  });

  it("AC1: an agent token gets 403 and the rejection is recorded, before anything else runs", async () => {
    const response = await POST(request(GOOD, AGENT_BEARER), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "agent_credential_not_allowed" });
    expect(recordAgentRouteRejection).toHaveBeenCalledTimes(1);
    expect(recordAgentRouteRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: `/api/approvals/${APPROVAL_ID}/decision`,
        method: "POST",
      }),
    );
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("refuses an agent token even when the body is invalid (the guard is first)", async () => {
    const response = await POST(request({ nonsense: true }, AGENT_BEARER), context("not-a-uuid"));
    expect(response.status).toBe(403);
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("lets a person approve, and returns only the id and status", async () => {
    const response = await POST(request(GOOD), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ id: APPROVAL_ID, status: "approved" });
    expect(decideApproval).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      decision: "approved",
    });
    expect(recordAgentRouteRejection).not.toHaveBeenCalled();
  });

  it("lets a person deny", async () => {
    decideApproval.mockResolvedValue({ outcome: "decided", id: APPROVAL_ID, status: "denied" });
    const response = await POST(request({ ...GOOD, decision: "denied" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: APPROVAL_ID, status: "denied" });
  });

  it.each([
    ["a payload hash", { ...GOOD, payload_hash: "a".repeat(64) }],
    ["a status", { ...GOOD, status: "approved" }],
    ["an unknown decision", { ...GOOD, decision: "rejected" }],
    ["expired as a decision", { ...GOOD, decision: "expired" }],
    ["a missing workspace", { decision: "approved" }],
    ["a bad workspace", { ...GOOD, workspace_id: "nope" }],
  ])("answers 400 and decides nothing for %s", async (_name, body) => {
    const response = await POST(request(body), context());
    expect(response.status).toBe(400);
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON and for a bad approval id", async () => {
    expect((await POST(request(undefined), context())).status).toBe(400);
    expect((await POST(request(GOOD), context("not-a-uuid"))).status).toBe(400);
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("answers 401 for a signed-out caller and 403 for a non-member", async () => {
    decideApproval.mockRejectedValueOnce(new WorkspaceAccessError("unauthenticated"));
    expect((await POST(request(GOOD), context())).status).toBe(401);
    decideApproval.mockRejectedValueOnce(new WorkspaceAccessError("forbidden"));
    expect((await POST(request(GOOD), context())).status).toBe(403);
  });

  it("answers 404 when nothing could be decided (missing, other workspace, decided, expired, used)", async () => {
    decideApproval.mockResolvedValue({ outcome: "not_decidable" });
    const response = await POST(request(GOOD), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers 500 with a fixed code when the database call fails, without leaking the cause", async () => {
    decideApproval.mockRejectedValue(new ApprovalDecisionError("pg: relation secret"));
    const response = await POST(request(GOOD), context());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
