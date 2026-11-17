import { describe, expect, it, vi } from "vitest";

import { createRunEventAlertSink } from "./alerts.js";
import {
  AUDIENCE,
  connectorFor,
  createFakeToolServer,
  SERVER_ID,
} from "./fake-tool-server.test-helpers.js";
import { createInMemoryToolServerRegistry } from "./registry.js";
import { allowlistServer, prepareReview, reviewAndPin } from "./review.js";
import { createToolServerGate } from "./tool-server-gate.js";

import type { ToolServerScope } from "./alerts.js";

vi.setConfig({ testTimeout: 15_000 });

/** A mismatch blocks until a human re-pins (AGO-68 D11), per workspace and server. */

const HUMAN = { kind: "human", userId: "owner-1" } as const;
type Ws = "ws-a" | "ws-b";
const scopeOf = (workspaceId: Ws): ToolServerScope => ({
  workspaceId,
  agentId: "agent-1",
  runId: "run-1",
});

function setup() {
  const registry = createInMemoryToolServerRegistry();
  const servers = {
    "ws-a": createFakeToolServer(),
    "ws-b": createFakeToolServer(),
  };
  const connector = connectorFor({
    "ws-a": { [SERVER_ID]: servers["ws-a"] },
    "ws-b": { [SERVER_ID]: servers["ws-b"] },
  });
  const events: unknown[] = [];
  const alerts = createRunEventAlertSink(() => ({
    emit: (event) => {
      events.push(event);
      return Promise.resolve({ id: "e", seq: events.length, created_at: "now" });
    },
  }));
  const gate = createToolServerGate({ registry, connector, alerts });
  const deps = { registry, connector };
  const pinReviewed = async (ws: Ws) => {
    const r = await prepareReview(deps, HUMAN, { workspaceId: ws, serverId: SERVER_ID });
    await reviewAndPin(deps, HUMAN, {
      workspaceId: ws,
      serverId: SERVER_ID,
      reviewedHash: r.hash,
    });
  };
  const approve = async (ws: Ws) => {
    await allowlistServer(deps, HUMAN, {
      workspaceId: ws,
      serverId: SERVER_ID,
      audience: AUDIENCE,
      audienceSecretRef: "secret:crm_signing",
    });
    await pinReviewed(ws);
  };
  return { registry, servers, gate, events, approve, pinReviewed };
}

