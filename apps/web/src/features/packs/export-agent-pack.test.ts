import { agentPackSchema } from "@ago/shared";
import { verifyPackChecksum } from "@ago/shared/pack-export";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExportAgentPackError, exportAgentPack } from "./export-agent-pack";

const WORKSPACE_ID = "19200000-0000-4000-8000-0000000000a1";
const AGENT_A = "19200000-0000-4000-8000-0000000002a1";
const AGENT_B = "19200000-0000-4000-8000-0000000002a2";
const SKILL_1 = "19200000-0000-4000-8000-0000000003a1";
const SKILL_2 = "19200000-0000-4000-8000-0000000003a2";
const NOW = new Date("2026-11-14T10:00:00.000Z");

// Built at runtime so no credential-looking literal sits in the repo.
const FAKE_API_KEY = ["sk", "ant", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");

/** Tables the export may read. Anything else (credentials, identities, runs, budgets) is a leak path. */
const READABLE_TABLES = new Set([
  "agents",
  "agent_skills",
  "agent_capabilities",
  "skills",
  "capabilities",
]);

interface Rows {
  agents: Record<string, unknown>[];
  agent_skills: Record<string, unknown>[];
  agent_capabilities: Record<string, unknown>[];
  skills: Record<string, unknown>[];
  capabilities: Record<string, unknown>[];
}

interface Call {
  table: string;
  select: string;
  filters: [string, unknown][];
}

function agentRow(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    role: "Researcher",
    model: "claude-sonnet-5-5",
    thinking_effort: "medium",
    prompt: `You are ${name}.`,
    mode: "strict",
    daily_budget_cents: 300,
    archived_at: null,
    ...extra,
  };
}

function baseRows(): Rows {
  return {
    agents: [agentRow(AGENT_B, "Writer"), agentRow(AGENT_A, "Analyst")],
    agent_skills: [
      { agent_id: AGENT_A, skill_id: SKILL_1 },
      { agent_id: AGENT_B, skill_id: SKILL_1 },
    ],
    agent_capabilities: [
      { agent_id: AGENT_A, capability: "vault.write" },
      { agent_id: AGENT_A, capability: "vault.read" },
    ],
    // SKILL_2 exists in the workspace but no selected agent uses it.
    skills: [
      { id: SKILL_1, name: "summarize", version: 2, body: "Summarize the text." },
      { id: SKILL_2, name: "unused", version: 1, body: "Never used." },
    ],
    capabilities: [
      { key: "vault.read", scope: "workspace" },
      { key: "vault.write", scope: "workspace" },
    ],
  };
}

/** A fake Supabase client. It records every query, ignores filter values and returns the rows given. */
function fakeClient(rows: Rows, rpcResult: { data: unknown; error: { code: string } | null }) {
  const calls: Call[] = [];
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  const client = {
    from(table: string) {
      const call: Call = { table, select: "", filters: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          if (name === "select") call.select = String(args[0]);
          else call.filters.push([`${name}:${String(args[0])}`, args[1]]);
          return builder;
        };
      for (const name of ["select", "eq", "in", "is", "order"]) builder[name] = chain(name);
      builder.then = (resolve: (value: unknown) => unknown) => {
        const all = (
          (rows as unknown as Record<string, Record<string, unknown>[]>)[table] ?? []
        ).slice();
        // Honour the `in` and `is null` filters like the database would (eq on workspace_id is recorded only).
        const data = all.filter((row) =>
          call.filters.every(([key, value]) => {
            const [op, column = ""] = key.split(":");
            if (op === "in") return (value as unknown[]).includes(row[column]);
            if (op === "is") return row[column] === value;
            return true;
          }),
        );
        return Promise.resolve(resolve({ data, error: null }));
      };
      return builder;
    },
    rpc,
  };
  return { client: client as never, calls, rpc };
}

const OK_EVENT = { data: "19200000-0000-4000-8000-0000000017a1", error: null };

