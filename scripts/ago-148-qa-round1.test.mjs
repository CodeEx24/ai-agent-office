/**
 * AGO-148 QA, fix round 1 re-test (tester-written). Probes of the "current state beats the snapshot" fix, through
 * the REAL built worker (`apps/worker/dist`) against the shared LOCAL Supabase stack:
 *
 * - re-grant: a removed capability that is granted again does NOT revive an old credential (the removal revoked it).
 *   Documented behaviour: a credential whose snapshot never carried the capability stays untouched by the removal.
 * - catalog toggle: disabling then re-enabling a capability is NOT a revoke, so the credential works again (the
 *   snapshot allowed it and it was never revoked). Documented, not asserted as a defect.
 * - unarchive: an archived agent's credentials stay revoked after unarchive; new issuance works again.
 * - concurrency: verification racing an archive commit never passes after the archive has committed.
 * - no stale cache: one long-lived verifier instance sees every state change on its very next call.
 *
 * Skips when no local Postgres answers or the worker is not built. Run inside the db lock:
 *   pnpm --filter @ago/worker build
 *   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-148-qa-round1.test.mjs
 * Creates its own workspace and removes it at the end (cascade). No `.env*` file is read.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITY_ENTRY = join(ROOT, "apps", "worker", "dist", "identity", "index.js");
const LOCAL_DB_PORT = Number(process.env.AGO_TEST_DB_PORT ?? 44322);
const LOCAL_DB = `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`;
const SECRET = "qa-round1-signing-secret-long-enough-1234";

function isPortOpen(port) {
  return new Promise((resolveProbe) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (open) => {
      socket.destroy();
      resolveProbe(open);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
const dbUp = await isPortOpen(LOCAL_DB_PORT);
const built = existsSync(IDENTITY_ENTRY);
const liveDescribe = describe.skipIf(!dbUp || !built);

const WORKSPACE = randomUUID();
let pool;
let issuer;
let verifier;

async function newAgent(capabilities = ["vault.read", "web.search"]) {
  const agentId = randomUUID();
  await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, $3)", [
    agentId,
    WORKSPACE,
    `qa round1 ${agentId}`,
  ]);
  for (const capability of capabilities) {
    await pool.query(
      "insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values ($1, $2, $3, $4)",
      [WORKSPACE, agentId, capability, capability === "vault.read" ? 0 : 1],
    );
  }
  return agentId;
}
async function newRun(agentId) {
  const id = randomUUID();
  await pool.query(
    "insert into public.runs (id, workspace_id, agent_id, status) values ($1, $2, $3, 'running')",
    [id, WORKSPACE, agentId],
  );
  return id;
}
async function issueFor(agentId) {
  const runId = await newRun(agentId);
  const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId, runId });
  return { ...issued, runId, agentId };
}
const check = (c, capability) =>
  verifier.verify(c.token, { workspaceId: WORKSPACE, runId: c.runId, capability });
const revokedAt = async (id) =>
  (await pool.query("select revoked_at from public.agent_credentials where id = $1", [id])).rows[0]
    .revoked_at;

beforeAll(async () => {
  if (!dbUp || !built) return;
  const requireFromWorker = createRequire(join(ROOT, "apps", "worker", "package.json"));
  const pg = requireFromWorker("pg");
  pool = new pg.Pool({ connectionString: LOCAL_DB, max: 8 });
  const identity = await import(pathToFileURL(IDENTITY_ENTRY).href);
  const store = identity.createPgCredentialStore(pool);
  issuer = identity.createCredentialIssuer({
    store,
    secret: SECRET,
    logger: { info: () => undefined },
  });
  // One long-lived verifier for the whole file: any cached answer would show up as a stale pass.
  verifier = identity.createCredentialVerifier({ store, secret: SECRET });
  await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-148 QA round 1')", [WORKSPACE]);
});

afterAll(async () => {
  if (pool === undefined) return;
  await pool.query("delete from public.workspaces where id = $1", [WORKSPACE]);
  await pool.end();
});

liveDescribe("round 1: re-grant after removal", () => {
  test("AC2: re-granting a removed capability does not revive the old credential (the removal revoked it)", async () => {
    const agent = await newAgent();
    const cred = await issueFor(agent);
    expect((await check(cred, "web.search")).ok).toBe(true);

    await pool.query("delete from public.agent_capabilities where agent_id = $1 and capability = 'web.search'", [
      agent,
    ]);
    expect(await check(cred, "web.search")).toEqual({ ok: false, reason: "revoked" });
    expect(await revokedAt(cred.credentialId)).not.toBeNull();

    await pool.query(
      "insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values ($1, $2, 'web.search', 1)",
      [WORKSPACE, agent],
    );

    // Still dead, for the removed capability and for the one that was never removed: the whole credential is revoked.
    expect(await check(cred, "web.search")).toEqual({ ok: false, reason: "revoked" });
    expect(await check(cred, "vault.read")).toEqual({ ok: false, reason: "revoked" });
  });

  test("AC2: a fresh credential after the re-grant carries the capability again", async () => {
    const agent = await newAgent();
    await pool.query("delete from public.agent_capabilities where agent_id = $1 and capability = 'web.search'", [
      agent,
    ]);
    await pool.query(
      "insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values ($1, $2, 'web.search', 1)",
      [WORKSPACE, agent],
    );
    const cred = await issueFor(agent);
    expect(cred.capabilities).toContain("web.search");
    expect((await check(cred, "web.search")).ok).toBe(true);
  });

  test("AC2: removing a grant the credential never carried leaves it working", async () => {
    const agent = await newAgent(["vault.read"]);
    const cred = await issueFor(agent); // snapshot: vault.read only
    await pool.query(
      "insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values ($1, $2, 'web.search', 1)",
      [WORKSPACE, agent],
    );
    // Granted after issue: the snapshot is only an upper bound, so it must NOT widen the old credential.
    expect(await check(cred, "web.search")).toEqual({ ok: false, reason: "missing_capability" });
    await pool.query("delete from public.agent_capabilities where agent_id = $1 and capability = 'web.search'", [
      agent,
    ]);
    expect((await check(cred, "vault.read")).ok).toBe(true);
    expect(await revokedAt(cred.credentialId)).toBeNull();
  });

  test("documented: disabling then re-enabling a catalog entry is not a revoke, so the credential works again", async () => {
    const agent = await newAgent();
    const cred = await issueFor(agent);
    await pool.query("update public.capabilities set enabled = false where workspace_id = $1 and key = 'web.search'", [
      WORKSPACE,
    ]);
    try {
      expect(await check(cred, "web.search")).toEqual({ ok: false, reason: "missing_capability" });
      expect((await check(cred, "vault.read")).ok).toBe(true);
    } finally {
      await pool.query(
        "update public.capabilities set enabled = true where workspace_id = $1 and key = 'web.search'",
        [WORKSPACE],
      );
    }
    // Snapshot allowed it, never revoked, catalog entry enabled again: allowed. Bounded by the 15 minute expiry.
    expect((await check(cred, "web.search")).ok).toBe(true);
    expect(await revokedAt(cred.credentialId)).toBeNull();
  });
});

liveDescribe("round 1: unarchive", () => {
  test("AC2: unarchiving an agent leaves its old credentials revoked, and new issuance works again", async () => {
    const agent = await newAgent();
    const cred = await issueFor(agent);
    expect((await check(cred, "vault.read")).ok).toBe(true);

    await pool.query("update public.agents set archived_at = now() where id = $1", [agent]);
    expect(await check(cred, "vault.read")).toEqual({ ok: false, reason: "revoked" });
    const stamp = await revokedAt(cred.credentialId);
    expect(stamp).not.toBeNull();

    await pool.query("update public.agents set archived_at = null where id = $1", [agent]);
    expect(await check(cred, "vault.read")).toEqual({ ok: false, reason: "revoked" });
    expect(await check(cred, "web.search")).toEqual({ ok: false, reason: "revoked" });
    expect((await revokedAt(cred.credentialId)).getTime()).toBe(stamp.getTime());

    const fresh = await issueFor(agent);
    expect((await check(fresh, "vault.read")).ok).toBe(true);
    expect((await check(cred, "vault.read")).ok).toBe(false);
  });

  test("AC2: issuance is refused while archived, with no row written", async () => {
    const agent = await newAgent();
    await pool.query("update public.agents set archived_at = now() where id = $1", [agent]);
    const run = await newRun(agent);
    await expect(issuer.issue({ workspaceId: WORKSPACE, agentId: agent, runId: run })).rejects.toBeDefined();
    const { rows } = await pool.query("select count(*)::int as n from public.agent_credentials where run_id = $1", [
      run,
    ]);
    expect(rows[0].n).toBe(0);
  });

  test("AC2 (defense in depth): with the revoke trigger bypassed, an archived agent's credential is still refused", async () => {
    // Proves the worker's one-query check is the control, not the trigger: the revoke trigger is skipped for one
    // session (session_replication_role = replica), the agent is archived, and the credential row stays unrevoked.
    const agent = await newAgent();
    const cred = await issueFor(agent);
    const client = await pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query("update public.agents set archived_at = now() where id = $1", [agent]);
    } finally {
      await client.query("reset session_replication_role").catch(() => undefined);
      client.release();
    }
    expect(await revokedAt(cred.credentialId)).toBeNull(); // trigger did not run
    expect(await check(cred, "vault.read")).toEqual({ ok: false, reason: "revoked" });
  });
});

liveDescribe("round 1: concurrency and staleness", () => {
  test("AC2: an uncommitted archive does not block use, and the first verify after commit is refused", async () => {
    const agent = await newAgent();
    const cred = await issueFor(agent);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("update public.agents set archived_at = now() where id = $1", [agent]);
      // READ COMMITTED: another session still sees the live agent until the archive commits.
      expect((await check(cred, "vault.read")).ok).toBe(true);
      await client.query("commit");
    } finally {
      client.release();
    }
    expect((await check(cred, "vault.read")).ok).toBe(false);
  });

  test("AC2: hammering verify while archiving never passes after the archive committed (30 rounds)", async () => {
    const violations = [];
    for (let round = 0; round < 30; round += 1) {
      const agent = await newAgent();
      const cred = await issueFor(agent);
      let committedAt = Number.POSITIVE_INFINITY;
      let stop = false;
      const passesAfterCommit = [];

      const hammer = async () => {
        while (!stop) {
          const startedAt = performance.now();
          const decision = await check(cred, "vault.read");
          if (decision.ok && startedAt > committedAt) passesAfterCommit.push(startedAt - committedAt);
        }
      };
      const workers = [hammer(), hammer(), hammer()];
      await new Promise((r) => setTimeout(r, 5 + (round % 7)));
      await pool.query("update public.agents set archived_at = now() where id = $1", [agent]);
      committedAt = performance.now();
      await new Promise((r) => setTimeout(r, 40));
      stop = true;
      await Promise.all(workers);
      if (passesAfterCommit.length > 0) violations.push({ round, passesAfterCommit });
      expect((await check(cred, "vault.read")).ok).toBe(false);
    }
    expect(violations).toEqual([]);
  }, 60_000);

  test("AC2: one long-lived verifier sees every state change on its next call (no cache)", async () => {
    const agent = await newAgent();
    const cred = await issueFor(agent);
    const answers = [];
    answers.push((await check(cred, "web.search")).ok); // true
    await pool.query("update public.capabilities set enabled = false where workspace_id = $1 and key = 'web.search'", [
      WORKSPACE,
    ]);
    answers.push((await check(cred, "web.search")).ok); // false at once
    await pool.query("update public.capabilities set enabled = true where workspace_id = $1 and key = 'web.search'", [
      WORKSPACE,
    ]);
    answers.push((await check(cred, "web.search")).ok); // true at once
    await pool.query("update public.agents set archived_at = now() where id = $1", [agent]);
    answers.push((await check(cred, "web.search")).ok); // false at once
    expect(answers).toEqual([true, false, true, false]);
  });

  test("AC2: revoking by run is seen immediately by a verifier that just said yes", async () => {
    const agent = await newAgent();
    const cred = await issueFor(agent);
    expect((await check(cred, "vault.read")).ok).toBe(true);
    await issuer.revokeForRun({ workspaceId: WORKSPACE, runId: cred.runId });
    expect(await check(cred, "vault.read")).toEqual({ ok: false, reason: "revoked" });
  });
});
