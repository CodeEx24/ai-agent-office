// @vitest-environment node
// AGO-194 live proof against the local Supabase stack (real sign-in, real RLS, the real import_agent_pack function).
// It needs the shared stack, so it only runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-194 --wait-min 120 && pnpm exec supabase db reset
//   RUN_DB_TESTS=1 pnpm --filter @ago/web exec vitest run src/features/packs/apply-agent-pack-import.live.test.ts
//   node scripts/db-lock.mjs release AGO-194
// Proves: the plan the TypeScript builds is the plan the function accepts; an owner imports and exactly one event is
// written; a member, a signed-out caller and the owner of another workspace are refused; a failing last agent leaves
// no row and no event; another workspace's rows are never touched. Keys come from `supabase status` at run time and
// are never printed. Test passwords are built at runtime.
import { execFile, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { applyAgentPackImport } from "./apply-agent-pack-import";

const run = promisify(execFile);
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_agent-office";
const enabled = process.env.RUN_DB_TESTS === "1";
// The stack is shared and can be slow right after heavy runs: give the live tests a roomy file-level timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function psql(sql: string): Promise<string> {
  const { stdout } = await run("docker", [
    "exec",
    "-i",
    DB_CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-At",
    "-c",
    sql,
  ]);
  return stdout.trim();
}

function localStackEnv(): { url: string; serviceKey: string; anonKey: string } {
  const out = execSync("pnpm exec supabase status -o env", { encoding: "utf8" });
  const read = (name: string): string =>
    new RegExp(`^${name}="?([^"\\r\\n]+)"?`, "m").exec(out)?.[1] ?? "";
  return { url: read("API_URL"), serviceKey: read("SERVICE_ROLE_KEY"), anonKey: read("ANON_KEY") };
}

function packText(prompt = "Find sources."): string {
  return JSON.stringify({
    packVersion: 1,
    metadata: { name: "Live pack", exportedAt: "2026-11-17T00:00:00Z", appVersion: "0.1.0" },
    agents: [
      {
        name: "Live scout",
        role: "Researcher",
        model: "claude-haiku-5-5",
        thinkingEffort: "medium",
        prompt,
        skills: ["Live citing"],
        capabilities: [
          { name: "vault.read", scope: "workspace" },
          { name: "code.run", scope: "sandbox" },
        ],
        dailyBudgetCents: 999_999,
        autonomyMode: "standard",
      },
    ],
    skills: [{ name: "Live citing", version: 4, body: "Cite sources." }],
  });
}

