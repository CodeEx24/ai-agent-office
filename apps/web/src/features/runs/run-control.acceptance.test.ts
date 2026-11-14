// AGO-86 functional acceptance (tester): the control route through the REAL proxy, the REAL route handler, the REAL
// requestRunControl and the REAL role gate. Only the outermost edges are faked: the Supabase clients (the signed-in
// session client and the service client the rejection recorder uses). Fake secrets and tokens are built at runtime.
import { signCredentialToken } from "@ago/shared/credential-token";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

// The recorder's service client (agent rejections) and the person's own session client are different clients.
const recorderRpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: (...a: unknown[]) => recorderRpc(...a) as unknown }),
}));

const session = {
  user: null as { id: string } | null,
  role: null as string | null,
  rpcAnswer: { data: "accepted" as unknown, error: null as unknown },
};
const sessionRpc = vi.fn();
const membershipLookup = vi.fn();
vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: { getUser: () => Promise.resolve({ data: { user: session.user }, error: null }) },
      from: (table: string) => {
        membershipLookup(table);
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: session.role === null ? null : { role: session.role },
              error: null,
            }),
        };
        return chain;
      },
      rpc: (...a: unknown[]) => {
        sessionRpc(...a);
        return Promise.resolve(session.rpcAnswer);
      },
    }),
}));
const updateSession = vi.fn();
vi.mock("../../lib/supabase/session", () => ({
  updateSession: (...a: unknown[]) => updateSession(...a) as unknown,
}));

import { NextRequest } from "next/server";

import { POST } from "../../app/api/runs/[id]/control/route";
import { proxy } from "../../proxy";

