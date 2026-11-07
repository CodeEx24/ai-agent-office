/**
 * AGO-166 independent QA tests (written by the tester, not the implementer): AC2 owner-only per-agent run limits,
 * proven against the shared LOCAL Supabase stack with the real API roles (`authenticated`, `anon`) and real JWT claims.
 * Complements supabase/tests/agent_run_limits.test.sql (pgTAP) and scripts/ago-166-rollback.test.mjs.
 *
 * - set_agent_run_limits(): owner ok; member, viewer, anon, a user with no membership (what an agent identity is
 *   in Postgres), and an owner of ANOTHER workspace are rejected; an agent id from another workspace is not found.
 * - the CHECK: out-of-bounds, non-integer, wrong type, unknown key and non-object values are rejected;
 *   the boundary values themselves are accepted.
 * - direct column writes are denied for every API role, owner included.
 * - the function is SECURITY DEFINER with a pinned search_path and not executable by anon or PUBLIC.
 * - double submit is idempotent; null clears; an archived agent cannot be changed.
 *
 * Every case runs inside a transaction that is rolled back: nothing is left in the shared stack. Skips (with a
 * note) when no local Postgres answers, so CI without Docker stays green. Run inside the lock:
 *   node scripts/db-lock.mjs acquire AGO-166-qa ... release AGO-166-qa
 *   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-166-qa.test.mjs
 * No `.env*` file is read; the connection is the local stack's well-known postgres login.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_DB_PORT = Number(process.env.AGO_TEST_DB_PORT ?? 44322);
const LOCAL_DB = `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`;

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
const liveDescribe = describe.skipIf(!dbUp);
if (!dbUp) console.warn(`AGO-166 QA cases skipped: no Postgres at 127.0.0.1:${LOCAL_DB_PORT}`);

const WS_A = randomUUID();
const WS_B = randomUUID();
const OWNER_A = randomUUID();
const MEMBER_A = randomUUID();
const VIEWER_A = randomUUID();
const OWNER_B = randomUUID();
const OUTSIDER = randomUUID();
const AGENT_A = randomUUID();
const AGENT_A_ARCHIVED = randomUUID();
const AGENT_B = randomUUID();

let pool;

/** One transaction per case with the fixtures inserted as postgres; always rolled back. */
async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const [id, email] of [
      [OWNER_A, "owner-a"],
      [MEMBER_A, "member-a"],
      [VIEWER_A, "viewer-a"],
      [OWNER_B, "owner-b"],
      [OUTSIDER, "outsider"],
    ]) {
      await client.query(
        "insert into auth.users (id, instance_id, aud, role, email) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)",
        [id, `ago166-qa-${email}@example.test`],
      );
    }
    await client.query("insert into public.workspaces (id, name) values ($1, 'AGO-166 QA A'), ($2, 'AGO-166 QA B')", [
      WS_A,
      WS_B,
    ]);
    await client.query(
      "insert into public.members (workspace_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'member'), ($1, $5, 'viewer'), ($2, $6, 'owner')",
      [WS_A, WS_B, OWNER_A, MEMBER_A, VIEWER_A, OWNER_B],
    );
    await client.query(
      "insert into public.agents (id, workspace_id, name, archived_at) values ($1, $4, 'qa agent a', null), ($2, $4, 'qa archived', now()), ($3, $5, 'qa agent b', null)",
      [AGENT_A, AGENT_A_ARCHIVED, AGENT_B, WS_A, WS_B],
    );
    return await work(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

/** Become an API role. `userId` null = anon (no JWT subject). */
async function actAs(client, role, userId) {
  await client.query("reset role");
  await client.query(`set local role ${role}`);
  const claims = userId === null ? { role: "anon" } : { sub: userId, role: "authenticated" };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}

/** Runs one statement under a savepoint, so a rejected one does not abort the surrounding transaction. */
async function attempt(client, sql, params = []) {
  await client.query("savepoint attempt");
  try {
    const result = await client.query(sql, params);
    await client.query("release savepoint attempt");
    return { state: "ok", result };
  } catch (error) {
    await client.query("rollback to savepoint attempt");
    return { state: error.code ?? String(error), message: error.message };
  }
}

const setLimits = (client, workspace, agent, limits) =>
  attempt(client, "select public.set_agent_run_limits($1, $2, $3::jsonb)", [
    workspace,
    agent,
    limits === null ? null : JSON.stringify(limits),
  ]);

/** The stored value, read as postgres (bypasses RLS) so the check is about what is persisted. */
async function stored(client, agent = AGENT_A) {
  await client.query("reset role");
  return (await client.query("select run_limits from public.agents where id = $1", [agent])).rows[0].run_limits;
}

beforeAll(async () => {
  if (!dbUp) return;
  const requireFromWorker = createRequire(join(ROOT, "apps", "worker", "package.json"));
  const pg = requireFromWorker("pg");
  pool = new pg.Pool({ connectionString: LOCAL_DB, max: 2 });
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

liveDescribe("AC2: only workspace owners can set per-agent run limits", () => {
  test("AC2: an owner sets limits through set_agent_run_limits() and they are stored", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      const limits = { maxSteps: 7, maxTokens: 2_000, maxWallMs: 30_000 };

      expect((await setLimits(client, WS_A, AGENT_A, limits)).state).toBe("ok");

      expect(await stored(client)).toEqual(limits);
    });
  });

  test("AC2 (negative): a member is rejected with insufficient_privilege and nothing is stored", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", MEMBER_A);
      expect((await setLimits(client, WS_A, AGENT_A, { maxSteps: 150 })).state).toBe("42501");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2 (negative): a viewer is rejected", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", VIEWER_A);
      expect((await setLimits(client, WS_A, AGENT_A, { maxSteps: 150 })).state).toBe("42501");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2 (negative): a signed-in user with no membership (an agent identity has none) is rejected", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OUTSIDER);
      expect((await setLimits(client, WS_A, AGENT_A, { maxSteps: 150 })).state).toBe("42501");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2 (negative): anon cannot call the function at all", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "anon", null);
      expect((await setLimits(client, WS_A, AGENT_A, { maxSteps: 150 })).state).toBe("42501");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2 (cross-workspace): an owner of workspace B cannot change workspace A's agent", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_B);
      // naming A's workspace fails the owner check; naming B's workspace with A's agent id finds no agent
      expect((await setLimits(client, WS_A, AGENT_A, { maxSteps: 150 })).state).toBe("42501");
      expect((await setLimits(client, WS_B, AGENT_A, { maxSteps: 150 })).state).toBe("P0002");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2 (cross-workspace): an owner of A cannot reach B's agent by naming it under A's workspace id", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      expect((await setLimits(client, WS_A, AGENT_B, { maxSteps: 150 })).state).toBe("P0002");
      expect(await stored(client, AGENT_B)).toBeNull();
    });
  });

  test("AC2: direct column writes are denied for every API role, an owner included", async () => {
    await inTransaction(async (client) => {
      for (const user of [OWNER_A, MEMBER_A, VIEWER_A, OUTSIDER]) {
        await actAs(client, "authenticated", user);
        const direct = await attempt(client, "update public.agents set run_limits = $2::jsonb where id = $1", [
          AGENT_A,
          JSON.stringify({ maxSteps: 150 }),
        ]);
        expect(direct.state, `direct update as ${user}`).toBe("42501");
      }
      await actAs(client, "anon", null);
      expect(
        (await attempt(client, "update public.agents set run_limits = '{\"maxSteps\":150}' where id = $1", [AGENT_A]))
          .state,
      ).toBe("42501");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2: an insert that carries run_limits is denied too (no column grant on insert)", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      const insert = await attempt(
        client,
        "insert into public.agents (workspace_id, name, run_limits) values ($1, 'sneaky', '{\"maxSteps\":150}')",
        [WS_A],
      );
      expect(insert.state).toBe("42501");
    });
  });
});

