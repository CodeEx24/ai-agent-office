// @vitest-environment node
// AGO-194 functional acceptance tests (tester-functional, round 3), live against the local Supabase stack. They cover
// the round-3 fixes: the Strict reset of an updated agent (dry run == apply, mode log, event detail), the AGO-192
// pack_events check, agent_capabilities paging with ties, the scrub parity between the TypeScript invisible-text set
// and the SQL class, and the first-pass type validation (22023, never 23502/23514). Real sign-in, real RLS, the real
// `import_agent_pack` function. Only the cookie-bound server client factory is not used here: the apply and preview
// functions take the signed-in client directly.
// It needs the shared stack, so it only runs with RUN_DB_TESTS=1 and inside the db lock:
//   RUN_DB_TESTS=1 pnpm --filter @ago/web exec vitest run src/features/packs/apply-agent-pack-import.acceptance3.live.test.ts
// Every scenario gets its own throwaway workspace; all of them are deleted in afterAll. Passwords are built at runtime.
import { execFile, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";
import { stripInvisibleText, isInvisibleCodePoint } from "@ago/shared/pack-import-preview";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { applyAgentPackImport } from "./apply-agent-pack-import";
import { loadPackImportContext, previewAgentPackImport } from "./preview-agent-pack-import";

const run = promisify(execFile);
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_agent-office";
const enabled = process.env.RUN_DB_TESTS === "1";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Loose = Record<string, unknown>;
type Client = SupabaseClient<Database>;
type Conflict = "skip" | "rename" | "new_version";

const PSQL_BASE = ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"];

async function psql(sql: string): Promise<string> {
  const { stdout } = await run("docker", [...PSQL_BASE, "-q", "-At", "-c", sql], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Runs SQL and returns the error text (with the SQLSTATE) it fails with, or "" when it succeeds. */
async function psqlError(sql: string): Promise<string> {
  try {
    await run("docker", [...PSQL_BASE, "-v", "VERBOSITY=verbose", "-q", "-At", "-c", sql]);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

async function rows<T = Loose>(sql: string): Promise<T[]> {
  const out = await psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`);
  return JSON.parse(out) as T[];
}

function localStackEnv(): { url: string; serviceKey: string; anonKey: string } {
  const out = execSync("pnpm exec supabase status -o env", { encoding: "utf8" });
  const read = (name: string): string =>
    new RegExp(`^${name}="?([^"\\r\\n]+)"?`, "m").exec(out)?.[1] ?? "";
  return { url: read("API_URL"), serviceKey: read("SERVICE_ROLE_KEY"), anonKey: read("ANON_KEY") };
}

// ----------------------------------------------------------------------------------------------- pack and plan data

const agentJson = (overrides: Loose = {}): Loose => ({
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5",
  thinkingEffort: "medium",
  prompt: "Find sources.",
  skills: [],
  capabilities: [{ name: "vault.read", scope: "workspace" }],
  dailyBudgetCents: 500,
  autonomyMode: "strict",
  ...overrides,
});
const packOf = (agents: Loose[], skills: Loose[] = []): string =>
  JSON.stringify({
    packVersion: 1,
    metadata: {
      name: "Acceptance pack 3",
      exportedAt: "2026-11-18T00:00:00Z",
      appVersion: "0.1.0",
    },
    agents,
    skills,
  });

const planAgent = (overrides: Loose = {}): Loose => ({
  name: "Planned",
  action: "create",
  role: "r",
  model: "claude-haiku-5-5",
  thinking_effort: "medium",
  prompt: "p",
  daily_budget_cents: 100,
  capabilities: [],
  skills: [],
  disabled_reason: null,
  ...overrides,
});
const planSkill = (overrides: Loose = {}): Loose => ({
  name: "PlannedSkill",
  action: "create",
  body: "b",
  ...overrides,
});
const planOf = (agents: Loose[], skills: Loose[] = [], rule = "skip"): Loose => ({
  rule,
  agents,
  skills,
});
const without = (entry: Loose, key: string): Loose => {
  const { [key]: _removed, ...rest } = entry;
  return rest;
};

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

describe.skipIf(!enabled)("AGO-194 acceptance, round 3 (live)", () => {
  const password = ["pw", randomUUID()].join("-");
  const stack = enabled ? localStackEnv() : { url: "", serviceKey: "", anonKey: "" };
  const userIds: string[] = [];
  const workspaces: string[] = [];
  let owner: { id: string; email: string };
  let ownerClient: Client;

  const anonClient = (): Client =>
    createClient<Database>(stack.url, stack.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  beforeAll(async () => {
    const email = `ago194-acc3-owner-${randomUUID()}@example.test`;
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
    owner = { id: body.id, email };
    ownerClient = anonClient();
    const { error } = await ownerClient.auth.signInWithPassword({ email, password });
    if (error) throw new Error("test sign-in failed");
  });

  afterAll(async () => {
    if (!enabled) return;
    if (workspaces.length > 0) {
      const ids = workspaces.map((id) => `'${id}'`).join(",");
      await psql(`delete from public.workspaces where id in (${ids})`);
    }
    for (const id of userIds) {
      await fetch(`${stack.url}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: stack.serviceKey, Authorization: `Bearer ${stack.serviceKey}` },
      });
    }
  });

  async function makeWorkspace(lowerTiers: Record<string, number> = {}): Promise<string> {
    const id = randomUUID();
    workspaces.push(id);
    await psql(`
      insert into public.workspaces (id, name) values ('${id}', 'AGO-194 acc3');
      insert into public.members (workspace_id, user_id, role, removed_at) values ('${id}', '${owner.id}', 'owner', null)`);
    for (const [key, tier] of Object.entries(lowerTiers)) {
      await psql(
        `update public.capabilities set tier = ${String(tier)} where workspace_id = '${id}' and key = '${key}'`,
      );
    }
    return id;
  }

  /** Seeds an agent through SQL (always strict), then moves it to the mode asked for through the owner's own RPC. */
  async function seedAgent(
    ws: string,
    name: string,
    options: {
      mode?: "strict" | "standard" | "relaxed";
      capabilities?: string[];
      prompt?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await psql(`insert into public.agents (id, workspace_id, name, role, model, thinking_effort, prompt, daily_budget_cents)
      values ('${id}', '${ws}', '${name}', 'Researcher', 'claude-haiku-5-5', 'medium', '${options.prompt ?? "Old prompt."}', 100)`);
    for (const key of options.capabilities ?? []) {
      await psql(`insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
        select '${ws}', '${id}', c.key, c.tier, 'approval' from public.capabilities c where c.workspace_id = '${ws}' and c.key = '${key}'`);
    }
    if (options.mode && options.mode !== "strict") {
      const moved = await ownerClient.rpc("set_agent_mode", {
        p_workspace_id: ws,
        p_agent_id: id,
        p_mode: options.mode,
      });
      expect(moved.error).toBeNull();
    }
    return id;
  }

  const snapshot = (ws: string): Promise<string> =>
    psql(
      `select (select count(*) from public.agents where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.skills where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.agent_skills where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.agent_capabilities where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.skill_versions where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.agent_versions where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.agent_mode_changes where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.pack_events where workspace_id = '${ws}')`,
    );
  const agentRow = async (ws: string, name: string): Promise<Loose | undefined> =>
    (
      await rows(`select id, mode, role, prompt, archived_at is not null as archived
                    from public.agents where workspace_id = '${ws}' and name = '${name}'`)
    )[0];
  const modeLog = (agentId: string) =>
    rows<{ from_mode: string; to_mode: string }>(
      `select from_mode, to_mode from public.agent_mode_changes where agent_id = '${agentId}' order by created_at, id`,
    );
  interface EventDetail {
    rule: string;
    modes_reset: number;
    agents_written: number;
    agents: Loose[];
  }
  const eventDetail = async (eventId: string): Promise<EventDetail> => {
    const found = await rows<{ detail: EventDetail }>(
      `select detail from public.pack_events where id = '${eventId}'`,
    );
    if (!found[0]) throw new Error("the import event is missing");
    return found[0].detail;
  };

  const applyOk = async (ws: string, text: string, conflictRule: Conflict) => {
    const result = await applyAgentPackImport(ownerClient, { workspaceId: ws, text, conflictRule });
    if (!result.ok || !("report" in result)) throw new Error("expected the import to apply");
    return result.report;
  };
  const previewOk = async (ws: string, text: string, conflictRule: Conflict) => {
    const result = await previewAgentPackImport(ownerClient, {
      workspaceId: ws,
      text,
      conflictRule,
    });
    if (!result.ok) throw new Error("expected the dry run to succeed");
    return result.preview;
  };

  const rpcImport = (ws: string, plan: unknown) =>
    (
      ownerClient as unknown as {
        rpc(
          name: string,
          args: Record<string, unknown>,
        ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
      }
    ).rpc("import_agent_pack", { p_workspace_id: ws, p_checksum: "a".repeat(64), p_plan: plan });

  // ==============================================================================================================
  describe("AC1 + round 3 (a): an update through new_version lands the agent in Strict, and says so", () => {
    for (const from of ["standard", "relaxed"] as const) {
      it(`resets an existing ${from} agent to strict when new_version replaces its prompt, and the dry run, the mode log and the event all say so`, async () => {
        const ws = await makeWorkspace();
        const agentId = await seedAgent(ws, "Scout", { mode: from });
        const text = packOf([agentJson({ prompt: "The reviewed prompt." })]);

        const preview = await previewOk(ws, text, "new_version");
        expect(preview.agents[0]).toMatchObject({ action: "update", resetsModeFrom: from });
        // The dry run writes nothing: the agent is still in its old mode.
        expect((await agentRow(ws, "Scout"))?.mode).toBe(from);

        const report = await applyOk(ws, text, "new_version");
        expect(report.agents[0]).toMatchObject({ action: "update", resetsModeFrom: from });
        expect(report.agents.map((a) => a.resetsModeFrom)).toEqual(
          preview.agents.map((a) => a.resetsModeFrom),
        );
        expect(await agentRow(ws, "Scout")).toMatchObject({
          mode: "strict",
          prompt: "The reviewed prompt.",
        });
        // The log: the owner's own move to `from`, then the reset, nothing else.
        expect(await modeLog(agentId)).toEqual([
          { from_mode: "strict", to_mode: from },
          { from_mode: from, to_mode: "strict" },
        ]);
        const detail = await eventDetail(report.eventId);
        expect(detail.modes_reset).toBe(1);
        expect(detail.agents).toEqual([
          { name: "Scout", action: "update", disabled_reason: null, mode_reset_from: from },
        ]);
      });
    }

    it("adds no mode-change row and no mode_reset_from key when the updated agent is already strict", async () => {
      const ws = await makeWorkspace();
      const agentId = await seedAgent(ws, "Scout");
      const text = packOf([agentJson({ prompt: "A different prompt." })]);

      const preview = await previewOk(ws, text, "new_version");
      expect(preview.agents[0]).toMatchObject({ action: "update", resetsModeFrom: null });
      const report = await applyOk(ws, text, "new_version");
      expect(report.agents[0]).toMatchObject({ action: "update", resetsModeFrom: null });

      expect(await modeLog(agentId)).toEqual([]);
      expect((await agentRow(ws, "Scout"))?.mode).toBe("strict");
      const detail = await eventDetail(report.eventId);
      expect(detail.modes_reset).toBe(0);
      expect(Object.hasOwn(detail.agents[0] ?? {}, "mode_reset_from")).toBe(false);
    });

    it("counts only the reset agents in modes_reset and marks mode_reset_from on exactly those, new agent included as strict", async () => {
      const ws = await makeWorkspace();
      const ids = {
        std: await seedAgent(ws, "Std", { mode: "standard" }),
        rel: await seedAgent(ws, "Rel", { mode: "relaxed" }),
        str: await seedAgent(ws, "Str"),
      };
      const text = packOf([
        agentJson({ name: "Std", prompt: "p1" }),
        agentJson({ name: "Rel", prompt: "p2" }),
        agentJson({ name: "Str", prompt: "p3" }),
        agentJson({ name: "Fresh", prompt: "p4" }),
      ]);
      const preview = await previewOk(ws, text, "new_version");
      const report = await applyOk(ws, text, "new_version");

      expect(preview.agents.map((a) => a.resetsModeFrom)).toEqual([
        "standard",
        "relaxed",
        null,
        null,
      ]);
      expect(report.agents.map((a) => a.resetsModeFrom)).toEqual([
        "standard",
        "relaxed",
        null,
        null,
      ]);
      for (const name of ["Std", "Rel", "Str", "Fresh"]) {
        expect((await agentRow(ws, name))?.mode, name).toBe("strict");
      }
      expect(await modeLog(ids.std)).toHaveLength(2);
      expect(await modeLog(ids.rel)).toHaveLength(2);
      expect(await modeLog(ids.str)).toHaveLength(0);
      const detail = await eventDetail(report.eventId);
      expect(detail.modes_reset).toBe(2);
      const byName = Object.fromEntries(detail.agents.map((a) => [a.name as string, a]));
      expect(byName.Std?.mode_reset_from).toBe("standard");
      expect(byName.Rel?.mode_reset_from).toBe("relaxed");
      expect(Object.hasOwn(byName.Str ?? {}, "mode_reset_from")).toBe(false);
      expect(Object.hasOwn(byName.Fresh ?? {}, "mode_reset_from")).toBe(false);
    });

    it("lands a created agent in strict and shows landsIn strict in the dry run", async () => {
      const ws = await makeWorkspace();
      const text = packOf([agentJson({ name: "Brand new", autonomyMode: "relaxed" })]);
      const preview = await previewOk(ws, text, "new_version");
      expect(preview.agents[0]).toMatchObject({
        action: "create",
        landsIn: "strict",
        resetsModeFrom: null,
      });
      const report = await applyOk(ws, text, "new_version");
      expect((await agentRow(ws, "Brand new"))?.mode).toBe("strict");
      expect(
        Object.hasOwn((await eventDetail(report.eventId)).agents[0] ?? {}, "mode_reset_from"),
      ).toBe(false);
    });

    it("does not reset a relaxed agent that the rule skips", async () => {
      const ws = await makeWorkspace();
      const agentId = await seedAgent(ws, "Scout", { mode: "relaxed" });
      const text = packOf([agentJson({ prompt: "Would replace it." })]);
      const preview = await previewOk(ws, text, "skip");
      expect(preview.agents[0]).toMatchObject({ action: "skip", resetsModeFrom: null });
      const report = await applyOk(ws, text, "skip");
      expect(report.agents[0]).toMatchObject({ action: "skip", resetsModeFrom: null });
      expect(await agentRow(ws, "Scout")).toMatchObject({ mode: "relaxed", prompt: "Old prompt." });
      expect(await modeLog(agentId)).toEqual([{ from_mode: "strict", to_mode: "relaxed" }]);
      expect((await eventDetail(report.eventId)).modes_reset).toBe(0);
    });

    it("does not reset a relaxed agent whose pack entry changes nothing under new_version", async () => {
      const ws = await makeWorkspace();
      const agentId = await seedAgent(ws, "Scout", { mode: "relaxed" });
      // Same role, model, thinking effort and prompt as the seeded row: no changed field.
      const text = packOf([agentJson({ prompt: "Old prompt." })]);
      const preview = await previewOk(ws, text, "new_version");
      expect(preview.agents[0]).toMatchObject({
        action: "skip",
        changedFields: [],
        resetsModeFrom: null,
      });
      const report = await applyOk(ws, text, "new_version");
      expect(report.agents[0]).toMatchObject({ action: "skip", resetsModeFrom: null });
      expect((await agentRow(ws, "Scout"))?.mode).toBe("relaxed");
      expect(await modeLog(agentId)).toHaveLength(1);
      expect((await eventDetail(report.eventId)).modes_reset).toBe(0);
    });

    it("does not reset an archived relaxed agent, which new_version skips", async () => {
      const ws = await makeWorkspace();
      const agentId = await seedAgent(ws, "Scout", { mode: "relaxed" });
      await psql(`update public.agents set archived_at = now() where id = '${agentId}'`);
      const text = packOf([agentJson({ prompt: "Would replace it." })]);
      const preview = await previewOk(ws, text, "new_version");
      expect(preview.agents[0]).toMatchObject({ action: "skip", resetsModeFrom: null });
      const report = await applyOk(ws, text, "new_version");
      expect(report.agents[0]).toMatchObject({ action: "skip", resetsModeFrom: null });
      expect(await agentRow(ws, "Scout")).toMatchObject({
        mode: "relaxed",
        prompt: "Old prompt.",
        archived: true,
      });
      expect(await modeLog(agentId)).toHaveLength(1);
    });

    it("does not reset a relaxed agent under rename, which makes a strict copy and leaves the original", async () => {
      const ws = await makeWorkspace();
      const agentId = await seedAgent(ws, "Scout", { mode: "relaxed" });
      const text = packOf([agentJson({ prompt: "Copy prompt." })]);
      const preview = await previewOk(ws, text, "rename");
      expect(preview.agents[0]).toMatchObject({ action: "create", resetsModeFrom: null });
      const report = await applyOk(ws, text, "rename");
      expect((await agentRow(ws, "Scout"))?.mode).toBe("relaxed");
      expect(await modeLog(agentId)).toHaveLength(1);
      const copy = await rows<{ mode: string }>(
        `select mode from public.agents where workspace_id = '${ws}' and name <> 'Scout'`,
      );
      expect(copy).toEqual([{ mode: "strict" }]);
      expect((await eventDetail(report.eventId)).modes_reset).toBe(0);
    });

    it("resets a relaxed agent to strict and disables it when the update completes the trifecta, and the dry run said both", async () => {
      const ws = await makeWorkspace({ "message.send_outbound": 2 });
      const agentId = await seedAgent(ws, "Courier", {
        mode: "relaxed",
        capabilities: ["message.send_outbound"],
      });
      const text = packOf([
        agentJson({
          name: "Courier",
          prompt: "New prompt.",
          capabilities: [
            { name: "web.search", scope: "workspace" },
            { name: "vault.read", scope: "workspace" },
          ],
        }),
      ]);
      const preview = await previewOk(ws, text, "new_version");
      expect(preview.agents[0]).toMatchObject({
        action: "update",
        resetsModeFrom: "relaxed",
        importDisabled: { reason: "trifecta_combination" },
      });
      const report = await applyOk(ws, text, "new_version");
      expect(report.agents[0]).toMatchObject({ resetsModeFrom: "relaxed" });
      expect(await agentRow(ws, "Courier")).toMatchObject({ mode: "strict", archived: true });
      expect(await modeLog(agentId)).toHaveLength(2);
      const detail = await eventDetail(report.eventId);
      expect(detail.agents[0]).toMatchObject({
        mode_reset_from: "relaxed",
        disabled_reason: "trifecta_combination",
      });
      expect(detail.modes_reset).toBe(1);
    });

    it("ignores any mode field in a plan sent straight to the function: creates land strict, updates end strict", async () => {
      const ws = await makeWorkspace();
      const relaxedId = await seedAgent(ws, "Relaxed one", { mode: "relaxed" });
      const strictId = await seedAgent(ws, "Strict one");
      for (const key of ["mode", "autonomy_mode", "agent_mode", "autonomyMode"]) {
        const marker = key.slice(0, 4);
        const { error } = await rpcImport(
          ws,
          planOf([
            planAgent({ name: `Created ${key}`, [key]: "relaxed" }),
            planAgent({ name: "Relaxed one", action: "update", prompt: marker, [key]: "relaxed" }),
            planAgent({ name: "Strict one", action: "update", prompt: marker, [key]: "relaxed" }),
          ]),
        );
        expect(error, key).toBeNull();
        expect((await agentRow(ws, `Created ${key}`))?.mode, key).toBe("strict");
        expect((await agentRow(ws, "Relaxed one"))?.mode, key).toBe("strict");
        expect((await agentRow(ws, "Strict one"))?.mode, key).toBe("strict");
      }
      // The relaxed agent was reset exactly once (the first plan); the strict one never.
      expect(await modeLog(relaxedId)).toEqual([
        { from_mode: "strict", to_mode: "relaxed" },
        { from_mode: "relaxed", to_mode: "strict" },
      ]);
      expect(await modeLog(strictId)).toEqual([]);
    });

    it("resets a standard agent when a crafted plan updates it, whatever mode the plan names", async () => {
      const ws = await makeWorkspace();
      const agentId = await seedAgent(ws, "Std", { mode: "standard" });
      const { error } = await rpcImport(
        ws,
        planOf([planAgent({ name: "Std", action: "update", prompt: "x", mode: "standard" })]),
      );
      expect(error).toBeNull();
      expect((await agentRow(ws, "Std"))?.mode).toBe("strict");
      expect(await modeLog(agentId)).toEqual([
        { from_mode: "strict", to_mode: "standard" },
        { from_mode: "standard", to_mode: "strict" },
      ]);
    });
  });

  // ==============================================================================================================
  describe("round 3 (b): the AGO-192 pack_events check cardinality(agent_names) = cardinality(agent_ids)", () => {
    const insertEvent = (ws: string, kind: string, ids: number, names: number): string => `
      begin;
      insert into public.pack_events (workspace_id, kind, exported_by, agent_ids, agent_names, skill_count, checksum)
        select '${ws}', '${kind}', m.id,
               array(select gen_random_uuid() from generate_series(1, ${String(ids)})),
               array(select 'n' || g from generate_series(1, ${String(names)}) g), 0, repeat('a', 64)
          from public.members m where m.workspace_id = '${ws}';
      rollback;`;

    it("exists on pack_events after the migration is applied", async () => {
      const out = await psql(
        `select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.pack_events'::regclass and contype = 'c' and conname = 'pack_events_check'`,
      );
      expect(out).toContain("cardinality(agent_names)");
      expect(out).toContain("cardinality(agent_ids)");
    });

    it("refuses an import event with more agent ids than names, and the reverse", async () => {
      const ws = await makeWorkspace();
      for (const [ids, names] of [
        [1, 0],
        [0, 1],
        [3, 2],
      ] as const) {
        const error = await psqlError(insertEvent(ws, "import", ids, names));
        expect(error, `ids ${String(ids)} names ${String(names)}`).toContain("23514");
        expect(error).toContain("pack_events_check");
      }
    });

    it("refuses an export event with mismatched names and ids", async () => {
      const ws = await makeWorkspace();
      const error = await psqlError(insertEvent(ws, "export", 2, 1));
      expect(error).toContain("23514");
      expect(error).toContain("pack_events_check");
    });

    it("accepts matching counts, so the refusal above is the check and not a broken fixture", async () => {
      const ws = await makeWorkspace();
      expect(await psqlError(insertEvent(ws, "import", 2, 2))).toBe("");
      expect(await psqlError(insertEvent(ws, "import", 0, 0))).toBe("");
      expect(await psqlError(insertEvent(ws, "export", 1, 1))).toBe("");
    });
  });

  // ==============================================================================================================
  describe("round 3 (c): agent_capabilities paging reads every grant once, ties included", () => {
    it("reads all grants of more than 1000 rows, including an agent whose grants straddle the page boundary", async () => {
      const ws = await makeWorkspace();
      const catalogSize = Number(
        await psql(
          `select count(*) from public.capabilities where workspace_id = '${ws}' and tier < 3`,
        ),
      );
      expect(catalogSize).toBeGreaterThan(5);
      const agentCount = Math.ceil(1100 / catalogSize) + 1;
      await psql(
        `insert into public.agents (workspace_id, name, role, model, thinking_effort, prompt, daily_budget_cents)
           select '${ws}', 'Bulk ' || g, 'r', 'claude-haiku-5-5', 'medium', 'p', 100 from generate_series(1, ${String(agentCount)}) g`,
      );
      await psql(
        `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
           select '${ws}', a.id, c.key, c.tier, 'approval'
             from public.agents a cross join public.capabilities c
            where a.workspace_id = '${ws}' and c.workspace_id = '${ws}' and c.tier < 3`,
      );
      // Fixture: grants number 1000 and 1001 (the last of page one, the first of page two) must belong to one agent.
      // Remove grants of the first agent until they do (each removal shifts the boundary by one row).
      const boundaryRows = () =>
        rows<{ agent_id: string }>(
          `select agent_id from public.agent_capabilities where workspace_id = '${ws}'
            order by agent_id, capability offset 999 limit 2`,
        );
      let boundary = await boundaryRows();
      for (
        let attempt = 0;
        attempt < 200 && boundary[0]?.agent_id !== boundary[1]?.agent_id;
        attempt++
      ) {
        await psql(
          `delete from public.agent_capabilities where (agent_id, capability) in (
             select agent_id, capability from public.agent_capabilities where workspace_id = '${ws}'
              order by agent_id, capability limit 1)`,
        );
        boundary = await boundaryRows();
      }
      const total = Number(
        await psql(`select count(*) from public.agent_capabilities where workspace_id = '${ws}'`),
      );
      expect(total).toBeGreaterThan(1000);
      expect(boundary).toHaveLength(2);
      expect(boundary[0]?.agent_id).toBe(boundary[1]?.agent_id);

      const context = await loadPackImportContext(ownerClient, ws, "new_version");
      const truth = await rows<{ name: string; capabilities: string[] }>(
        `select a.name, array_agg(c.capability order by c.capability) as capabilities
           from public.agents a join public.agent_capabilities c on c.agent_id = a.id
          where a.workspace_id = '${ws}' group by a.name order by a.name`,
      );
      expect(context.existingAgents).toHaveLength(agentCount);
      let seen = 0;
      for (const expected of truth) {
        const got = context.existingAgents.find((agent) => agent.name === expected.name);
        const held = [...(got?.capabilities ?? [])].sort();
        // Exactly the database's set: nothing missing (a skipped grant) and nothing twice (a re-read grant).
        expect(held, expected.name).toEqual(expected.capabilities);
        seen += held.length;
      }
      expect(seen).toBe(total);
      const straddler = (
        await rows<{ name: string }>(
          `select name from public.agents where id = '${boundary[0]?.agent_id ?? ""}'`,
        )
      )[0]?.name;
      expect(
        context.existingAgents.find((agent) => agent.name === straddler)?.capabilities,
      ).toHaveLength(truth.find((entry) => entry.name === straddler)?.capabilities.length ?? -1);
    });
  });

  // ==============================================================================================================
  describe("round 3: the event-name scrub in SQL matches the TypeScript set, code point by code point", () => {
    // Written here from the ticket's list, independent of PACK_INVISIBLE_RANGES.
    const REMOVED: [string, number, number][] = [
      ["C0 controls", 0x0001, 0x001f],
      ["DEL and C1 controls", 0x007f, 0x009f],
      ["soft hyphen", 0x00ad, 0x00ad],
      ["combining grapheme joiner", 0x034f, 0x034f],
      ["Arabic letter mark", 0x061c, 0x061c],
      ["Mongolian vowel separator", 0x180e, 0x180e],
      ["zero-width and direction marks", 0x200b, 0x200f],
      ["line and paragraph separators and bidi embeddings", 0x2028, 0x202e],
      ["word joiner and invisible operators", 0x2060, 0x2064],
      ["bidi isolates", 0x2066, 0x2069],
      ["byte order mark", 0xfeff, 0xfeff],
      ["tag characters", 0xe0000, 0xe007f],
    ];
    const KEPT_NEIGHBOURS = [
      0x0020, 0x00a0, 0x00ac, 0x00ae, 0x034e, 0x0350, 0x061b, 0x061d, 0x180d, 0x180f, 0x200a,
      0x2010, 0x2027, 0x202f, 0x205f, 0x2065, 0x206a, 0xfefe, 0xff00, 0xe0080, 0xe0100,
    ];
    const nameOf = (cp: number): string => `A${String.fromCodePoint(cp)}B`;
    const eventNameOf = new Map<number, string>();

    beforeAll(async () => {
      const all = [
        ...REMOVED.flatMap(([, from, to]) =>
          Array.from({ length: to - from + 1 }, (_, i) => from + i),
        ),
        ...KEPT_NEIGHBOURS,
      ];
      for (let start = 0; start < all.length; start += 100) {
        const batch = all.slice(start, start + 100);
        const ws = await makeWorkspace();
        const { data, error } = await rpcImport(
          ws,
          planOf(batch.map((cp) => planAgent({ name: nameOf(cp) }))),
        );
        if (error) throw new Error(`batch ${String(start)} failed: ${error.code ?? "?"}`);
        const event = (
          await rows<{ agent_names: string[] }>(
            `select agent_names from public.pack_events where id = '${String(data)}'`,
          )
        )[0];
        batch.forEach((cp, index) => eventNameOf.set(cp, event?.agent_names[index] ?? "<missing>"));
      }
    });

    for (const [label, from, to] of REMOVED) {
      it(`removes every code point of ${label} (${hex(from)} to ${hex(to)}) from the recorded agent name`, () => {
        const wrong: string[] = [];
        for (let cp = from; cp <= to; cp++) {
          if (eventNameOf.get(cp) !== "AB") wrong.push(hex(cp));
        }
        expect(wrong).toEqual([]);
      });
    }

    it("keeps the neighbours just outside the ranges (U+0020, U+00AC, U+00AE, U+2065, U+E0080 and others)", () => {
      const wrong: string[] = [];
      for (const cp of KEPT_NEIGHBOURS) {
        if (eventNameOf.get(cp) !== nameOf(cp)) wrong.push(hex(cp));
      }
      expect(wrong).toEqual([]);
    });

    it("gives the same cleaned name as the TypeScript stripInvisibleText for every code point tested", () => {
      const wrong: string[] = [];
      for (const [cp, event] of eventNameOf) {
        if (event !== stripInvisibleText(nameOf(cp))) wrong.push(hex(cp));
      }
      expect(wrong).toEqual([]);
    });

    it("removes exactly the code points the TypeScript set lists, over the whole Unicode range, in the deployed function's own class", async () => {
      const source = await psql(
        `select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_agent_pack'`,
      );
      const klass = /regexp_replace\(\s*v_agent ->> 'name',\s*'(\[[^']+\])'/.exec(source)?.[1];
      expect(klass, "the scrub class in the deployed function").toBeDefined();
      // Every non-surrogate code point except NUL, evaluated by the deployed class itself.
      const removed = (
        await psql(
          `select string_agg(cp::text, ',' order by cp) from generate_series(1, 1114111) cp
            where not (cp between 55296 and 57343)
              and regexp_replace(chr(cp), $re$${klass ?? ""}$re$, '', 'g') = ''`,
        )
      )
        .split(",")
        .map(Number);
      const expected: number[] = [];
      for (let cp = 1; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        if (isInvisibleCodePoint(cp)) expected.push(cp);
      }
      expect(removed.length).toBe(expected.length);
      expect(removed).toEqual(expected);
    });
  });

  // ==============================================================================================================
  describe("round 3: the first pass of the function refuses wrong shapes with 22023, never 23502 or 23514", () => {
    const WRONG_VALUES: [string, (entry: Loose, key: string) => Loose][] = [
      ["a number", (entry, key) => ({ ...entry, [key]: 5 })],
      ["null", (entry, key) => ({ ...entry, [key]: null })],
      ["an object", (entry, key) => ({ ...entry, [key]: { a: 1 } })],
      ["missing", (entry, key) => without(entry, key)],
      ["a boolean", (entry, key) => ({ ...entry, [key]: true })],
      ["an array", (entry, key) => ({ ...entry, [key]: ["x"] })],
    ];

    /** Sends the plan, expects 22023 and that nothing was written, even though an earlier entry was fine. */
    async function expectRefused(label: string, mutate: (entry: Loose) => Loose) {
      const ws = await makeWorkspace();
      await seedAgent(ws, "Existing");
      const before = await snapshot(ws);
      const { error } = await rpcImport(
        ws,
        planOf([planAgent({ name: "FirstFine" }), mutate(planAgent({ name: "Second" }))]),
      );
      expect(error?.code, label).toBe("22023");
      expect(await snapshot(ws), label).toBe(before);
      expect(await agentRow(ws, "FirstFine")).toBeUndefined();
      expect(await agentRow(ws, "Second")).toBeUndefined();
    }

    for (const key of ["role", "model", "prompt", "thinking_effort"]) {
      for (const [label, wrong] of WRONG_VALUES) {
        it(`refuses ${key} as ${label} with 22023 and writes nothing`, async () => {
          await expectRefused(`${key} ${label}`, (entry) => wrong(entry, key));
        });
      }
    }

    for (const key of ["capabilities", "skills"]) {
      const NON_ARRAYS: [string, unknown][] = [
        ["a string", "vault.read"],
        ["a number", 3],
        ["null", null],
        ["an object", { 0: "vault.read" }],
        ["a boolean", false],
      ];
      for (const [label, value] of NON_ARRAYS) {
        it(`refuses ${key} as ${label} with 22023 and writes nothing`, async () => {
          await expectRefused(`${key} ${label}`, (entry) => ({ ...entry, [key]: value }));
        });
      }
      it(`refuses ${key} when it is missing with 22023 and writes nothing`, async () => {
        await expectRefused(`${key} missing`, (entry) => without(entry, key));
      });
      it(`refuses ${key} with 51 elements with 22023 and writes nothing`, async () => {
        await expectRefused(`${key} 51`, (entry) => ({
          ...entry,
          [key]: Array.from({ length: 51 }, () => "vault.read"),
        }));
      });
      it(`refuses ${key} with 200 elements with 22023 and writes nothing`, async () => {
        await expectRefused(`${key} 200`, (entry) => ({
          ...entry,
          [key]: Array.from({ length: 200 }, (_, i) => `k${String(i)}`),
        }));
      });
      const BAD_ELEMENTS: [string, unknown][] = [
        ["a number", 7],
        ["null", null],
        ["an object", { name: "vault.read" }],
        ["a nested array", ["vault.read"]],
        ["a boolean", true],
      ];
      for (const [label, element] of BAD_ELEMENTS) {
        it(`refuses ${key} holding ${label} among strings with 22023 and writes nothing`, async () => {
          await expectRefused(`${key} element ${label}`, (entry) => ({
            ...entry,
            [key]: ["vault.read", element],
          }));
        });
      }
    }

    const BAD_BUDGETS: [string, unknown][] = [
      ["a string", "100"],
      ["a fraction", 12.5],
      ["zero", 0],
      ["5001", 5001],
      ["negative", -1],
      ["null", null],
      ["an object", { cents: 100 }],
    ];
    for (const [label, value] of BAD_BUDGETS) {
      it(`refuses a daily budget of ${label} with 22023 and writes nothing`, async () => {
        await expectRefused(`budget ${label}`, (entry) => ({
          ...entry,
          daily_budget_cents: value,
        }));
      });
    }
    it("refuses a missing daily budget with 22023 and writes nothing", async () => {
      await expectRefused("budget missing", (entry) => without(entry, "daily_budget_cents"));
    });

    const BAD_REASONS: [string, unknown][] = [
      ["another string", "something_else"],
      ["the right word in another case", "TRIFECTA_COMBINATION"],
      ["the right word with a trailing space", "trifecta_combination "],
      ["an empty string", ""],
      ["a number", 1],
      ["a boolean", true],
      ["an object", { reason: "trifecta_combination" }],
      ["an empty array", []],
      ["an array holding the word", ["trifecta_combination"]],
    ];
    for (const [label, value] of BAD_REASONS) {
      it(`refuses disabled_reason as ${label} with 22023 and writes nothing`, async () => {
        await expectRefused(`reason ${label}`, (entry) => ({ ...entry, disabled_reason: value }));
      });
    }

    it("accepts disabled_reason null, missing and trifecta_combination (the last archives the agent)", async () => {
      const ws = await makeWorkspace();
      const { error } = await rpcImport(
        ws,
        planOf([
          planAgent({ name: "Null reason", disabled_reason: null }),
          without(planAgent({ name: "Missing reason" }), "disabled_reason"),
          planAgent({ name: "Reason set", disabled_reason: "trifecta_combination" }),
        ]),
      );
      expect(error).toBeNull();
      expect((await agentRow(ws, "Null reason"))?.archived).toBe(false);
      expect((await agentRow(ws, "Missing reason"))?.archived).toBe(false);
      expect((await agentRow(ws, "Reason set"))?.archived).toBe(true);
    });

    it("accepts exactly 50 capabilities and exactly 50 skills in one agent entry", async () => {
      const ws = await makeWorkspace();
      const { error } = await rpcImport(
        ws,
        planOf(
          [
            planAgent({
              name: "Fifty",
              capabilities: Array.from({ length: 50 }, () => "vault.read"),
              skills: Array.from({ length: 50 }, () => "Shared skill"),
            }),
          ],
          [planSkill({ name: "Shared skill" })],
        ),
      );
      expect(error).toBeNull();
      expect(
        await psql(
          `select count(*) from public.agent_capabilities c join public.agents a on a.id = c.agent_id where a.workspace_id = '${ws}' and a.name = 'Fifty'`,
        ),
      ).toBe("1");
      expect(
        await psql(
          `select count(*) from public.agent_skills s join public.agents a on a.id = s.agent_id where a.workspace_id = '${ws}' and a.name = 'Fifty'`,
        ),
      ).toBe("1");
    });

    it("refuses a wrong shape in a LATER agent and leaves an earlier valid update untouched", async () => {
      const ws = await makeWorkspace();
      await seedAgent(ws, "Existing", { mode: "relaxed" });
      const before = await snapshot(ws);
      const { error } = await rpcImport(
        ws,
        planOf([
          planAgent({ name: "Existing", action: "update", prompt: "Hijacked" }),
          planAgent({ name: "Bad", role: null }),
        ]),
      );
      expect(error?.code).toBe("22023");
      expect(await snapshot(ws)).toBe(before);
      expect(await agentRow(ws, "Existing")).toMatchObject({
        mode: "relaxed",
        prompt: "Old prompt.",
      });
    });
  });
});
