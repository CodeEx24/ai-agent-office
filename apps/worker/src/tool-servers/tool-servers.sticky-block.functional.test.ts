import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createToolOffer } from "../agent/tool-offer.js";
import { createCredentialBroker } from "../credentials/credential-broker.js";
import { createInMemorySecretStore } from "../credentials/secret-store.js";
import { createToolServerCaller, ToolServerDeniedError } from "./audience.js";
import {
  AUDIENCE,
  connectorFor,
  createFakeToolServer,
  SERVER_ID,
  SIGNING_KEY,
} from "./fake-tool-server.test-helpers.js";
import { createInMemoryToolServerRegistry } from "./registry.js";
import { allowlistServer, prepareReview, reviewAndPin } from "./review.js";
import { createToolServerGate } from "./tool-server-gate.js";

import type { AgentTool } from "../agent/tools.js";
import type { CredentialVerifier } from "../identity/index.js";
import type { ToolServerAlertSink, ToolServerScope } from "./alerts.js";
import type { ToolServerLookup, ToolServerRegistry } from "./registry.js";

// Edge tests for the sticky block (AGO-68 D11). Local fakes only: no network, no database.
vi.setConfig({ testTimeout: 15_000 });

const WS = "ws-a";
const SCOPE: ToolServerScope = { workspaceId: WS, agentId: "agent-1", runId: "run-1" };
const HUMAN = { kind: "human", userId: "owner-1" } as const;
const AGENT_TOKEN = ["ago", "agt", "header.payload.signature"].join("_");

const verifier: CredentialVerifier = {
  verify: (token) =>
    Promise.resolve(
      token === AGENT_TOKEN
        ? {
            ok: true,
            credentialId: "c1",
            agentId: "agent-1",
            capabilities: ["crm.read"],
            policyCheckRequired: true,
          }
        : { ok: false, reason: "bad_signature" },
    ),
};

/** Wraps a registry and records the name of every method called on it. */
function recordCalls(registry: ToolServerRegistry) {
  const calls: string[] = [];
  const wrapped = new Proxy(registry, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { wrapped, calls };
}

function setup(registryOverride?: (r: ToolServerRegistry) => ToolServerRegistry) {
  const baseRegistry = createInMemoryToolServerRegistry();
  const registry = registryOverride?.(baseRegistry) ?? baseRegistry;
  const server = createFakeToolServer();
  const connector = connectorFor({ [WS]: { [SERVER_ID]: server } });
  const alertScopes: string[] = [];
  const alerts: ToolServerAlertSink = {
    changed: (_scope, change) => {
      alertScopes.push(change.liveHash);
      return Promise.resolve();
    },
  };
  const gate = createToolServerGate({ registry, connector, alerts });
  const deps = { registry, connector };
  const approve = async () => {
    await allowlistServer(deps, HUMAN, {
      workspaceId: WS,
      serverId: SERVER_ID,
      audience: AUDIENCE,
      audienceSecretRef: "secret:crm_signing",
    });
    const review = await prepareReview(deps, HUMAN, { workspaceId: WS, serverId: SERVER_ID });
    await reviewAndPin(deps, HUMAN, {
      workspaceId: WS,
      serverId: SERVER_ID,
      reviewedHash: review.hash,
    });
  };
  return { baseRegistry, registry, server, connector, gate, deps, alertScopes, approve };
}

const serverTool = (name: string): AgentTool => ({
  name,
  description: name,
  tier: 1,
  capabilityKey: "crm.read",
  serverId: SERVER_ID,
  inputSchema: z.looseObject({}),
  modelInputSchema: { type: "object" },
  execute: () => Promise.resolve("ok"),
});

describe("sticky block: worker restart", () => {
  it("a fresh registry after a restart denies the server as not allowlisted, never ok", async () => {
    const first = setup();
    await first.approve();
    first.server.setDescription("lookup", "evil");
    expect((await first.gate.check(SCOPE, SERVER_ID)).ok).toBe(false);

    // Restart: a new in-memory registry holds nothing, even though the server now matches its old pin.
    first.server.setDescription("lookup", "lookup tool");
    const restarted = createInMemoryToolServerRegistry();
    const gate = createToolServerGate({ registry: restarted, connector: first.connector });
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({
      ok: false,
      reason: "server_not_allowlisted",
    });
  });
});

describe("sticky block: concurrent mismatches", () => {
  it("many parallel checks of one mismatching server all deny and leave one block", async () => {
    const { gate, server, approve, baseRegistry } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    const verdicts = await Promise.all(
      Array.from({ length: 25 }, () => gate.check(SCOPE, SERVER_ID)),
    );
    expect(verdicts.every((v) => !v.ok)).toBe(true);
    const entry = await baseRegistry.get(WS, SERVER_ID);
    expect(entry?.blocked?.observedHash).toEqual(expect.any(String));
    expect(entry?.blocked?.alertedHash).toBe(entry?.blocked?.observedHash);
  });

  it("many parallel checks of one mismatching hash raise exactly one alert", async () => {
    const { gate, server, approve, alertScopes } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    await Promise.all(Array.from({ length: 25 }, () => gate.check(SCOPE, SERVER_ID)));
    expect(alertScopes).toHaveLength(1);
  });

  it("parallel checks across runs for the same hash raise exactly one alert", async () => {
    const { gate, server, approve, alertScopes } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        gate.check({ ...SCOPE, runId: `run-${String(i)}` }, SERVER_ID),
      ),
    );
    expect(alertScopes).toHaveLength(1);
  });
});