liveDescribe("AC2: out-of-bounds values are rejected by the CHECK, boundary values accepted", () => {
  const rejected = [
    ["maxSteps above the cap (201)", { maxSteps: 201 }],
    ["maxSteps zero", { maxSteps: 0 }],
    ["maxSteps negative", { maxSteps: -1 }],
    ["maxTokens below the floor (999)", { maxTokens: 999 }],
    ["maxTokens above the cap (5000001)", { maxTokens: 5_000_001 }],
    ["maxWallMs below the floor (999)", { maxWallMs: 999 }],
    ["maxWallMs above the cap (840001)", { maxWallMs: 840_001 }],
    ["a float", { maxSteps: 10.5 }],
    ["a string number", { maxSteps: "10" }],
    ["a boolean", { maxSteps: true }],
    ["null as a value", { maxSteps: null }],
    ["an unknown key", { unlimited: true }],
    ["a known and an unknown key", { maxSteps: 5, maxFoo: 1 }],
    ["a nested object", { maxSteps: { n: 5 } }],
    ["an array", [5]],
    ["a bare number", 5],
    ["a bare string", "unlimited"],
  ];

  test.each(rejected)("AC2: owner is rejected for %s (invalid_parameter_value)", async (_label, value) => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      const outcome = await setLimits(client, WS_A, AGENT_A, value);
      expect(outcome.state).toBe("22023");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2: the CHECK also stops a superuser write of an out-of-bounds value (no path to 'unlimited')", async () => {
    await inTransaction(async (client) => {
      await client.query("reset role");
      for (const value of [{ maxSteps: 201 }, { maxWallMs: 999_999_999 }, { maxTokens: 10_000_000 }]) {
        const direct = await attempt(client, "update public.agents set run_limits = $2::jsonb where id = $1", [
          AGENT_A,
          JSON.stringify(value),
        ]);
        expect(direct.state, JSON.stringify(value)).toBe("23514");
      }
    });
  });

  test("AC2: the exact boundary values are accepted", async () => {
    await inTransaction(async (client) => {
      for (const value of [
        { maxSteps: 1, maxTokens: 1_000, maxWallMs: 1_000 },
        { maxSteps: 200, maxTokens: 5_000_000, maxWallMs: 840_000 },
      ]) {
        await actAs(client, "authenticated", OWNER_A);
        expect((await setLimits(client, WS_A, AGENT_A, value)).state).toBe("ok");
        expect(await stored(client)).toEqual(value);
      }
    });
  });

  test("AC2: an empty object is valid (every field optional) and a partial object keeps only what was set", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      expect((await setLimits(client, WS_A, AGENT_A, {})).state).toBe("ok");
      expect(await stored(client)).toEqual({});
      await actAs(client, "authenticated", OWNER_A);
      expect((await setLimits(client, WS_A, AGENT_A, { maxTokens: 5_000 })).state).toBe("ok");
      expect(await stored(client)).toEqual({ maxTokens: 5_000 });
    });
  });

  test("AC2: a rejected value does not overwrite a previously stored good value", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      await setLimits(client, WS_A, AGENT_A, { maxSteps: 12 });
      expect((await setLimits(client, WS_A, AGENT_A, { maxSteps: 9_999 })).state).toBe("22023");
      expect(await stored(client)).toEqual({ maxSteps: 12 });
    });
  });
});

