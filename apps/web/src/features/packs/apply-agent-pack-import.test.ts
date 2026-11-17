import { describe, expect, it } from "vitest";

import { ApplyPackImportError, applyAgentPackImport } from "./apply-agent-pack-import";
import { previewAgentPackImport } from "./preview-agent-pack-import";

const WORKSPACE = "19400000-0000-4000-8000-0000000000a1";
const OTHER_WORKSPACE = "19400000-0000-4000-8000-0000000000b1";

type Row = Record<string, unknown>;

interface RpcCall {
  name: string;
  args: { p_workspace_id: string; p_checksum: string; p_plan: Record<string, unknown> };
}

/** A fake client: select/eq/order/range for the reading, and one recorded rpc. Any other write is recorded. */
function fakeClient(
  tables: Record<string, Row[]>,
  rpc: (call: RpcCall) => { data: unknown; error: { code?: string } | null },
) {
  const rpcCalls: RpcCall[] = [];
  const otherWrites: string[] = [];
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        range(from: number, to: number) {
          const rows = (tables[table] ?? []).filter((row) =>
            filters.every(([column, value]) => row[column] === value),
          );
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
        insert: () => otherWrites.push(`${table}.insert`),
        update: () => otherWrites.push(`${table}.update`),
        upsert: () => otherWrites.push(`${table}.upsert`),
        delete: () => otherWrites.push(`${table}.delete`),
      };
      return builder;
    },
    rpc(name: string, args: RpcCall["args"]) {
      const call = { name, args };
      rpcCalls.push(call);
      return Promise.resolve(rpc(call));
    },
  };
  return { client: client as never, rpcCalls, otherWrites };
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
    autonomyMode: "standard",
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

const CATALOG = [
  { workspace_id: WORKSPACE, key: "vault.read", tier: 0, scope: "workspace" },
  { workspace_id: WORKSPACE, key: "code.run", tier: 3, scope: "sandbox" },
  // Another workspace's catalog: never read for this one.
  { workspace_id: OTHER_WORKSPACE, key: "vault.read", tier: 0, scope: "workspace" },
];
const OK = () => ({ data: "00000000-0000-4000-8000-00000000e001", error: null });

describe("applyAgentPackImport", () => {
  it("applies the plan in ONE rpc, after reading, with the content checksum and no Tier 3 capability", async () => {
    const { client, rpcCalls, otherWrites } = fakeClient({ capabilities: CATALOG }, OK);
    const result = await applyAgentPackImport(client, { workspaceId: WORKSPACE, text: packText() });
    if (!result.ok || !("report" in result)) throw new Error("expected a report");
    expect(result.report).toMatchObject({
      applied: true,
      eventId: "00000000-0000-4000-8000-00000000e001",
      conflictRule: "skip",
      importable: true,
    });
    expect(otherWrites).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    const call = rpcCalls[0];
    expect(call?.name).toBe("import_agent_pack");
    expect(call?.args.p_workspace_id).toBe(WORKSPACE);
    expect(call?.args.p_checksum).toMatch(/^[0-9a-f]{64}$/);
    const plan = call?.args.p_plan as { agents: { capabilities: string[]; name: string }[] };
    expect(plan.agents[0]?.capabilities).toEqual(["vault.read"]);
  });

  it("reports exactly what the dry run with the same rule reports", async () => {
    const tables = { capabilities: CATALOG };
    const dry = await previewAgentPackImport(fakeClient(tables, OK).client, {
      workspaceId: WORKSPACE,
      text: packText(),
      conflictRule: "skip",
    });
    const { client } = fakeClient(tables, OK);
    const applied = await applyAgentPackImport(client, {
      workspaceId: WORKSPACE,
      text: packText(),
    });
    if (!dry.ok || !applied.ok || !("report" in applied)) throw new Error("expected both to pass");
    const { applied: _applied, eventId: _eventId, conflictRule: _rule, ...report } = applied.report;
    expect(report).toEqual(dry.preview);
  });

  it("never calls the database for a pack that is not valid", async () => {
    const { client, rpcCalls } = fakeClient({ capabilities: CATALOG }, OK);
    const result = await applyAgentPackImport(client, { workspaceId: WORKSPACE, text: "{nope" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_json" } });
    expect(rpcCalls).toEqual([]);
  });

  it("never calls the database for a blocked pack (a model off the allowlist)", async () => {
    const { client, rpcCalls } = fakeClient({ capabilities: CATALOG }, OK);
    const result = await applyAgentPackImport(client, {
      workspaceId: WORKSPACE,
      text: packText({ agents: [agentJson({ model: "not-a-real-model" })] }),
    });
    expect(result).toMatchObject({ ok: false, blocked: { importable: false } });
    expect(rpcCalls).toEqual([]);
  });

  it("sends an empty plan under skip when everything already exists, and still records the event", async () => {
    const { client, rpcCalls } = fakeClient(
      {
        capabilities: CATALOG,
        agents: [
          {
            workspace_id: WORKSPACE,
            name: "Scout",
            role: "x",
            model: "claude-sonnet-5-5",
            thinking_effort: "medium",
            prompt: "x",
            archived_at: null,
          },
        ],
        skills: [{ workspace_id: WORKSPACE, name: "Citing", version: 1, body: "Cite." }],
      },
      OK,
    );
    const result = await applyAgentPackImport(client, { workspaceId: WORKSPACE, text: packText() });
    expect(result.ok).toBe(true);
    expect(rpcCalls[0]?.args.p_plan).toMatchObject({ rule: "skip", agents: [], skills: [] });
  });

  it.each([
    ["42501", "forbidden"],
    ["23505", "stale"],
    ["40001", "stale"],
    ["22023", "invalid"],
    ["P0002", "invalid"],
    ["XX000", "failed"],
  ])("maps SQLSTATE %s to %s without repeating any database text", async (sqlstate, code) => {
    const { client } = fakeClient({ capabilities: CATALOG }, () => ({
      data: null,
      error: { code: sqlstate },
    }));
    const failure = await applyAgentPackImport(client, {
      workspaceId: WORKSPACE,
      text: packText(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplyPackImportError);
    expect((failure as ApplyPackImportError).code).toBe(code);
    expect((failure as ApplyPackImportError).message).not.toContain("Find sources");
  });

  it("fails when the database does not return an event id", async () => {
    const { client } = fakeClient({ capabilities: CATALOG }, () => ({ data: null, error: null }));
    await expect(
      applyAgentPackImport(client, { workspaceId: WORKSPACE, text: packText() }),
    ).rejects.toMatchObject({ code: "failed" });
  });
});
