import { describe, expect, it, vi } from "vitest";

import { createCredentialIssuer, createCredentialVerifier } from "../identity/index.js";
import { createLogger } from "../logger.js";
import { createCredentialBroker, BrokerDeniedError, BrokerToolError } from "./credential-broker.js";
import { createSecretScrubber, secretForms } from "./secret-scrubber.js";
import { createInMemorySecretStore } from "./secret-store.js";

import type { CredentialStore, StoredCredential } from "../identity/index.js";
import type { BrokerAuditEntry } from "@ago/shared";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const CAP = "crm.read";
// Built at runtime and not shaped like any real key, so it is found only by the broker's own matching.
const VALUE = ["vault", "Zq9Tt4", "mW2xK8vLpR+/="].join("_");
const SIGNING = "s".repeat(40);

/** In-memory issuance log with the same behavior the verifier relies on. */
function fakeCredentialStore(granted: readonly string[]) {
  const rows = new Map<string, StoredCredential>();
  const store: CredentialStore = {
    grantedCapabilities: () => Promise.resolve([...granted]),
    isAgentActive: () => Promise.resolve(true),
    insert: (record) => {
      rows.set(record.tokenHash, {
        id: record.id,
        workspaceId: record.workspaceId,
        agentId: record.agentId,
        runId: record.runId,
        capabilities: record.capabilities,
        expiresAt: record.expiresAt,
        revokedAt: null,
        agentArchived: false,
        liveCapabilities: record.capabilities,
      });
      return Promise.resolve();
    },
    findByTokenHash: (hash) => Promise.resolve(rows.get(hash) ?? null),
    revokeForRun: () => {
      for (const [hash, row] of rows) rows.set(hash, { ...row, revokedAt: new Date() });
      return Promise.resolve(rows.size);
    },
  };
  return store;
}

async function setup(options: { granted?: readonly string[]; boundCapabilities?: string[] } = {}) {
  const store = fakeCredentialStore(options.granted ?? [CAP]);
  const issuer = createCredentialIssuer({ store, secret: SIGNING });
  const verifier = createCredentialVerifier({ store, secret: SIGNING });
  const issued = await issuer.issue({
    workspaceId: WS,
    agentId: AGENT,
    runId: RUN,
    requestedCapabilities: [CAP],
  });
  const entries: BrokerAuditEntry[] = [];
  const logLines: string[] = [];
  const logger = createLogger({
    destination: {
      write: (chunk) => {
        logLines.push(chunk);
      },
    },
  });
  const broker = createCredentialBroker({
    verifier,
    secrets: createInMemorySecretStore([
      {
        workspaceId: WS,
        name: "crm_api_key",
        value: VALUE,
        capabilities: options.boundCapabilities ?? [CAP],
      },
    ]),
    sink: {
      record: (entry) => {
        entries.push(entry);
      },
    },
    logger,
  });
  const request = {
    workspaceId: WS,
    agentId: AGENT,
    runId: RUN,
    toolName: "crm_lookup",
    capability: CAP,
    secretRef: "secret:crm_api_key",
    credentialToken: issued.token,
  };
  return { broker, request, entries, logLines, issuer, store, token: issued.token };
}

const everythingFor = (...parts: unknown[]) => JSON.stringify(parts);

