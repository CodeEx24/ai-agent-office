// AGO-160 functional acceptance tests (live database). These add what claims.integration.test.ts and
// supabase/tests/task_claims.test.sql do not already prove:
//   C1  the claim functions refuse anon / authenticated at call time (pgTAP only reads the grant table), allow
//       service_role, and are SECURITY DEFINER with an empty search_path (read from pg_proc)
//   C3  claim_events: a member really reads it through RLS, an outsider and anon do not, nobody can insert, update
//       or delete; members cannot read the fence token
//   D5  TTL bounds at the edges: 10 and 3600 accepted, 9 and 3601 refused (claim and renew), default 300
//   --  release then reclaim: a released claim can be claimed again with a new token, the old token is fenced
// It skips itself when the shared local Supabase stack is down. Run it inside the db lock as AGO-160.
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgClaimStore, type ClaimStore } from "./claim-store.js";

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

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
const MEMBER_USER = randomUUID();
const OUTSIDER_USER = randomUUID();

const CLAIM_FUNCTION_CALLS: readonly { name: string; sql: string; values: () => unknown[] }[] = [
  {
    name: "claim_task",
    sql: "select * from public.claim_task($1, $2, $3, null, 60)",
    values: () => [WORKSPACE, randomUUID(), AGENT_1],
  },
  {
    name: "renew_claim",
    sql: "select * from public.renew_claim($1, $2, $3, 60)",
    values: () => [WORKSPACE, randomUUID(), randomUUID()],
  },
  {
    name: "release_claim",
    sql: "select * from public.release_claim($1, $2, $3, 'released')",
    values: () => [WORKSPACE, randomUUID(), randomUUID()],
  },
  {
    name: "sweep_expired_claims",
    sql: "select public.sweep_expired_claims($1)",
    values: () => [WORKSPACE],
  },
];