describe("exportAgentPack", () => {
  let rows: Rows;

  beforeEach(() => {
    rows = baseRows();
  });

  it("AC1: exports the selected agents and only the skills they use", async () => {
    const { client, calls } = fakeClient(rows, OK_EVENT);
    const exported = await exportAgentPack(client, {
      workspaceId: WORKSPACE_ID,
      agentIds: [AGENT_A, AGENT_B],
      now: NOW,
    });
    expect(exported.pack.agents.map((agent) => agent.name)).toEqual(["Analyst", "Writer"]);
    expect(exported.pack.skills.map((skill) => skill.name)).toEqual(["summarize"]);
    // The skill read asks for the used ids only, never the whole workspace library.
    const skillRead = calls.find((call) => call.table === "skills");
    expect(skillRead?.filters).toContainEqual(["in:id", [SKILL_1]]);
    expect(agentPackSchema.safeParse(JSON.parse(exported.json)).success).toBe(true);
  });

  it("AC3: capabilities leave as names and scopes only", async () => {
    const { client } = fakeClient(rows, OK_EVENT);
    const exported = await exportAgentPack(client, {
      workspaceId: WORKSPACE_ID,
      agentIds: [AGENT_A],
      now: NOW,
    });
    const analyst = exported.pack.agents[0];
    expect(analyst?.capabilities).toEqual([
      { name: "vault.read", scope: "workspace" },
      { name: "vault.write", scope: "workspace" },
    ]);
  });

  it("AC2: the file carries a checksum that verifies, and the same data gives the same bytes", async () => {
    const first = await exportAgentPack(fakeClient(rows, OK_EVENT).client, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    const second = await exportAgentPack(fakeClient(baseRows(), OK_EVENT).client, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    expect(verifyPackChecksum(first.pack)).toBe("valid");
    expect(second.json).toBe(first.json);
    expect(first.fileName).toBe(`agent-pack-${first.checksum.slice(0, 12)}.json`);
  });

  it("never puts ids or the workspace in the file", async () => {
    const exported = await exportAgentPack(fakeClient(rows, OK_EVENT).client, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
    });
    for (const id of [WORKSPACE_ID, AGENT_A, AGENT_B, SKILL_1, SKILL_2]) {
      expect(exported.json).not.toContain(id);
    }
  });

  it("AC4: logs the export before returning, with the agent ids and the checksum, and no pack content", async () => {
    const { client, rpc } = fakeClient(rows, OK_EVENT);
    const exported = await exportAgentPack(client, { workspaceId: WORKSPACE_ID, now: NOW });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_pack_export", {
      p_workspace_id: WORKSPACE_ID,
      p_agent_ids: [AGENT_B, AGENT_A],
      p_skill_count: 1,
      p_checksum: exported.checksum,
    });
    expect(exported.eventId).toBe(OK_EVENT.data);
    const payload = JSON.stringify(rpc.mock.calls);
    expect(payload).not.toContain("You are");
    expect(payload).not.toContain("Summarize the text.");
  });

  it("a failed event write means no file", async () => {
    const { client } = fakeClient(rows, { data: null, error: { code: "XX000" } });
    await expect(
      exportAgentPack(client, { workspaceId: WORKSPACE_ID, now: NOW }),
    ).rejects.toMatchObject({
      code: "failed",
    });
  });

  it("maps a database refusal for a viewer to forbidden", async () => {
    const { client } = fakeClient(rows, { data: null, error: { code: "42501" } });
    await expect(
      exportAgentPack(client, { workspaceId: WORKSPACE_ID, now: NOW }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("an agent that cannot be found fails the whole export with no partial pack and no event", async () => {
    rows.agents = [agentRow(AGENT_A, "Analyst")];
    const { client, rpc } = fakeClient(rows, OK_EVENT);
    await expect(
      exportAgentPack(client, {
        workspaceId: WORKSPACE_ID,
        agentIds: [AGENT_A, AGENT_B],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("treats a repeated agent id as one agent", async () => {
    rows.agents = [agentRow(AGENT_A, "Analyst")];
    const { client } = fakeClient(rows, OK_EVENT);
    const exported = await exportAgentPack(client, {
      workspaceId: WORKSPACE_ID,
      agentIds: [AGENT_A, AGENT_A],
      now: NOW,
    });
    expect(exported.pack.agents).toHaveLength(1);
  });

  it("answers no_agents when there is nothing to export", async () => {
    rows.agents = [];
    const { client, rpc } = fakeClient(rows, OK_EVENT);
    await expect(
      exportAgentPack(client, { workspaceId: WORKSPACE_ID, now: NOW }),
    ).rejects.toMatchObject({
      code: "no_agents",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("exports only active agents when none are named", async () => {
    const { client, calls } = fakeClient(rows, OK_EVENT);
    await exportAgentPack(client, { workspaceId: WORKSPACE_ID, now: NOW });
    expect(calls.find((call) => call.table === "agents")?.filters).toContainEqual([
      "is:archived_at",
      null,
    ]);
  });

  it("refuses a grant whose catalog row is gone instead of guessing a scope", async () => {
    rows.capabilities = [{ key: "vault.read", scope: "workspace" }];
    const { client, rpc } = fakeClient(rows, OK_EVENT);
    await expect(
      exportAgentPack(client, { workspaceId: WORKSPACE_ID, agentIds: [AGENT_A], now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_pack" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses to export when a credential-shaped value sits in a prompt or a skill, and logs nothing", async () => {
    for (const planted of [
      () => {
        rows.agents = [
          agentRow(AGENT_A, "Analyst", { prompt: `Use ${FAKE_API_KEY} to call the API.` }),
        ];
      },
      () => {
        rows.skills = [
          { id: SKILL_1, name: "summarize", version: 1, body: `Header: ${FAKE_API_KEY}` },
        ];
      },
    ]) {
      rows = baseRows();
      planted();
      const { client, rpc } = fakeClient(rows, OK_EVENT);
      const failure = await exportAgentPack(client, {
        workspaceId: WORKSPACE_ID,
        agentIds: [AGENT_A],
        now: NOW,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExportAgentPackError);
      expect((failure as ExportAgentPackError).code).toBe("invalid_pack");
      // The error carries a code only: not the value, not the row.
      expect((failure as Error).message).not.toContain(FAKE_API_KEY);
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("a planted credential in a column the export never selects cannot reach the file", async () => {
    const poisoned = {
      ...agentRow(AGENT_A, "Analyst"),
      token_hash: FAKE_API_KEY,
      run_limits: { key: FAKE_API_KEY },
    };
    rows.agents = [poisoned];
    const exported = await exportAgentPack(fakeClient(rows, OK_EVENT).client, {
      workspaceId: WORKSPACE_ID,
      agentIds: [AGENT_A],
      now: NOW,
    });
    expect(exported.json).not.toContain(FAKE_API_KEY);
  });

  it("reads only the five export tables, by named columns, always scoped to the workspace", async () => {
    const { client, calls } = fakeClient(rows, OK_EVENT);
    await exportAgentPack(client, { workspaceId: WORKSPACE_ID, now: NOW });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(READABLE_TABLES.has(call.table)).toBe(true);
      expect(call.select).not.toContain("*");
      expect(call.select.length).toBeGreaterThan(0);
      expect(call.filters).toContainEqual(["eq:workspace_id", WORKSPACE_ID]);
    }
  });
});
