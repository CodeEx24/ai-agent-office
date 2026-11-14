// AGO-58 integration test: the SQL of the atomic approval-expiry wake (`wakeRunAfterExpiry`) against the real
// local Postgres, not the in-memory fake. It skips itself when the shared local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-58 ... release AGO-58
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgRunStore, RUN_STATUS } from "./index.js";

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
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();

describe.skipIf(!live)("wakeRunAfterExpiry (live database)", { timeout: 30_000 }, () => {
  let pool: pg.Pool;

  const newPausedRun = async (workspaceId = WORKSPACE, agentId = AGENT): Promise<string> => {
    const id = randomUUID();
    await pool.query(
      "insert into public.runs (id, workspace_id, agent_id, status) values ($1, $2, $3, $4)",
      [id, workspaceId, agentId, RUN_STATUS.paused],
    );
    return id;
  };
  const status = async (id: string): Promise<string> =>
    (await pool.query<{ status: string }>("select status from public.runs where id = $1", [id]))
      .rows[0]?.status ?? "missing";
  const requestPause = (workspaceId: string, runId: string) =>
    pool.query(
      "insert into private.run_checkpoints (workspace_id, run_id, pause_requested_at) values ($1, $2, now())",
      [workspaceId, runId],
    );

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
    for (const [workspace, agent] of [
      [WORKSPACE, AGENT],
      [OTHER_WORKSPACE, OTHER_AGENT],
    ] as const) {
      await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-58 test')", [
        workspace,
      ]);
      await pool.query(
        "insert into public.agents (id, workspace_id, name) values ($1, $2, 'agent')",
        [agent, workspace],
      );
    }
  });

  afterAll(async () => {
    const ids = [WORKSPACE, OTHER_WORKSPACE];
    await pool.query("delete from public.runs where workspace_id = any($1)", [ids]);
    await pool.query("delete from public.agents where workspace_id = any($1)", [ids]);
    await pool.query("delete from public.workspaces where id = any($1)", [ids]);
    await pool.end();
  });

  it("moves a paused run with no pause request to queued, and says true", async () => {
    const store = createPgRunStore(pool);
    const runId = await newPausedRun();
    await expect(store.wakeRunAfterExpiry({ workspaceId: WORKSPACE, runId })).resolves.toBe(true);
    expect(await status(runId)).toBe(RUN_STATUS.queued);
  });

  it("leaves a run paused when a human pause request is recorded", async () => {
    const store = createPgRunStore(pool);
    const runId = await newPausedRun();
    await requestPause(WORKSPACE, runId);
    await expect(store.wakeRunAfterExpiry({ workspaceId: WORKSPACE, runId })).resolves.toBe(false);
    expect(await status(runId)).toBe(RUN_STATUS.paused);
  });

  it("does not move a run that is not paused, or one named in another workspace", async () => {
    const store = createPgRunStore(pool);
    const queued = await newPausedRun();
    await pool.query("update public.runs set status = $2 where id = $1", [
      queued,
      RUN_STATUS.queued,
    ]);
    await expect(store.wakeRunAfterExpiry({ workspaceId: WORKSPACE, runId: queued })).resolves.toBe(
      false,
    );

    const paused = await newPausedRun();
    await expect(
      store.wakeRunAfterExpiry({ workspaceId: OTHER_WORKSPACE, runId: paused }),
    ).resolves.toBe(false);
    expect(await status(paused)).toBe(RUN_STATUS.paused);
  });

  it("two concurrent wakes make exactly one transition", async () => {
    const store = createPgRunStore(pool);
    for (let round = 0; round < 5; round += 1) {
      const runId = await newPausedRun();
      const ref = { workspaceId: WORKSPACE, runId };
      const results = await Promise.all([
        store.wakeRunAfterExpiry(ref),
        store.wakeRunAfterExpiry(ref),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await status(runId)).toBe(RUN_STATUS.queued);
    }
  });
});
