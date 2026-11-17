// AGO-84 acceptance (live database): the worker's kill switch guard and credential issuer against the REAL
// private.kill_switches table, written by the REAL public.activate_kill_switch / release_kill_switch functions.
// The in-memory drill proves how the loop reacts to a latch; this file proves the worker's SQL reads what the
// database function writes (scope rule, release, workspace isolation) and that the issuer path is refused.
// It skips itself when the local Supabase stack is down. Run it inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-84 ... release AGO-84
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import {
  createCredentialIssuer,
  createPgCredentialStore,
  type CredentialIssuer,
} from "../identity/index.js";
import { createPgKillSwitchGuard, KillSwitchActiveError } from "./kill-switch-guard.js";

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const TEST_ONLY_SIGNING_SECRET = "test-only-not-a-real-secret-for-the-kill-switch-live-test";

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

interface KillCounts {
  runs_stopped: number;
  credentials_revoked: number;
}

const live = await isDatabaseUp();

const WS = randomUUID();
const OTHER_WS = randomUUID();
const OWNER = randomUUID();
const AGENT_1 = randomUUID();
const AGENT_2 = randomUUID();
const OTHER_AGENT = randomUUID();

describe.skipIf(!live)("AGO-84 kill switch (live database)", { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  const guard = () => createPgKillSwitchGuard(pool);

  /** Call a kill switch function the way the web route does: as the signed-in owner (authenticated role). */
  async function asOwner(fn: "activate_kill_switch" | "release_kill_switch", args: unknown[]) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: OWNER, role: "authenticated" }),
      ]);
      const result = await client.query<{ r: KillCounts }>(
        `select public.${fn}($1, $2, $3) as r`,
        args,
      );
      await client.query("commit");
      const counts = result.rows[0];
      if (counts === undefined) throw new Error("kill switch function returned no row");
      return counts.r;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const activate = (scope: "workspace" | "agent", agentId: string | null = null) =>
    asOwner("activate_kill_switch", [WS, scope, agentId]);
  const release = (scope: "workspace" | "agent", agentId: string | null = null) =>
    asOwner("release_kill_switch", [WS, scope, agentId]);

  async function newRun(workspaceId: string, agentId: string): Promise<string> {
    const id = randomUUID();
    await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
      id,
      workspaceId,
      agentId,
    ]);
    return id;
  }
  const issuerWith = (withGuard: boolean): CredentialIssuer =>
    createCredentialIssuer({
      store: createPgCredentialStore(pool),
      secret: TEST_ONLY_SIGNING_SECRET,
      ...(withGuard ? { killSwitch: guard() } : {}),
    });

  async function clearLatches(): Promise<void> {
    await pool.query("delete from private.kill_switches where workspace_id in ($1, $2)", [
      WS,
      OTHER_WS,
    ]);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
      [OWNER, `ago84-live-${OWNER}@example.test`],
    );
    for (const [workspace, agents] of [
      [WS, [AGENT_1, AGENT_2]],
      [OTHER_WS, [OTHER_AGENT]],
    ] as const) {
      await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-84 live test')", [
        workspace,
      ]);
      for (const agent of agents) {
        await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, $3)", [
          agent,
          workspace,
          `agent-${agent}`,
        ]);
      }
    }
    await pool.query(
      "insert into public.members (workspace_id, user_id, role) values ($1, $2, 'owner')",
      [WS, OWNER],
    );
  });

  afterAll(async () => {
    const ids = [WS, OTHER_WS];
    await pool.query("delete from private.kill_switches where workspace_id = any($1::uuid[])", [
      ids,
    ]);
    // agent_credentials is append-only: its rows may only go with the cascade from the workspace itself.
    await pool.query("delete from public.workspaces where id = any($1::uuid[])", [ids]);
    await pool.query("delete from auth.users where id = $1", [OWNER]);
    await pool.end();
  });

  describe("AC1: the guard reads what activate_kill_switch latches", () => {
    it("reports nothing killed when no switch was ever pulled", async () => {
      await clearLatches();
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_1 })).toBe(false);
    });

    it("reports every agent of the workspace killed, and no other workspace, after a workspace kill", async () => {
      await clearLatches();
      await activate("workspace");
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_1 })).toBe(true);
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_2 })).toBe(true);
      expect(await guard().isKilled({ workspaceId: OTHER_WS, agentId: OTHER_AGENT })).toBe(false);
      await clearLatches();
    });

    it("reports only the targeted agent killed after an agent kill", async () => {
      await clearLatches();
      await activate("agent", AGENT_1);
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_1 })).toBe(true);
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_2 })).toBe(false);
      await clearLatches();
    });

    it("does not treat a stale agent id from another workspace as killed by this workspace's agent latch", async () => {
      await clearLatches();
      await activate("agent", AGENT_1);
      expect(await guard().isKilled({ workspaceId: OTHER_WS, agentId: AGENT_1 })).toBe(false);
      await clearLatches();
    });

    it("reports not killed again after the owner releases the switch", async () => {
      await clearLatches();
      await activate("workspace");
      await release("workspace");
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_1 })).toBe(false);
      await clearLatches();
    });

    it("keeps an agent latch live when a different agent's latch is released", async () => {
      await clearLatches();
      await activate("agent", AGENT_1);
      await activate("agent", AGENT_2);
      await release("agent", AGENT_2);
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_1 })).toBe(true);
      expect(await guard().isKilled({ workspaceId: WS, agentId: AGENT_2 })).toBe(false);
      await clearLatches();
    });

    it("fails closed when the latch table cannot be read", async () => {
      const broken = new pg.Pool({
        connectionString: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        connectionTimeoutMillis: 500,
      });
      broken.on("error", () => undefined);
      await expect(
        createPgKillSwitchGuard(broken).isKilled({ workspaceId: WS, agentId: AGENT_1 }),
      ).rejects.toThrow();
      await broken.end().catch(() => undefined);
    });
  });

  describe("AC1: no credential is issued in a latched scope", () => {
    it("issues a credential for a live run when no switch is set (control case)", async () => {
      await clearLatches();
      const runId = await newRun(WS, AGENT_1);
      const issued = await issuerWith(true).issue({ workspaceId: WS, agentId: AGENT_1, runId });
      expect(issued.token.length).toBeGreaterThan(0);
    });

    it("refuses the issuer with KillSwitchActiveError and writes no credential while the workspace is latched", async () => {
      await clearLatches();
      const runId = await newRun(WS, AGENT_1);
      await activate("workspace");
      await expect(
        issuerWith(true).issue({ workspaceId: WS, agentId: AGENT_1, runId }),
      ).rejects.toBeInstanceOf(KillSwitchActiveError);
      const rows = await pool.query("select 1 from public.agent_credentials where run_id = $1", [
        runId,
      ]);
      expect(rows.rowCount).toBe(0);
      await clearLatches();
    });

    it("still refuses in the database when the worker guard is bypassed (second layer)", async () => {
      await clearLatches();
      const runId = await newRun(WS, AGENT_2);
      await activate("agent", AGENT_2);
      await expect(
        issuerWith(false).issue({ workspaceId: WS, agentId: AGENT_2, runId }),
      ).rejects.toMatchObject({ code: "42501" });
      await clearLatches();
    });

    it("lets the sibling agent be issued a credential while one agent is latched", async () => {
      await clearLatches();
      await activate("agent", AGENT_1);
      const runId = await newRun(WS, AGENT_2);
      const issued = await issuerWith(true).issue({ workspaceId: WS, agentId: AGENT_2, runId });
      expect(issued.token.length).toBeGreaterThan(0);
      await clearLatches();
    });

    it("issues again for a new run after release", async () => {
      await clearLatches();
      await activate("workspace");
      await release("workspace");
      const runId = await newRun(WS, AGENT_1);
      const issued = await issuerWith(true).issue({ workspaceId: WS, agentId: AGENT_1, runId });
      expect(issued.token.length).toBeGreaterThan(0);
    });
  });

  describe("AC2: state is preserved after the kill", () => {
    it("revokes credentials without deleting them and flags the run for stop without deleting it", async () => {
      await clearLatches();
      const runId = await newRun(WS, AGENT_1);
      await issuerWith(false).issue({ workspaceId: WS, agentId: AGENT_1, runId });
      const result = await activate("workspace");
      expect(result.credentials_revoked).toBeGreaterThanOrEqual(1);
      expect(result.runs_stopped).toBeGreaterThanOrEqual(1);
      const cred = await pool.query<{ revoked_at: Date | null }>(
        "select revoked_at from public.agent_credentials where run_id = $1",
        [runId],
      );
      expect(cred.rowCount).toBeGreaterThanOrEqual(1);
      expect(cred.rows.every((r) => r.revoked_at !== null)).toBe(true);
      const stop = await pool.query<{ stop_requested_at: Date | null }>(
        "select stop_requested_at from private.run_checkpoints where workspace_id = $1 and run_id = $2",
        [WS, runId],
      );
      expect(stop.rows[0]?.stop_requested_at).not.toBeNull();
      const kept = await pool.query("select 1 from public.runs where id = $1", [runId]);
      expect(kept.rowCount).toBe(1);
      await clearLatches();
    });

    it("keeps credentials of another workspace live when this workspace is killed", async () => {
      await clearLatches();
      const otherRun = await newRun(OTHER_WS, OTHER_AGENT);
      await issuerWith(false).issue({
        workspaceId: OTHER_WS,
        agentId: OTHER_AGENT,
        runId: otherRun,
      });
      await activate("workspace");
      const cred = await pool.query<{ revoked_at: Date | null }>(
        "select revoked_at from public.agent_credentials where run_id = $1",
        [otherRun],
      );
      expect(cred.rows.every((r) => r.revoked_at === null)).toBe(true);
      await clearLatches();
    });
  });
});
