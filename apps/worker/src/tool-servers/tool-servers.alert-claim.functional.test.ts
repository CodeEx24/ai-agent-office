import { describe, expect, it, vi } from "vitest";

import {
  AUDIENCE,
  connectorFor,
  createFakeToolServer,
  SERVER_ID,
} from "./fake-tool-server.test-helpers.js";
import { createInMemoryToolServerRegistry, MAX_ALERTED_HASHES } from "./registry.js";
import { allowlistServer, prepareReview, reviewAndPin } from "./review.js";
import { createToolServerGate } from "./tool-server-gate.js";

import type { ToolServerAlertSink, ToolServerChange, ToolServerScope } from "./alerts.js";
import type { ToolServerRegistry } from "./registry.js";

// Edge tests for the atomic alert claim (AGO-68 D11). Local fakes only: no network, no database.
vi.setConfig({ testTimeout: 15_000 });

const WS = "ws-a";
const AT = "2026-01-01T00:00:00.000Z";
const SCOPE: ToolServerScope = { workspaceId: WS, agentId: "agent-1", runId: "run-1" };
const HUMAN = { kind: "human", userId: "owner-1" } as const;

const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

interface SinkOptions {
  /** Called for every attempt (1-based); return a promise to make the sink slow or failing. */
  readonly onAttempt?: (attempt: number) => Promise<void>;
}

function setup(
  options: { sink?: SinkOptions; wrap?: (r: ToolServerRegistry) => ToolServerRegistry } = {},
) {
  const base = createInMemoryToolServerRegistry();
  const registry = options.wrap?.(base) ?? base;
  const server = createFakeToolServer();
  const connector = connectorFor({ [WS]: { [SERVER_ID]: server } });
  const attempts: ToolServerChange[] = [];
  const delivered: ToolServerChange[] = [];
  const alerts: ToolServerAlertSink = {
    changed: async (_scope, change) => {
      attempts.push(change);
      await options.sink?.onAttempt?.(attempts.length);
      delivered.push(change);
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
    await repin();
  };
  const repin = async () => {
    const review = await prepareReview(deps, HUMAN, { workspaceId: WS, serverId: SERVER_ID });
    await reviewAndPin(deps, HUMAN, {
      workspaceId: WS,
      serverId: SERVER_ID,
      reviewedHash: review.hash,
    });
  };
  return { base, registry, server, gate, deps, attempts, delivered, approve, repin };
}

describe("alert claim: slow sink interleaved with other checks", () => {
  it("denies every check and raises one alert while the first sink call is still in flight", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { gate, server, approve, attempts, delivered } = setup({
      sink: { onAttempt: () => hold },
    });
    await approve();
    server.setDescription("lookup", "evil");

    const first = gate.check(SCOPE, SERVER_ID);
    await ticks(50); // the first check is now parked inside the sink
    expect(attempts).toHaveLength(1);

    const during = await Promise.all(
      Array.from({ length: 10 }, () => gate.check(SCOPE, SERVER_ID)),
    );
    expect(during.every((v) => !v.ok)).toBe(true);
    expect(attempts).toHaveLength(1);

    release();
    expect((await first).ok).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it("stays denied while the sink is slow even if the live list reverts to the pin", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { gate, server, approve } = setup({ sink: { onAttempt: () => hold } });
    await approve();
    server.setDescription("lookup", "evil");
    const first = gate.check(SCOPE, SERVER_ID);
    await ticks(50);
    server.setDescription("lookup", "lookup tool");

    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "hash_mismatch" });
    release();
    await first;
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "hash_mismatch" });
  });

  it("raises a separate alert for a second distinct hash while the first alert is still sending", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { gate, server, approve, attempts, delivered } = setup({
      sink: { onAttempt: (n) => (n === 1 ? hold : Promise.resolve()) },
    });
    await approve();
    server.setDescription("lookup", "evil-1");
    const first = gate.check(SCOPE, SERVER_ID);
    await ticks(50);
    server.setDescription("lookup", "evil-2");
    await gate.check(SCOPE, SERVER_ID);
    release();
    await first;

    expect(attempts).toHaveLength(2);
    expect(new Set(delivered.map((c) => c.liveHash)).size).toBe(2);
  });
});

