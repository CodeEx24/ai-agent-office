/**
 * AGO-148 independent QA tests (written by the tester, not the implementer): attack and boundary cases for the
 * per-agent identity and short-lived scoped credentials, through the REAL built worker (`apps/worker/dist`)
 * against the shared LOCAL Supabase stack. Complements scripts/ago-148-acceptance.test.mjs (happy paths).
 *
 * - AC1: expiry min(task end, issued + 15 min) with a fake verifier clock, and immediate revocation.
 * - AC2: tamper, swapped signatures, wrong secret, forged-but-unissued token, `alg: none`, wrong agent/run/
 *   workspace, archived agent, a grant removed after issue, an empty request.
 * - AC3: every issuance is its own row, no token or payload in the log or in any rejection.
 *
 * Skips (with a note) when no local Postgres answers or the worker is not built, so CI without Docker stays green.
 * Run inside the lock:  node scripts/db-lock.mjs acquire AGO-148-qa ... release AGO-148-qa
 *   pnpm --filter @ago/worker build
 *   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-148-qa.test.mjs
 * Creates its own workspace and removes it at the end (cascade). No `.env*` file is read.
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
const SECRET = "qa-signing-secret-that-is-long-enough-1234";
const OTHER_SECRET = "another-signing-secret-that-is-long-enough";

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
if (!dbUp) console.warn(`AGO-148 QA cases skipped: no Postgres at 127.0.0.1:${LOCAL_DB_PORT}`);
if (dbUp && !built) console.warn("AGO-148 QA cases skipped: run `pnpm --filter @ago/worker build`");

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const ARCHIVED_AGENT = randomUUID();
const GRANT_AGENT = randomUUID();

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodePayload = (token) =>
  JSON.parse(Buffer.from(token.slice("ago_agt_".length).split(".")[1], "base64url").toString("utf8"));
const parts = (token) => token.slice("ago_agt_".length).split(".");
const assemble = (header, payload, signature) => `ago_agt_${header}.${payload}.${signature}`;

let pool;
let identity;
let store;
let issuer;
let verifierAt;
let logged;

async function newRun(agentId = AGENT, workspaceId = WORKSPACE) {
  const id = randomUUID();
  await pool.query(
    "insert into public.runs (id, workspace_id, agent_id, status) values ($1, $2, $3, 'running')",
    [id, workspaceId, agentId],
  );
  return id;
}
const ask = (runId, capability, extra = {}) => ({
  workspaceId: WORKSPACE,
  runId,
  capability,
  ...extra,
});
const row = async (id) =>
  (await pool.query("select * from public.agent_credentials where id = $1", [id])).rows[0];
const issueFor = (runId, extra = {}) =>
  issuer.issue({ workspaceId: WORKSPACE, agentId: AGENT, runId, ...extra });
async function sqlState(promise) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error.code ?? String(error);
  }
}

beforeAll(async () => {
  if (!dbUp || !built) return;
  const requireFromWorker = createRequire(join(ROOT, "apps", "worker", "package.json"));
  const pg = requireFromWorker("pg");
  pool = new pg.Pool({ connectionString: LOCAL_DB, max: 2 });
  identity = await import(pathToFileURL(IDENTITY_ENTRY).href);
  store = identity.createPgCredentialStore(pool);
  logged = [];
  issuer = identity.createCredentialIssuer({
    store,
    secret: SECRET,
    logger: { info: (fields, message) => logged.push(JSON.stringify({ fields, message })) },
  });
  verifierAt = (now) => identity.createCredentialVerifier({ store, secret: SECRET, now: () => now });

  await pool.query(
    "insert into public.workspaces (id, name) values ($1, 'AGO-148 QA'), ($2, 'AGO-148 QA other')",
    [WORKSPACE, OTHER_WORKSPACE],
  );
  await pool.query(
    "insert into public.agents (id, workspace_id, name) values ($1, $4, 'qa agent'), ($2, $4, 'qa other agent'), ($3, $4, 'qa archived'), ($5, $4, 'qa grant')",
    [AGENT, OTHER_AGENT, ARCHIVED_AGENT, WORKSPACE, GRANT_AGENT],
  );
  for (const agent of [AGENT, OTHER_AGENT, ARCHIVED_AGENT, GRANT_AGENT]) {
    await pool.query(
      "insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values ($1, $2, 'vault.read', 0), ($1, $2, 'web.search', 1)",
      [WORKSPACE, agent],
    );
  }
});

afterAll(async () => {
  if (pool === undefined) return;
  await pool.query("delete from public.workspaces where id = any($1::uuid[])", [
    [WORKSPACE, OTHER_WORKSPACE],
  ]);
  await pool.end();
});

liveDescribe("AC1: expires at task end or in 15 minutes, whichever is sooner", () => {
  test("AC1: with the clock moved, the credential works one second before 15 minutes and is expired at 15 minutes", async () => {
    const run = await newRun();
    const issued = await issueFor(run);
    expect(issued.expiresAt.getTime() - issued.issuedAt.getTime()).toBe(900_000);

    const justBefore = verifierAt(new Date(issued.expiresAt.getTime() - 1_000));
    const atExpiry = verifierAt(new Date(issued.expiresAt.getTime()));
    const wellAfter = verifierAt(new Date(issued.expiresAt.getTime() + 3_600_000));

    expect((await justBefore.verify(issued.token, ask(run, "vault.read"))).ok).toBe(true);
    expect(await atExpiry.verify(issued.token, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await wellAfter.verify(issued.token, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("AC1: a task ending in 2 minutes ends the credential at the task end, not at 15 minutes", async () => {
    const run = await newRun();
    const taskEndsAt = new Date(Date.now() + 120_000);
    const issued = await issueFor(run, { taskEndsAt });

    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(taskEndsAt.getTime());
    expect(issued.expiresAt.getTime()).toBeGreaterThan(taskEndsAt.getTime() - 2_000);
    const beforeEnd = verifierAt(new Date(issued.expiresAt.getTime() - 1_000));
    const afterEnd = verifierAt(new Date(issued.expiresAt.getTime()));
    const at14Minutes = verifierAt(new Date(issued.issuedAt.getTime() + 14 * 60_000));

    expect((await beforeEnd.verify(issued.token, ask(run, "vault.read"))).ok).toBe(true);
    expect((await afterEnd.verify(issued.token, ask(run, "vault.read"))).ok).toBe(false);
    expect((await at14Minutes.verify(issued.token, ask(run, "vault.read"))).ok).toBe(false);
  });

  test("AC1 (negative): a task end that has already passed issues nothing and writes no row", async () => {
    const run = await newRun();
    const count = async () =>
      (await pool.query("select count(*)::int as n from public.agent_credentials where run_id = $1", [run]))
        .rows[0].n;
    const before = await count();

    await expect(issueFor(run, { taskEndsAt: new Date(Date.now() - 1_000) })).rejects.toMatchObject({
      name: "TaskAlreadyEndedError",
    });

    expect(await count()).toBe(before);
  });

  test("AC1: revokeForRun stops the credential immediately, a second call revokes nothing and keeps revoked_at", async () => {
    const run = await newRun();
    const issued = await issueFor(run);
    const verifier = verifierAt(new Date());
    expect((await verifier.verify(issued.token, ask(run, "vault.read"))).ok).toBe(true);

    expect(await issuer.revokeForRun({ workspaceId: WORKSPACE, runId: run })).toBe(1);
    const revokedAt = (await row(issued.credentialId)).revoked_at;

    expect(await verifier.verify(issued.token, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(await issuer.revokeForRun({ workspaceId: WORKSPACE, runId: run })).toBe(0);
    expect((await row(issued.credentialId)).revoked_at).toEqual(revokedAt);
  });

  test("AC1 (negative): revoking by another workspace's id does not revoke this credential", async () => {
    const run = await newRun();
    const issued = await issueFor(run);

    expect(await issuer.revokeForRun({ workspaceId: OTHER_WORKSPACE, runId: run })).toBe(0);

    expect((await row(issued.credentialId)).revoked_at).toBeNull();
  });

  for (const status of ["succeeded", "failed", "cancelled", "paused", "awaiting_approval"]) {
    test(`AC1: a run that moves to "${status}" revokes its credentials at once`, async () => {
      const run = await newRun();
      const issued = await issueFor(run);

      await pool.query("update public.runs set status = $2 where id = $1", [run, status]);

      expect(await verifierAt(new Date()).verify(issued.token, ask(run, "vault.read"))).toEqual({
        ok: false,
        reason: "revoked",
      });
      expect((await row(issued.credentialId)).revoked_at).not.toBeNull();
    });
  }

  test("AC1: a run that goes from queued to running keeps its credential", async () => {
    const run = await newRun();
    await pool.query("update public.runs set status = 'queued' where id = $1", [run]);
    const issued = await issueFor(run);

    await pool.query("update public.runs set status = 'running' where id = $1", [run]);

    expect((await verifierAt(new Date()).verify(issued.token, ask(run, "vault.read"))).ok).toBe(true);
  });

  test("AC1 (negative): the database refuses to issue for a run that already ended, even with a valid expiry", async () => {
    const run = await newRun();
    await pool.query("update public.runs set status = 'failed' where id = $1", [run]);

    await expect(issueFor(run)).rejects.toMatchObject({ code: "42501" });
  });
});

liveDescribe("AC2: a credential cannot be used for a capability the agent lacks", () => {
  test("AC2 (negative): editing the capabilities in the payload while keeping the signature is rejected", async () => {
    const run = await newRun();
    const issued = await issueFor(run);
    const [header, , signature] = parts(issued.token);
    const claims = { ...decodePayload(issued.token), caps: ["payments.execute", "vault.read"] };

    const forged = assemble(header, b64(claims), signature);

    expect(await verifierAt(new Date()).verify(forged, ask(run, "payments.execute"))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("AC2 (negative): extending exp in the payload while keeping the signature is rejected", async () => {
    const run = await newRun();
    const issued = await issueFor(run);
    const [header, , signature] = parts(issued.token);
    const claims = decodePayload(issued.token);

    const forged = assemble(header, b64({ ...claims, exp: claims.exp + 3_600 }), signature);

    expect(await verifierAt(new Date()).verify(forged, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("AC2 (negative): the signature of one credential cannot be put on another's payload", async () => {
    const runA = await newRun();
    const runB = await newRun();
    const a = await issueFor(runA, { requestedCapabilities: ["vault.read"] });
    const b = await issueFor(runB);
    const [headerA, payloadA] = parts(a.token);
    const [, , signatureB] = parts(b.token);

    const swapped = assemble(headerA, payloadA, signatureB);

    expect(await verifierAt(new Date()).verify(swapped, ask(runA, "vault.read"))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("AC2 (negative): a verifier with a different secret rejects a genuine credential", async () => {
    const run = await newRun();
    const issued = await issueFor(run);
    const other = identity.createCredentialVerifier({ store, secret: OTHER_SECRET });

    expect(await other.verify(issued.token, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("AC2 (negative): a correctly signed token that was never issued (leaked secret) has no row and is rejected", async () => {
    const run = await newRun();
    const now = Math.floor(Date.now() / 1000);
    const minted = identity.signCredentialToken(
      {
        jti: randomUUID(),
        agent_id: AGENT,
        workspace_id: WORKSPACE,
        run_id: run,
        caps: ["vault.read", "web.search"],
        iat: now,
        exp: now + 600,
      },
      SECRET,
    );

    expect(await verifierAt(new Date()).verify(minted, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "unknown_credential",
    });
  });

  test("AC2 (negative): a token whose claims ask for more than 15 minutes cannot even be signed", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      identity.signCredentialToken(
        {
          jti: randomUUID(),
          agent_id: AGENT,
          workspace_id: WORKSPACE,
          run_id: randomUUID(),
          caps: ["vault.read"],
          iat: now,
          exp: now + 901,
        },
        SECRET,
      ),
    ).toThrow();
  });

  test("AC2 (negative): an `alg: none` header with the signature stripped is rejected as malformed", async () => {
    const run = await newRun();
    const issued = await issueFor(run);
    const [, payload] = parts(issued.token);

    const none = assemble(b64({ alg: "none", typ: "JWT" }), payload, "");

    expect(await verifierAt(new Date()).verify(none, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  for (const [label, token] of [
    ["an empty string", ""],
    ["a token without the prefix", "eyJhbGciOiJIUzI1NiJ9.e30.c2ln"],
    ["only the prefix", "ago_agt_"],
    ["two segments", "ago_agt_aaa.bbb"],
    ["four segments", "ago_agt_a.b.c.d"],
  ]) {
    test(`AC2 (negative): ${label} is malformed and never throws`, async () => {
      const decision = await verifierAt(new Date()).verify(token, ask(randomUUID(), "vault.read"));
      expect(decision).toEqual({ ok: false, reason: "malformed" });
    });
  }

  test("AC2 (negative): another agent, another run and another workspace are each rejected for the same credential", async () => {
    const run = await newRun();
    const otherRun = await newRun(OTHER_AGENT);
    const issued = await issueFor(run);
    const verifier = verifierAt(new Date());

    expect(await verifier.verify(issued.token, ask(run, "vault.read", { agentId: OTHER_AGENT }))).toEqual({
      ok: false,
      reason: "wrong_agent",
    });
    expect(await verifier.verify(issued.token, ask(otherRun, "vault.read"))).toEqual({
      ok: false,
      reason: "wrong_run",
    });
    expect(
      await verifier.verify(issued.token, ask(run, "vault.read", { workspaceId: OTHER_WORKSPACE })),
    ).toEqual({ ok: false, reason: "wrong_workspace" });
    expect(await verifier.verify(issued.token, ask(run, "vault.read", { agentId: AGENT }))).toMatchObject({
      ok: true,
    });
  });

  test("AC2: an empty request carries nothing, and a narrower request is never widened", async () => {
    const run = await newRun();
    const none = await issueFor(run, { requestedCapabilities: [] });
    const one = await issueFor(run, { requestedCapabilities: ["vault.read"] });
    const verifier = verifierAt(new Date());

    expect(none.capabilities).toEqual([]);
    expect(await verifier.verify(none.token, ask(run, "vault.read"))).toEqual({
      ok: false,
      reason: "missing_capability",
    });
    expect(one.capabilities).toEqual(["vault.read"]);
    expect(await verifier.verify(one.token, ask(run, "web.search"))).toEqual({
      ok: false,
      reason: "missing_capability",
    });
  });

  test("AC2 (negative): a secret holder cannot widen a credential by re-signing its claims, because the log has no row for the new token", async () => {
    const run = await newRun();
    const now = Math.floor(Date.now() / 1000);
    const issued = await issueFor(run, { requestedCapabilities: ["vault.read"] });
    const widened = identity.signCredentialToken(
      {
        jti: issued.credentialId,
        agent_id: AGENT,
        workspace_id: WORKSPACE,
        run_id: run,
        caps: ["vault.read", "web.search"],
        iat: now,
        exp: now + 600,
      },
      SECRET,
    );

    expect(await verifierAt(new Date()).verify(widened, ask(run, "web.search"))).toEqual({
      ok: false,
      reason: "unknown_credential",
    });
  });

  test("AC2 (negative): after the agent is archived, its credential is rejected", async () => {
    const run = await newRun(ARCHIVED_AGENT);
    const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId: ARCHIVED_AGENT, runId: run });
    expect((await verifierAt(new Date()).verify(issued.token, ask(run, "vault.read"))).ok).toBe(true);

    await pool.query("update public.agents set archived_at = now() where id = $1", [ARCHIVED_AGENT]);

    const decision = await verifierAt(new Date()).verify(issued.token, ask(run, "vault.read"));
    expect(decision.ok, "an archived agent's live credential must be refused").toBe(false);
  });

  test("AC2 (negative): a new credential cannot be issued to an archived agent", async () => {
    const run = await newRun(ARCHIVED_AGENT);

    await expect(
      issuer.issue({ workspaceId: WORKSPACE, agentId: ARCHIVED_AGENT, runId: run }),
    ).rejects.toBeDefined();
  });

  test("AC2 (negative): after the capability grant is removed, the existing credential no longer works for it", async () => {
    const run = await newRun(GRANT_AGENT);
    const issued = await issuer.issue({ workspaceId: WORKSPACE, agentId: GRANT_AGENT, runId: run });
    expect((await verifierAt(new Date()).verify(issued.token, ask(run, "web.search"))).ok).toBe(true);

    await pool.query(
      "delete from public.agent_capabilities where agent_id = $1 and capability = 'web.search'",
      [GRANT_AGENT],
    );

    const decision = await verifierAt(new Date()).verify(issued.token, ask(run, "web.search"));
    expect(decision.ok, "the agent no longer holds web.search").toBe(false);
  });

  test("AC2 (negative): a capability the workspace disables after issue stops working", async () => {
    const run = await newRun();
    const issued = await issueFor(run);
    await pool.query(
      "update public.capabilities set enabled = false where workspace_id = $1 and key = 'web.search'",
      [WORKSPACE],
    );
    try {
      const decision = await verifierAt(new Date()).verify(issued.token, ask(run, "web.search"));
      expect(decision.ok, "the catalog disabled web.search").toBe(false);
    } finally {
      await pool.query(
        "update public.capabilities set enabled = true where workspace_id = $1 and key = 'web.search'",
        [WORKSPACE],
      );
    }
  });

  test("AC2: a credential only proves the capability; the decision always demands the policy check", async () => {
    const run = await newRun();
    const issued = await issueFor(run);

    const decision = await verifierAt(new Date()).verify(issued.token, ask(run, "vault.read"));

    expect(decision).toMatchObject({ ok: true, policyCheckRequired: true });
  });
});

liveDescribe("AC3: every issuance is logged, and no secret is", () => {
  test("AC3: issuing twice for one run writes two rows with different ids and hashes", async () => {
    const run = await newRun();
    const first = await issueFor(run);
    const second = await issueFor(run);

    const rows = (
      await pool.query("select id, token_hash from public.agent_credentials where run_id = $1", [run])
    ).rows;

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.token_hash)).size).toBe(2);
    expect(first.token).not.toBe(second.token);
  });

  test("AC3: each row records who, which run, which workspace, the capabilities and both timestamps", async () => {
    const run = await newRun();
    const issued = await issueFor(run);

    const stored = await row(issued.credentialId);

    expect(stored).toMatchObject({
      workspace_id: WORKSPACE,
      agent_id: AGENT,
      run_id: run,
      token_hash: createHash("sha256").update(issued.token).digest("hex"),
    });
    expect(stored.capabilities).toEqual(["vault.read", "web.search"]);
    expect(new Date(stored.issued_at).getTime()).toBeLessThan(new Date(stored.expires_at).getTime());
  });

  test("AC3 (negative): neither the token nor any of its segments are in the table, the issuer log line or a rejection", async () => {
    const run = await newRun();
    logged.length = 0;
    const issued = await issueFor(run);
    const [header, payload, signature] = parts(issued.token);
    const rejection = await verifierAt(new Date()).verify(issued.token, ask(run, "payments.execute"));

    const surfaces = [
      JSON.stringify((await pool.query("select * from public.agent_credentials")).rows),
      logged.join("\n"),
      JSON.stringify(rejection),
    ].join("\n");

    expect(logged.length, "one log line per issuance").toBe(1);
    for (const secret of [issued.token, header, payload, signature, SECRET]) {
      expect(surfaces).not.toContain(secret);
    }
    expect(logged[0]).toContain(issued.credentialId);
  });

  test("AC3 (negative): the table owner cannot edit, delete or empty an issuance row (and the row survives)", async () => {
    const run = await newRun();
    const issued = await issueFor(run);

    expect(
      await sqlState(
        pool.query(
          "update public.agent_credentials set expires_at = expires_at + interval '1 hour' where id = $1",
          [issued.credentialId],
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlState(
        pool.query("update public.agent_credentials set token_hash = repeat('0', 64) where id = $1", [
          issued.credentialId,
        ]),
      ),
    ).toBe("42501");
    expect(
      await sqlState(pool.query("delete from public.agent_credentials where id = $1", [issued.credentialId])),
    ).toBe("42501");
    expect(await sqlState(pool.query("delete from public.agent_credentials"))).toBe("42501");
    expect(await sqlState(pool.query("truncate public.agent_credentials cascade"))).toBe("42501");
    expect((await row(issued.credentialId)).id).toBe(issued.credentialId);
  });

  test("AC3 (negative): deleting the run cannot silently erase the issuance log", async () => {
    const run = await newRun();
    const issued = await issueFor(run);

    const outcome = await sqlState(pool.query("delete from public.runs where id = $1", [run]));

    expect(await row(issued.credentialId), `delete run: ${outcome}`).toBeDefined();
  });
});