liveDescribe("AC2: edge cases of the owner path", () => {
  test("AC2: double submit is idempotent (same value twice, same stored result, no error)", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      const limits = { maxSteps: 25, maxWallMs: 60_000 };
      expect((await setLimits(client, WS_A, AGENT_A, limits)).state).toBe("ok");
      expect((await setLimits(client, WS_A, AGENT_A, limits)).state).toBe("ok");
      expect(await stored(client)).toEqual(limits);
    });
  });

  test("AC2: null clears the override (back to the worker defaults)", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      await setLimits(client, WS_A, AGENT_A, { maxSteps: 25 });
      expect((await setLimits(client, WS_A, AGENT_A, null)).state).toBe("ok");
      expect(await stored(client)).toBeNull();
    });
  });

  test("AC2: an unknown agent id is 'not found', not a silent success", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      expect((await setLimits(client, WS_A, randomUUID(), { maxSteps: 5 })).state).toBe("P0002");
    });
  });

  test("AC2: an archived agent cannot be changed", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      expect((await setLimits(client, WS_A, AGENT_A_ARCHIVED, { maxSteps: 5 })).state).toBe("P0002");
      expect(await stored(client, AGENT_A_ARCHIVED)).toBeNull();
    });
  });

  test("AC2: missing arguments (null workspace or agent) are rejected, never applied broadly", async () => {
    await inTransaction(async (client) => {
      await actAs(client, "authenticated", OWNER_A);
      expect((await setLimits(client, null, AGENT_A, { maxSteps: 5 })).state).not.toBe("ok");
      expect((await setLimits(client, WS_A, null, { maxSteps: 5 })).state).not.toBe("ok");
      expect(await stored(client)).toBeNull();
      expect(await stored(client, AGENT_B)).toBeNull();
    });
  });

  test("AC2: a change touches exactly one agent: its sibling in the same workspace is untouched", async () => {
    await inTransaction(async (client) => {
      await client.query("reset role");
      const sibling = randomUUID();
      await client.query("insert into public.agents (id, workspace_id, name) values ($1, $2, 'sibling')", [
        sibling,
        WS_A,
      ]);
      await actAs(client, "authenticated", OWNER_A);
      await setLimits(client, WS_A, AGENT_A, { maxSteps: 5 });
      expect(await stored(client, sibling)).toBeNull();
      expect(await stored(client, AGENT_A)).toEqual({ maxSteps: 5 });
    });
  });
});

