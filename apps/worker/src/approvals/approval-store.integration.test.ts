// AGO-21 integration test: the real Postgres approval store against public.approvals. It skips itself when
// the shared local Supabase stack is down. Run it inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-21 ... release AGO-21
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { ApprovalConflictError, createPgApprovalStore } from "./approval-store.js";

import type { NewApproval } from "./approval-store.js";

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

const WS = randomUUID();
const OTHER_WS = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const HASH = "b".repeat(64);
const T0 = new Date("2026-11-13T00:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe.skipIf(!live)("Postgres approval store (live database)", { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let runId: string;
  let otherRunId: string;
  const store = () => createPgApprovalStore(pool);
  const status = async (id: string): Promise<string> =>
    (
      await pool.query<{ status: string }>("select status from public.approvals where id = $1", [
        id,
      ])
    ).rows[0]?.status ?? "missing";
  const input = (over: Partial<NewApproval> = {}): NewApproval => ({
    workspaceId: WS,
    runId,
    agentId: AGENT,
    approvalId: randomUUID(),
    action: "risky",
    payloadHash: HASH,
    expiresAt: later(60_000),
    ...over,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    for (const [workspace, agent] of [
      [WS, AGENT],
      [OTHER_WS, OTHER_AGENT],
    ] as const) {
      await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-21 test')", [
        workspace,
      ]);
      await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, 'a')", [
        agent,
        workspace,
      ]);
    }
    runId = randomUUID();
    otherRunId = randomUUID();
    await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
      runId,
      WS,
      AGENT,
    ]);
    await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
      otherRunId,
      OTHER_WS,
      OTHER_AGENT,
    ]);
  });

  afterAll(async () => {
    const ids = `'${WS}', '${OTHER_WS}'`;
    await pool.query(`
      begin;
      delete from public.approvals where workspace_id in (${ids});
      delete from public.runs where workspace_id in (${ids});
      delete from public.agents where workspace_id in (${ids});
      delete from public.workspaces where id in (${ids});
      commit;`);
    await pool.end();
  });

  it("creates a pending row and reads it back inside its workspace only", async () => {
    const a = input();
    const stored = await store().create(a);

    expect(stored).toMatchObject({
      approvalId: a.approvalId,
      status: "pending",
      payloadHash: HASH,
    });
    expect(stored.expiresAt.getTime()).toBe(a.expiresAt.getTime());
    expect(await store().get({ workspaceId: WS, approvalId: a.approvalId })).not.toBeNull();
    expect(await store().get({ workspaceId: OTHER_WS, approvalId: a.approvalId })).toBeNull();
  });

  it("is idempotent: creating the same call again returns the one row", async () => {
    const a = input();
    await store().create(a);
    const again = await store().create({ ...a, expiresAt: later(999_000) });

    expect(again.expiresAt.getTime()).toBe(a.expiresAt.getTime());
    const count = await pool.query("select 1 from public.approvals where id = $1", [a.approvalId]);
    expect(count.rowCount).toBe(1);
  });

  it("refuses to hand back a row bound to a different run or payload", async () => {
    const a = input();
    await store().create(a);

    await expect(store().create({ ...a, payloadHash: "c".repeat(64) })).rejects.toBeInstanceOf(
      ApprovalConflictError,
    );
    await expect(
      store().create({ ...a, workspaceId: OTHER_WS, runId: otherRunId, agentId: OTHER_AGENT }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it("expires a due pending row exactly once, to rejected", async () => {
    const a = input({ expiresAt: later(1_000) });
    await store().create(a);
    const ref = { workspaceId: WS, approvalId: a.approvalId };

    expect(await store().expire(ref, later(999))).toBeNull();
    expect(await status(a.approvalId)).toBe("pending");

    const moved = await store().expire(ref, later(1_000));
    expect(moved).toMatchObject({ approvalId: a.approvalId, runId, payloadHash: HASH });
    expect(await status(a.approvalId)).toBe("rejected");
    expect(await store().expire(ref, later(5_000))).toBeNull();
  });

  it("does not expire across workspaces, or a row a human already decided", async () => {
    const a = input({ expiresAt: later(1_000) });
    await store().create(a);
    const crossWorkspace = { workspaceId: OTHER_WS, approvalId: a.approvalId };
    expect(await store().expire(crossWorkspace, later(9_000))).toBeNull();

    const b = input({ expiresAt: later(1_000) });
    await store().create(b);
    await pool.query("update public.approvals set status = 'denied' where id = $1", [b.approvalId]);
    expect(
      await store().expire({ workspaceId: WS, approvalId: b.approvalId }, later(9_000)),
    ).toBeNull();
    expect(await status(b.approvalId)).toBe("denied");
  });

  it("expireDue flips only the due pending rows, once, up to the limit", async () => {
    const due1 = input({ expiresAt: later(1_000) });
    const due2 = input({ expiresAt: later(2_000) });
    const notDue = input({ expiresAt: later(900_000) });
    for (const a of [due1, due2, notDue]) await store().create(a);

    const first = await store().expireDue(later(10_000), 1_000);
    const ids = first.map((row) => row.approvalId);
    expect(ids).toEqual(expect.arrayContaining([due1.approvalId, due2.approvalId]));
    expect(ids).not.toContain(notDue.approvalId);
    expect(await status(notDue.approvalId)).toBe("pending");
    expect(await store().expireDue(later(10_000), 1_000)).toEqual([]);

    const x = input({ expiresAt: later(1_000) });
    const y = input({ expiresAt: later(1_000) });
    for (const a of [x, y]) await store().create(a);
    expect(await store().expireDue(later(10_000), 1)).toHaveLength(1);
  });

  describe("consume (AGO-47)", () => {
    /** A row a human approved, the way the RLS-limited decide path will write it (status only). */
    async function approvedRow(over: Partial<NewApproval> = {}): Promise<NewApproval> {
      const a = input(over);
      await store().create(a);
      await pool.query("update public.approvals set status = 'approved' where id = $1", [
        a.approvalId,
      ]);
      return a;
    }
    const ref = (a: NewApproval) => ({
      workspaceId: a.workspaceId,
      runId: a.runId,
      approvalId: a.approvalId,
    });
    const consumedAt = async (id: string): Promise<Date | null> =>
      (
        await pool.query<{ consumed_at: Date | null }>(
          "select consumed_at from public.approvals where id = $1",
          [id],
        )
      ).rows[0]?.consumed_at ?? null;

    it("consumes an approved, unused, unexpired row with the matching hash, once", async () => {
      const a = await approvedRow();

      const first = await store().consume(ref(a), HASH, later(1_000));
      expect(first).toMatchObject({
        approvalId: a.approvalId,
        status: "approved",
        payloadHash: HASH,
      });
      expect(first?.consumedAt?.getTime()).toBe(later(1_000).getTime());

      expect(await store().consume(ref(a), HASH, later(2_000))).toBeNull();
      // The first use stays the recorded one, and the status is untouched (the worker never rewrites a decision).
      expect((await consumedAt(a.approvalId))?.getTime()).toBe(later(1_000).getTime());
      expect(await status(a.approvalId)).toBe("approved");
    });

    it("refuses a different payload hash and leaves the row unused", async () => {
      const a = await approvedRow();

      expect(await store().consume(ref(a), "c".repeat(64), later(1_000))).toBeNull();
      expect(await consumedAt(a.approvalId)).toBeNull();
      // The right hash still works afterwards: a refusal spends nothing.
      expect(await store().consume(ref(a), HASH, later(1_000))).not.toBeNull();
    });

    it("refuses at the limit: expires_at > now is required, so now == expires_at is expired", async () => {
      const a = await approvedRow({ expiresAt: later(5_000) });

      expect(await store().consume(ref(a), HASH, later(5_000))).toBeNull();
      expect(await store().consume(ref(a), HASH, later(9_000))).toBeNull();
      expect(await consumedAt(a.approvalId)).toBeNull();
      expect(await store().consume(ref(a), HASH, later(4_999))).not.toBeNull();
    });

    it.each(["pending", "denied", "rejected"])("refuses a %s row", async (state) => {
      const a = input();
      await store().create(a);
      await pool.query("update public.approvals set status = $2 where id = $1", [
        a.approvalId,
        state,
      ]);

      expect(await store().consume(ref(a), HASH, later(1_000))).toBeNull();
      expect(await consumedAt(a.approvalId)).toBeNull();
    });

    it("is scoped by workspace and by run", async () => {
      const a = await approvedRow();

      expect(
        await store().consume({ ...ref(a), workspaceId: OTHER_WS }, HASH, later(1)),
      ).toBeNull();
      expect(await store().consume({ ...ref(a), runId: otherRunId }, HASH, later(1))).toBeNull();
      expect(await store().consume({ ...ref(a), runId: randomUUID() }, HASH, later(1))).toBeNull();
      expect(await consumedAt(a.approvalId)).toBeNull();
    });

    it("two concurrent consumes of one row give exactly one winner", async () => {
      const a = await approvedRow();
      // The pool has 4 connections, so these really run at the same time on separate connections.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store().consume(ref(a), HASH, later(1_000))),
      );

      expect(results.filter((row) => row !== null)).toHaveLength(1);
      expect(await consumedAt(a.approvalId)).not.toBeNull();
    });

    it("races across many rows without ever granting one row twice", async () => {
      const rows = await Promise.all(Array.from({ length: 5 }, () => approvedRow()));
      const results = await Promise.all(
        rows.flatMap((a) =>
          Array.from({ length: 4 }, () => store().consume(ref(a), HASH, later(1_000))),
        ),
      );

      expect(results.filter((row) => row !== null)).toHaveLength(rows.length);
      for (const a of rows) {
        expect(results.filter((row) => row?.approvalId === a.approvalId)).toHaveLength(1);
      }
    });

    it("a consumed row is never moved by the expiry paths", async () => {
      const a = await approvedRow({ expiresAt: later(1_000) });
      await store().consume(ref(a), HASH, later(500));

      expect(
        await store().expire({ workspaceId: WS, approvalId: a.approvalId }, later(9_000)),
      ).toBeNull();
      expect(await status(a.approvalId)).toBe("approved");
    });
  });
});
