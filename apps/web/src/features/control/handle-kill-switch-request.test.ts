import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const activateKillSwitch = vi.fn();
const releaseKillSwitch = vi.fn();
const recordAgentRouteRejection = vi.fn();

vi.mock("./request-kill-switch", () => {
  class KillSwitchError extends Error {}
  return {
    KillSwitchError,
    activateKillSwitch: (...args: unknown[]) => activateKillSwitch(...args) as unknown,
    releaseKillSwitch: (...args: unknown[]) => releaseKillSwitch(...args) as unknown,
  };
});
vi.mock("../approvals/record-agent-rejection", () => ({
  recordAgentRouteRejection: (...args: unknown[]) => recordAgentRouteRejection(...args) as unknown,
}));
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError };
});

import type { NextRequest } from "next/server";

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { handleKillSwitchRequest } from "./handle-kill-switch-request";
import { KillSwitchError } from "./request-kill-switch";

const WORKSPACE_ID = "84000000-0000-4000-8000-0000000000a1";
const AGENT_ID = "84000000-0000-4000-8000-0000000000a2";
// Built at runtime: the prefix is what the guard looks at, the rest is not a real token.
const AGENT_BEARER = `Bearer ${["ago", "agt", ""].join("_")}fake.fake.fake`;

function request(body: unknown, authorization?: string): NextRequest {
  const headers = new Headers(authorization ? { authorization } : {});
  return {
    nextUrl: new URL("http://localhost/api/control/kill"),
    method: "POST",
    headers,
    json: () =>
      body === undefined ? Promise.reject(new SyntaxError("no body")) : Promise.resolve(body),
  } as unknown as NextRequest;
}

const GOOD = { workspace_id: WORKSPACE_ID, scope: "workspace" };
const COUNTS = { runs_stopped: 3, credentials_revoked: 4 };

describe("handleKillSwitchRequest", () => {
  beforeEach(() => {
    activateKillSwitch.mockReset().mockResolvedValue(COUNTS);
    releaseKillSwitch.mockReset().mockResolvedValue({ runs_stopped: 0, credentials_revoked: 0 });
    recordAgentRouteRejection.mockReset().mockResolvedValue("recorded");
  });

  it("refuses an agent credential with 403 and an audit event, before anything else", async () => {
    const response = await handleKillSwitchRequest(request(GOOD, AGENT_BEARER), "activate");
    expect(response.status).toBe(403);
    expect(recordAgentRouteRejection).toHaveBeenCalledTimes(1);
    expect(activateKillSwitch).not.toHaveBeenCalled();
  });

  it("refuses an agent credential on release too", async () => {
    const response = await handleKillSwitchRequest(request(GOOD, AGENT_BEARER), "release");
    expect(response.status).toBe(403);
    expect(releaseKillSwitch).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON, has unknown fields, or mixes scope and agent", async () => {
    expect((await handleKillSwitchRequest(request(undefined), "activate")).status).toBe(400);
    expect(
      (await handleKillSwitchRequest(request({ ...GOOD, extra: true }), "activate")).status,
    ).toBe(400);
    expect(
      (
        await handleKillSwitchRequest(
          request({ workspace_id: WORKSPACE_ID, scope: "agent" }),
          "activate",
        )
      ).status,
    ).toBe(400);
    expect(activateKillSwitch).not.toHaveBeenCalled();
  });

  it("answers 401 when not signed in and 403 when not an owner", async () => {
    activateKillSwitch.mockRejectedValueOnce(new WorkspaceAccessError("unauthenticated"));
    expect((await handleKillSwitchRequest(request(GOOD), "activate")).status).toBe(401);
    activateKillSwitch.mockRejectedValueOnce(new WorkspaceAccessError("forbidden"));
    expect((await handleKillSwitchRequest(request(GOOD), "activate")).status).toBe(403);
  });

  it("activates a workspace scope and reports the counts", async () => {
    const response = await handleKillSwitchRequest(request(GOOD), "activate");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scope: "workspace", status: "active", ...COUNTS });
    expect(activateKillSwitch).toHaveBeenCalledWith(GOOD);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("activates one agent and releases a scope", async () => {
    const agentBody = { workspace_id: WORKSPACE_ID, scope: "agent", agent_id: AGENT_ID };
    expect((await handleKillSwitchRequest(request(agentBody), "activate")).status).toBe(200);
    const released = await handleKillSwitchRequest(request(GOOD), "release");
    expect(await released.json()).toMatchObject({ scope: "workspace", status: "released" });
  });

  it("answers 500 when the database call fails, without leaking the cause", async () => {
    activateKillSwitch.mockRejectedValueOnce(new KillSwitchError("db detail"));
    const response = await handleKillSwitchRequest(request(GOOD), "activate");
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("db detail");
  });
});