describe.skipIf(!enabled)("AGO-194 agent pack import (live)", () => {
  const wsA = randomUUID();
  const wsB = randomUUID();
  const password = ["pw", randomUUID()].join("-");
  const stack = enabled ? localStackEnv() : { url: "", serviceKey: "", anonKey: "" };
  const userIds: string[] = [];
  let owner: SupabaseClient<Database>;
  let member: SupabaseClient<Database>;
  let ownerOfB: SupabaseClient<Database>;
  let signedOut: SupabaseClient<Database>;

  async function createUser(label: string): Promise<{ id: string; email: string }> {
    const email = `ago194-${label}-${randomUUID()}@example.test`;
    const res = await fetch(`${stack.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: stack.serviceKey,
        Authorization: `Bearer ${stack.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const body = (await res.json()) as { id: string };
    userIds.push(body.id);
    return { id: body.id, email };
  }

  async function signIn(email: string): Promise<SupabaseClient<Database>> {
    const client = createClient<Database>(stack.url, stack.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error("test sign-in failed");
    return client;
  }

  beforeAll(async () => {
    const [a, m, b] = [
      await createUser("owner"),
      await createUser("member"),
      await createUser("b"),
    ];
    await psql(`
      insert into public.workspaces (id, name) values ('${wsA}', 'AGO-194 live A'), ('${wsB}', 'AGO-194 live B');
      insert into public.members (workspace_id, user_id, role) values
        ('${wsA}', '${a.id}', 'owner'), ('${wsA}', '${m.id}', 'member'), ('${wsB}', '${b.id}', 'owner');
      insert into public.skills (workspace_id, name, body) values ('${wsB}', 'Live citing', 'B body');
      insert into public.agents (workspace_id, name, role, model, prompt, daily_budget_cents)
        values ('${wsB}', 'Live scout', 'B role', 'claude-haiku-5-5', 'b prompt', 100)`);
    owner = await signIn(a.email);
    member = await signIn(m.email);
    ownerOfB = await signIn(b.email);
    signedOut = createClient<Database>(stack.url, stack.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    // The workspace delete cascades to the append-only events (the guard allows exactly that).
    await psql(`delete from public.workspaces where id in ('${wsA}', '${wsB}')`);
    for (const id of userIds) {
      await fetch(`${stack.url}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: stack.serviceKey, Authorization: `Bearer ${stack.serviceKey}` },
      });
    }
  });

  const rpcImport = (client: SupabaseClient<Database>, workspace: string, plan: unknown) =>
    (
      client as unknown as {
        rpc(
          name: string,
          args: Record<string, unknown>,
        ): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
      }
    ).rpc("import_agent_pack", {
      p_workspace_id: workspace,
      p_checksum: "a".repeat(64),
      p_plan: plan,
    });

  /** agents:skills:grants:import events of workspace A, so one string says whether anything was written. */
  const countA = (): Promise<string> =>
    psql(
      `select (select count(*) from public.agents where workspace_id = '${wsA}') || ':' ||
              (select count(*) from public.skills where workspace_id = '${wsA}') || ':' ||
              (select count(*) from public.agent_capabilities where workspace_id = '${wsA}') || ':' ||
              (select count(*) from public.pack_events where workspace_id = '${wsA}' and kind = 'import')`,
    );

  it("refuses a member, a signed-out caller and the owner of another workspace, and writes nothing", async () => {
    const plan = { rule: "skip", agents: [], skills: [] };
    expect((await rpcImport(member, wsA, plan)).error?.code).toBe("42501");
    expect((await rpcImport(signedOut, wsA, plan)).error?.code).toBe("42501");
    expect((await rpcImport(ownerOfB, wsA, plan)).error?.code).toBe("42501");
    expect(await countA()).toBe("0:0:0:0");
  });

  it("a failing last agent fails the whole import: no agent, skill, grant or event", async () => {
    const agent = (name: string, budget: number) => ({
      name,
      action: "create",
      role: "r",
      model: "claude-haiku-5-5",
      thinking_effort: "medium",
      prompt: "p",
      daily_budget_cents: budget,
      capabilities: ["vault.read"],
      skills: ["Atomic skill"],
      disabled_reason: null,
    });
    const { error } = await rpcImport(owner, wsA, {
      rule: "skip",
      skills: [{ name: "Atomic skill", action: "create", body: "x" }],
      agents: [agent("Atomic one", 100), agent("Atomic two", 100), agent("Atomic three", 0)],
    });
    expect(error?.code).toBe("22023");
    expect(await countA()).toBe("0:0:0:0");
  });

  it("an owner imports a pack: strict, no Tier 3, the budget capped, one event with the checksum", async () => {
    const result = await applyAgentPackImport(owner, { workspaceId: wsA, text: packText() });
    if (!result.ok || !("report" in result)) throw new Error("expected the import to apply");
    expect(result.report).toMatchObject({ applied: true, importable: true, conflictRule: "skip" });

    expect(
      await psql(`select mode || ':' || daily_budget_cents || ':' || coalesce(archived_at::text, 'active')
                    from public.agents where workspace_id = '${wsA}' and name = 'Live scout'`),
    ).toBe("strict:500:active"); // the pack asked for 999999; the workspace cap (500) is what lands
    // vault.read (Tier 0) is granted in approval mode; code.run (Tier 3) is never granted.
    expect(
      await psql(`select string_agg(capability || ':' || mode, ',' order by capability)
                    from public.agent_capabilities where workspace_id = '${wsA}'`),
    ).toBe("vault.read:approval");
    expect(
      await psql(
        `select version from public.skills where workspace_id = '${wsA}' and name = 'Live citing'`,
      ),
    ).toBe("1");
    expect(await countA()).toBe("1:1:1:1");
    expect(
      await psql(
        `select checksum ~ '^[0-9a-f]{64}$' from public.pack_events where workspace_id = '${wsA}' and kind = 'import'`,
      ),
    ).toBe("t");
    expect(result.report.eventId).toBe(
      await psql(
        `select id from public.pack_events where workspace_id = '${wsA}' and kind = 'import'`,
      ),
    );
  });

  it("another workspace's agent and skill with the same names are never touched", async () => {
    expect(
      await psql(`select body || ':' || version from public.skills where workspace_id = '${wsB}'`),
    ).toBe("B body:1");
    expect(await psql(`select role from public.agents where workspace_id = '${wsB}'`)).toBe(
      "B role",
    );
    expect(
      await psql(`select count(*) from public.pack_events where workspace_id = '${wsB}'`),
    ).toBe("0");
  });

  it("importing the same pack again under skip changes no agent or skill and records one more event", async () => {
    const result = await applyAgentPackImport(owner, { workspaceId: wsA, text: packText() });
    expect(result.ok).toBe(true);
    expect(await countA()).toBe("1:1:1:2");
  });

  it("an update resets a relaxed agent to strict: the dry run says so, the apply does it, the log and the event record it", async () => {
    const agentId = await psql(
      `select id from public.agents where workspace_id = '${wsA}' and name = 'Live scout'`,
    );
    const promoted = await owner.rpc("set_agent_mode", {
      p_workspace_id: wsA,
      p_agent_id: agentId,
      p_mode: "relaxed",
    });
    expect(promoted.error).toBeNull();

    const text = packText("A new prompt that the owner reviewed.");
    const result = await applyAgentPackImport(owner, {
      workspaceId: wsA,
      text,
      conflictRule: "new_version",
    });
    if (!result.ok || !("report" in result)) throw new Error("expected the import to apply");
    // Preview == apply: the report the owner saw names the reset, and the database does exactly that.
    expect(result.report.agents[0]).toMatchObject({ action: "update", resetsModeFrom: "relaxed" });
    expect(
      await psql(`select mode || ':' || prompt from public.agents where id = '${agentId}'`),
    ).toBe("strict:A new prompt that the owner reviewed.");
    expect(
      await psql(
        `select count(*) from public.agent_mode_changes where agent_id = '${agentId}' and from_mode = 'relaxed' and to_mode = 'strict'`,
      ),
    ).toBe("1");
    expect(
      await psql(
        `select detail -> 'agents' -> 0 ->> 'mode_reset_from' from public.pack_events where id = '${result.report.eventId}'`,
      ),
    ).toBe("relaxed");
  });
});
