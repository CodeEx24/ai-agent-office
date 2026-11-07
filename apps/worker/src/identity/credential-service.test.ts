import { createHmac } from "node:crypto";

import {
  AGENT_CREDENTIAL_PREFIX,
  CREDENTIAL_MAX_TTL_SECONDS,
  TaskAlreadyEndedError,
} from "@ago/shared";
import { describe, expect, it, vi } from "vitest";

import { scrubString } from "../logger.js";
import {
  createCredentialIssuer,
  createCredentialVerifier,
  hashCredentialToken,
  signCredentialToken,
  verifyCredentialToken,
  type CredentialStore,
  type IssueCredentialRequest,
  type NewCredentialRecord,
  type StoredCredential,
} from "./index.js";

const SECRET = "test-signing-secret-that-is-long-enough-123";
const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-0000000000b1";
const AGENT = "00000000-0000-4000-8000-0000000000a2";
const OTHER_AGENT = "00000000-0000-4000-8000-0000000000b2";
const RUN = "00000000-0000-4000-8000-0000000000a3";
const OTHER_RUN = "00000000-0000-4000-8000-0000000000b3";
const START = new Date("2026-11-07T12:00:00.000Z");
const START_SECONDS = Math.floor(START.getTime() / 1000);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** An in-memory store with a settable clock; the real database rules are proven by the pgTAP suite. */
function setup(granted: string[] = ["vault.read", "web.search", "code.run"]) {
  let nowMs = START.getTime();
  const now = () => new Date(nowMs);
  const rows = new Map<string, Mutable<NewCredentialRecord> & { revokedAt: Date | null }>();
  const store: CredentialStore = {
    grantedCapabilities: () => Promise.resolve([...granted]),
    insert(record) {
      rows.set(record.tokenHash, { ...record, revokedAt: null });
      return Promise.resolve();
    },
    findByTokenHash(hash): Promise<StoredCredential | null> {
      return Promise.resolve(rows.get(hash) ?? null);
    },
    revokeForRun({ workspaceId, runId }) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.workspaceId === workspaceId && row.runId === runId && row.revokedAt === null) {
          row.revokedAt = now();
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
  };
  const info = vi.fn();
  return {
    store,
    issuer: createCredentialIssuer({ store, secret: SECRET, now, logger: { info } }),
    verifier: createCredentialVerifier({ store, secret: SECRET, now }),
    rows,
    info,
    advanceSeconds: (seconds: number) => {
      nowMs += seconds * 1000;
    },
  };
}
type Setup = ReturnType<typeof setup>;

const issueFor = (s: Setup, extra: Partial<IssueCredentialRequest> = {}) =>
  s.issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId: RUN, ...extra });
const ask = (
  capability: string,
  extra: Partial<{ workspaceId: string; runId: string; agentId: string }> = {},
) => ({ workspaceId: WORKSPACE, runId: RUN, capability, ...extra });
const claimsFor = (overrides: Record<string, unknown> = {}) => ({
  jti: "00000000-0000-4000-8000-0000000000c1",
  agent_id: AGENT,
  workspace_id: WORKSPACE,
  run_id: RUN,
  caps: ["vault.read"],
  iat: START_SECONDS,
  exp: START_SECONDS + 300,
  ...overrides,
});
const EXPIRED = { ok: false, reason: "expired" } as const;
const MISSING = { ok: false, reason: "missing_capability" } as const;

