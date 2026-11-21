import { describe, expect, it, vi } from "vitest";

import { createToolRegistry } from "../agent/tools.js";

import {
  createManagerTools,
  PROPOSE_TASKS_TOOL_NAME,
  READ_GOAL_TOOL_NAME,
} from "./manager-tools.js";
import { createPgManagerStore } from "./pg-manager-store.js";
import { proposeTasksInputSchema } from "./propose-tasks-schema.js";

import type { CreateGoalTasksResult, ManagerStore } from "./manager-store.js";
import type { ToolContext } from "../agent/tools.js";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const GOAL = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const context: ToolContext = {
  workspaceId: WS,
  runId: RUN,
  agentId: AGENT,
  signal: new AbortController().signal,
};

function storeReturning(
  result: CreateGoalTasksResult,
  createGoalTasks = vi.fn(() => Promise.resolve(result)),
): ManagerStore {
  return {
    readGoalForRun: vi.fn(() => Promise.resolve({ goalId: GOAL, text: "grow signups" })),
    createGoalTasks,
  };
}

const task = (ref: string, extra: Record<string, unknown> = {}) => ({
  ref,
  title: `Task ${ref}`,
  brief: `Do ${ref}`,
  ...extra,
});

describe("proposeTasksInputSchema (AC1, AC2: shape the database re-checks)", () => {
  it("accepts a proposal with briefs, a suggested agent and earlier dependencies", () => {
    const parsed = proposeTasksInputSchema.safeParse({
      goal_id: GOAL,
      tasks: [task("a", { suggested_agent_id: AGENT }), task("b", { depends_on: ["a"] })],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["no tasks", { goal_id: GOAL, tasks: [] }],
    [
      "13 tasks",
      { goal_id: GOAL, tasks: Array.from({ length: 13 }, (_, i) => task(`t${String(i)}`)) },
    ],
    ["an empty brief", { goal_id: GOAL, tasks: [task("a", { brief: "   " })] }],
    ["a duplicate ref", { goal_id: GOAL, tasks: [task("a"), task("a")] }],
    ["a self dependency", { goal_id: GOAL, tasks: [task("a", { depends_on: ["a"] })] }],
    [
      "a forward dependency (no cycles)",
      { goal_id: GOAL, tasks: [task("a", { depends_on: ["b"] }), task("b")] },
    ],
    ["an unknown dependency", { goal_id: GOAL, tasks: [task("a", { depends_on: ["zzz"] })] }],
    ["a bad agent id", { goal_id: GOAL, tasks: [task("a", { suggested_agent_id: "nope" })] }],
    [
      "an unknown field such as agent_id (no assignment)",
      { goal_id: GOAL, tasks: [task("a", { agent_id: AGENT })] },
    ],
    [
      "a new-agent field (no hiring)",
      { goal_id: GOAL, tasks: [task("a", { new_agent: { name: "x" } })] },
    ],
  ])("refuses %s", (_name, input) => {
    expect(proposeTasksInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("propose_tasks tool", () => {
  it("passes the run's own workspace and run, never ids from the model", async () => {
    const createGoalTasks = vi.fn(() =>
      Promise.resolve({ ok: true as const, taskIds: ["t1", "t2"] }),
    );
    const store = storeReturning({ ok: true, taskIds: [] }, createGoalTasks);
    const tool = createManagerTools({ store }).find((t) => t.name === PROPOSE_TASKS_TOOL_NAME);
    const input = { goal_id: GOAL, tasks: [task("a"), task("b", { depends_on: ["a"] })] };
    const out = await tool?.execute(tool.inputSchema.parse(input), context);
    expect(out).toBe("proposed 2 tasks in the Inbox: t1, t2");
    expect(createGoalTasks).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, runId: RUN, goalId: GOAL }),
    );
  });

  it("reports a refusal as a fixed reason code", async () => {
    const store = storeReturning({ ok: false, reason: "unknown_agent" });
    const tool = createManagerTools({ store }).find((t) => t.name === PROPOSE_TASKS_TOOL_NAME);
    const input = tool?.inputSchema.parse({ goal_id: GOAL, tasks: [task("a")] });
    expect(await tool?.execute(input, context)).toBe("proposal refused: unknown_agent");
  });

  it("needs the tasks.manage grant at tier 1 (the policy engine checks it before it runs)", () => {
    for (const tool of createManagerTools({ store: storeReturning({ ok: true, taskIds: [] }) })) {
      expect(tool.capabilityKey).toBe("tasks.manage");
      expect(tool.tier).toBe(1);
    }
  });
});

describe("read_goal tool", () => {
  it("returns the goal text as a tool result (wrapped as untrusted data by the context builder)", async () => {
    const tool = createManagerTools({ store: storeReturning({ ok: true, taskIds: [] }) }).find(
      (t) => t.name === READ_GOAL_TOOL_NAME,
    );
    expect(await tool?.execute({}, context)).toBe(`goal_id: ${GOAL}\n\ngrow signups`);
  });

  it("says so when no goal is linked", async () => {
    const store: ManagerStore = {
      readGoalForRun: () => Promise.resolve(null),
      createGoalTasks: () => Promise.resolve({ ok: true, taskIds: [] }),
    };
    const tool = createManagerTools({ store }).find((t) => t.name === READ_GOAL_TOOL_NAME);
    expect(await tool?.execute({}, context)).toBe("no goal is linked to this task");
  });
});

describe("AC3: the Manager cannot create or hire agents", () => {
  it("offers no tool that creates, hires, imports or edits an agent", () => {
    const registry = createToolRegistry(
      createManagerTools({ store: storeReturning({ ok: true, taskIds: [] }) }),
    );
    expect(
      registry
        .all()
        .map((t) => t.name)
        .sort(),
    ).toEqual([PROPOSE_TASKS_TOOL_NAME, READ_GOAL_TOOL_NAME]);
    for (const tool of registry.all()) {
      expect(tool.name).not.toMatch(/agent|hire|create|import/i);
    }
  });

  it("has no store method that writes an agent", () => {
    const store = createPgManagerStore({ query: () => Promise.resolve({ rows: [] }) });
    expect(Object.keys(store).sort()).toEqual(["createGoalTasks", "readGoalForRun"]);
  });
});

describe("pg manager store refusals", () => {
  const failing = (code: string, message: string) =>
    createPgManagerStore({
      query: () => Promise.reject(Object.assign(new Error(message), { code, message })),
    });
  const input = { workspaceId: WS, runId: RUN, goalId: GOAL, tasks: [] };

  it.each([
    ["42501", "only an active Manager can propose tasks", "not_manager"],
    ["P0002", "unknown or archived agent", "unknown_agent"],
    ["P0002", "the run is not planning this goal", "goal_not_assigned"],
    ["22023", "a goal can have at most 24 proposed tasks", "limit_reached"],
    ["22023", "bad task title", "invalid"],
  ])("maps %s %s to %s", async (code, message, reason) => {
    expect(await failing(code, message).createGoalTasks(input)).toEqual({ ok: false, reason });
  });

  it("does not hide an unexpected database error", async () => {
    await expect(failing("XX000", "boom").createGoalTasks(input)).rejects.toThrow("boom");
  });
});
