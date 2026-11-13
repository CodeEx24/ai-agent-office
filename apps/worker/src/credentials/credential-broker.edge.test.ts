import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCredentialIssuer, createCredentialVerifier } from "../identity/index.js";
import { createLogger } from "../logger.js";
import { createBrokeredTool, SECRET_REF_FIELD } from "./brokered-tool.js";
import { BrokerDeniedError, BrokerToolError, createCredentialBroker } from "./credential-broker.js";
import { createSecretScrubber } from "./secret-scrubber.js";
import { createInMemorySecretStore } from "./secret-store.js";

import type { ToolContext } from "../agent/tools.js";
import type { CredentialStore, StoredCredential } from "../identity/index.js";
import type { BrokerAuditEntry } from "@ago/shared";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_AGENT = "00000000-0000-4000-8000-0000000000a2";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const CAP = "crm.read";
const SIGNING = "t".repeat(40);
// Runtime-built, with regex-special, quote, backslash and non-ASCII characters.
const SPECIAL = ["a.b*c", "(d)[e]", "f+g?|h^$", 'q"uote', "back\\slash", "ünï-日本-🔑"].join("");
const PASTED = ["Zk4", "Lm9", "pastedNotARef77"].join("_");

function credentialStore(): CredentialStore {
  const rows = new Map<string, StoredCredential>();
  return {
    grantedCapabilities: () => Promise.resolve([CAP]),
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
    revokeForRun: () => Promise.resolve(0),
  };
}