describe("alert claim: release then re-claim ordering", () => {
  it("grants the claim again only after a release, and only once per release", async () => {
    const { base, approve } = setup();
    await approve();
    const claim = () => base.claimAlert(WS, SERVER_ID, "h1", AT);

    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
    await base.releaseAlert(WS, SERVER_ID, "h1");
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
  });

  it("two parallel claims right after a release produce exactly one winner", async () => {
    const { base, approve } = setup();
    await approve();
    await base.claimAlert(WS, SERVER_ID, "h1", AT);
    await base.releaseAlert(WS, SERVER_ID, "h1");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => base.claimAlert(WS, SERVER_ID, "h1", AT)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("releasing one hash leaves the claim on another hash intact", async () => {
    const { base, approve } = setup();
    await approve();
    await base.claimAlert(WS, SERVER_ID, "h1", AT);
    await base.claimAlert(WS, SERVER_ID, "h2", AT);
    await base.releaseAlert(WS, SERVER_ID, "h1");
    expect(await base.claimAlert(WS, SERVER_ID, "h2", AT)).toBe(false);
    expect(await base.claimAlert(WS, SERVER_ID, "h1", AT)).toBe(true);
  });

  it("releasing a hash that was never claimed or on an unknown server changes nothing", async () => {
    const { base, approve } = setup();
    await approve();
    await base.releaseAlert(WS, SERVER_ID, "never"); // not blocked yet
    await base.releaseAlert("ws-x", "nope", "never");
    expect((await base.get(WS, SERVER_ID))?.blocked ?? null).toBeNull();
    expect(await base.get("ws-x", "nope")).toBeNull();
  });

  it("a release never lifts the block", async () => {
    const { base, approve } = setup();
    await approve();
    await base.claimAlert(WS, SERVER_ID, "h1", AT);
    await base.releaseAlert(WS, SERVER_ID, "h1");
    expect((await base.get(WS, SERVER_ID))?.blocked).toMatchObject({ observedHash: "h1" });
  });
});

describe("alert claim: a sink that fails once under 25 parallel checks", () => {
  it("denies all 25, then delivers exactly one alert on a later check and never loses it", async () => {
    const { gate, server, approve, attempts, delivered } = setup({
      sink: {
        onAttempt: (n) => (n === 1 ? Promise.reject(new Error("sink down")) : Promise.resolve()),
      },
    });
    await approve();
    server.setDescription("lookup", "evil");

    const verdicts = await Promise.all(
      Array.from({ length: 25 }, () => gate.check(SCOPE, SERVER_ID)),
    );
    expect(verdicts.every((v) => !v.ok)).toBe(true);
    expect(delivered.length).toBeLessThanOrEqual(1);

    // A later check retries when the batch itself did not deliver.
    const later = await gate.check(SCOPE, SERVER_ID);
    expect(later.ok).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(attempts.length).toBeLessThanOrEqual(2);

    // And now it is claimed for good: more checks add nothing.
    await Promise.all(Array.from({ length: 10 }, () => gate.check(SCOPE, SERVER_ID)));
    expect(delivered).toHaveLength(1);
  });

  it("keeps denying when releaseAlert itself throws after the sink failed", async () => {
    const { gate, server, approve, delivered } = setup({
      sink: { onAttempt: () => Promise.reject(new Error("sink down")) },
      wrap: (r) => ({
        ...r,
        get: r.get.bind(r),
        claimAlert: r.claimAlert.bind(r),
        markBlocked: r.markBlocked.bind(r),
        allowlist: r.allowlist.bind(r),
        pin: r.pin.bind(r),
        releaseAlert: () => Promise.reject(new Error("registry down")),
      }),
    });
    await approve();
    server.setDescription("lookup", "evil");
    const verdicts = await Promise.all(
      Array.from({ length: 5 }, () => gate.check(SCOPE, SERVER_ID)),
    );
    expect(verdicts.every((v) => !v.ok)).toBe(true);
    expect(delivered).toHaveLength(0);
  });

  it("denies every caller with hash_mismatch when claimAlert itself throws", async () => {
    const { gate, server, approve, attempts } = setup({
      wrap: (r) => ({
        ...r,
        get: r.get.bind(r),
        markBlocked: r.markBlocked.bind(r),
        releaseAlert: r.releaseAlert.bind(r),
        allowlist: r.allowlist.bind(r),
        pin: r.pin.bind(r),
        claimAlert: () => Promise.reject(new Error("registry down")),
      }),
    });
    await approve();
    server.setDescription("lookup", "evil");
    const verdicts = await Promise.all(
      Array.from({ length: 5 }, () => gate.check(SCOPE, SERVER_ID)),
    );
    expect(verdicts).toEqual(
      Array.from({ length: 5 }, () => ({ ok: false, reason: "hash_mismatch" })),
    );
    expect(attempts).toHaveLength(0);
  });
});

describe("alert claim: unknown server and human re-pin", () => {
  it("claimAlert for an unknown server or workspace returns false and creates nothing", async () => {
    const { base, approve } = setup();
    await approve();
    expect(await base.claimAlert(WS, "nope", "h", AT)).toBe(false);
    expect(await base.claimAlert("ws-x", SERVER_ID, "h", AT)).toBe(false);
    expect(await base.get(WS, "nope")).toBeNull();
    expect(await base.get("ws-x", SERVER_ID)).toBeNull();
    expect((await base.get(WS, SERVER_ID))?.blocked ?? null).toBeNull();
  });

  it("a claim in one workspace never consumes the claim of another workspace", async () => {
    const { base, approve } = setup();
    await approve();
    await base.allowlist({
      workspaceId: "ws-b",
      serverId: SERVER_ID,
      audience: AUDIENCE,
      audienceSecretRef: "secret:crm_signing",
      allowlistedBy: "owner-2",
      allowlistedAt: AT,
    });
    expect(await base.claimAlert(WS, SERVER_ID, "h1", AT)).toBe(true);
    expect(await base.claimAlert("ws-b", SERVER_ID, "h1", AT)).toBe(true);
    expect(await base.claimAlert(WS, SERVER_ID, "h1", AT)).toBe(false);
  });

  it("alerts again for the same hash after a human re-pin cleared the block and the alerted hashes", async () => {
    const { gate, server, approve, repin, base, delivered } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    await gate.check(SCOPE, SERVER_ID);
    expect(delivered).toHaveLength(1);
    const evilHash = delivered[0]?.liveHash;

    // Human reviews the original state again and pins it: block and alerted hashes are gone.
    server.setDescription("lookup", "lookup tool");
    await repin();
    expect((await base.get(WS, SERVER_ID))?.blocked ?? null).toBeNull();
    expect((await gate.check(SCOPE, SERVER_ID)).ok).toBe(true);

    // The same evil state returns: it is a new mismatch against the new pin and must alert again.
    server.setDescription("lookup", "evil");
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "hash_mismatch" });
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.liveHash).toBe(evilHash);
  });

  it("a pin after a claim clears the claim so the same hash can be claimed again", async () => {
    const { base, approve, repin } = setup();
    await approve();
    expect(await base.claimAlert(WS, SERVER_ID, "h1", AT)).toBe(true);
    await repin();
    expect((await base.get(WS, SERVER_ID))?.blocked ?? null).toBeNull();
    expect(await base.claimAlert(WS, SERVER_ID, "h1", AT)).toBe(true);
  });

  it("a claim racing a human re-pin never leaves the server ok under the old claim's block after the pin wins last", async () => {
    const { gate, base, server, approve, repin } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    await Promise.all([gate.check(SCOPE, SERVER_ID), gate.check(SCOPE, SERVER_ID)]);
    server.setDescription("lookup", "lookup tool");
    await repin();
    // The pin ran last, so the human decision stands.
    expect((await base.get(WS, SERVER_ID))?.blocked ?? null).toBeNull();
    expect((await gate.check(SCOPE, SERVER_ID)).ok).toBe(true);
  });
});

