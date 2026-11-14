// AGO-58 functional acceptance: AC1 through the REAL proxy and the REAL route handler with the REAL recorder.
// Only the outermost edges are faked: the Supabase client (to see the one rpc call) and the human-only side of the
// route (decideApproval), which must never run for an agent. Fake secrets and tokens are built at runtime.
import { signCredentialToken } from "@ago/shared/credential-token";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const createClient = vi.fn((..._args: unknown[]) => ({ rpc }));
vi.mock("@supabase/supabase-js", () => ({ createClient: (...a: unknown[]) => createClient(...a) }));

const decideApproval = vi.fn();
vi.mock("./decide-approval", () => {
  class ApprovalDecisionError extends Error {}
  return {
    ApprovalDecisionError,
    decideApproval: (...a: unknown[]) => decideApproval(...a) as unknown,
  };
});
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {}
  return { WorkspaceAccessError };
});
const updateSession = vi.fn();
vi.mock("../../lib/supabase/session", () => ({
  updateSession: (...a: unknown[]) => updateSession(...a) as unknown,
}));

import { NextRequest } from "next/server";

import { POST } from "../../app/api/approvals/[id]/decision/route";
import { proxy } from "../../proxy";

const SECRET = ["acceptance", "signing", "material"].join("-").padEnd(40, "q");
const SERVICE_KEY = ["service", "role", "stand", "in"].join("-");
const IDS = {
  jti: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workspace_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const APPROVAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DECIDE_PATH = `/api/approvals/${APPROVAL_ID}/decision`;

function signed(secret = SECRET): string {
  const iat = Math.floor(Date.now() / 1000);
  return signCredentialToken({ ...IDS, caps: [], iat, exp: iat + 600 }, secret);
}

function req(method: string, path: string, authorization?: string, body?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: authorization === undefined ? {} : { authorization },
    ...(body === undefined || method === "GET" ? {} : { body }),
  });
}

const ctx = { params: Promise.resolve({ id: APPROVAL_ID }) };

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ error: null });
  createClient.mockClear();
  decideApproval.mockReset();
  updateSession.mockReset();
  updateSession.mockResolvedValue({
    isSignedIn: false,
    userId: undefined,
    response: new Response(null),
  });
  vi.stubEnv("AGENT_CREDENTIAL_SIGNING_SECRET", SECRET);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-stand-in");
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function expectedRpcArgs(method: string, route: string) {
  return {
    p_workspace_id: IDS.workspace_id,
    p_run_id: IDS.run_id,
    p_agent_id: IDS.agent_id,
    p_jti: IDS.jti,
    p_route: route,
    p_method: method,
  };
}

