// @vitest-environment node
// AGO-194 functional acceptance tests (tester-functional, round 2), live against the local Supabase stack. They cover
// the round-2 fixes: the action whitelist of the function, the trifecta lint on an update, hostile text (NUL, invalid
// UTF-16, direction and zero-width characters), rename truncation and budget forms. Real sign-in, real RLS, real
// `import_agent_pack`, the real apply and preview routes. Only the cookie-bound server client factory is swapped for
// the signed-in client of the person under test.
// It needs the shared stack, so it only runs with RUN_DB_TESTS=1 and inside the db lock:
//   RUN_DB_TESTS=1 pnpm --filter @ago/web exec vitest run src/features/packs/apply-agent-pack-import.acceptance2.live.test.ts
// Every scenario gets its own throwaway workspace; all of them are deleted in afterAll. Passwords and fake tokens are
// built at runtime. Hostile text is only ever compared by bytes or escaped, never printed.
import { execFile, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";
import { lintTrifecta } from "@ago/shared/trifecta-lint";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const routeClient = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("server-only", () => ({}));
vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve(routeClient.current),
}));

import { POST as applyRoute } from "../../app/api/agent-packs/import/route";
import { POST as previewRoute } from "../../app/api/agent-packs/import/preview/route";
import { applyAgentPackImport } from "./apply-agent-pack-import";

const run = promisify(execFile);
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_agent-office";
const enabled = process.env.RUN_DB_TESTS === "1";
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Loose = Record<string, unknown>;
type Client = SupabaseClient<Database>;
type Conflict = "skip" | "rename" | "new_version";

const PSQL_BASE = ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"];

