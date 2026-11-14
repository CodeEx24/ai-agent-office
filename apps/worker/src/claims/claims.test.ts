import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startClaimHeartbeat } from "./claim-heartbeat.js";
import { createPgClaimStore, type ClaimQueryable, type ClaimStore } from "./claim-store.js";

import type { ClaimRef, RenewClaimResult } from "@ago/shared";

const WORKSPACE = randomUUID();
const TASK = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const REF: ClaimRef = { workspaceId: WORKSPACE, claimId: randomUUID(), claimToken: randomUUID() };

function fakeDb(
  rows: readonly unknown[],
): ClaimQueryable & { calls: { text: string; values: readonly unknown[] }[] } {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
}

describe("createPgClaimStore", () => {
  it("maps a won claim and sends the defaults (no run, 300 s)", async () => {
    const token = randomUUID();
    const claimId = randomUUID();
    const db = fakeDb([
      {
        outcome: "claimed",
        reason: null,
        claim_id: claimId,
        claim_token: token,
        expires_at: "2026-11-14T10:00:00.000Z",
        holder_agent_id: AGENT,
      },
    ]);
    const result = await createPgClaimStore(db).claim({
      workspaceId: WORKSPACE,
      taskId: TASK,
      agentId: AGENT,
    });
    expect(result).toEqual({
      outcome: "claimed",
      claimId,
      claimToken: token,
      expiresAt: new Date("2026-11-14T10:00:00.000Z"),
    });
    expect(db.calls[0]?.values).toEqual([WORKSPACE, TASK, AGENT, null, 300]);
    expect(db.calls[0]?.text).toContain("public.claim_task");
  });

  it("maps held (holder and expiry, no token) and refused (with the reason)", async () => {
    const held = await createPgClaimStore(
      fakeDb([
        {
          outcome: "held",
          reason: "task_already_claimed",
          claim_id: null,
          claim_token: null,
          expires_at: new Date(5_000),
          holder_agent_id: OTHER_AGENT,
        },
      ]),
    ).claim({ workspaceId: WORKSPACE, taskId: TASK, agentId: AGENT });
    expect(held).toEqual({
      outcome: "held",
      holderAgentId: OTHER_AGENT,
      expiresAt: new Date(5_000),
    });
    expect(held).not.toHaveProperty("claimToken");

    const refused = await createPgClaimStore(
      fakeDb([
        {
          outcome: "refused",
          reason: "agent_archived",
          claim_id: null,
          claim_token: null,
          expires_at: null,
          holder_agent_id: null,
        },
      ]),
    ).claim({ workspaceId: WORKSPACE, taskId: TASK, agentId: AGENT });
    expect(refused).toEqual({ outcome: "refused", reason: "agent_archived" });
  });

  it("rejects bad input before any statement runs (ttl out of range, not a uuid, extra field)", async () => {
    const db = fakeDb([]);
    const store = createPgClaimStore(db);
    await expect(
      store.claim({ workspaceId: WORKSPACE, taskId: TASK, agentId: AGENT, ttlSeconds: 5 }),
    ).rejects.toThrow();
    await expect(
      store.claim({ workspaceId: WORKSPACE, taskId: TASK, agentId: AGENT, ttlSeconds: 3601 }),
    ).rejects.toThrow();
    await expect(
      store.claim({ workspaceId: "nope", taskId: TASK, agentId: AGENT }),
    ).rejects.toThrow();
    await expect(
      store.claim({
        workspaceId: WORKSPACE,
        taskId: TASK,
        agentId: AGENT,
        claimedBy: "x",
      } as never),
    ).rejects.toThrow();
    await expect(store.renew({ ...REF, claimToken: "not-a-token" })).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  it("fails loudly when the database answers with an unknown reason or no row", async () => {
    const store = createPgClaimStore(fakeDb([{ outcome: "refused", reason: "something_new" }]));
    await expect(
      store.claim({ workspaceId: WORKSPACE, taskId: TASK, agentId: AGENT }),
    ).rejects.toThrow();
    await expect(
      createPgClaimStore(fakeDb([])).claim({
        workspaceId: WORKSPACE,
        taskId: TASK,
        agentId: AGENT,
      }),
    ).rejects.toThrow(/no row/);
  });

  it("renews, releases and completes with the token, and maps refusals", async () => {
    const renewDb = fakeDb([{ outcome: "renewed", reason: null, expires_at: new Date(9_000) }]);
    expect(await createPgClaimStore(renewDb).renew(REF, 60)).toEqual({
      outcome: "renewed",
      expiresAt: new Date(9_000),
    });
    expect(renewDb.calls[0]?.values).toEqual([WORKSPACE, REF.claimId, REF.claimToken, 60]);

    expect(
      await createPgClaimStore(
        fakeDb([{ outcome: "refused", reason: "stale_token", expires_at: null }]),
      ).renew(REF),
    ).toEqual({ outcome: "refused", reason: "stale_token" });

    const releaseDb = fakeDb([{ outcome: "completed", reason: null }]);
    expect(await createPgClaimStore(releaseDb).release(REF, "completed")).toEqual({
      outcome: "completed",
    });
    expect(releaseDb.calls[0]?.values).toEqual([
      WORKSPACE,
      REF.claimId,
      REF.claimToken,
      "completed",
    ]);
    expect(
      await createPgClaimStore(fakeDb([{ outcome: "refused", reason: "claim_expired" }])).release(
        REF,
      ),
    ).toEqual({ outcome: "refused", reason: "claim_expired" });
    await expect(createPgClaimStore(fakeDb([])).release(REF, "deleted" as never)).rejects.toThrow();
  });

  it("sweeps one workspace or all and returns the count", async () => {
    const one = fakeDb([{ freed: "3" }]);
    expect(await createPgClaimStore(one).sweepExpired(WORKSPACE)).toBe(3);
    expect(one.calls[0]?.values).toEqual([WORKSPACE]);
    const all = fakeDb([{ freed: 0 }]);
    expect(await createPgClaimStore(all).sweepExpired()).toBe(0);
    expect(all.calls[0]?.values).toEqual([null]);
  });
});

describe("startClaimHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function storeWith(behaviour: () => Promise<RenewClaimResult>): {
    store: ClaimStore;
    renew: ReturnType<typeof vi.fn>;
  } {
    const renew = vi.fn(behaviour);
    const store: ClaimStore = {
      claim: vi.fn(),
      renew,
      release: vi.fn(),
      sweepExpired: vi.fn(),
    };
    return { store, renew };
  }

  it("renews every ttl / 3 and keeps the claim while the database says renewed", async () => {
    const { store, renew } = storeWith(() =>
      Promise.resolve({ outcome: "renewed", expiresAt: new Date() }),
    );
    const onLost = vi.fn();
    const heartbeat = startClaimHeartbeat({ store, ref: REF, ttlSeconds: 30, onLost });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith(REF, 30);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(onLost).not.toHaveBeenCalled();
    expect(heartbeat.isActive).toBe(true);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(heartbeat.isActive).toBe(false);
  });

  it("reports the loss once, with the database's reason, and stops renewing", async () => {
    const { store, renew } = storeWith(() =>
      Promise.resolve({ outcome: "refused", reason: "stale_token" }),
    );
    const onLost = vi.fn();
    const heartbeat = startClaimHeartbeat({ store, ref: REF, ttlSeconds: 30, onLost });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith("refused:stale_token");
    expect(renew).toHaveBeenCalledTimes(1);
    expect(heartbeat.isActive).toBe(false);
  });

  it("tolerates a transient error, then gives up as unreachable after a whole ttl without a renewal", async () => {
    let clock = 0;
    const { store } = storeWith(() => Promise.reject(new Error("db down")));
    const onLost = vi.fn();
    const onError = vi.fn();
    startClaimHeartbeat({ store, ref: REF, ttlSeconds: 30, onLost, onError, nowMs: () => clock });
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
    clock = 30_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onLost).toHaveBeenCalledWith("unreachable");
  });
});
