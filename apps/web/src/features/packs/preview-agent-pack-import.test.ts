import { describe, expect, it } from "vitest";

import { PreviewPackImportError, previewAgentPackImport } from "./preview-agent-pack-import";

const WORKSPACE_A = "19300000-0000-4000-8000-0000000000a1";
const WORKSPACE_B = "19300000-0000-4000-8000-0000000000b1";

/** The only tables a preview may read, and the only columns of each. */
const ALLOWED_READS: Record<string, string> = {
  agents: "name, role, model, thinking_effort, prompt, archived_at",
  skills: "name, version, body",
  capabilities: "key, tier, scope",
};

type Row = Record<string, unknown>;

interface Recorder {
  reads: { table: string; columns: string; filters: [string, unknown][] }[];
  /** Anything that is not a select: must stay empty. */
  writes: string[];
}

/**
 * A fake Supabase client that records every call. It supports exactly select/eq/order/range; insert, update,
 * upsert, delete and rpc exist only to be recorded as writes (and fail the test that sees one).
 */
function fakeClient(tables: Record<string, Row[]>, options: { failTable?: string } = {}) {
  const recorder: Recorder = { reads: [], writes: [] };
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let columns = "";
      const builder = {
        select(cols: string) {
          columns = cols;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order() {
          return builder;
        },
        range(from: number, to: number) {
          recorder.reads.push({ table, columns, filters });
          if (options.failTable === table) {
            return Promise.resolve({ data: null, error: { message: "boom" } });
          }
          const rows = (tables[table] ?? []).filter((row) =>
            filters.every(([column, value]) => row[column] === value),
          );
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
        insert() {
          recorder.writes.push(`${table}.insert`);
          return builder;
        },
        update() {
          recorder.writes.push(`${table}.update`);
          return builder;
        },
        upsert() {
          recorder.writes.push(`${table}.upsert`);
          return builder;
        },
        delete() {
          recorder.writes.push(`${table}.delete`);
          return builder;
        },
      };
      return builder;
    },
    rpc(name: string) {
      recorder.writes.push(`rpc.${name}`);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client: client as never, recorder };
}

function agentJson(overrides: Record<string, unknown> = {}) {
  return {
    name: "Scout",
    role: "Researcher",
    model: "claude-sonnet-5-5",
    thinkingEffort: "medium",
    prompt: "Find sources.",
    skills: ["Citing"],
    capabilities: [
      { name: "vault.read", scope: "workspace" },
      { name: "code.run", scope: "sandbox" },
    ],
    dailyBudgetCents: 500,
    autonomyMode: "strict",
    ...overrides,
  };
}

function packText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    packVersion: 1,
    metadata: { name: "Research team", exportedAt: "2026-11-13T00:00:00Z", appVersion: "0.1.0" },
    agents: [agentJson()],
    skills: [{ name: "Citing", version: 1, body: "Cite." }],
    ...overrides,
  });
}

const CATALOG_A = [
  { workspace_id: WORKSPACE_A, key: "vault.read", tier: 0, scope: "workspace" },
  { workspace_id: WORKSPACE_A, key: "code.run", tier: 3, scope: "sandbox" },
];

describe("previewAgentPackImport", () => {
  it("previews against the workspace and reads only three tables by named columns", async () => {
    const { client, recorder } = fakeClient({
      agents: [
        {
          workspace_id: WORKSPACE_A,
          name: "Scout",
          role: "Researcher",
          model: "claude-sonnet-5-5",
          thinking_effort: "medium",
          prompt: "An older prompt.",
          archived_at: null,
        },
      ],
      skills: [],
      capabilities: CATALOG_A,
    });
    const result = await previewAgentPackImport(client, {
      workspaceId: WORKSPACE_A,
      text: packText(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.agents[0]).toMatchObject({ action: "update", changedFields: ["prompt"] });
    expect(result.preview.skills[0]?.action).toBe("create");
    expect(result.preview.agents[0]?.capabilities.map((c) => [c.name, c.tier, c.status])).toEqual([
      ["vault.read", 0, "applied"],
      ["code.run", 3, "ignored"],
    ]);

    expect(recorder.reads.map((read) => read.table).sort()).toEqual([
      "agents",
      "capabilities",
      "skills",
    ]);
    for (const read of recorder.reads) {
      expect(read.columns).toBe(ALLOWED_READS[read.table]);
      expect(read.filters).toEqual([["workspace_id", WORKSPACE_A]]);
    }
    expect(recorder.writes).toEqual([]);
  });

  it("writes nothing: no insert, update, upsert, delete or rpc, for any outcome", async () => {
    for (const text of [packText(), "{ not json", packText({ agents: [] })]) {
      const { client, recorder } = fakeClient({ agents: [], skills: [], capabilities: CATALOG_A });
      await previewAgentPackImport(client, { workspaceId: WORKSPACE_A, text });
      expect(recorder.writes).toEqual([]);
    }
  });

  it("does no database work for a file that fails validation", async () => {
    const { client, recorder } = fakeClient({});
    const result = await previewAgentPackImport(client, {
      workspaceId: WORKSPACE_A,
      text: "{ not json",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_json" } });
    expect(recorder.reads).toEqual([]);
  });

  it("does not see another workspace's rows (every read is filtered by the workspace id)", async () => {
    const { client } = fakeClient({
      agents: [
        {
          workspace_id: WORKSPACE_B,
          name: "Scout",
          role: "Researcher",
          model: "claude-sonnet-5-5",
          thinking_effort: "medium",
          prompt: "Find sources.",
          archived_at: null,
        },
      ],
      skills: [{ workspace_id: WORKSPACE_B, name: "Citing", version: 4, body: "Cite." }],
      capabilities: [{ workspace_id: WORKSPACE_B, key: "vault.read", tier: 0, scope: "workspace" }],
    });
    const result = await previewAgentPackImport(client, {
      workspaceId: WORKSPACE_A,
      text: packText(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Workspace B's agent and skill are invisible: both are "create", and B's catalog is not used.
    expect(result.preview.agents[0]).toMatchObject({ action: "create", conflict: false });
    expect(result.preview.skills[0]).toMatchObject({ action: "create", conflict: false });
    expect(result.preview.agents[0]?.capabilities.every((c) => c.tier === null)).toBe(true);
  });

  it("reads a table larger than one page in pages", async () => {
    const many = Array.from({ length: 1500 }, (_, index) => ({
      workspace_id: WORKSPACE_A,
      name: `Skill ${String(index)}`,
      version: 1,
      body: "x",
    }));
    const { client, recorder } = fakeClient({ agents: [], skills: many, capabilities: CATALOG_A });
    const result = await previewAgentPackImport(client, {
      workspaceId: WORKSPACE_A,
      text: packText({
        skills: [{ name: "Skill 1400", version: 1, body: "x" }],
        agents: [agentJson({ skills: ["Skill 1400"], capabilities: [] })],
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.skills[0]).toMatchObject({ action: "skip", conflict: true });
    }
    expect(recorder.reads.filter((read) => read.table === "skills")).toHaveLength(2);
  });

  it("throws a generic error when a read fails, without the database's text", async () => {
    const { client } = fakeClient({ agents: [] }, { failTable: "skills" });
    const failure = previewAgentPackImport(client, { workspaceId: WORKSPACE_A, text: packText() });
    await expect(failure).rejects.toBeInstanceOf(PreviewPackImportError);
    await expect(failure).rejects.not.toThrow("boom");
  });
});