async function psql(sql: string): Promise<string> {
  const { stdout } = await run("docker", [...PSQL_BASE, "-q", "-At", "-c", sql]);
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
const skillJson = (overrides: Loose = {}): Loose => ({
  name: "Cite",
  version: 1,
  body: "Cite sources.",
  ...overrides,
});
const packOf = (agents: Loose[], skills: Loose[] = [], extra: Loose = {}): string =>
  JSON.stringify({
    packVersion: 1,
    metadata: {
      name: "Acceptance pack 2",
      exportedAt: "2026-11-17T00:00:00Z",
      appVersion: "0.1.0",
    },
    agents,
    skills,
    ...extra,
  });

const capability = (name: string, scope = "workspace"): Loose => ({ name, scope });
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

/** Every string anywhere in a parsed JSON answer. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allStrings(item, out);
    }
  }
  return out;
}

// eslint-disable-next-line no-control-regex -- the point of the check
const REPORT_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex -- the point of the check
const FORMAT_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

const isWellFormed = (text: string): boolean => {
  try {
    encodeURIComponent(text); // throws on an unpaired surrogate
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!enabled)("AGO-194 acceptance, round 2 (live)", () => {
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
    const email = `ago194-acc2-owner-${randomUUID()}@example.test`;
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

  /** A throwaway workspace with the owner; `lowerTiers` lowers catalog tiers (a workspace can) so outbound legs survive. */
  async function makeWorkspace(lowerTiers: Record<string, number> = {}): Promise<string> {
    const id = randomUUID();
    workspaces.push(id);
    await psql(`
      insert into public.workspaces (id, name) values ('${id}', 'AGO-194 acc2');
      insert into public.members (workspace_id, user_id, role, removed_at) values ('${id}', '${owner.id}', 'owner', null)`);
    for (const [key, tier] of Object.entries(lowerTiers)) {
      await psql(
        `update public.capabilities set tier = ${String(tier)} where workspace_id = '${id}' and key = '${key}'`,
      );
    }
    return id;
  }

  async function seedAgent(
    ws: string,
    name: string,
    options: { role?: string; capabilities?: string[] } = {},
  ): Promise<string> {
    const id = randomUUID();
    await psql(`insert into public.agents (id, workspace_id, name, role, model, thinking_effort, prompt, daily_budget_cents)
      values ('${id}', '${ws}', '${name}', '${options.role ?? "Old role"}', 'claude-haiku-5-5', 'medium', 'Old prompt.', 100)`);
    for (const key of options.capabilities ?? []) {
      await psql(`insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
        select '${ws}', '${id}', c.key, c.tier, 'approval' from public.capabilities c where c.workspace_id = '${ws}' and c.key = '${key}'`);
    }
    return id;
  }

  const seedSkill = (ws: string, name: string, body: string): Promise<string> =>
    psql(
      `insert into public.skills (workspace_id, name, body) values ('${ws}', '${name}', '${body}')`,
    );

  /** One string that says whether anything was written. */
  const snapshot = (ws: string): Promise<string> =>
    psql(
      `select (select count(*) from public.agents where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.skills where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.agent_skills where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.agent_capabilities where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.skill_versions where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.agent_versions where workspace_id = '${ws}') || ':' ||
              (select count(*) from public.pack_events where workspace_id = '${ws}')`,
    );
  const agentRow = async (ws: string, name: string): Promise<Loose | undefined> =>
    (
      await rows(`select id, mode, role, daily_budget_cents, archived_at, char_length(name) as name_chars
                    from public.agents where workspace_id = '${ws}' and name = '${name}'`)
    )[0];
  const grants = async (ws: string, name: string): Promise<string[]> =>
    (
      await rows<{ capability: string }>(
        `select c.capability from public.agent_capabilities c join public.agents a on a.id = c.agent_id
          where a.workspace_id = '${ws}' and a.name = '${name}' order by c.capability`,
      )
    ).map((row) => row.capability);
  const lastEvent = async (ws: string) =>
    (
      await rows<{ agent_names: string[]; detail: { disabled: number; agents: Loose[] } }>(
        `select agent_names, detail from public.pack_events where workspace_id = '${ws}' and kind = 'import' order by created_at desc limit 1`,
      )
    )[0];

  // ---- entry points -------------------------------------------------------------------------------------------

  interface RouteAnswer {
    status: number;
    body: Loose;
  }

  function fakeRequest(
    path: string,
    ws: string,
    body: string | Uint8Array,
    options: { conflict?: string; rawQuery?: string } = {},
  ) {
    const headers = new Headers({ "content-type": "application/json" });
    const query =
      options.rawQuery ??
      `workspace_id=${ws}${options.conflict ? `&conflict=${options.conflict}` : ""}`;
    return {
      headers,
      nextUrl: { pathname: path, searchParams: new URLSearchParams(query) },
      body: new Response(body as unknown as BodyInit).body,
    } as unknown as Parameters<typeof applyRoute>[0];
  }

  async function answer(response: Response): Promise<RouteAnswer> {
    return { status: response.status, body: (await response.json()) as Loose };
  }

  async function callApply(
    ws: string,
    body: string | Uint8Array,
    options: Parameters<typeof fakeRequest>[3] = {},
  ): Promise<RouteAnswer> {
    routeClient.current = ownerClient;
    return answer(await applyRoute(fakeRequest("/api/agent-packs/import", ws, body, options)));
  }

  async function callPreview(
    ws: string,
    body: string | Uint8Array,
    options: Parameters<typeof fakeRequest>[3] = {},
  ): Promise<RouteAnswer> {
    routeClient.current = ownerClient;
    return answer(
      await previewRoute(fakeRequest("/api/agent-packs/import/preview", ws, body, options)),
    );
  }

  const applyOk = async (ws: string, text: string, conflictRule?: Conflict) => {
    const result = await applyAgentPackImport(ownerClient, { workspaceId: ws, text, conflictRule });
    if (!result.ok || !("report" in result)) throw new Error("expected the import to apply");
    return result.report as unknown as Loose & {
      eventId: string;
      summary: { disabled: number };
      agents: { action: string; targetName: string; importDisabled: { reason: string } | null }[];
      ignored: { reason: string; agent?: string; item: string }[];
    };
  };

  /** The crafted-call path: a signed-in client calling the function with a plan the TypeScript never built. */
  const rpcImport = (ws: string, plan: unknown) =>
    (
      ownerClient as unknown as {
        rpc(
          name: string,
          args: Record<string, unknown>,
        ): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
      }
    ).rpc("import_agent_pack", { p_workspace_id: ws, p_checksum: "a".repeat(64), p_plan: plan });

  /** The same call with the plan as RAW JSON text (number forms the JS client cannot send), as the owner, in psql. */
  const rawImport = (ws: string, planJson: string): Promise<string> =>
    psqlError(`begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${owner.id}","role":"authenticated"}', true);
      select public.import_agent_pack('${ws}', '${"a".repeat(64)}', $plan$${planJson}$plan$::jsonb);
      commit;`);

  // ==============================================================================================================
  describe("AC2/AC5: the function accepts only an explicit action from its whitelist, for agent and skill entries", () => {
    const BAD_ACTIONS: [string, (entry: Loose) => Loose][] = [
      ["missing", (entry) => without(entry, "action")],
      ["null", (entry) => ({ ...entry, action: null })],
      ["an empty string", (entry) => ({ ...entry, action: "" })],
      ["an unknown word", (entry) => ({ ...entry, action: "delete" })],
      ["a different case", (entry) => ({ ...entry, action: "CREATE" })],
      ["a value with a leading space", (entry) => ({ ...entry, action: " create" })],
      ["a value with a trailing space", (entry) => ({ ...entry, action: "create " })],
      ["a number", (entry) => ({ ...entry, action: 1 })],
      ["zero", (entry) => ({ ...entry, action: 0 })],
      ["a boolean", (entry) => ({ ...entry, action: true })],
      ["an object", (entry) => ({ ...entry, action: { create: true } })],
      ["an empty object", (entry) => ({ ...entry, action: {} })],
      ["an array holding the word", (entry) => ({ ...entry, action: ["create"] })],
      ["an empty array", (entry) => ({ ...entry, action: [] })],
    ];

    for (const [label, mutate] of BAD_ACTIONS) {
      it(`refuses an agent entry whose action is ${label} with 22023 and writes nothing, even when an earlier entry is fine`, async () => {
        const ws = await makeWorkspace();
        await seedAgent(ws, "Existing", { role: "Old role" });
        const before = await snapshot(ws);
        const { error } = await rpcImport(
          ws,
          planOf([
            planAgent({ name: "FirstFine" }),
            mutate(planAgent({ name: "Existing", role: "Hijacked" })),
          ]),
        );
        expect(error?.code).toBe("22023");
        expect(await snapshot(ws)).toBe(before);
        expect((await agentRow(ws, "Existing"))?.role).toBe("Old role");
        expect(await agentRow(ws, "FirstFine")).toBeUndefined();
      });

      it(`refuses a skill entry whose action is ${label} with 22023 and writes nothing, even when an earlier entry is fine`, async () => {
        const ws = await makeWorkspace();
        await seedSkill(ws, "Existing", "Old body.");
        const before = await snapshot(ws);
        const { error } = await rpcImport(
          ws,
          planOf(
            [],
            [
              planSkill({ name: "FirstFine" }),
              mutate(planSkill({ name: "Existing", action: "new_version", body: "Hijacked" })),
            ],
          ),
        );
        expect(error?.code).toBe("22023");
        expect(await snapshot(ws)).toBe(before);
        expect(
          await psql(
            `select body from public.skills where workspace_id = '${ws}' and name = 'Existing'`,
          ),
        ).toBe("Old body.");
      });
    }

    it("refuses an action that belongs to the other kind of entry (an agent skipping, a skill updating)", async () => {
      const ws = await makeWorkspace();
      const before = await snapshot(ws);
      for (const action of ["new_version", "skip", "rename", "UPDATE"]) {
        const { error } = await rpcImport(ws, planOf([planAgent({ action })]));
        expect(error?.code, `agent action ${action}`).toBe("22023");
      }
      for (const action of ["update", "skip", "rename"]) {
        const { error } = await rpcImport(ws, planOf([], [planSkill({ action })]));
        expect(error?.code, `skill action ${action}`).toBe("22023");
      }
      expect(await snapshot(ws)).toBe(before);
    });

    it("refuses an action with an embedded NUL without a server error and writes nothing", async () => {
      const ws = await makeWorkspace();
      const before = await snapshot(ws);
      const { error } = await rpcImport(ws, planOf([planAgent({ action: "create\u0000" })]));
      expect(error).not.toBeNull();
      expect(["22023", "22P05", "22032", "22P02"]).toContain(error?.code);
      expect(await snapshot(ws)).toBe(before);
    });

    it("still accepts the four valid actions (create and update for agents, create and new_version for skills)", async () => {
      const ws = await makeWorkspace();
      await seedAgent(ws, "Existing", { role: "Old role" });
      await seedSkill(ws, "ExistingSkill", "Old body.");
      const { error } = await rpcImport(
        ws,
        planOf(
          [
            planAgent({ name: "Brand new", action: "create" }),
            planAgent({ name: "Existing", action: "update", role: "Updated role" }),
          ],
          [
            planSkill({ name: "NewSkill", action: "create" }),
            planSkill({ name: "ExistingSkill", action: "new_version", body: "New body." }),
          ],
        ),
      );
      expect(error).toBeNull();
      expect((await agentRow(ws, "Existing"))?.role).toBe("Updated role");
      expect(
        await psql(
          `select version from public.skills where workspace_id = '${ws}' and name = 'ExistingSkill'`,
        ),
      ).toBe("2");
    });
  });

  // ==============================================================================================================
  describe("AC3: the trifecta lint judges what an agent will hold, so an update cannot complete it silently", () => {
    it("disables an existing agent whose update completes the trifecta (new_version), and reports it in the report, the dry run and the event", async () => {
      const ws = await makeWorkspace({ "message.send_outbound": 2 });
      await seedAgent(ws, "Courier", { capabilities: ["message.send_outbound"] });
      const pack = packOf([
        agentJson({
          name: "Courier",
          role: "Updated courier",
          capabilities: [capability("web.search", "external"), capability("vault.read")],
        }),
      ]);
      const preview = await callPreview(ws, pack, { conflict: "new_version" });
      expect(preview.status).toBe(200);
      const report = await applyOk(ws, pack, "new_version");
      expect(report.agents[0]).toMatchObject({
        action: "update",
        importDisabled: { reason: "trifecta_combination" },
      });
      expect(report.summary.disabled).toBe(1);
      expect((preview.body.agents as Loose[])[0]?.importDisabled).toEqual(
        report.agents[0]!.importDisabled,
      );
      const row = await agentRow(ws, "Courier");
      expect(row?.archived_at).not.toBeNull();
      expect(row?.mode).toBe("strict");
      expect(row?.role).toBe("Updated courier");
      expect(await grants(ws, "Courier")).toEqual([
        "message.send_outbound",
        "vault.read",
        "web.search",
      ]);
      const event = await lastEvent(ws);
      expect(event?.detail.disabled).toBe(1);
      expect(event?.detail.agents).toEqual([
        { name: "Courier", action: "update", disabled_reason: "trifecta_combination" },
      ]);
    });

    it("disables an existing agent that already holds two legs when the pack brings the third", async () => {
      const ws = await makeWorkspace({ "message.send_outbound": 2 });
      await seedAgent(ws, "Researcher", { capabilities: ["web.search", "vault.read"] });
      const report = await applyOk(
        ws,
        packOf([
          agentJson({
            name: "Researcher",
            capabilities: [capability("message.send_outbound", "external")],
          }),
        ]),
        "new_version",
      );
      expect(report.agents[0]!.importDisabled).toMatchObject({ reason: "trifecta_combination" });
      expect((await agentRow(ws, "Researcher"))?.archived_at).not.toBeNull();
      expect(lintTrifecta(await grants(ws, "Researcher")).ok).toBe(false);
    });

    it("disables the agent through the integration and browse legs too, not only the three keys of the first test", async () => {
      const ws = await makeWorkspace({ "integration.write": 2, "web.browse": 2 });
      await seedAgent(ws, "Syncer", { capabilities: ["integration.write", "vault.read"] });
      const report = await applyOk(
        ws,
        packOf([
          agentJson({ name: "Syncer", capabilities: [capability("web.browse", "external")] }),
        ]),
        "new_version",
      );
      expect(report.agents[0]!.importDisabled).toMatchObject({ reason: "trifecta_combination" });
      expect((await agentRow(ws, "Syncer"))?.archived_at).not.toBeNull();
    });

    it("leaves an existing agent with two legs active when the pack brings a harmless capability", async () => {
      const ws = await makeWorkspace({ "message.send_outbound": 2 });
      await seedAgent(ws, "Researcher", { capabilities: ["web.search", "vault.read"] });
      const report = await applyOk(
        ws,
        packOf([agentJson({ name: "Researcher", capabilities: [capability("tasks.manage")] })]),
        "new_version",
      );
      expect(report.agents[0]!.importDisabled).toBeNull();
      expect(report.summary.disabled).toBe(0);
      expect((await agentRow(ws, "Researcher"))?.archived_at).toBeNull();
    });

    it("leaves the agent active when the third leg is Tier 3 and is dropped, so the union stays clean", async () => {
      const ws = await makeWorkspace(); // starter tiers: message.send_outbound is Tier 3
      await seedAgent(ws, "Researcher", { capabilities: ["web.search", "vault.read"] });
      const report = await applyOk(
        ws,
        packOf([
          agentJson({
            name: "Researcher",
            capabilities: [capability("message.send_outbound", "external")],
          }),
        ]),
        "new_version",
      );
      expect(report.agents[0]!.importDisabled).toBeNull();
      expect((await agentRow(ws, "Researcher"))?.archived_at).toBeNull();
      expect(await grants(ws, "Researcher")).toEqual(["vault.read", "web.search"]);
    });

    it("does not touch or disable the existing agent under skip, and a rename leaves it alone and judges only the copy", async () => {
      const ws = await makeWorkspace({ "message.send_outbound": 2 });
      await seedAgent(ws, "Courier", { capabilities: ["message.send_outbound"] });
      const pack = packOf([
        agentJson({
          name: "Courier",
          capabilities: [capability("web.search", "external"), capability("vault.read")],
        }),
      ]);
      const skipped = await applyOk(ws, pack, "skip");
      expect(skipped.agents[0]!.action).toBe("skip");
      expect((await agentRow(ws, "Courier"))?.archived_at).toBeNull();
      expect((await agentRow(ws, "Courier"))?.role).toBe("Old role");

      const renamed = await applyOk(ws, pack, "rename");
      expect(renamed.agents[0]!.targetName).toBe("Courier (imported)");
      expect(renamed.agents[0]!.importDisabled).toBeNull();
      expect((await agentRow(ws, "Courier"))?.archived_at).toBeNull();
      expect(await grants(ws, "Courier")).toEqual(["message.send_outbound"]);
      expect((await agentRow(ws, "Courier (imported)"))?.archived_at).toBeNull();
    });

    it("recomputes the trifecta in the function for a crafted update whose plan claims no reason", async () => {
      const ws = await makeWorkspace({ "message.send_outbound": 2 });
      await seedAgent(ws, "Courier", { capabilities: ["message.send_outbound"] });
      const { error } = await rpcImport(
        ws,
        planOf(
          [
            planAgent({
              name: "Courier",
              action: "update",
              capabilities: ["web.search", "vault.read"],
              disabled_reason: null,
            }),
          ],
          [],
          "new_version",
        ),
      );
      expect(error).toBeNull();
      expect((await agentRow(ws, "Courier"))?.archived_at).not.toBeNull();
      const event = await lastEvent(ws);
      expect(event?.detail.agents[0]).toMatchObject({ disabled_reason: "trifecta_combination" });
      expect(event?.detail.disabled).toBe(1);
    });

    it("recomputes the trifecta in the function for a crafted create that claims no reason", async () => {
      const ws = await makeWorkspace({ "message.send_outbound": 2 });
      const { error } = await rpcImport(
        ws,
        planOf([
          planAgent({
            name: "Sneaky",
            capabilities: ["web.search", "vault.read", "message.send_outbound"],
            disabled_reason: null,
          }),
        ]),
      );
      expect(error).toBeNull();
      expect((await agentRow(ws, "Sneaky"))?.archived_at).not.toBeNull();
    });

    it("keeps a reason the plan supplies even when the function sees no trifecta", async () => {
      const ws = await makeWorkspace();
      const { error } = await rpcImport(
        ws,
        planOf([planAgent({ name: "Flagged", disabled_reason: "trifecta_combination" })]),
      );
      expect(error).toBeNull();
      expect((await agentRow(ws, "Flagged"))?.archived_at).not.toBeNull();
    });

    it("lets a planned update on an archived or missing agent fail as stale (409) and write nothing", async () => {
      const ws = await makeWorkspace();
      const before = await snapshot(ws);
      const { error } = await rpcImport(
        ws,
        planOf([planAgent({ name: "Nobody", action: "update" })], [], "new_version"),
      );
      expect(error?.code).toBe("40001");
      expect(await snapshot(ws)).toBe(before);
    });
  });

  // ==============================================================================================================
  describe("AC5 hostile text: NUL and invalid UTF-16 are a clean 422 naming the field, nothing written, text never echoed", () => {
    const MARK = "MARKER-HOSTILE-LIVE";
    const DIRTY: [string, string][] = [
      ["a NUL", `${MARK}\u0000tail`],
      ["a lone high surrogate", `${MARK}\ud800tail`],
      ["a lone low surrogate", `${MARK}\udc00tail`],
      ["a reversed surrogate pair", `${MARK}\udc00\ud800tail`],
    ];
    // Each: where the bad text goes, and the path the 422 must name. Departments, notes and secret refs are never
    // stored, but the file is one unit and is refused whole.
    const PLACES: [string, (dirty: string) => string][] = [
      ["agents.0.name", (d) => packOf([agentJson({ name: d })])],
      ["agents.0.role", (d) => packOf([agentJson({ role: d })])],
      ["agents.0.prompt", (d) => packOf([agentJson({ prompt: d })])],
      ["agents.0.model", (d) => packOf([agentJson({ model: d })])],
      ["agents.0.department", (d) => packOf([agentJson({ department: d })])],
      ["agents.0.skills.0", (d) => packOf([agentJson({ skills: [d] })])],
      ["agents.0.secretRefs.0", (d) => packOf([agentJson({ secretRefs: [d] })])],
      ["skills.0.name", (d) => packOf([agentJson()], [skillJson({ name: d })])],
      ["skills.0.body", (d) => packOf([agentJson()], [skillJson({ body: d })])],
      ["notes.0.title", (d) => packOf([agentJson()], [], { notes: [{ title: d, body: "n" }] })],
      ["notes.0.body", (d) => packOf([agentJson()], [], { notes: [{ title: "n", body: d }] })],
    ];

    for (const [path, build] of PLACES) {
      it(`answers bad text in ${path} with 422 invalid_pack on both routes, names the path, never repeats the text and writes nothing`, async () => {
        const ws = await makeWorkspace();
        const before = await snapshot(ws);
        for (const [label, dirty] of DIRTY) {
          for (const call of [callApply, callPreview]) {
            const { status, body } = await call(ws, build(dirty));
            expect(status, `${label} in ${path}`).toBe(422);
            expect(body.error).toBe("invalid_pack");
            const issues = body.issues as { path: string; message: string }[];
            expect(issues.map((issue) => issue.path)).toEqual([path]);
            expect(issues[0]!.message).toMatch(/NUL character or an invalid Unicode/);
            const text = JSON.stringify(body);
            expect(text).not.toContain(MARK);
            expect(text).not.toContain("tail");
          }
        }
        expect(await snapshot(ws)).toBe(before);
      });
    }

    it("answers bad text in the pack metadata and in a field name with 422 and writes nothing", async () => {
      const ws = await makeWorkspace();
      const before = await snapshot(ws);
      const meta = JSON.parse(packOf([agentJson()])) as Loose;
      (meta.metadata as Loose).name = "a\u0000b";
      const keyed = JSON.parse(packOf([agentJson()])) as Loose;
      (keyed.agents as Loose[])[0]!["bad\u0000key"] = 1;
      const keyedSurrogate = JSON.parse(packOf([agentJson()])) as Loose;
      keyedSurrogate["bad\ud800key"] = 1;
      for (const pack of [meta, keyed, keyedSurrogate]) {
        const { status, body } = await callApply(ws, JSON.stringify(pack));
        expect(status).toBe(422);
        expect(body.error).toBe("invalid_pack");
        expect(JSON.stringify(body)).not.toContain("\u0000");
      }
      expect(await snapshot(ws)).toBe(before);
    });

    it("answers bad text in the conflict or workspace query with a 4xx, never a 500", async () => {
      const ws = await makeWorkspace();
      const before = await snapshot(ws);
      for (const rawQuery of [
        `workspace_id=${ws}&conflict=skip%00`,
        `workspace_id=${ws}%00&conflict=skip`,
        `workspace_id=${ws}&conflict=%ED%A0%80`,
      ]) {
        const { status } = await callApply(ws, packOf([agentJson()]), { rawQuery });
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(500);
      }
      expect(await snapshot(ws)).toBe(before);
    });

    it("answers a body with invalid UTF-8 bytes without a server error", async () => {
      const ws = await makeWorkspace();
      const [head, tail] = packOf([agentJson({ prompt: "BYTES" })]).split("BYTES");
      // 0xff and 0xfe are never valid in UTF-8, and 0xc3 starts a sequence that never finishes.
      const body = Buffer.concat([
        Buffer.from(head!, "utf8"),
        Buffer.from([0xff, 0xfe, 0xc3]),
        Buffer.from(tail!, "utf8"),
      ]);
      const { status } = await callApply(ws, new Uint8Array(body));
      expect(status).toBeLessThan(500);
    });

    it("keeps accepting a valid emoji and other control characters as stored data", async () => {
      const ws = await makeWorkspace();
      const { status } = await callApply(
        ws,
        packOf([agentJson({ name: "Emoji 😀", prompt: "Find \u202e sources \u200b 😀\t" })]),
      );
      expect(status).toBe(200);
      expect(await agentRow(ws, "Emoji 😀")).toBeDefined();
    });
  });

  // ==============================================================================================================
  describe("AC4 rename truncation: the stored copy is well formed and within 120 characters after a cut near an emoji, a ZWJ sequence or a combining mark", () => {
    const ZWJ = String.fromCharCode(0x200d);
    const ZWJ_FAMILY = ["👨", "👩", "👧", "👦"].join(ZWJ); // 11 UTF-16 units, 7 code points, 1 grapheme
    const ACUTE = String.fromCharCode(0x301);

    /** What the rename stored: every agent name except the seeded one, read back as hex so no client encoding is involved. */
    const storedCopies = async (ws: string, seeded: string): Promise<string[]> =>
      (
        await rows<{ hex: string }>(
          `select encode(convert_to(name, 'UTF8'), 'hex') as hex from public.agents
            where workspace_id = '${ws}' and name <> '${seeded}' order by created_at, name`,
        )
      ).map((row) => Buffer.from(row.hex, "hex").toString("utf8"));

    it("renames a 120-unit name whose cut falls inside an emoji into a stored, well-formed copy within 120 characters", async () => {
      const ws = await makeWorkspace();
      const name = `${"a".repeat(108)}😀bb`; // budget for the copy is 109 units: a unit cut lands inside the emoji
      await seedAgent(ws, name);
      await applyOk(ws, packOf([agentJson({ name })]), "rename");
      const [copy, ...others] = await storedCopies(ws, name);
      expect(others).toEqual([]);
      expect(isWellFormed(copy!)).toBe(true);
      expect(copy!.length).toBeLessThanOrEqual(120);
      expect(copy!.endsWith(" (imported)")).toBe(true);
    });

    it("renames a name that ends in a ZWJ sequence into well-formed copies that count up on repeated renames", async () => {
      const ws = await makeWorkspace();
      const name = `${"a".repeat(100)}${ZWJ_FAMILY}`;
      await seedAgent(ws, name);
      for (let index = 0; index < 3; index += 1) {
        await applyOk(ws, packOf([agentJson({ name })]), "rename");
      }
      const copies = await storedCopies(ws, name);
      expect(copies).toHaveLength(3);
      expect(new Set(copies).size).toBe(3);
      for (const copy of copies) {
        expect(isWellFormed(copy)).toBe(true);
        expect(copy.length).toBeLessThanOrEqual(120);
      }
      expect(copies.map((copy) => /\(imported( \d+)?\)$/.exec(copy)?.[0]).sort()).toEqual([
        "(imported 2)",
        "(imported 3)",
        "(imported)",
      ]);
    });

    it("renames a name that ends in a combining mark into a well-formed copy", async () => {
      const ws = await makeWorkspace();
      const name = `${"a".repeat(108)}e${ACUTE}`;
      await seedAgent(ws, name);
      await applyOk(ws, packOf([agentJson({ name })]), "rename");
      const [copy] = await storedCopies(ws, name);
      expect(isWellFormed(copy!)).toBe(true);
      expect(copy!.length).toBeLessThanOrEqual(120);
    });
  });

  // ==============================================================================================================
  describe("AC5 event and report: direction, zero-width and control characters are cleaned from what the import records", () => {
    const CASES: [string, string, string][] = [
      ["a right-to-left override", "Ev\u202eil", "Evil"],
      ["zero-width characters", "Zw\u200bsp\u200c\u200d", "Zwsp"],
      ["C0, DEL and C1 controls", "Ctl\u0001\u001f\u007f\u0085\u009fX", "CtlX"],
      ["line and paragraph separators", "Sep\u2028\u2029Y", "SepY"],
      ["direction marks", "Mark\u200e\u200fZ", "MarkZ"],
      ["embeddings and isolates", "Emb\u202a\u202b\u202c\u202d\u2066\u2067\u2068\u2069Q", "EmbQ"],
      ["word joiner and BOM", "Word\u2060\ufeffJ", "WordJ"],
    ];

    for (const [label, raw, clean] of CASES) {
      it(`records the name without ${label} in the event and keeps it out of the report, while the agent row keeps the name as given`, async () => {
        const ws = await makeWorkspace();
        const logged: string[] = [];
        const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
          vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
            logged.push(args.map(String).join(" "));
          }),
        );
        let report: Awaited<ReturnType<typeof applyOk>>;
        try {
          report = await applyOk(ws, packOf([agentJson({ name: raw })]));
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
        const event = await lastEvent(ws);
        expect(event?.agent_names).toEqual([clean]);
        expect(event?.detail.agents.map((agent) => agent.name)).toEqual([clean]);
        expect(allStrings(report).filter((text) => REPORT_CHARS.test(text))).toEqual([]);
        expect(logged.filter((text) => FORMAT_CHARS.test(text))).toEqual([]);
        expect(await agentRow(ws, raw)).toBeDefined();
      });
    }

    it("records a ? for a name made only of invisible characters, so the event never holds an empty name", async () => {
      const ws = await makeWorkspace();
      await applyOk(ws, packOf([agentJson({ name: "\u200b\u200d" })]));
      expect((await lastEvent(ws))?.agent_names).toEqual(["?"]);
    });

    it("records the Arabic letter mark, which is a bidi control, without the mark", async () => {
      const ws = await makeWorkspace();
      await applyOk(ws, packOf([agentJson({ name: "Alm\u061cName" })]));
      expect((await lastEvent(ws))?.agent_names).toEqual(["AlmName"]);
    });

    it("cuts a 120-character name in the event to 120 characters and keeps the full name on the agent", async () => {
      const ws = await makeWorkspace();
      const name = `${"n".repeat(100)}\u202e${"m".repeat(19)}`; // 120 units including the override
      await applyOk(ws, packOf([agentJson({ name })]));
      const event = await lastEvent(ws);
      expect(event?.agent_names).toEqual([`${"n".repeat(100)}${"m".repeat(19)}`]);
    });
  });

  // ==============================================================================================================
  describe("AC2 budgets: a bad number is a clean refusal (422 or 22023), never a server error", () => {
    const BAD_ROUTE_BUDGETS: [string, string][] = [
      ["a fraction", "1.5"],
      ["a tiny fraction", "0.1"],
      ["a negative", "-5"],
      ["negative zero", "-0"],
      ["zero", "0"],
      ["a string", '"500"'],
      ["a numeric string", '"1e2"'],
      ["null", "null"],
      ["a boolean", "true"],
      ["an array", "[500]"],
      ["an object", '{"cents":500}'],
      ["an exponent past the number range", "1e400"],
      ["a huge exponent", "1E+99"],
      ["a negative exponent", "5e-1"],
      ["a huge integer", "99999999999999999999"],
      ["one past the pack maximum", "100000001"],
    ];
    for (const [label, literal] of BAD_ROUTE_BUDGETS) {
      it(`answers a pack budget that is ${label} with 422 invalid_pack and writes nothing`, async () => {
        const ws = await makeWorkspace();
        const before = await snapshot(ws);
        const text = packOf([agentJson({ dailyBudgetCents: "BUDGET" })]).replace(
          '"BUDGET"',
          literal,
        );
        for (const call of [callApply, callPreview]) {
          const { status, body } = await call(ws, text);
          expect(status).toBe(422);
          expect(body.error).toBe("invalid_pack");
        }
        expect(await snapshot(ws)).toBe(before);
      });
    }

    it("reads an exponent form that is a whole number as that number: 1e2 stores 100, 5e3 stores 5000 and 1e8 is capped at 500", async () => {
      const ws = await makeWorkspace();
      for (const [name, literal] of [
        ["E2", "1e2"],
        ["E3", "5e3"],
        ["E8", "1e8"],
        ["Plus", "1E+2"],
        ["Dot", "1.0e2"],
      ] as const) {
        const text = packOf([agentJson({ name, dailyBudgetCents: "BUDGET" })]).replace(
          '"BUDGET"',
          literal,
        );
        const { status } = await callApply(ws, text);
        expect(status, literal).toBe(200);
      }
      expect((await agentRow(ws, "E2"))?.daily_budget_cents).toBe(100);
      expect((await agentRow(ws, "E3"))?.daily_budget_cents).toBe(5000);
      expect((await agentRow(ws, "E8"))?.daily_budget_cents).toBe(500);
      expect((await agentRow(ws, "Plus"))?.daily_budget_cents).toBe(100);
      expect((await agentRow(ws, "Dot"))?.daily_budget_cents).toBe(100);
    });

    const BAD_RPC_BUDGETS: [string, unknown][] = [
      ["a fraction", 1.5],
      ["a negative", -1],
      ["zero", 0],
      ["above the cap", 5001],
      ["a huge integer", 10_000_000_000],
      ["a string", "100"],
      ["null", null],
      ["a boolean", true],
      ["an array", [100]],
      ["an object", { cents: 100 }],
    ];
    for (const [label, value] of BAD_RPC_BUDGETS) {
      it(`refuses a crafted plan whose budget is ${label} with 22023 and writes nothing`, async () => {
        const ws = await makeWorkspace();
        const before = await snapshot(ws);
        const { error } = await rpcImport(ws, planOf([planAgent({ daily_budget_cents: value })]));
        expect(error?.code).toBe("22023");
        expect(await snapshot(ws)).toBe(before);
      });
    }

    it("refuses a crafted plan with a missing budget with 22023", async () => {
      const ws = await makeWorkspace();
      const { error } = await rpcImport(ws, planOf([without(planAgent(), "daily_budget_cents")]));
      expect(error?.code).toBe("22023");
    });

    const BAD_RAW_BUDGETS = ["5.0", "100.00", "1e400", "5e-1", "-0", "0e0", "1e4", "1E+4"];
    for (const literal of BAD_RAW_BUDGETS) {
      it(`refuses the raw JSON budget ${literal} with 22023, not a cast error, and writes nothing`, async () => {
        const ws = await makeWorkspace();
        const before = await snapshot(ws);
        const plan = JSON.stringify(planOf([planAgent({ daily_budget_cents: "BUDGET" })])).replace(
          '"BUDGET"',
          literal,
        );
        const failure = await rawImport(ws, plan);
        expect(failure).toContain("22023");
        expect(await snapshot(ws)).toBe(before);
      });
    }

    it("accepts the raw JSON budgets 1e2 and 1e0 as the whole numbers 100 and 1, the bounds 1 and 5000 included", async () => {
      const ws = await makeWorkspace();
      for (const [name, literal] of [
        ["R100", "1e2"],
        ["R1", "1e0"],
        ["R5000", "5000"],
        ["R1b", "1"],
      ] as const) {
        const plan = JSON.stringify(
          planOf([planAgent({ name, daily_budget_cents: "BUDGET" })]),
        ).replace('"BUDGET"', literal);
        expect(await rawImport(ws, plan), literal).toBe("");
      }
      expect((await agentRow(ws, "R100"))?.daily_budget_cents).toBe(100);
      expect((await agentRow(ws, "R1"))?.daily_budget_cents).toBe(1);
      expect((await agentRow(ws, "R5000"))?.daily_budget_cents).toBe(5000);
    });
  });
});