describe.skipIf(!live)("task claims acceptance (live database)", () => {
  const clients: pg.Client[] = [];
  let admin: pg.Client;
  let store: ClaimStore;

  async function connect(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function newTask(workspaceId = WORKSPACE): Promise<string> {
    const id = randomUUID();
    await admin.query(
      "insert into public.tasks (id, workspace_id, title) values ($1, $2, 'acceptance test')",
      [id, workspaceId],
    );
    return id;
  }

  async function claimOk(taskId: string, agentId = AGENT_1, ttlSeconds = 60) {
    const result = await store.claim({ workspaceId: WORKSPACE, taskId, agentId, ttlSeconds });
    if (result.outcome !== "claimed") throw new Error(`expected a claim, got ${result.outcome}`);
    return {
      claimId: result.claimId,
      claimToken: result.claimToken,
      ref: {
        workspaceId: WORKSPACE,
        claimId: result.claimId,
        claimToken: result.claimToken,
      },
    };
  }

  /** Run `body` in a transaction as `role` (with an optional JWT subject), always rolled back. */
  async function asRole<T>(
    role: "anon" | "authenticated" | "service_role",
    userId: string | null,
    body: (db: pg.Client) => Promise<T>,
  ): Promise<T> {
    const db = await connect();
    await db.query("begin");
    try {
      await db.query(`set local role ${role}`);
      if (userId !== null) {
        await db.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: userId, role }),
        ]);
      }
      return await body(db);
    } finally {
      await db.query("rollback");
    }
  }

  /** The SQLSTATE of a failing statement (it aborts the transaction, which `asRole` rolls back). */
  async function sqlState(db: pg.Client, text: string, values: unknown[] = []): Promise<string> {
    try {
      await db.query(text, values);
    } catch (error) {
      return (error as { code?: string }).code ?? "no-code";
    }
    return "no-error";
  }

  beforeAll(async () => {
    admin = await connect();
    store = createPgClaimStore(await connect());
    await admin.query(
      "insert into public.workspaces (id, name) values ($1, 'AGO-160 acceptance'), ($2, 'AGO-160 acceptance other')",
      [WORKSPACE, OTHER_WORKSPACE],
    );
    await admin.query(
      "insert into public.agents (id, workspace_id, name) values ($1, $3, 'acc-1'), ($2, $3, 'acc-2')",
      [AGENT_1, AGENT_2, WORKSPACE],
    );
    await admin.query("insert into auth.users (id) values ($1), ($2)", [
      MEMBER_USER,
      OUTSIDER_USER,
    ]);
    await admin.query(
      "insert into public.members (workspace_id, user_id, role) values ($1, $2, 'viewer'), ($3, $4, 'owner')",
      [WORKSPACE, MEMBER_USER, OTHER_WORKSPACE, OUTSIDER_USER],
    );
  });

  afterAll(async () => {
    await admin.query("delete from public.workspaces where id = any($1)", [
      [WORKSPACE, OTHER_WORKSPACE],
    ]);
    await admin.query("delete from auth.users where id = any($1)", [[MEMBER_USER, OUTSIDER_USER]]);
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  });

  describe("C1: SECURITY DEFINER functions are locked down", () => {
    it.each(CLAIM_FUNCTION_CALLS)(
      "$name is refused for anon and for a signed-in member (permission denied)",
      async (call) => {
        for (const role of ["anon", "authenticated"] as const) {
          const state = await asRole(role, role === "anon" ? null : MEMBER_USER, (db) =>
            sqlState(db, call.sql, call.values()),
          );
          expect(state, `${call.name} as ${role}`).toBe("42501");
        }
      },
    );

    it("claim_task works for service_role, the one role that holds execute", async () => {
      const taskId = await newTask();
      const outcome = await asRole("service_role", null, async (db) => {
        const result = await db.query(
          "select outcome from public.claim_task($1, $2, $3, null, 60)",
          [WORKSPACE, taskId, AGENT_1],
        );
        return (result.rows[0] as { outcome: string }).outcome;
      });
      expect(outcome).toBe("claimed");
      // asRole rolls back, so the task stays free.
      expect(
        (await store.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_2 })).outcome,
      ).toBe("claimed");
    });

    it("every claim function is SECURITY DEFINER with an empty search_path and a pinned owner", async () => {
      const result = await admin.query(
        `select p.proname, p.prosecdef, p.proconfig
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and p.proname in ('claim_task', 'renew_claim', 'release_claim', 'sweep_expired_claims')
          order by p.proname`,
      );
      expect(result.rows.map((r: { proname: string }) => r.proname)).toEqual([
        "claim_task",
        "release_claim",
        "renew_claim",
        "sweep_expired_claims",
      ]);
      for (const row of result.rows as {
        proname: string;
        prosecdef: boolean;
        proconfig: string[];
      }[]) {
        expect(row.prosecdef, row.proname).toBe(true);
        const searchPath = row.proconfig.find((cfg) => cfg.startsWith("search_path="));
        expect(searchPath?.replace(/["']/g, ""), row.proname).toBe("search_path=");
      }
    });
  });

  describe("C3: claim_events access control", () => {
    it("a workspace member reads the claim events of their workspace through RLS", async () => {
      const taskId = await newTask();
      await claimOk(taskId);
      const types = await asRole("authenticated", MEMBER_USER, async (db) => {
        const result = await db.query("select type from public.claim_events where task_id = $1", [
          taskId,
        ]);
        return result.rows.map((r: { type: string }) => r.type);
      });
      expect(types).toEqual(["claim.acquired"]);
    });

    it("a user from another workspace sees no claim events of this workspace", async () => {
      const taskId = await newTask();
      await claimOk(taskId);
      const count = await asRole("authenticated", OUTSIDER_USER, async (db) => {
        const result = await db.query(
          "select count(*)::int as n from public.claim_events where task_id = $1",
          [taskId],
        );
        return (result.rows[0] as { n: number }).n;
      });
      expect(count).toBe(0);
    });

    it("anon cannot read claim events at all", async () => {
      const state = await asRole("anon", null, (db) =>
        sqlState(db, "select * from public.claim_events limit 1"),
      );
      expect(state).toBe("42501");
    });

    it.each(["authenticated", "service_role"] as const)(
      "%s cannot insert, update, delete or truncate claim events",
      async (role) => {
        const taskId = await newTask();
        const claim = await claimOk(taskId);
        const userId = role === "authenticated" ? MEMBER_USER : null;
        const statements: [string, unknown[]][] = [
          [
            "insert into public.claim_events (workspace_id, task_id, claim_id, agent_id, type) values ($1, $2, $3, $4, 'claim.released')",
            [WORKSPACE, taskId, claim.claimId, AGENT_1],
          ],
          ["update public.claim_events set type = 'claim.released' where task_id = $1", [taskId]],
          ["delete from public.claim_events where task_id = $1", [taskId]],
          ["truncate public.claim_events", []],
        ];
        for (const [text, values] of statements) {
          // each statement gets its own transaction: a failure aborts it
          const state = await asRole(role, userId, (db) => sqlState(db, text, values));
          expect(state, `${role}: ${text}`).toBe("42501");
        }
        expect(
          (
            await admin.query(
              "select count(*)::int as n from public.claim_events where task_id = $1",
              [taskId],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
      },
    );

    it("the table owner cannot update or delete a claim event either (trigger guard)", async () => {
      const taskId = await newTask();
      await claimOk(taskId);
      const db = await connect();
      await db.query("begin");
      try {
        expect(
          await sqlState(db, "update public.claim_events set type = 'x' where task_id = $1", [
            taskId,
          ]),
        ).toBe("42501");
      } finally {
        await db.query("rollback");
      }
      await db.query("begin");
      try {
        expect(
          await sqlState(db, "delete from public.claim_events where task_id = $1", [taskId]),
        ).toBe("42501");
      } finally {
        await db.query("rollback");
      }
      const left = await admin.query(
        "select count(*)::int as n from public.claim_events where task_id = $1",
        [taskId],
      );
      expect((left.rows[0] as { n: number }).n).toBe(1);
    });

    it("a member can read a claim's expiry but not its fence token", async () => {
      const taskId = await newTask();
      await claimOk(taskId);
      const states = await asRole("authenticated", MEMBER_USER, async (db) => {
        const ok = await db.query("select expires_at from public.claims where task_id = $1", [
          taskId,
        ]);
        // the failing statement goes last: it aborts the transaction
        const denied = await sqlState(
          db,
          "select claim_token from public.claims where task_id = $1",
          [taskId],
        );
        return { rows: ok.rows.length, denied };
      });
      expect(states).toEqual({ rows: 1, denied: "42501" });
    });
  });

  describe("D5: TTL bounds", () => {
    // Expected expiry derived from the ttl itself, independently of the code under test.
    async function ttlOf(claimId: string): Promise<number> {
      const result = await admin.query(
        "select round(extract(epoch from (expires_at - coalesce(renewed_at, claimed_at))))::int as s from public.claims where id = $1",
        [claimId],
      );
      return (result.rows[0] as { s: number }).s;
    }

    it.each([10, 3600])(
      "claim_task accepts a ttl of %i seconds, the inclusive bound",
      async (ttl) => {
        const taskId = await newTask();
        const claim = await claimOk(taskId, AGENT_1, ttl);
        expect(await ttlOf(claim.claimId)).toBe(ttl);
      },
    );

    it.each([9, 3601, 0, -1])(
      "claim_task refuses a ttl of %i seconds with invalid_ttl and leaves no claim",
      async (ttl) => {
        const taskId = await newTask();
        const result = await admin.query(
          "select outcome, reason from public.claim_task($1, $2, $3, null, $4)",
          [WORKSPACE, taskId, AGENT_1, ttl],
        );
        expect(result.rows).toEqual([{ outcome: "refused", reason: "invalid_ttl" }]);
        const claims = await admin.query(
          "select count(*)::int as n from public.claims where task_id = $1",
          [taskId],
        );
        expect((claims.rows[0] as { n: number }).n).toBe(0);
      },
    );

    it("claim_task with no ttl uses the 300 second default", async () => {
      const taskId = await newTask();
      const result = await store.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_1 });
      if (result.outcome !== "claimed") throw new Error("expected a claim");
      expect(await ttlOf(result.claimId)).toBe(300);
    });

    it.each([10, 3600])(
      "renew accepts a ttl of %i seconds and sets expiry that far from now",
      async (ttl) => {
        const taskId = await newTask();
        const claim = await claimOk(taskId);
        expect((await store.renew(claim.ref, ttl)).outcome).toBe("renewed");
        expect(await ttlOf(claim.claimId)).toBe(ttl);
      },
    );

    it.each([9, 3601])(
      "renew refuses a ttl of %i seconds with invalid_ttl and keeps the expiry",
      async (ttl) => {
        const taskId = await newTask();
        const claim = await claimOk(taskId, AGENT_1, 120);
        const result = await admin.query(
          "select outcome, reason from public.renew_claim($1, $2, $3, $4)",
          [WORKSPACE, claim.claimId, claim.claimToken, ttl],
        );
        expect(result.rows).toEqual([{ outcome: "refused", reason: "invalid_ttl" }]);
        expect(await ttlOf(claim.claimId)).toBe(120);
      },
    );

    it.each([9, 3601])(
      "the worker store rejects a ttl of %i seconds before it reaches the database",
      async (ttl) => {
        const taskId = await newTask();
        await expect(
          store.claim({ workspaceId: WORKSPACE, taskId, agentId: AGENT_1, ttlSeconds: ttl }),
        ).rejects.toThrow();
        const claims = await admin.query(
          "select count(*)::int as n from public.claims where task_id = $1",
          [taskId],
        );
        expect((claims.rows[0] as { n: number }).n).toBe(0);
      },
    );
  });

  describe("release then reclaim", () => {
    it("a released claim can be claimed again by another agent, with a new token, and the old token is fenced", async () => {
      const taskId = await newTask();
      const first = await claimOk(taskId, AGENT_1);
      expect(await store.release(first.ref, "released")).toEqual({ outcome: "released" });

      const second = await claimOk(taskId, AGENT_2);
      expect(second.claimId).not.toBe(first.claimId);
      expect(second.claimToken).not.toBe(first.claimToken);

      // old holder, old claim: already released
      expect(await store.renew(first.ref)).toEqual({
        outcome: "refused",
        reason: "claim_released",
      });
      expect(await store.release(first.ref, "completed")).toEqual({
        outcome: "refused",
        reason: "claim_released",
      });
      // old token on the new claim: stale
      const staleOnNew = { ...first.ref, claimId: second.claimId };
      expect(await store.renew(staleOnNew)).toEqual({ outcome: "refused", reason: "stale_token" });
      expect(await store.release(staleOnNew, "released")).toEqual({
        outcome: "refused",
        reason: "stale_token",
      });

      const active = await admin.query(
        "select agent_id from public.claims where task_id = $1 and released_at is null",
        [taskId],
      );
      expect(active.rows).toEqual([{ agent_id: AGENT_2 }]);
    });

    it("the same agent can reclaim its own released task and gets a fresh token", async () => {
      const taskId = await newTask();
      const first = await claimOk(taskId, AGENT_1);
      await store.release(first.ref, "released");
      const again = await claimOk(taskId, AGENT_1);
      expect(again.claimToken).not.toBe(first.claimToken);
      expect((await store.renew(again.ref)).outcome).toBe("renewed");
    });

    it("release with another workspace's id finds no claim and leaves the claim active", async () => {
      const taskId = await newTask();
      const claim = await claimOk(taskId);
      expect(await store.release({ ...claim.ref, workspaceId: OTHER_WORKSPACE })).toEqual({
        outcome: "refused",
        reason: "claim_not_found",
      });
      expect((await store.renew(claim.ref)).outcome).toBe("renewed");
    });
  });
});