describe("sticky block (AGO-68 D11)", () => {
  it("change then change back stays blocked, with one alert and a recorded block", async () => {
    const { gate, servers, approve, events, registry } = setup();
    await approve("ws-a");
    servers["ws-a"].setDescription("lookup", "evil");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
    servers["ws-a"].setDescription("lookup", "lookup tool");
    expect(await gate.check(scopeOf("ws-a"), SERVER_ID)).toEqual({
      ok: false,
      reason: "hash_mismatch",
    });
    expect(events).toHaveLength(1);
    const entry = await registry.get("ws-a", SERVER_ID);
    expect(entry?.blocked?.observedHash).toEqual(expect.any(String));
    expect(entry?.blocked?.blockedAt).toEqual(expect.any(String));
  });

  it("a human reviewAndPin of the original hash unblocks", async () => {
    const { gate, servers, approve, pinReviewed } = setup();
    await approve("ws-a");
    servers["ws-a"].setDescription("lookup", "evil");
    await gate.check(scopeOf("ws-a"), SERVER_ID);
    servers["ws-a"].setDescription("lookup", "lookup tool");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);

    await pinReviewed("ws-a");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(true);
  });

  it("a human can pin the new snapshot instead; the old one then counts as a change", async () => {
    const { gate, servers, approve, pinReviewed } = setup();
    await approve("ws-a");
    servers["ws-a"].setDescription("lookup", "reviewed new text");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
    await pinReviewed("ws-a");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(true);
    servers["ws-a"].setDescription("lookup", "lookup tool");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
  });

  it("a second different change while blocked raises one more alert, and a repeat none", async () => {
    const { gate, servers, approve, events } = setup();
    await approve("ws-a");
    servers["ws-a"].setDescription("lookup", "first");
    await gate.check(scopeOf("ws-a"), SERVER_ID);
    await gate.check(scopeOf("ws-a"), SERVER_ID);
    expect(events).toHaveLength(1);
    servers["ws-a"].setDescription("lookup", "second");
    await gate.check(scopeOf("ws-a"), SERVER_ID);
    await gate.check(scopeOf("ws-a"), SERVER_ID);
    expect(events).toHaveLength(2);
    // Back to the pin: still blocked, and no alert (nothing new was observed).
    servers["ws-a"].setDescription("lookup", "lookup tool");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
    expect(events).toHaveLength(2);
  });

  it("does not alert again from another run for the same hash (no flood)", async () => {
    const { gate, servers, approve, events } = setup();
    await approve("ws-a");
    servers["ws-a"].setDescription("lookup", "first");
    await gate.check(scopeOf("ws-a"), SERVER_ID);
    await gate.check({ ...scopeOf("ws-a"), runId: "run-2" }, SERVER_ID);
    expect(events).toHaveLength(1);
  });

  it("is per workspace: a block in one workspace leaves another untouched", async () => {
    const { gate, servers, approve, registry } = setup();
    await approve("ws-a");
    await approve("ws-b");
    servers["ws-a"].setDescription("lookup", "evil");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
    expect((await gate.check(scopeOf("ws-b"), SERVER_ID)).ok).toBe(true);
    expect((await registry.get("ws-b", SERVER_ID))?.blocked ?? null).toBeNull();
  });

  it("re-allowlisting clears the block along with the pin", async () => {
    const { gate, servers, approve, registry } = setup();
    await approve("ws-a");
    servers["ws-a"].setDescription("lookup", "evil");
    await gate.check(scopeOf("ws-a"), SERVER_ID);
    servers["ws-a"].setDescription("lookup", "lookup tool");
    await approve("ws-a"); // a fresh human allowlist and review
    expect((await registry.get("ws-a", SERVER_ID))?.blocked ?? null).toBeNull();
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(true);
  });

  it("25 parallel checks with two different hashes raise exactly two alerts", async () => {
    const { gate, servers, approve, events } = setup();
    await approve("ws-a");
    const many = () =>
      Promise.all(Array.from({ length: 25 }, () => gate.check(scopeOf("ws-a"), SERVER_ID)));
    servers["ws-a"].setDescription("lookup", "first");
    const one = await many();
    servers["ws-a"].setDescription("lookup", "second");
    const two = await many();
    expect([...one, ...two].every((v) => !v.ok)).toBe(true); // every caller is denied, claim or not
    expect(events).toHaveLength(2);
  });

  it("parallel checks across two workspaces raise one alert each", async () => {
    const { gate, servers, approve, events } = setup();
    await approve("ws-a");
    await approve("ws-b");
    servers["ws-a"].setDescription("lookup", "evil");
    servers["ws-b"].setDescription("lookup", "evil");
    const verdicts = await Promise.all(
      (["ws-a", "ws-b"] as const).flatMap((ws) =>
        Array.from({ length: 25 }, () => gate.check(scopeOf(ws), SERVER_ID)),
      ),
    );
    expect(verdicts.every((v) => !v.ok)).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("a failed alert gives the claim back so the next check alerts, and still denies", async () => {
    const registry = createInMemoryToolServerRegistry();
    const server = createFakeToolServer();
    const connector = connectorFor({ "ws-a": { [SERVER_ID]: server } });
    let fail = true;
    const sent: unknown[] = [];
    const gate = createToolServerGate({
      registry,
      connector,
      alerts: {
        changed: (scope) => {
          if (fail) return Promise.reject(new Error("sink down"));
          sent.push(scope);
          return Promise.resolve();
        },
      },
    });
    const deps = { registry, connector };
    await allowlistServer(deps, HUMAN, {
      workspaceId: "ws-a",
      serverId: SERVER_ID,
      audience: AUDIENCE,
      audienceSecretRef: "secret:crm_signing",
    });
    const r = await prepareReview(deps, HUMAN, { workspaceId: "ws-a", serverId: SERVER_ID });
    await reviewAndPin(deps, HUMAN, {
      workspaceId: "ws-a",
      serverId: SERVER_ID,
      reviewedHash: r.hash,
    });
    server.setDescription("lookup", "evil");
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
    fail = false;
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
    expect((await gate.check(scopeOf("ws-a"), SERVER_ID)).ok).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