describe("sticky block: an agent cannot re-allowlist", () => {
  it.each([
    ["an agent actor", { kind: "agent", userId: "agent-1" }],
    [
      "a human carrying an agent credential header",
      {
        kind: "human",
        userId: "owner-1",
        headers: new Headers({ authorization: `Bearer ${AGENT_TOKEN}` }),
      },
    ],
  ])("refuses re-allowlist by %s with human_only and keeps the block", async (_l, actor) => {
    const { gate, server, approve, deps, baseRegistry } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    await gate.check(SCOPE, SERVER_ID);
    server.setDescription("lookup", "lookup tool");

    await expect(
      allowlistServer(deps, actor, {
        workspaceId: WS,
        serverId: SERVER_ID,
        audience: AUDIENCE,
        audienceSecretRef: "secret:crm_signing",
      }),
    ).rejects.toMatchObject({ reason: "human_only" });

    expect((await baseRegistry.get(WS, SERVER_ID))?.blocked).not.toBeNull();
    expect((await baseRegistry.get(WS, SERVER_ID))?.pin).not.toBeNull();
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "hash_mismatch" });
  });

  it("refuses reviewAndPin by an agent actor and keeps the block", async () => {
    const { gate, server, approve, deps, baseRegistry } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    await gate.check(SCOPE, SERVER_ID);
    server.setDescription("lookup", "lookup tool");
    const review = await prepareReview(deps, HUMAN, { workspaceId: WS, serverId: SERVER_ID });

    await expect(
      reviewAndPin(
        deps,
        { kind: "agent", userId: "agent-1" },
        {
          workspaceId: WS,
          serverId: SERVER_ID,
          reviewedHash: review.hash,
        },
      ),
    ).rejects.toMatchObject({ reason: "human_only" });
    expect((await baseRegistry.get(WS, SERVER_ID))?.blocked).not.toBeNull();
    expect((await gate.check(SCOPE, SERVER_ID)).ok).toBe(false);
  });
});

describe("sticky block: agent-facing code cannot write or clear a block", () => {
  it("the lookup view and the block recorder do not expose allowlist or pin (type level)", () => {
    const lookup: ToolServerLookup = createInMemoryToolServerRegistry();
    // @ts-expect-error the agent-facing view has no pin
    expect(lookup.pin).toBeDefined(); // runtime object is the full registry; only the type hides it
    // @ts-expect-error the agent-facing view has no markBlocked
    expect(lookup.markBlocked).toBeDefined();
    const gateDeps: Parameters<typeof createToolServerGate>[0] = {
      registry: createInMemoryToolServerRegistry(),
      connector: connectorFor({}),
    };
    // @ts-expect-error the gate's registry cannot allowlist
    expect(gateDeps.registry.allowlist).toBeDefined();
    // @ts-expect-error the gate's registry cannot pin or unblock
    expect(gateDeps.registry.pin).toBeDefined();
  });

  it("caller and offer paths only ever read, block or note an alert; they never allowlist or pin", async () => {
    const { wrapped, calls } = recordCalls(createInMemoryToolServerRegistry());
    const { gate, server, approve } = setup(() => wrapped);
    await approve();
    calls.length = 0; // forget the human setup calls
    const broker = createCredentialBroker({
      verifier,
      secrets: createInMemorySecretStore([
        { workspaceId: WS, name: "crm_signing", value: SIGNING_KEY, capabilities: ["crm.read"] },
      ]),
    });
    const caller = createToolServerCaller({ registry: wrapped, gate, broker, transport: server });
    const offer = createToolOffer({
      source: { grantedCapabilities: () => Promise.resolve(["crm.read"]) },
      serverGate: gate,
    });
    const request = {
      ...SCOPE,
      serverId: SERVER_ID,
      toolName: "lookup",
      capability: "crm.read",
      input: {},
      credentialToken: AGENT_TOKEN,
    };

    // Healthy, then changed, then reverted: every agent-path action in the sticky-block lifecycle.
    await expect(caller.call(request)).resolves.toBe("ok:lookup");
    server.setDescription("lookup", "evil");
    await expect(caller.call(request)).rejects.toBeInstanceOf(ToolServerDeniedError);
    server.setDescription("lookup", "lookup tool");
    await expect(caller.call(request)).rejects.toMatchObject({ reason: "hash_mismatch" });
    expect([...(await offer.offeredToolNames([serverTool("lookup")], SCOPE))]).toEqual([]);

    const allowed = new Set(["get", "markBlocked", "claimAlert", "releaseAlert"]);
    expect(calls.filter((c) => !allowed.has(c))).toEqual([]);
    expect(calls).toContain("markBlocked");
    // The agent path never unblocked it: the block set during the run is still there.
    expect((await wrapped.get(WS, SERVER_ID))?.blocked).not.toBeNull();
  });

  it("markBlocked called twice keeps the first observed hash and time (idempotent, cannot be overwritten)", async () => {
    const { baseRegistry, approve } = setup();
    await approve();
    await baseRegistry.markBlocked(WS, SERVER_ID, "hash-1", "2026-01-01T00:00:00.000Z");
    await baseRegistry.markBlocked(WS, SERVER_ID, "hash-2", "2026-02-02T00:00:00.000Z");
    expect((await baseRegistry.get(WS, SERVER_ID))?.blocked).toMatchObject({
      observedHash: "hash-1",
      blockedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("markBlocked and claimAlert are no-ops for an unknown server or workspace (nothing is created)", async () => {
    const registry = createInMemoryToolServerRegistry();
    await registry.markBlocked("ws-x", "nope", "h", "2026-01-01T00:00:00.000Z");
    expect(await registry.claimAlert("ws-x", "nope", "h", "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(await registry.get("ws-x", "nope")).toBeNull();
  });
});