async function setup(value = SPECIAL) {
  const store = credentialStore();
  const issued = await createCredentialIssuer({ store, secret: SIGNING }).issue({
    workspaceId: WS,
    agentId: AGENT,
    runId: RUN,
    requestedCapabilities: [CAP],
  });
  const entries: BrokerAuditEntry[] = [];
  const logLines: string[] = [];
  const broker = createCredentialBroker({
    verifier: createCredentialVerifier({ store, secret: SIGNING }),
    secrets: createInMemorySecretStore([
      { workspaceId: WS, name: "crm_api_key", value, capabilities: [CAP] },
      {
        workspaceId: OTHER_WS,
        name: "crm_api_key",
        value: "other-ws-value-1",
        capabilities: [CAP],
      },
    ]),
    sink: { record: (entry) => void entries.push(entry) },
    logger: createLogger({ destination: { write: (chunk) => void logLines.push(chunk) } }),
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
  return { broker, request, entries, logLines, token: issued.token };
}

describe("AC1: a prompt asking for a key returns no value (scrubbing edge cases)", () => {
  it("removes a value with regex-special and unicode characters in every spelling", () => {
    const scrub = createSecretScrubber(SPECIAL);
    const spellings = [
      SPECIAL,
      Buffer.from(SPECIAL).toString("base64"),
      Buffer.from(SPECIAL).toString("base64url"),
      Buffer.from(SPECIAL).toString("hex"),
      encodeURIComponent(SPECIAL),
      JSON.stringify(SPECIAL).slice(1, -1),
    ];
    for (const form of spellings) {
      expect(scrub(`x ${form} y`)).toBe("x [redacted] y");
    }
  });

  it("removes the value from every line of a multi-line error", async () => {
    const { broker, request } = await setup();
    const failure = await broker
      .withSecret(request, () =>
        Promise.reject(new Error(`line1 ${SPECIAL}\nline2 ${SPECIAL}\n  at x (${SPECIAL})`)),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrokerToolError);
    expect((failure as Error).message).not.toContain(SPECIAL);
    expect((failure as Error).message.split("\n")).toHaveLength(3);
  });

  it("returns a fixed message when the function throws something that is not an Error", async () => {
    const { broker, request, entries } = await setup();
    for (const thrown of [SPECIAL, { key: SPECIAL }, null, 42]) {
      const failure = await broker
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the point
        .withSecret(request, () => Promise.reject(thrown))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BrokerToolError);
      expect((failure as Error).message).toBe("tool failed");
    }
    expect(JSON.stringify(entries)).not.toContain(SPECIAL);
  });

  it("scrubs the value from a synchronous throw inside the function", async () => {
    const { broker, request } = await setup();
    const failure = await broker
      .withSecret(request, () => {
        throw new Error(`boom ${SPECIAL}`);
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrokerToolError);
    expect((failure as Error).message).not.toContain(SPECIAL);
  });
});

describe("AC2: secrets never appear in run events or logs (audit and log content)", () => {
  it("never writes a pasted key, the token or the value to the audit or the log", async () => {
    const { broker, request, entries, logLines, token } = await setup();
    await broker
      .withSecret({ ...request, secretRef: PASTED }, () => Promise.resolve("x"))
      .catch(() => undefined);
    await broker.withSecret(request, (secret) => Promise.resolve(secret));
    await broker
      .withSecret(request, () => Promise.reject(new Error(SPECIAL)))
      .catch(() => undefined);
    const written = JSON.stringify([entries, logLines]);
    expect(written).not.toContain(PASTED);
    expect(written).not.toContain(SPECIAL);
    expect(written).not.toContain(token);
    expect(entries.map((e) => e.outcome)).toEqual(["denied", "allowed", "allowed", "error"]);
  });

  it("returns the redaction marker, never the value, when the function echoes it", async () => {
    const { broker, request } = await setup();
    await expect(broker.withSecret(request, (secret) => Promise.resolve(secret))).resolves.toBe(
      "[redacted]",
    );
  });
});

describe("AC3: broker calls are logged with the agent and tool (denials and other agents)", () => {
  it("refuses a credential held by another agent and audits the call with the requesting agent", async () => {
    const { broker, request, entries } = await setup();
    const use = vi.fn(() => Promise.resolve("x"));
    const failure = await broker
      .withSecret({ ...request, agentId: OTHER_AGENT }, use)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrokerDeniedError);
    expect((failure as BrokerDeniedError).reason).toBe("wrong_agent");
    expect(use).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: "denied",
      agentId: OTHER_AGENT,
      toolName: "crm_lookup",
    });
  });

  it("audits a call refused because the credential belongs to another workspace", async () => {
    const { broker, request, entries } = await setup();
    const failure = await broker
      .withSecret({ ...request, workspaceId: OTHER_WS }, () => Promise.resolve("x"))
      .catch((error: unknown) => error);
    expect((failure as BrokerDeniedError).reason).toBe("wrong_workspace");
    expect(entries[0]).toMatchObject({ outcome: "denied", workspaceId: OTHER_WS });
  });

  it("keeps concurrent calls separate: each gets its own audit entry and its own result", async () => {
    const { broker, request, entries } = await setup();
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((tag, index) =>
        broker.withSecret({ ...request, toolName: `tool_${tag}` }, async (secret) => {
          await new Promise((resolve) => setTimeout(resolve, 8 - index * 2));
          return `${tag}:${secret}`;
        }),
      ),
    );
    expect(results).toEqual(["a:[redacted]", "b:[redacted]", "c:[redacted]", "d:[redacted]"]);
    expect(entries.map((e) => e.toolName).sort()).toEqual(["tool_a", "tool_b", "tool_c", "tool_d"]);
  });

  it("does not run the function and audits a tool error when the run is already aborted", async () => {
    const { broker, request, entries } = await setup();
    const use = vi.fn(() => Promise.resolve("x"));
    const controller = new AbortController();
    controller.abort();
    const failure = await broker
      .withSecret(request, use, controller.signal)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BrokerToolError);
    expect(use).not.toHaveBeenCalled();
    expect(entries.map((e) => e.reason)).toEqual([null, "tool_error"]);
  });
});