describe("AC1: an agent token calling an approval route gets 403 and an event (proxy)", () => {
  it.each(["POST", "GET", "PUT", "PATCH", "DELETE"])(
    "proxy answers 403 agent_credential_not_allowed and records one event for a signed agent token on %s",
    async (method) => {
      const bearer = signed();
      const res = await proxy(req(method, DECIDE_PATH, `Bearer ${bearer}`));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "agent_credential_not_allowed" });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(
        "record_agent_approval_rejection",
        expectedRpcArgs(method, DECIDE_PATH),
      );
      expect(updateSession).not.toHaveBeenCalled();
      const seen = JSON.stringify([rpc.mock.calls, warn.mock.calls]);
      expect(seen).not.toContain(bearer);
      expect(seen).not.toContain(SECRET);
      expect(seen).not.toContain(SERVICE_KEY);
    },
  );

  it("proxy records an event for an agent token on the bare /api/approvals path (any route under the prefix)", async () => {
    const res = await proxy(req("GET", "/api/approvals", `Bearer ${signed()}`));
    expect(res.status).toBe(403);
    expect(rpc).toHaveBeenCalledWith(
      "record_agent_approval_rejection",
      expectedRpcArgs("GET", "/api/approvals"),
    );
  });

  it("proxy records an event for a route that does not exist under /api/approvals", async () => {
    const res = await proxy(req("POST", "/api/approvals/anything/else", `Bearer ${signed()}`));
    expect(res.status).toBe(403);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("proxy answers 403 for a forged signature with no event and no token in the log", async () => {
    const forged = signed("a-different-secret".padEnd(40, "z"));
    const res = await proxy(req("POST", DECIDE_PATH, `Bearer ${forged}`));
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(forged);
  });

  it.each([
    ["a malformed agent token", `Bearer ${["ago", "agt", ""].join("_")}not.a.jwt`],
    ["an agent-prefixed token with no dots", `Bearer ${["ago", "agt", ""].join("_")}x`],
  ])("proxy answers 403 with no event for %s", async (_name, authorization) => {
    const res = await proxy(req("POST", DECIDE_PATH, authorization));
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("proxy does not treat an empty bearer or a missing header as an agent (no 403, no event)", async () => {
    for (const authorization of [undefined, "Bearer ", "Bearer"]) {
      const res = await proxy(req("POST", DECIDE_PATH, authorization));
      expect(res.status).not.toBe(403);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("proxy answers 403 but writes no event for a method outside the fixed list (OPTIONS; TRACE cannot be built in a Request, the recorder unit test covers it)", async () => {
    const res = await proxy(req("OPTIONS", DECIDE_PATH, `Bearer ${signed()}`));
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("proxy answers 403 with no event for a signed agent token on a route outside /api/approvals", async () => {
    for (const path of ["/api/capabilities", "/api/approvalsx", "/approvals"]) {
      const res = await proxy(req("POST", path, `Bearer ${signed()}`));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "agent_credential_not_allowed" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("AC1: an agent token calling an approval route gets 403 and an event (route handler, proxy bypassed)", () => {
  it("route answers 403, records exactly one event and never decides, for a signed agent token", async () => {
    const bearer = signed();
    const body = JSON.stringify({ workspace_id: IDS.workspace_id, decision: "approved" });
    const res = await POST(req("POST", DECIDE_PATH, `Bearer ${bearer}`, body), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "agent_credential_not_allowed" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "record_agent_approval_rejection",
      expectedRpcArgs("POST", DECIDE_PATH),
    );
    expect(decideApproval).not.toHaveBeenCalled();
    const seen = JSON.stringify([rpc.mock.calls, warn.mock.calls]);
    expect(seen).not.toContain(bearer);
    expect(seen).not.toContain("approved");
  });

  it("route answers 403 with no event for a forged signature", async () => {
    const res = await POST(
      req("POST", DECIDE_PATH, `Bearer ${signed("forged-secret".padEnd(40, "f"))}`, "{}"),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("route still answers 403 when the event write fails", async () => {
    rpc.mockResolvedValue({ error: { code: "42501" } });
    const res = await POST(req("POST", DECIDE_PATH, `Bearer ${signed()}`, "{}"), ctx);
    expect(res.status).toBe(403);
    expect(decideApproval).not.toHaveBeenCalled();
  });
});

describe("AC1: no service key on the web server", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])(
    "proxy still answers 403, logs code no_service_key and never throws when the key is %s",
    async (_name, value) => {
      if (value === undefined) vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
      else vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", value);
      const bearer = signed();
      const res = await proxy(req("POST", DECIDE_PATH, `Bearer ${bearer}`));
      expect(res.status).toBe(403);
      expect(createClient).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ route: DECIDE_PATH, code: "no_service_key" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(bearer);
    },
  );

  it("route still answers 403 when the key is unset", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    const res = await POST(req("POST", DECIDE_PATH, `Bearer ${signed()}`, "{}"), ctx);
    expect(res.status).toBe(403);
    expect(warn.mock.calls[0]?.[1]).toEqual({ route: DECIDE_PATH, code: "no_service_key" });
  });

  it("recordAgentRouteRejection returns failed (not a throw) when the key is missing", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { recordAgentRouteRejection } = await import("./record-agent-rejection");
    const log = vi.fn();
    await expect(
      recordAgentRouteRejection({
        headers: new Headers({ authorization: `Bearer ${signed()}` }),
        pathname: DECIDE_PATH,
        method: "POST",
        log,
      }),
    ).resolves.toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.any(String), {
      route: DECIDE_PATH,
      code: "no_service_key",
    });
  });
});