describe("credential broker: allowed call", () => {
  it("runs the function with the value and returns only scrubbed text", async () => {
    const { broker, request, entries, logLines } = await setup();
    const use = vi.fn((secret: string) => Promise.resolve(`header was Bearer ${secret}`));

    const text = await broker.withSecret(request, use);

    expect(use).toHaveBeenCalledWith(VALUE);
    expect(text).not.toContain(VALUE);
    expect(text).toContain("[redacted]");
    // AC3: the call is recorded with the agent and the tool, in the sink and in the log.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agentId: AGENT,
      toolName: "crm_lookup",
      capability: CAP,
      secretRef: "secret:crm_api_key",
      outcome: "allowed",
      workspaceId: WS,
      runId: RUN,
    });
    const logged = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      agent_id: AGENT,
      tool_name: "crm_lookup",
      broker_ref: "crm_api_key",
      outcome: "allowed",
    });
    // AC2: neither the value nor the credential token is in what was written.
    expect(everythingFor(entries, logLines)).not.toContain(VALUE);
  });

  it("scrubs the value out of an error the function throws", async () => {
    const { broker, request, entries } = await setup();

    const failure = await broker
      .withSecret(request, () => Promise.reject(new Error(`401 for key ${VALUE}`)))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrokerToolError);
    expect((failure as Error).message).not.toContain(VALUE);
    expect((failure as Error).cause).toBeUndefined();
    expect(entries.map((entry) => `${entry.outcome}:${String(entry.reason)}`)).toEqual([
      "allowed:null",
      "error:tool_error",
    ]);
  });

  it("refuses a function that returns something other than text", async () => {
    const { broker, request } = await setup();
    const failure = await broker
      .withSecret(request, () => Promise.resolve({ key: VALUE } as never))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrokerToolError);
    expect((failure as Error).message).not.toContain(VALUE);
  });
});

describe("credential broker: refused calls never release the value", () => {
  async function expectDenied(
    run: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<unknown>,
    reason: string,
    options?: Parameters<typeof setup>[0],
  ) {
    const ctx = await setup(options);
    const result = await run(ctx).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(BrokerDeniedError);
    expect((result as BrokerDeniedError).reason).toBe(reason);
    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]).toMatchObject({ outcome: "denied", reason, toolName: "crm_lookup" });
    expect(everythingFor(ctx.entries, ctx.logLines, (result as Error).message)).not.toContain(
      VALUE,
    );
  }

  it("a pasted key instead of a reference", async () => {
    const pasted = ["Pw3", "Hh8", "kD5nQ1sY0zXc"].join("_");
    const ctx = await setup();
    const use = vi.fn(() => Promise.resolve("x"));
    await expect(
      ctx.broker.withSecret({ ...ctx.request, secretRef: pasted }, use),
    ).rejects.toMatchObject({ reason: "invalid_reference" });
    expect(use).not.toHaveBeenCalled();
    // The malformed input might be a real key: it is never audited or logged.
    expect(ctx.entries[0]?.secretRef).toBeNull();
    expect(everythingFor(ctx.entries, ctx.logLines)).not.toContain(pasted);
  });

  it("no credential token", async () => {
    await expectDenied(
      ({ broker, request }) =>
        broker.withSecret({ ...request, credentialToken: undefined }, () => Promise.resolve("x")),
      "no_credential",
    );
  });

  it("a credential without the tool's capability", async () => {
    await expectDenied(
      ({ broker, request }) =>
        broker.withSecret({ ...request, capability: "vault.write" }, () => Promise.resolve("x")),
      "missing_capability",
    );
  });

  it("a revoked credential", async () => {
    await expectDenied(async ({ broker, request, issuer }) => {
      await issuer.revokeForRun({ workspaceId: WS, runId: RUN });
      return broker.withSecret(request, () => Promise.resolve("x"));
    }, "revoked");
  });

  it("a credential for another run", async () => {
    await expectDenied(
      ({ broker, request }) =>
        broker.withSecret({ ...request, runId: "00000000-0000-4000-8000-0000000000b2" }, () =>
          Promise.resolve("x"),
        ),
      "wrong_run",
    );
  });

  it("a tampered token", async () => {
    await expectDenied(
      ({ broker, request, token }) =>
        broker.withSecret({ ...request, credentialToken: `${token}x` }, () => Promise.resolve("x")),
      "bad_signature",
    );
  });

  it.each([
    ["an unknown name", { secretRef: "secret:other" }],
    ["another workspace", { workspaceId: OTHER_WS }],
  ])("%s is refused without running the function", async (_label, change) => {
    const ctx = await setup();
    const use = vi.fn(() => Promise.resolve("x"));
    const outcome = await ctx.broker
      .withSecret({ ...ctx.request, ...change }, use)
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(BrokerDeniedError);
    expect(use).not.toHaveBeenCalled();
  });

  it("a secret not bound to the capability", async () => {
    await expectDenied(
      ({ broker, request }) => broker.withSecret(request, () => Promise.resolve("x")),
      "secret_unavailable",
      { boundCapabilities: ["vault.write"] },
    );
  });

  it("fails closed when the audit sink is down", async () => {
    const ctx = await setup();
    const broker = createCredentialBroker({
      verifier: createCredentialVerifier({ store: ctx.store, secret: SIGNING }),
      secrets: createInMemorySecretStore([
        { workspaceId: WS, name: "crm_api_key", value: VALUE, capabilities: [CAP] },
      ]),
      sink: { record: () => Promise.reject(new Error("sink down")) },
    });
    const use = vi.fn(() => Promise.resolve("x"));
    await expect(broker.withSecret(ctx.request, use)).rejects.toMatchObject({
      reason: "audit_unavailable",
    });
    expect(use).not.toHaveBeenCalled();
  });

  it("treats a failing secret store as unavailable, without its message", async () => {
    const ctx = await setup();
    const broker = createCredentialBroker({
      verifier: createCredentialVerifier({ store: ctx.store, secret: SIGNING }),
      secrets: { resolve: () => Promise.reject(new Error("db at host-internal:5432 refused")) },
    });
    const failure = await broker
      .withSecret(ctx.request, () => Promise.resolve("x"))
      .catch((error: unknown) => error);
    expect((failure as BrokerDeniedError).reason).toBe("secret_unavailable");
    expect((failure as Error).message).not.toContain("host-internal");
  });
});

