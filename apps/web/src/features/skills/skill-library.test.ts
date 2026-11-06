import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requireWorkspaceRole = vi.fn();
vi.mock("../workspaces/workspace-access", () => ({
  requireWorkspaceRole: (...args: unknown[]) => requireWorkspaceRole(...args) as unknown,
}));

interface DbResult {
  data: unknown;
  error: { code?: string } | null;
}
/** Results handed out per table, in call order. */
const results: Record<string, DbResult[]> = {};
const calls: { table: string; method: string; args: unknown[] }[] = [];

function chainFor(table: string) {
  const next = () => Promise.resolve(results[table]?.shift() ?? { data: null, error: null });
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "insert", "update", "delete", "eq", "is", "order"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ table, method, args });
      return chain;
    };
  }
  chain.single = next;
  chain.maybeSingle = next;
  chain.then = (resolve: (value: DbResult) => unknown, reject: (reason: unknown) => unknown) =>
    next().then(resolve, reject);
  return chain;
}
vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ from: (table: string) => chainFor(table) }),
}));

import {
  assignSkill,
  createSkill,
  getSkillDetail,
  listSkills,
  saveSkill,
  SkillLibraryError,
  unassignSkill,
} from "./skill-library";

const WS = "12800000-0000-4000-8000-0000000000a1";
const SKILL = "12800000-0000-4000-8000-0000000003a1";
const AGENT = "12800000-0000-4000-8000-0000000002a1";

function skillRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SKILL,
    workspace_id: WS,
    name: "research",
    description: "d",
    body: "# hi",
    version: 2,
    created_at: "2026-11-06T00:00:00+00:00",
    updated_at: "2026-11-06T00:00:00+00:00",
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof SkillLibraryError ? error.code : "other";
  }
  return undefined;
}

beforeEach(() => {
  for (const key of Object.keys(results)) Reflect.deleteProperty(results, key);
  calls.length = 0;
  requireWorkspaceRole.mockReset();
  requireWorkspaceRole.mockResolvedValue({ userId: "u", workspaceId: WS, role: "owner" });
});

describe("roles", () => {
  it("lets any member or viewer read", async () => {
    results.skills = [{ data: [skillRow()], error: null }];
    await listSkills(WS);
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WS, "viewer");
  });

  it.each([
    ["createSkill", () => createSkill({ workspaceId: WS, name: "n", description: "", body: "" })],
    [
      "saveSkill",
      () =>
        saveSkill({
          workspaceId: WS,
          skillId: SKILL,
          expectedVersion: 1,
          description: "",
          body: "",
        }),
    ],
    ["assignSkill", () => assignSkill({ workspaceId: WS, skillId: SKILL, agentId: AGENT })],
    ["unassignSkill", () => unassignSkill({ workspaceId: WS, skillId: SKILL, agentId: AGENT })],
  ])("%s requires the owner role and writes nothing when it is refused", async (_name, run) => {
    requireWorkspaceRole.mockRejectedValue(new Error("forbidden"));
    await expect(run()).rejects.toThrow("forbidden");
    expect(requireWorkspaceRole).toHaveBeenCalledWith(WS, "owner");
    expect(calls).toHaveLength(0);
  });
});

describe("reading", () => {
  it("scopes every query to the approved workspace and parses rows", async () => {
    results.skills = [{ data: [skillRow()], error: null }];
    const skills = await listSkills(WS);
    expect(skills[0]).toMatchObject({ id: SKILL, workspaceId: WS, version: 2 });
    expect(calls).toContainEqual({ table: "skills", method: "eq", args: ["workspace_id", WS] });
  });

  it("fails closed on a stored row that breaks the schema", async () => {
    results.skills = [{ data: [skillRow({ version: 0 })], error: null }];
    expect(await codeOf(listSkills(WS))).toBe("failed");
  });

  it("returns the history newest first with assignments and assignable agents", async () => {
    results.skills = [{ data: skillRow(), error: null }];
    results.skill_versions = [
      {
        data: [
          { id: WS, skill_id: SKILL, version: 2, body: "b", created_by: null, created_at: "t" },
        ],
        error: null,
      },
    ];
    results.agent_skills = [
      { data: [{ agent_id: AGENT, agents: { name: "Scout" } }], error: null },
    ];
    results.agents = [{ data: [{ id: AGENT, name: "Scout" }], error: null }];
    const detail = await getSkillDetail(WS, SKILL);
    expect(detail.versions).toHaveLength(1);
    expect(detail.assignments).toEqual([{ agentId: AGENT, agentName: "Scout" }]);
    expect(detail.agents).toEqual([{ id: AGENT, name: "Scout" }]);
    expect(calls).toContainEqual({
      table: "skill_versions",
      method: "order",
      args: ["version", { ascending: false }],
    });
  });

  it("reports a missing skill as not_found", async () => {
    results.skills = [{ data: null, error: null }];
    expect(await codeOf(getSkillDetail(WS, SKILL))).toBe("not_found");
  });
});

describe("writing", () => {
  it("maps a duplicate name to name_taken", async () => {
    results.skills = [{ data: null, error: { code: "23505" } }];
    expect(
      await codeOf(createSkill({ workspaceId: WS, name: "n", description: "", body: "" })),
    ).toBe("name_taken");
  });

  it("never sends a version or workspace override when saving", async () => {
    results.skills = [{ data: [{ version: 3 }], error: null }];
    const saved = await saveSkill({
      workspaceId: WS,
      skillId: SKILL,
      expectedVersion: 2,
      description: "d",
      body: "new",
    });
    expect(saved).toEqual({ version: 3 });
    const update = calls.find((call) => call.method === "update");
    expect(update?.args[0]).toEqual({ description: "d", body: "new" });
    expect(calls).toContainEqual({ table: "skills", method: "eq", args: ["version", 2] });
  });

  it("refuses a stale save instead of overwriting a newer version", async () => {
    results.skills = [
      { data: [], error: null },
      { data: { id: SKILL }, error: null },
    ];
    expect(
      await codeOf(
        saveSkill({
          workspaceId: WS,
          skillId: SKILL,
          expectedVersion: 1,
          description: "",
          body: "x",
        }),
      ),
    ).toBe("stale");
  });

  it("reports a save of a deleted skill as not_found", async () => {
    results.skills = [
      { data: [], error: null },
      { data: null, error: null },
    ];
    expect(
      await codeOf(
        saveSkill({
          workspaceId: WS,
          skillId: SKILL,
          expectedVersion: 1,
          description: "",
          body: "x",
        }),
      ),
    ).toBe("not_found");
  });

  it("treats assigning twice as a no-op and any other error as failed", async () => {
    results.agent_skills = [
      { data: null, error: { code: "23505" } },
      { data: null, error: { code: "42501" } },
    ];
    await expect(
      assignSkill({ workspaceId: WS, skillId: SKILL, agentId: AGENT }),
    ).resolves.toBeUndefined();
    expect(await codeOf(assignSkill({ workspaceId: WS, skillId: SKILL, agentId: AGENT }))).toBe(
      "failed",
    );
  });

  it("unassigns by workspace, agent and skill, and nothing else", async () => {
    results.agent_skills = [{ data: null, error: null }];
    await unassignSkill({ workspaceId: WS, skillId: SKILL, agentId: AGENT });
    const eqs = calls.filter((call) => call.method === "eq").map((call) => call.args);
    expect(eqs).toEqual([
      ["workspace_id", WS],
      ["agent_id", AGENT],
      ["skill_id", SKILL],
    ]);
    expect(calls.some((call) => call.table === "skills")).toBe(false);
  });
});