describe("alert claim: bounded alerted-hash memory", () => {
  it("keeps at most MAX_ALERTED_HASHES hashes and the block still holds", async () => {
    const { base, approve } = setup();
    await approve();
    const total = MAX_ALERTED_HASHES + 10;
    for (let i = 0; i < total; i += 1) {
      expect(await base.claimAlert(WS, SERVER_ID, `h${String(i)}`, AT)).toBe(true);
    }
    const blocked = (await base.get(WS, SERVER_ID))?.blocked;
    expect(blocked?.alertedHashes).toHaveLength(MAX_ALERTED_HASHES);
    expect(blocked?.observedHash).toBe("h0");
    expect(blocked?.alertedHash).toBe(`h${String(total - 1)}`);
    // The newest hash is still remembered; the oldest was forgotten.
    expect(await base.claimAlert(WS, SERVER_ID, `h${String(total - 1)}`, AT)).toBe(false);
    expect(await base.claimAlert(WS, SERVER_ID, "h0", AT)).toBe(true);
  });

  it("the gate still denies every check after the memory overflowed and an old hash is forgotten", async () => {
    const { gate, base, server, approve, delivered } = setup();
    await approve();
    server.setDescription("lookup", "evil");
    await gate.check(SCOPE, SERVER_ID); // blocks; first alert
    const firstHash = delivered[0]?.liveHash ?? "";
    for (let i = 0; i < MAX_ALERTED_HASHES + 5; i += 1) {
      await base.claimAlert(WS, SERVER_ID, `filler-${String(i)}`, AT);
    }
    // The first hash fell out of memory: it may alert again, but must never be allowed.
    expect((await base.get(WS, SERVER_ID))?.blocked?.alertedHashes).not.toContain(firstHash);
    for (let i = 0; i < 3; i += 1) {
      expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "hash_mismatch" });
    }
    // Reverting to the pinned list is still denied (sticky), not unblocked by forgetting.
    server.setDescription("lookup", "lookup tool");
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "hash_mismatch" });
    expect((await base.get(WS, SERVER_ID))?.blocked).not.toBeNull();
  });

  it("releasing every remembered hash leaves the server blocked with no alerted hash", async () => {
    const { base, approve } = setup();
    await approve();
    await base.claimAlert(WS, SERVER_ID, "h1", AT);
    await base.claimAlert(WS, SERVER_ID, "h2", AT);
    await base.releaseAlert(WS, SERVER_ID, "h1");
    await base.releaseAlert(WS, SERVER_ID, "h2");
    expect((await base.get(WS, SERVER_ID))?.blocked).toMatchObject({
      alertedHash: null,
      alertedHashes: [],
    });
  });
});

