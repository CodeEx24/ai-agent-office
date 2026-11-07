/**
 * AGO-148 live acceptance tests: per-agent identity and short-lived scoped credentials, through the REAL built
 * worker (`apps/worker/dist`) against the shared LOCAL Supabase stack (127.0.0.1:44322). One group per
 * acceptance criterion. They prove what the in-memory unit tests cannot: the issuance log row really lands, the
 * database refuses what the issuer would never send, and the run ending really revokes the credential.
 *
 * - Cases skip (with a note) when no Postgres answers on the local port, so CI without Docker stays green.
 * - Run inside the lock:  node scripts/db-lock.mjs acquire AGO-148 ... release AGO-148
 *   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-148-acceptance.test.mjs
 * - Build first: `pnpm --filter @ago/worker build`. No `.env*` file is read, and no hosted project is reachable
 *   (the connection string is the local container's).
 * - It creates its own workspace and removes it at the end (cascade), so nothing leaks between runs.
 */
import { createHash, randomUUID } from "node:crypto";
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
const SECRET = "live-test-signing-secret-that-is-long-enough";

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
if (!dbUp) {
  console.warn(`AGO-148 live cases skipped: no Postgres at 127.0.0.1:${LOCAL_DB_PORT} (supabase start)`);
}
if (dbUp && !built) {
  console.warn("AGO-148 live cases skipped: run `pnpm --filter @ago/worker build` first");
}

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const AGENT = randomUUID();
const RUN = randomUUID();
const RUN_TWO = randomUUID();

let pool;
let issuer;
let verifier;

async function sqlState(promise) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error.code ?? String(error);
  }
}

const ask = (capability, extra = {}) => ({
  workspaceId: WORKSPACE,
  runId: RUN,
  capability,
  ...extra,
});
const credentialRow = async (id) =>
  (await pool.query("select * from public.agent_credentials where id = $1", [id])).rows[0];

beforeAll(async () => {
  if (!dbUp || !built) return;
  const requireFromWorker = createRequire(join(ROOT, "apps", "worker", "package.json"));
  const pg = requireFromWorker("pg");
  pool = new pg.Pool({ connectionString: LOCAL_DB, max: 2 });
  const identity = await import(pathToFileURL(IDENTITY_ENTRY).href);
  const store = identity.createPgCredentialStore(pool);
  issuer = identity.createCredentialIssuer({ store, secret: SECRET });
  verifier = identity.createCredentialVerifier({ store, secret: SECRET });

  await pool.query(
    "insert into public.workspaces (id, name) values ($1, 'AGO-148 live'), ($2, 'AGO-148 live other')",
    [WORKSPACE, OTHER_WORKSPACE],
  );
  await pool.query(
    "insert into public.agents (id, workspace_id, name) values ($1, $2, 'live agent')",
    [AGENT, WORKSPACE],
  );
  await pool.query(
    "insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values ($1, $2, 'vault.read', 0), ($1, $2, 'web.search', 1), ($1, $2, 'code.run', 3)",
    [WORKSPACE, AGENT],
  );
  await pool.query(
    "insert into public.runs (id, workspace_id, agent_id, status) values ($1, $3, $4, 'running'), ($2, $3, $4, 'running')",
    [RUN, RUN_TWO, WORKSPACE, AGENT],
  );
});

afterAll(async () => {
  if (pool === undefined) return;
  await pool.query("delete from public.workspaces where id = any($1::uuid[])", [
    [WORKSPACE, OTHER_WORKSPACE],
  ]);
  await pool.end();
});

liveDescribe("AC3: every issuance is logged", () => {
  test("each agent has its own identity, and it is not an auth user", async () => {
    const identities = await pool.query(
      "select id from public.agent_identities where workspace_id = $1 and agent_id = $2",
      [WORKSPACE, AGENT],
    );
    expect(identities.rowCount).toBe(1);
    const asUser = await pool.query("select 1 from auth.users where id = $1", [
      identities.rows[0].id,
    ]);
    expect(asUser.rowCount).toBe(0);
  });

  test("issuing writes one row with the token hash, the capability set and the expiry, and never the token", async () => {
    const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId: RUN });
    const row = await credentialRow(issued.credentialId);
    expect(row.token_hash).toBe(createHash("sha256").update(issued.token).digest("hex"));
    expect(row.capabilities).toEqual(["code.run", "vault.read", "web.search"]);
    expect(row.revoked_at).toBeNull();
    const everything = JSON.stringify(
      (await pool.query("select * from public.agent_credentials where run_id = $1", [RUN])).rows,
    );
    expect(everything).not.toContain(issued.token);
    expect(everything).not.toContain(issued.token.split(".")[1]);
  });

  test("the log cannot be edited, deleted or emptied (even as the table owner)", async () => {
    const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId: RUN });
    expect(
      await sqlState(
        pool.query("update public.agent_credentials set capabilities = '{}' where id = $1", [
          issued.credentialId,
        ]),
      ),
    ).toBe("42501");
    expect(
      await sqlState(
        pool.query("delete from public.agent_credentials where id = $1", [issued.credentialId]),
      ),
    ).toBe("42501");
    expect(await sqlState(pool.query("truncate public.agent_credentials"))).toBe("42501");
    expect(await credentialRow(issued.credentialId)).toBeDefined();
  });
});