describe("in-memory secret store", () => {
  it("rejects a bad name and an empty value when it is built", () => {
    expect(() =>
      createInMemorySecretStore([
        { workspaceId: WS, name: "Bad Name", value: "v", capabilities: [] },
      ]),
    ).toThrow();
    expect(() =>
      createInMemorySecretStore([{ workspaceId: WS, name: "ok", value: "", capabilities: [] }]),
    ).toThrow(/empty value/);
  });
});

describe("secret scrubber", () => {
  const spellings: [string, string][] = [
    ["raw", VALUE],
    ["base64", Buffer.from(VALUE).toString("base64")],
    ["base64 without padding", Buffer.from(VALUE).toString("base64").replace(/=+$/, "")],
    ["base64url", Buffer.from(VALUE).toString("base64url")],
    ["hex", Buffer.from(VALUE).toString("hex")],
    ["upper hex", Buffer.from(VALUE).toString("hex").toUpperCase()],
    ["url-encoded", encodeURIComponent(VALUE)],
  ];

  it.each(spellings)("removes the %s form", (_label, form) => {
    const scrub = createSecretScrubber(VALUE);
    expect(scrub(`before ${form} after`)).toBe("before [redacted] after");
  });

  it("removes every occurrence and leaves other text alone", () => {
    const scrub = createSecretScrubber(VALUE);
    expect(scrub(`${VALUE}|${VALUE}|plain`)).toBe("[redacted]|[redacted]|plain");
  });

  it("has no forms for an empty value, so it cannot garble text", () => {
    expect(secretForms("")).toEqual([]);
    expect(createSecretScrubber("")("untouched")).toBe("untouched");
  });

  it("still applies the shared pattern scrubber to other credentials", () => {
    const other = ["Bearer", ["tok", "Qw8Er7Ty6Ui5"].join("_")].join(" ");
    expect(createSecretScrubber(VALUE)(`auth: ${other}`)).not.toContain("Qw8Er7Ty6Ui5");
  });
});
