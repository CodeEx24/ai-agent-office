// AGO-160 integration test: the real Postgres claim functions through the worker ClaimStore, no model and no
// network. It skips itself when the shared local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-160 ... release AGO-160
//   AC1  two workers claim the same task at the same instant (separate connections): exactly one wins, 25 rounds,
//        plus a 6-way race
//   AC2  an expired claim is taken by another agent; the old holder cannot renew, release or complete; the
//        worker's own clock plays no part in expiry
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgClaimStore, type ClaimStore } from "./claim-store.js";

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const RACE_ROUNDS = 25;

async function isDatabaseUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const live = await isDatabaseUp();

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const AGENT_1 = randomUUID();
const AGENT_2 = randomUUID();
const AGENT_ARCHIVED = randomUUID();
const OTHER_AGENT = randomUUID();

/** A gate that releases every waiting attempt in the same tick, so the connections really do race. */
function startingGun(): { wait: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { wait, fire };
}

describe.skipIf(!live)("task claims (live database)", () => {
  const clients: pg.Client[] = [];
  let admin: pg.Client;
  let stores: ClaimStore[];

  async function connect(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function newTask(workspaceId = WORKSPACE): Promise<string> {
    const id = randomUUID();
    await admin.query(
      "insert into public.tasks (id, workspace_id, title) values ($1, $2, 'claim test')",
      [id, workspaceId],
    );
    return id;
  }

  async function expireNow(taskId: string): Promise<void> {
    await admin.query(
      `update public.claims set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where task_id = $1 and released_at is null`,
      [taskId],
    );
  }

  async function activeClaims(taskId: string): Promise<number> {
    const result = await admin.query(
      "select count(*)::int as n from public.claims where task_id = $1 and released_at is null",
      [taskId],
    );
    return (result.rows[0] as { n: number }).n;
  }

  // Events written in one transaction share created_at, so compare as sorted sets, not as a sequence.
  async function eventTypes(taskId: string): Promise<string[]> {
    const result = await admin.query("select type from public.claim_events where task_id = $1", [
      taskId,
    ]);
    return result.rows.map((row: { type: string }) => row.type).sort();
  }

  beforeAll(async () => {
    admin = await connect();
    stores = [];
    for (let i = 0; i < 6; i++) stores.push(createPgClaimStore(await connect()));
    await admin.query(
      "insert into public.workspaces (id, name) values ($1, 'AGO-160 live'), ($2, 'AGO-160 live other')",
      [WORKSPACE, OTHER_WORKSPACE],
    );
    await admin.query(
      `insert into public.agents (id, workspace_id, name, archived_at) values
         ($1, $5, 'claim-1', null), ($2, $5, 'claim-2', null), ($3, $5, 'claim-archived', now()), ($4, $6, 'claim-other', null)`,
      [AGENT_1, AGENT_2, AGENT_ARCHIVED, OTHER_AGENT, WORKSPACE, OTHER_WORKSPACE],
    );
  });

  afterAll(async () => {
    // Deleting the workspace is the one allowed removal: it cascades to claims and claim_events.
    await admin.query("delete from public.workspaces where id = any($1)", [
      [WORKSPACE, OTHER_WORKSPACE],
    ]);
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  });

  it(`AC1: two workers claim the same task at the same instant, ${String(RACE_ROUNDS)} rounds, exactly one wins every time`, async () => {
    const [storeA, storeB] = stores as [ClaimStore, ClaimStore];
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const taskId = await newTask();
      const gun = startingGun();
      const attempt = (store: ClaimStore, agentId: string) =>
        gun.wait.then(() =>
          store.claim({ workspaceId: WORKSPACE, taskId, agentId, ttlSeconds: 60 }),
        );
      const pending = Promise.all([attempt(storeA, AGENT_1), attempt(storeB, AGENT_2)]);
      gun.fire();
      const [first, second] = await pending;

      expect([first.outcome, second.outcome].sort(), `round ${String(round)}`).toEqual([
        "claimed",
        "held",
      ]);
      const winner = first.outcome === "claimed" ? AGENT_1 : AGENT_2;
      const loser = first.outcome === "held" ? first : second;
      if (loser.outcome === "held") expect(loser.holderAgentId).toBe(winner);
      expect(await activeClaims(taskId)).toBe(1);
      expect(await eventTypes(taskId)).toEqual(["claim.acquired"]);
    }
  });

  it("AC1: six workers claim at once, 5 rounds, exactly one wins every time", async () => {
    const agents = [AGENT_1, AGENT_2, AGENT_1, AGENT_2, AGENT_1, AGENT_2];
    for (let round = 0; round < 5; round++) {
      const taskId = await newTask();
      const gun = startingGun();
      const pending = Promise.all(
        stores.map((store, index) =>
          gun.wait.then(() =>
            store.claim({
              workspaceId: WORKSPACE,
              taskId,
              agentId: agents[index] as string,
              ttlSeconds: 60,
            }),
          ),
        ),
      );
      gun.fire();
      const results = await pending;
      expect(
        results.filter((r) => r.outcome === "claimed"),
        `round ${String(round)}`,
      ).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "held")).toHaveLength(5);
      expect(await activeClaims(taskId)).toBe(1);
    }
  });

  it("AC2: an expired claim is taken by another agent, and the old holder is fenced out", async () => {
    const [store1, store2] = stores as [ClaimStore, ClaimStore];
    const taskId = await newTask();
    const first = await store1.claim({
      workspaceId: WORKSPACE,
      taskId,
      agentId: AGENT_1,
      ttlSeconds: 60,
    });
    if (first.outcome !== "claimed") throw new Error("expected the first claim to win");
    const oldRef = { workspaceId: WORKSPACE, claimId: first.claimId, claimToken: first.claimToken };

    // While it is live, nobody else can take it.
    expect((await store2.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_2 })).outcome).toBe(
      "held",
    );

    await expireNow(taskId);
    expect(await store1.renew(oldRef)).toEqual({ outcome: "refused", reason: "claim_expired" });

    const second = await store2.claim({
      workspaceId: WORKSPACE,
      taskId,
      agentId: AGENT_2,
      ttlSeconds: 60,
    });
    if (second.outcome !== "claimed") throw new Error("expected the takeover to win");
    expect(second.claimToken).not.toBe(first.claimToken);

    // The old holder: nothing works, with the old claim id or with the old token on the new claim.
    expect((await store1.renew(oldRef)).outcome).toBe("refused");
    expect((await store1.release(oldRef, "released")).outcome).toBe("refused");
    expect((await store1.release(oldRef, "completed")).outcome).toBe("refused");
    const staleOnNew = { ...oldRef, claimId: second.claimId };
    expect(await store1.renew(staleOnNew)).toEqual({ outcome: "refused", reason: "stale_token" });
    expect(await store1.release(staleOnNew, "released")).toEqual({
      outcome: "refused",
      reason: "stale_token",
    });
    expect(await store1.release(staleOnNew, "completed")).toEqual({
      outcome: "refused",
      reason: "stale_token",
    });
    expect(await activeClaims(taskId)).toBe(1);

    // The new holder is unaffected and can finish.
    const newRef = {
      workspaceId: WORKSPACE,
      claimId: second.claimId,
      claimToken: second.claimToken,
    };
    expect((await store2.renew(newRef, 120)).outcome).toBe("renewed");
    expect(await store2.release(newRef, "completed")).toEqual({ outcome: "completed" });
    expect(await eventTypes(taskId)).toEqual([
      "claim.acquired",
      "claim.acquired",
      "claim.completed",
      "claim.expired",
      "claim.renewed",
    ]);
  });

  it("AC2: two agents race for an expired claim and exactly one takes it", async () => {
    const [storeA, storeB] = stores as [ClaimStore, ClaimStore];
    for (let round = 0; round < 10; round++) {
      const taskId = await newTask();
      const seed = await storeA.claim({
        workspaceId: WORKSPACE,
        taskId,
        agentId: AGENT_1,
        ttlSeconds: 60,
      });
      expect(seed.outcome).toBe("claimed");
      await expireNow(taskId);
      const gun = startingGun();
      const pending = Promise.all([
        gun.wait.then(() =>
          storeA.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_2, ttlSeconds: 60 }),
        ),
        gun.wait.then(() =>
          storeB.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_2, ttlSeconds: 60 }),
        ),
      ]);
      gun.fire();
      const results = await pending;
      expect(results.map((r) => r.outcome).sort(), `round ${String(round)}`).toEqual([
        "claimed",
        "held",
      ]);
      expect(await activeClaims(taskId)).toBe(1);
    }
  });

  it("AC2: expiry is the database's call, not the worker's clock", async () => {
    const [store1, store2] = stores as [ClaimStore, ClaimStore];
    const taskId = await newTask();
    const first = await store1.claim({
      workspaceId: WORKSPACE,
      taskId,
      agentId: AGENT_1,
      ttlSeconds: 60,
    });
    expect(first.outcome).toBe("claimed");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 365 * 24 * 3600 * 1000)); // this worker believes it is a year later
      expect(
        (await store2.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_2 })).outcome,
      ).toBe("held");
    } finally {
      vi.useRealTimers();
    }
    expect(await activeClaims(taskId)).toBe(1);
  });

  it("refuses an archived agent, another workspace's agent or task, and a bad run, each with its reason", async () => {
    const [store] = stores as [ClaimStore];
    const taskId = await newTask();
    expect(await store.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_ARCHIVED })).toEqual({
      outcome: "refused",
      reason: "agent_archived",
    });
    expect(await store.claim({ workspaceId: WORKSPACE, taskId, agentId: OTHER_AGENT })).toEqual({
      outcome: "refused",
      reason: "workspace_mismatch",
    });
    const otherTask = await newTask(OTHER_WORKSPACE);
    expect(
      await store.claim({ workspaceId: WORKSPACE, taskId: otherTask, agentId: AGENT_1 }),
    ).toEqual({ outcome: "refused", reason: "workspace_mismatch" });
    expect(
      await store.claim({ workspaceId: WORKSPACE, taskId: randomUUID(), agentId: AGENT_1 }),
    ).toEqual({ outcome: "refused", reason: "task_not_found" });
    expect(
      await store.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_1, runId: randomUUID() }),
    ).toEqual({ outcome: "refused", reason: "run_mismatch" });
    expect(await activeClaims(taskId)).toBe(0);
  });

  it("sweeps abandoned claims so the tasks free up, and logs each one", async () => {
    const [store] = stores as [ClaimStore];
    const taskId = await newTask();
    await store.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_1, ttlSeconds: 60 });
    await expireNow(taskId);
    expect(await store.sweepExpired(WORKSPACE)).toBe(1);
    expect(await activeClaims(taskId)).toBe(0);
    expect(await store.sweepExpired(WORKSPACE)).toBe(0);
    expect(await eventTypes(taskId)).toEqual(["claim.acquired", "claim.expired"]);
    expect((await store.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_2 })).outcome).toBe(
      "claimed",
    );
  });

  it("never writes a claim token into the event log", async () => {
    const [store] = stores as [ClaimStore];
    const taskId = await newTask();
    const claim = await store.claim({
      workspaceId: WORKSPACE,
      taskId,
      agentId: AGENT_1,
      ttlSeconds: 60,
    });
    if (claim.outcome !== "claimed") throw new Error("expected a claim");
    await store.renew({
      workspaceId: WORKSPACE,
      claimId: claim.claimId,
      claimToken: claim.claimToken,
    });
    const leaked = await admin.query(
      "select count(*)::int as n from public.claim_events where task_id = $1 and payload::text like $2",
      [taskId, `%${claim.claimToken}%`],
    );
    expect((leaked.rows[0] as { n: number }).n).toBe(0);
  });
});