liveDescribe("AC1: expires at task end or in 15 minutes, whichever is sooner", () => {
  test("no task end gives 15 minutes; a longer task gives 15 minutes; a shorter task ends with the task", async () => {
    const lifetime = async (taskEndsAt) => {
      const issued = await issuer.issue({
        workspaceId: WORKSPACE,
        agentId: AGENT,
        runId: RUN,
        taskEndsAt,
      });
      const row = await credentialRow(issued.credentialId);
      return (new Date(row.expires_at).getTime() - new Date(row.issued_at).getTime()) / 1000;
    };
    expect(await lifetime(undefined)).toBe(900);
    expect(await lifetime(new Date(Date.now() + 60 * 60_000))).toBe(900);
    const short = await lifetime(new Date(Date.now() + 120_000));
    expect(short).toBeLessThanOrEqual(120);
    expect(short).toBeGreaterThan(110);
  });

  test("the database itself refuses a credential longer than 15 minutes", async () => {
    const hash = createHash("sha256").update(randomUUID()).digest("hex");
    expect(
      await sqlState(
        pool.query(
          "insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at) values ($1, $2, $3, $4, '{}', now(), now() + interval '16 minutes')",
          [WORKSPACE, AGENT, RUN, hash],
        ),
      ),
    ).toBe("23514");
  });

  test("ending the run revokes its credentials, and no new one can be issued for it", async () => {
    const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId: RUN_TWO });
    expect((await verifier.verify(issued.token, ask("vault.read", { runId: RUN_TWO }))).ok).toBe(
      true,
    );
    await pool.query("update public.runs set status = 'succeeded' where id = $1", [RUN_TWO]);
    expect(await verifier.verify(issued.token, ask("vault.read", { runId: RUN_TWO }))).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect((await credentialRow(issued.credentialId)).revoked_at).not.toBeNull();
    await expect(
      issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId: RUN_TWO }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

liveDescribe("AC2: a credential cannot be used for a capability the agent lacks", () => {
  test("only granted capabilities are carried; the rest are dropped and reported", async () => {
    const issued = await issuer.issue({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      runId: RUN,
      requestedCapabilities: ["vault.read", "payments.execute"],
    });
    expect(issued.capabilities).toEqual(["vault.read"]);
    expect(issued.droppedCapabilities).toEqual(["payments.execute"]);
    expect((await verifier.verify(issued.token, ask("vault.read"))).ok).toBe(true);
    expect(await verifier.verify(issued.token, ask("web.search"))).toEqual({
      ok: false,
      reason: "missing_capability",
    });
    expect(await verifier.verify(issued.token, ask("payments.execute"))).toEqual({
      ok: false,
      reason: "missing_capability",
    });
  });

  test("the database refuses an issuance row that carries a capability the agent lacks or the catalog disabled", async () => {
    const insertWith = (caps) =>
      pool.query(
        "insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at) values ($1, $2, $3, $4, $5::text[], now(), now() + interval '5 minutes')",
        [WORKSPACE, AGENT, RUN, createHash("sha256").update(randomUUID()).digest("hex"), caps],
      );
    expect(await sqlState(insertWith(["tasks.manage"]))).toBe("42501");
    await pool.query(
      "update public.capabilities set enabled = false where workspace_id = $1 and key = 'web.search'",
      [WORKSPACE],
    );
    expect(await sqlState(insertWith(["web.search"]))).toBe("42501");
    await pool.query(
      "update public.capabilities set enabled = true where workspace_id = $1 and key = 'web.search'",
      [WORKSPACE],
    );
    expect(await sqlState(insertWith(["web.search"]))).toBe("ok");
  });

  test("a credential is rejected for another workspace or another run", async () => {
    const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId: RUN });
    expect(
      await verifier.verify(issued.token, ask("vault.read", { workspaceId: OTHER_WORKSPACE })),
    ).toEqual({ ok: false, reason: "wrong_workspace" });
    expect(
      await verifier.verify(issued.token, ask("vault.read", { runId: randomUUID() })),
    ).toEqual({ ok: false, reason: "wrong_run" });
  });

  test("a tier 3 capability on a credential still goes through the policy check (never bypassed)", async () => {
    const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId: RUN });
    expect(await verifier.verify(issued.token, ask("code.run"))).toMatchObject({
      ok: true,
      policyCheckRequired: true,
    });
  });
});