describe("AC1: a credential expires at task end or in 15 minutes, whichever is sooner", () => {
  it("expires in 15 minutes when the task runs longer or has no end", async () => {
    const s = setup();
    const noEnd = await issueFor(s);
    expect(noEnd.expiresAt.getTime() - START.getTime()).toBe(CREDENTIAL_MAX_TTL_SECONDS * 1000);
    const longTask = await issueFor(s, { taskEndsAt: new Date(START.getTime() + 3_600_000) });
    expect(longTask.expiresAt.getTime() - START.getTime()).toBe(900_000);
  });

  it("expires with the task when the task ends sooner", async () => {
    const s = setup();
    const credential = await issueFor(s, { taskEndsAt: new Date(START.getTime() + 120_000) });
    expect(credential.expiresAt.getTime() - START.getTime()).toBe(120_000);
  });

  it("is accepted until the expiry second, then rejected as expired (fake clock)", async () => {
    const s = setup();
    const { token } = await issueFor(s, { taskEndsAt: new Date(START.getTime() + 60_000) });
    expect((await s.verifier.verify(token, ask("vault.read"))).ok).toBe(true);
    s.advanceSeconds(59);
    expect((await s.verifier.verify(token, ask("vault.read"))).ok).toBe(true);
    s.advanceSeconds(1);
    expect(await s.verifier.verify(token, ask("vault.read"))).toEqual(EXPIRED);
    s.advanceSeconds(3600);
    expect(await s.verifier.verify(token, ask("vault.read"))).toEqual(EXPIRED);
  });

  it("a 15 minute credential is dead at 15 minutes", async () => {
    const s = setup();
    const { token } = await issueFor(s);
    s.advanceSeconds(899);
    expect((await s.verifier.verify(token, ask("vault.read"))).ok).toBe(true);
    s.advanceSeconds(1);
    expect(await s.verifier.verify(token, ask("vault.read"))).toEqual(EXPIRED);
  });

  it("issues nothing for a task that has already ended", async () => {
    const s = setup();
    await expect(
      issueFor(s, { taskEndsAt: new Date(START.getTime() - 1000) }),
    ).rejects.toBeInstanceOf(TaskAlreadyEndedError);
    expect(s.rows.size).toBe(0);
  });

  it("is revoked when the run ends", async () => {
    const s = setup();
    const { token } = await issueFor(s);
    expect(await s.issuer.revokeForRun({ workspaceId: WORKSPACE, runId: RUN })).toBe(1);
    expect(await s.verifier.verify(token, ask("vault.read"))).toEqual({
      ok: false,
      reason: "revoked",
    });
  });
});

describe("AC2: a credential cannot be used for a capability the agent lacks", () => {
  it("carries the granted capabilities when none are requested", async () => {
    const credential = await issueFor(setup());
    expect(credential.capabilities).toEqual(["code.run", "vault.read", "web.search"]);
  });

  it("carries only the intersection of granted and requested, and reports what was dropped", async () => {
    const credential = await issueFor(setup(), {
      requestedCapabilities: ["vault.read", "payments.execute"],
    });
    expect(credential.capabilities).toEqual(["vault.read"]);
    expect(credential.droppedCapabilities).toEqual(["payments.execute"]);
  });

  it("rejects a capability that was never on the credential", async () => {
    const s = setup();
    const { token } = await issueFor(s, { requestedCapabilities: ["vault.read"] });
    expect((await s.verifier.verify(token, ask("vault.read"))).ok).toBe(true);
    expect(await s.verifier.verify(token, ask("web.search"))).toEqual(MISSING);
    expect(await s.verifier.verify(token, ask("payments.execute"))).toEqual(MISSING);
  });

  it("an agent with no capabilities gets a credential that opens nothing", async () => {
    const s = setup([]);
    const { token } = await issueFor(s, { requestedCapabilities: ["vault.read"] });
    expect(await s.verifier.verify(token, ask("vault.read"))).toEqual(MISSING);
  });

  it("a forged token that adds a capability is not accepted (the issuance row is authoritative)", async () => {
    const s = setup();
    const { token, credentialId } = await issueFor(s, { requestedCapabilities: ["vault.read"] });
    const forged = signCredentialToken(
      claimsFor({ jti: credentialId, caps: ["vault.read", "code.run"] }),
      SECRET,
    );
    expect(forged).not.toBe(token);
    expect(await s.verifier.verify(forged, ask("code.run"))).toEqual({
      ok: false,
      reason: "unknown_credential",
    });
  });

  it("a tier 3 capability on a credential still requires the policy check and approval (never bypassed)", async () => {
    const s = setup();
    const { token } = await issueFor(s);
    expect(await s.verifier.verify(token, ask("code.run"))).toMatchObject({
      ok: true,
      policyCheckRequired: true,
    });
  });
});

