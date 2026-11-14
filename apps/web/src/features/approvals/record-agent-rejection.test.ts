import { signCredentialToken } from "@ago/shared/credential-token";
import { describe, expect, it, vi } from "vitest";

import {
  isApprovalRoute,
  recordAgentRouteRejection,
  type RejectionRecorderClient,
} from "./record-agent-rejection";

// Fake secret and token are built at runtime so no realistic-looking secret is committed.
const SECRET = ["unit", "test", "signing", "key"].join("-").padEnd(40, "x");
const IDS = {
  jti: "11111111-1111-4111-8111-111111111111",
  agent_id: "22222222-2222-4222-8222-222222222222",
  workspace_id: "33333333-3333-4333-8333-333333333333",
  run_id: "44444444-4444-4444-8444-444444444444",
};

function token(secret = SECRET): string {
  const iat = Math.floor(Date.now() / 1000);
  return signCredentialToken({ ...IDS, caps: [], iat, exp: iat + 600 }, secret);
}

function setup(rpcResult: { error: { code?: string } | null } = { error: null }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const client: RejectionRecorderClient = { rpc };
  const log = vi.fn();
  return { rpc, client, log };
}

function headers(authorization: string | null) {
  return new Headers(authorization === null ? {} : { authorization });
}

describe("isApprovalRoute", () => {
  it.each(["/api/approvals", "/api/approvals/a1/decision"])("matches %s", (path) => {
    expect(isApprovalRoute(path)).toBe(true);
  });
  it.each(["/api/approvalsx", "/api/capabilities", "/approvals"])("does not match %s", (path) => {
    expect(isApprovalRoute(path)).toBe(false);
  });
});

describe("recordAgentRouteRejection", () => {
  it("records one fixed-shape event for a genuinely signed credential", async () => {
    const { rpc, client, log } = setup();
    const outcome = await recordAgentRouteRejection({
      headers: headers(`Bearer ${token()}`),
      pathname: "/api/approvals/a1/decision",
      method: "POST",
      secret: SECRET,
      client,
      log,
    });
    expect(outcome).toBe("recorded");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_agent_approval_rejection", {
      p_workspace_id: IDS.workspace_id,
      p_run_id: IDS.run_id,
      p_agent_id: IDS.agent_id,
      p_jti: IDS.jti,
      p_route: "/api/approvals/a1/decision",
      p_method: "POST",
    });
  });

  it("never sends the token, a header or anything free-form to the database or the log", async () => {
    const { rpc, client, log } = setup({ error: { code: "42501" } });
    const bearer = token();
    await recordAgentRouteRejection({
      headers: headers(`Bearer ${bearer}`),
      pathname: "/api/approvals/a1/decision",
      method: "POST",
      secret: SECRET,
      client,
      log,
    });
    const everything = JSON.stringify([rpc.mock.calls, log.mock.calls]);
    expect(everything).not.toContain(bearer);
    expect(everything).not.toContain(bearer.split(".")[2]);
    expect(everything).not.toContain(SECRET);
    expect(Object.keys(rpc.mock.calls[0]?.[1] as object).sort()).toEqual([
      "p_agent_id",
      "p_jti",
      "p_method",
      "p_route",
      "p_run_id",
      "p_workspace_id",
    ]);
  });

  it("writes no event for a forged signature (it names no real run) and only logs", async () => {
    const { rpc, client, log } = setup();
    const outcome = await recordAgentRouteRejection({
      headers: headers(`Bearer ${token("another-secret-".padEnd(40, "y"))}`),
      pathname: "/api/approvals/a1/decision",
      method: "POST",
      secret: SECRET,
      client,
      log,
    });
    expect(outcome).toBe("unverified");
    expect(rpc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it.each([null, "Bearer ago_agt_not.a.token", "Basic abc"])(
    "writes no event for a missing or malformed credential (%j)",
    async (authorization) => {
      const { rpc, client, log } = setup();
      const outcome = await recordAgentRouteRejection({
        headers: headers(authorization),
        pathname: "/api/approvals",
        method: "POST",
        secret: SECRET,
        client,
        log,
      });
      expect(outcome).toBe("unverified");
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("writes no event for a method outside the event's fixed list", async () => {
    const { rpc, client, log } = setup();
    const outcome = await recordAgentRouteRejection({
      headers: headers(`Bearer ${token()}`),
      pathname: "/api/approvals",
      method: "TRACE",
      secret: SECRET,
      client,
      log,
    });
    expect(outcome).toBe("unverified");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports failed (and never throws) when the database call errors or throws", async () => {
    const failing = setup({ error: { code: "42501" } });
    await expect(
      recordAgentRouteRejection({
        headers: headers(`Bearer ${token()}`),
        pathname: "/api/approvals",
        method: "POST",
        secret: SECRET,
        client: failing.client,
        log: failing.log,
      }),
    ).resolves.toBe("failed");

    const throwing: RejectionRecorderClient = {
      rpc: () => {
        throw new Error("network down");
      },
    };
    await expect(
      recordAgentRouteRejection({
        headers: headers(`Bearer ${token()}`),
        pathname: "/api/approvals",
        method: "POST",
        secret: SECRET,
        client: throwing,
        log: vi.fn(),
      }),
    ).resolves.toBe("failed");
  });
});