liveDescribe("AC2: the new functions are locked down (AGO-107 catalog expectations)", () => {
  const meta = async (signature) =>
    (
      await pool.query(
        `select p.prosecdef, p.proconfig,
                has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec
           from pg_proc p
          where p.oid = $1::regprocedure`,
        [signature],
      )
    ).rows[0];

  test("AC2: set_agent_run_limits is SECURITY DEFINER with an empty pinned search_path, executable by authenticated only", async () => {
    const info = await meta("public.set_agent_run_limits(uuid, uuid, jsonb)");
    expect(info.prosecdef).toBe(true);
    expect(info.proconfig).toContain('search_path=""');
    expect(info.anon_exec).toBe(false);
    expect(info.authenticated_exec).toBe(true);
  });

  test("AC2: run_limits_valid pins its search_path and is not executable by anon", async () => {
    const info = await meta("private.run_limits_valid(jsonb)");
    expect(info.proconfig).toContain('search_path=""');
    expect(info.anon_exec).toBe(false);
  });

  test("AC2: the only API-role-visible way to write run_limits is the function: no UPDATE/INSERT column grant exists", async () => {
    const grants = await pool.query(
      `select grantee, privilege_type from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'agents' and column_name = 'run_limits'
          and grantee in ('anon', 'authenticated', 'PUBLIC') and privilege_type in ('INSERT', 'UPDATE')`,
    );
    expect(grants.rows).toEqual([]);
  });

  test("AC2: the worker's own read (service connection, scoped by workspace_id and id) never returns another workspace's row", async () => {
    await inTransaction(async (client) => {
      await client.query("reset role");
      await client.query("update public.agents set run_limits = '{\"maxSteps\":3}' where id = $1", [AGENT_B]);
      const wrongWorkspace = await client.query(
        "select run_limits from public.agents where workspace_id = $1 and id = $2",
        [WS_A, AGENT_B],
      );
      expect(wrongWorkspace.rows).toEqual([]);
      const right = await client.query(
        "select run_limits from public.agents where workspace_id = $1 and id = $2",
        [WS_B, AGENT_B],
      );
      expect(right.rows[0].run_limits).toEqual({ maxSteps: 3 });
    });
  });
});