describe("in-memory secret store isolation", () => {
  it("serves the same name per workspace and never the other workspace's value", async () => {
    const store = createInMemorySecretStore([
      { workspaceId: WS, name: "k", value: "value-ws-one", capabilities: [CAP] },
      { workspaceId: OTHER_WS, name: "k", value: "value-ws-two", capabilities: [CAP] },
    ]);
    await expect(store.resolve({ workspaceId: WS, name: "k", capability: CAP })).resolves.toBe(
      "value-ws-one",
    );
    await expect(
      store.resolve({ workspaceId: OTHER_WS, name: "k", capability: CAP }),
    ).resolves.toBe("value-ws-two");
    await expect(
      store.resolve({
        workspaceId: "00000000-0000-4000-8000-000000000003",
        name: "k",
        capability: CAP,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a secret bound to no capability", async () => {
    const store = createInMemorySecretStore([
      { workspaceId: WS, name: "k", value: "v-1", capabilities: [] },
    ]);
    await expect(
      store.resolve({ workspaceId: WS, name: "k", capability: CAP }),
    ).resolves.toBeNull();
  });
});

describe("brokered tool input handling", () => {
  const context = (signal = new AbortController().signal): ToolContext => ({
    workspaceId: WS,
    runId: RUN,
    agentId: AGENT,
    signal,
  });

  /** The loop calls `execute` inside a safe wrapper, so a synchronous throw counts as a rejection. */
  const call = async (
    tool: { execute: (i: unknown, c: ToolContext) => Promise<string> },
    input: unknown,
    c = context(),
  ) => tool.execute(input, c);

  async function toolSetup() {
    const base = await setup();
    const run = vi.fn((args: { q: string }, secret: string) =>
      Promise.resolve(`found ${args.q} with ${secret}`),
    );
    const tool = createBrokeredTool({
      name: "crm_lookup",
      description: "Look up a contact.",
      tier: 1,
      capabilityKey: CAP,
      args: { q: z.string().min(1) },
      modelProperties: { q: { type: "string" } },
      modelRequired: ["q"],
      broker: base.broker,
      credentialFor: () => base.token,
      run,
    });
    return { ...base, tool, run };
  }

  it("runs with a valid reference and scrubs the value from the result", async () => {
    const { tool } = await toolSetup();
    await expect(
      tool.execute({ secret_ref: "secret:crm_api_key", q: "ada" }, context()),
    ).resolves.toBe("found ada with [redacted]");
  });

  it("rejects an extra field and never runs the function", async () => {
    const { tool, run, entries } = await toolSetup();
    await expect(
      call(tool, { secret_ref: "secret:crm_api_key", q: "ada", extra: PASTED }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
  });

  it("rejects a pasted key in the reference field without echoing it", async () => {
    const { tool, run } = await toolSetup();
    const failure = await call(tool, { secret_ref: PASTED, q: "ada" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a missing reference", async () => {
    const { tool, run } = await toolSetup();
    await expect(call(tool, { q: "ada" })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to build a tool whose own arguments use the reserved reference field", async () => {
    const { broker } = await setup();
    expect(() =>
      createBrokeredTool({
        name: "bad_tool",
        description: "x",
        tier: 1,
        capabilityKey: CAP,
        args: { [SECRET_REF_FIELD]: z.string() },
        modelProperties: {},
        broker,
        credentialFor: () => undefined,
        run: () => Promise.resolve("x"),
      }),
    ).toThrow(/reserved/);
  });

  it("describes the reference as required and forbids extra properties to the model", async () => {
    const { tool } = await toolSetup();
    expect(tool.modelInputSchema).toMatchObject({
      required: ["secret_ref", "q"],
      additionalProperties: false,
    });
  });

  it("does not run the function when the context signal is already aborted", async () => {
    const { tool, run } = await toolSetup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute({ secret_ref: "secret:crm_api_key", q: "ada" }, context(controller.signal)),
    ).rejects.toBeInstanceOf(BrokerToolError);
    expect(run).not.toHaveBeenCalled();
  });

  it("is denied when the run has no credential", async () => {
    const base = await setup();
    const tool = createBrokeredTool({
      name: "crm_lookup",
      description: "x",
      tier: 1,
      capabilityKey: CAP,
      args: {},
      modelProperties: {},
      broker: base.broker,
      credentialFor: () => undefined,
      run: () => Promise.resolve("x"),
    });
    await expect(
      tool.execute({ secret_ref: "secret:crm_api_key" }, context()),
    ).rejects.toMatchObject({
      reason: "no_credential",
    });
  });
});