describe("every rejection path", () => {
  it("malformed: not a credential, wrong parts, wrong header, empty signature", async () => {
    const s = setup();
    for (const token of [
      "",
      "garbage",
      `${AGENT_CREDENTIAL_PREFIX}only.two`,
      `${AGENT_CREDENTIAL_PREFIX}a.b.c.d`,
      "eyJhbGciOiJIUzI1NiJ9.e30.sig",
    ]) {
      expect(await s.verifier.verify(token, ask("vault.read"))).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from("{}").toString("base64url");
    expect(
      await s.verifier.verify(`${AGENT_CREDENTIAL_PREFIX}${header}.${payload}.`, ask("vault.read")),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("malformed: correctly signed but the claims are invalid (unknown claim)", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ admin: true })).toString("base64url");
    const signature = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(
      verifyCredentialToken(`${AGENT_CREDENTIAL_PREFIX}${header}.${payload}.${signature}`, SECRET),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("bad_signature: a tampered payload and a different secret", async () => {
    const s = setup();
    const { token } = await issueFor(s);
    const [header, payload, signature] = token.slice(AGENT_CREDENTIAL_PREFIX.length).split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >;
    const tampered = Buffer.from(
      JSON.stringify({ ...claims, caps: ["payments.execute"] }),
    ).toString("base64url");
    expect(
      await s.verifier.verify(
        `${AGENT_CREDENTIAL_PREFIX}${header ?? ""}.${tampered}.${signature ?? ""}`,
        ask("payments.execute"),
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });

    const otherSecret = createCredentialVerifier({
      store: s.store,
      secret: "another-signing-secret-that-is-long-enough-1",
    });
    expect(await otherSecret.verify(token, ask("vault.read"))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("unknown_credential: a validly signed token that was never issued", async () => {
    const s = setup();
    const token = signCredentialToken(claimsFor(), SECRET);
    expect(await s.verifier.verify(token, ask("vault.read"))).toEqual({
      ok: false,
      reason: "unknown_credential",
    });
  });

  it("wrong_workspace, wrong_agent and wrong_run", async () => {
    const s = setup();
    const { token } = await issueFor(s);
    expect(
      await s.verifier.verify(token, ask("vault.read", { workspaceId: OTHER_WORKSPACE })),
    ).toEqual({ ok: false, reason: "wrong_workspace" });
    expect(await s.verifier.verify(token, ask("vault.read", { agentId: OTHER_AGENT }))).toEqual({
      ok: false,
      reason: "wrong_agent",
    });
    expect(await s.verifier.verify(token, ask("vault.read", { runId: OTHER_RUN }))).toEqual({
      ok: false,
      reason: "wrong_run",
    });
    expect((await s.verifier.verify(token, ask("vault.read", { agentId: AGENT }))).ok).toBe(true);
  });

  it("the stored expiry also counts: a row that expired early rejects a token that has not", async () => {
    const s = setup();
    const { token } = await issueFor(s);
    for (const row of s.rows.values()) row.expiresAt = new Date(START.getTime() + 1000);
    s.advanceSeconds(2);
    expect(await s.verifier.verify(token, ask("vault.read"))).toEqual(EXPIRED);
  });
});

describe("no token in logs, events or the database", () => {
  it("stores only the hash, never the token, and logs no token", async () => {
    const s = setup();
    const credential = await issueFor(s);
    expect(s.rows.size).toBe(1);
    const stored = JSON.stringify([...s.rows.values()]);
    expect(stored).not.toContain(credential.token);
    expect(stored).toContain(hashCredentialToken(credential.token));
    expect(hashCredentialToken(credential.token)).toMatch(/^[0-9a-f]{64}$/);
    expect(s.info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(s.info.mock.calls);
    expect(logged).not.toContain(credential.token);
    expect(logged).not.toContain(credential.token.split(".")[1] ?? "unreachable");
    expect(logged).toContain(credential.credentialId);
  });

  it("the shared redaction scrubs a token that reaches a log line anyway", async () => {
    const { token } = await issueFor(setup());
    const scrubbed = scrubString(`calling tool with ${token} now`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain(token.split(".")[2] ?? "unreachable");
  });

  it("refuses a signing secret that is too short and never signs invalid claims", () => {
    expect(() => signCredentialToken(claimsFor(), "short")).toThrow(/at least 32/);
    expect(() => signCredentialToken(claimsFor({ exp: START_SECONDS + 901 }), SECRET)).toThrow();
  });
});

describe("AC3: every issuance is logged", () => {
  it("writes one issuance record per credential, with its capability set and expiry", async () => {
    const s = setup();
    const a = await issueFor(s, { requestedCapabilities: ["vault.read"] });
    const b = await issueFor(s);
    expect(s.rows.size).toBe(2);
    const records = [...s.rows.values()];
    expect(records.map((r) => r.id).sort()).toEqual([a.credentialId, b.credentialId].sort());
    expect(records.every((r) => r.expiresAt.getTime() - r.issuedAt.getTime() <= 900_000)).toBe(
      true,
    );
    expect(s.info).toHaveBeenCalledTimes(2);
  });
});