describe("alert claim: never makes a server ok", () => {
  it("a claim on a healthy pinned server blocks it instead of allowing it", async () => {
    const { gate, base, approve } = setup();
    await approve();
    expect((await gate.check(SCOPE, SERVER_ID)).ok).toBe(true);
    await base.claimAlert(WS, SERVER_ID, "whatever", AT);
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "hash_mismatch" });
  });

  it("a claim does not touch the pin or the allowlist entry", async () => {
    const { base, approve } = setup();
    await approve();
    const before = await base.get(WS, SERVER_ID);
    await base.claimAlert(WS, SERVER_ID, "h1", AT);
    await base.releaseAlert(WS, SERVER_ID, "h1");
    const after = await base.get(WS, SERVER_ID);
    expect(after?.pin).toEqual(before?.pin);
    expect(after?.audience).toBe(before?.audience);
    expect(after?.allowlistedBy).toBe(before?.allowlistedBy);
  });

  it("a claim on an allowlisted but unpinned server keeps it denied as pin_missing", async () => {
    const { gate, base, deps } = setup();
    await allowlistServer(deps, HUMAN, {
      workspaceId: WS,
      serverId: SERVER_ID,
      audience: AUDIENCE,
      audienceSecretRef: "secret:crm_signing",
    });
    await base.claimAlert(WS, SERVER_ID, "h1", AT);
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({ ok: false, reason: "pin_missing" });
  });

  it("a claim for a server that is not allowlisted keeps it denied as server_not_allowlisted", async () => {
    const { gate, base } = setup();
    await base.claimAlert(WS, SERVER_ID, "h1", AT);
    expect(await gate.check(SCOPE, SERVER_ID)).toEqual({
      ok: false,
      reason: "server_not_allowlisted",
    });
  });
});