const SECRET = ["acceptance", "signing", "material"].join("-").padEnd(40, "q");
const SERVICE_KEY = ["service", "role", "stand", "in"].join("-");
const IDS = {
  jti: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workspace_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const PERSON = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
const CONTROL_PATH = `/api/runs/${IDS.run_id}/control`;
const ACTIONS = ["pause", "resume", "stop"] as const;

function signed(secret = SECRET): string {
  const iat = Math.floor(Date.now() / 1000);
  return signCredentialToken({ ...IDS, caps: [], iat, exp: iat + 600 }, secret);
}

function req(method: string, authorization?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${CONTROL_PATH}`, {
    method,
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      "content-type": "application/json",
    },
    ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = { params: Promise.resolve({ id: IDS.run_id }) };
const body = (action: string) => ({ workspace_id: IDS.workspace_id, action });

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  recorderRpc.mockReset();
  recorderRpc.mockResolvedValue({ error: null });
  sessionRpc.mockReset();
  membershipLookup.mockReset();
  updateSession.mockReset();
  updateSession.mockResolvedValue({
    isSignedIn: false,
    userId: undefined,
    response: new Response(null),
  });
  session.user = PERSON;
  session.role = "member";
  session.rpcAnswer = { data: "accepted", error: null };
  vi.stubEnv("AGENT_CREDENTIAL_SIGNING_SECRET", SECRET);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-stand-in");
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("AGO-86 AC2: agent tokens are rejected on the control route (proxy)", () => {
  it.each(ACTIONS)(
    "the proxy answers 403 agent_credential_not_allowed and records one event for a signed agent token (%s)",
    async (action) => {
      const bearer = signed();
      const res = await proxy(req("POST", `Bearer ${bearer}`, body(action)));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "agent_credential_not_allowed" });
      expect(recorderRpc).toHaveBeenCalledTimes(1);
      expect(recorderRpc).toHaveBeenCalledWith("record_agent_approval_rejection", {
        p_workspace_id: IDS.workspace_id,
        p_run_id: IDS.run_id,
        p_agent_id: IDS.agent_id,
        p_jti: IDS.jti,
        p_route: CONTROL_PATH,
        p_method: "POST",
      });
      expect(updateSession).not.toHaveBeenCalled();
      expect(sessionRpc).not.toHaveBeenCalled();
      const seen = JSON.stringify([recorderRpc.mock.calls, warn.mock.calls]);
      expect(seen).not.toContain(bearer);
      expect(seen).not.toContain(SECRET);
      expect(seen).not.toContain(SERVICE_KEY);
    },
  );

  it.each(["GET", "PUT", "PATCH", "DELETE"])(
    "the proxy refuses an agent token on %s too, not only POST",
    async (method) => {
      const res = await proxy(req(method, `Bearer ${signed()}`));
      expect(res.status).toBe(403);
      expect(sessionRpc).not.toHaveBeenCalled();
    },
  );

  it("a forged agent token is refused with no event and no token in the log", async () => {
    const forged = signed("a-different-secret".padEnd(40, "z"));
    const res = await proxy(req("POST", `Bearer ${forged}`, body("stop")));
    expect(res.status).toBe(403);
    expect(recorderRpc).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(forged);
  });
});

describe("AGO-86 AC2: agent tokens are rejected on the control route (handler, proxy bypassed)", () => {
  it.each(ACTIONS)(
    "the handler answers 403, records exactly one event and never records a control request (%s)",
    async (action) => {
      const res = await POST(req("POST", `Bearer ${signed()}`, body(action)), ctx);
      expect(res.status).toBe(403);
      expect(recorderRpc).toHaveBeenCalledTimes(1);
      expect(sessionRpc).not.toHaveBeenCalled();
      expect(membershipLookup).not.toHaveBeenCalled();
    },
  );

  it("an agent token wins over a signed-in person's cookie session: still 403, still no control request", async () => {
    session.user = PERSON;
    session.role = "owner";
    const res = await POST(req("POST", `Bearer ${signed()}`, body("stop")), ctx);
    expect(res.status).toBe(403);
    expect(sessionRpc).not.toHaveBeenCalled();
  });
});

describe("AGO-86: who may control a run (real role gate)", () => {
  it("denies a viewer with 403 and never reaches the database function", async () => {
    session.role = "viewer";
    for (const action of ACTIONS) {
      const res = await POST(req("POST", undefined, body(action)), ctx);
      expect(res.status).toBe(403);
    }
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it("denies a signed-in user who is not a member of that workspace", async () => {
    session.role = null;
    const res = await POST(req("POST", undefined, body("stop")), ctx);
    expect(res.status).toBe(403);
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it("denies a membership with an unknown stored role (fails closed)", async () => {
    session.role = "superuser";
    const res = await POST(req("POST", undefined, body("pause")), ctx);
    expect(res.status).toBe(403);
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it("answers 401 for a signed-out caller and touches neither membership nor database", async () => {
    session.user = null;
    const res = await POST(req("POST", undefined, body("pause")), ctx);
    expect(res.status).toBe(401);
    expect(membershipLookup).not.toHaveBeenCalled();
    expect(sessionRpc).not.toHaveBeenCalled();
  });

  it.each(["member", "owner"])(
    "lets a %s pause, resume and stop with their own session",
    async (role) => {
      session.role = role;
      for (const action of ACTIONS) {
        sessionRpc.mockClear();
        const res = await POST(req("POST", undefined, body(action)), ctx);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: IDS.run_id, action, status: "accepted" });
        expect(sessionRpc).toHaveBeenCalledTimes(1);
        expect(sessionRpc).toHaveBeenCalledWith("request_run_control", {
          p_workspace_id: IDS.workspace_id,
          p_run_id: IDS.run_id,
          p_action: action,
        });
      }
      expect(recorderRpc).not.toHaveBeenCalled();
    },
  );
});

describe("AGO-86: what the route does with the database answer", () => {
  it("answers 404 when the request cannot apply (not_applicable)", async () => {
    session.rpcAnswer = { data: "not_applicable", error: null };
    const res = await POST(req("POST", undefined, body("resume")), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers 500 with a fixed code, and no cause, when the database call fails", async () => {
    session.rpcAnswer = {
      data: null,
      error: { message: "relation private.run_checkpoints secret" },
    };
    const res = await POST(req("POST", undefined, body("stop")), ctx);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("fails closed with 500 on an answer it does not know (never reports accepted)", async () => {
    session.rpcAnswer = { data: "yes", error: null };
    const res = await POST(req("POST", undefined, body("stop")), ctx);
    expect(res.status).toBe(500);
  });

  it.each([
    ["an actor field", { ...body("stop"), actor: "agent" }],
    ["a status field", { ...body("stop"), status: "stopped" }],
    ["an unknown action", body("kill")],
  ])("answers 400 and records nothing when the body carries %s", async (_name, payload) => {
    const res = await POST(req("POST", undefined, payload), ctx);
    expect(res.status).toBe(400);
    expect(sessionRpc).not.toHaveBeenCalled();
  });
});
