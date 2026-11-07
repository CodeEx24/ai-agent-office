import { describe, expect, it } from "vitest";

import {
  AGENT_CREDENTIAL_PREFIX,
  CREDENTIAL_MAX_TTL_SECONDS,
  TaskAlreadyEndedError,
  agentCredentialClaimsSchema,
  bearerTokenOf,
  computeCredentialExpiry,
  hasAgentCredential,
  intersectCapabilities,
} from "./credential-schemas.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("computeCredentialExpiry (AC1: task end or 15 minutes, whichever is sooner)", () => {
  it("caps at 15 minutes when there is no task end", () => {
    expect(computeCredentialExpiry({ now: NOW }).toISOString()).toBe(minutes(15).toISOString());
    expect(CREDENTIAL_MAX_TTL_SECONDS).toBe(900);
  });

  it("caps at 15 minutes when the task runs longer", () => {
    expect(computeCredentialExpiry({ now: NOW, taskEndsAt: minutes(60) }).toISOString()).toBe(
      minutes(15).toISOString(),
    );
  });

  it("ends with the task when the task ends sooner", () => {
    expect(computeCredentialExpiry({ now: NOW, taskEndsAt: minutes(4) }).toISOString()).toBe(
      minutes(4).toISOString(),
    );
  });

  it("treats a task ending exactly at 15 minutes as 15 minutes", () => {
    expect(computeCredentialExpiry({ now: NOW, taskEndsAt: minutes(15) }).toISOString()).toBe(
      minutes(15).toISOString(),
    );
  });

  it("rounds down to whole seconds so a credential never outlives the request", () => {
    const end = new Date(NOW.getTime() + 90_900);
    expect(computeCredentialExpiry({ now: NOW, taskEndsAt: end }).getTime()).toBe(
      NOW.getTime() + 90_000,
    );
  });

  it("refuses to issue when the task has ended or ends this second", () => {
    expect(() => computeCredentialExpiry({ now: NOW, taskEndsAt: NOW })).toThrow(
      TaskAlreadyEndedError,
    );
    expect(() => computeCredentialExpiry({ now: NOW, taskEndsAt: minutes(-1) })).toThrow(
      TaskAlreadyEndedError,
    );
    expect(() =>
      computeCredentialExpiry({ now: NOW, taskEndsAt: new Date(NOW.getTime() + 400) }),
    ).toThrow(TaskAlreadyEndedError);
  });

  it("treats a null task end like no task end", () => {
    expect(computeCredentialExpiry({ now: NOW, taskEndsAt: null }).toISOString()).toBe(
      minutes(15).toISOString(),
    );
  });
});

describe("intersectCapabilities (AC2)", () => {
  const granted = ["vault.read", "web.search", "tasks.manage"];

  it("gives every granted capability when none is requested", () => {
    expect(intersectCapabilities(granted)).toEqual(["tasks.manage", "vault.read", "web.search"]);
    expect(intersectCapabilities(granted, null)).toEqual([
      "tasks.manage",
      "vault.read",
      "web.search",
    ]);
  });

  it("gives only the granted ones that were requested", () => {
    expect(intersectCapabilities(granted, ["web.search", "vault.read"])).toEqual([
      "vault.read",
      "web.search",
    ]);
  });

  it("never adds a capability the agent lacks", () => {
    expect(intersectCapabilities(granted, ["payments.execute", "vault.read"])).toEqual([
      "vault.read",
    ]);
    expect(intersectCapabilities([], ["vault.read"])).toEqual([]);
  });

  it("an empty request gives an empty credential, not everything", () => {
    expect(intersectCapabilities(granted, [])).toEqual([]);
  });

  it("de-duplicates", () => {
    expect(intersectCapabilities(granted, ["vault.read", "vault.read"])).toEqual(["vault.read"]);
  });
});

describe("agentCredentialClaimsSchema", () => {
  const claims = {
    jti: "00000000-0000-4000-8000-000000000001",
    agent_id: "00000000-0000-4000-8000-000000000002",
    workspace_id: "00000000-0000-4000-8000-000000000003",
    run_id: "00000000-0000-4000-8000-000000000004",
    caps: ["vault.read"],
    iat: 1_800_000_000,
    exp: 1_800_000_600,
  };

  it("accepts valid claims", () => {
    expect(agentCredentialClaimsSchema.safeParse(claims).success).toBe(true);
  });

  it("rejects a lifetime over 15 minutes and an expiry before issue", () => {
    expect(
      agentCredentialClaimsSchema.safeParse({ ...claims, exp: claims.iat + 901 }).success,
    ).toBe(false);
    expect(agentCredentialClaimsSchema.safeParse({ ...claims, exp: claims.iat }).success).toBe(
      false,
    );
  });

  it("rejects unknown claims and malformed capability keys", () => {
    expect(agentCredentialClaimsSchema.safeParse({ ...claims, admin: true }).success).toBe(false);
    expect(agentCredentialClaimsSchema.safeParse({ ...claims, caps: ["*"] }).success).toBe(false);
    expect(agentCredentialClaimsSchema.safeParse({ ...claims, caps: ["Vault.Read"] }).success).toBe(
      false,
    );
  });
});

describe("hasAgentCredential (human-only guard input)", () => {
  const headers = (authorization: string | null) => ({
    get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : null),
  });

  it("detects an agent credential in a bearer header, in any spelling of Bearer", () => {
    expect(hasAgentCredential(headers(`Bearer ${AGENT_CREDENTIAL_PREFIX}abc.def`))).toBe(true);
    expect(hasAgentCredential(headers(`bearer ${AGENT_CREDENTIAL_PREFIX}abc.def`))).toBe(true);
    expect(hasAgentCredential(headers(`  BEARER   ${AGENT_CREDENTIAL_PREFIX}abc.def`))).toBe(true);
  });

  it("does not flag a human session token, other schemes or no header", () => {
    expect(hasAgentCredential(headers("Bearer eyJhbGciOiJIUzI1NiJ9.x.y"))).toBe(false);
    expect(hasAgentCredential(headers(`Basic ${AGENT_CREDENTIAL_PREFIX}abc`))).toBe(false);
    expect(hasAgentCredential(headers(null))).toBe(false);
  });

  it("extracts the bearer token", () => {
    expect(bearerTokenOf("Bearer abc")).toBe("abc");
    expect(bearerTokenOf(undefined)).toBeUndefined();
  });
});
