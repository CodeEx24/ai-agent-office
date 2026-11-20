import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";

vi.mock("server-only", () => ({}));
vi.mock("../../../lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("../../workspaces/workspace-access", () => ({
  requireWorkspaceRole: vi.fn((workspaceId: string) =>
    Promise.resolve({ userId: "u", workspaceId, role: "viewer" }),
  ),
}));

import { MAX_RUN_VIEW_EVENTS, RUN_VIEW_PAGE_SIZE, loadRunView } from "./load-run-view";
import {
  AGENT_ID,
  OTHER_RUN_ID,
  OTHER_WORKSPACE_ID,
  RUN_ID,
  WORKSPACE_ID,
  at,
  ev,
} from "./run-view-fixtures";

/**
 * Functional acceptance tests for loadRunView (AGO-153). The fake below behaves like a small table store: it applies
 * the `eq` / `gt` filters the loader sends to real rows, so a missing workspace filter would leak another workspace's
 * data here (that is how RLS plus the explicit filter protect the page).
 */

type Row = Record<string, unknown>;

interface Tables {
  readonly runs: readonly object[];
  readonly agents: readonly object[];
  readonly run_events: readonly object[];
}

function store(tables: Tables) {
  const queried: string[] = [];
  const client = {
    from(table: keyof Tables) {
      queried.push(table);
      let rows = tables[table].map((row) => row as Row);
      let max = Number.POSITIVE_INFINITY;
      const chain: Record<string, unknown> = {};
      for (const name of ["select"]) chain[name] = () => chain;
      chain.eq = (key: string, value: unknown) => {
        rows = rows.filter((row) => row[key] === value);
        return chain;
      };
      chain.gt = (key: string, value: number) => {
        rows = rows.filter((row) => (row[key] as number) > value);
        return chain;
      };
      chain.order = (key: string) => {
        rows = rows.sort((a, b) => (a[key] as number) - (b[key] as number));
        return chain;
      };
      chain.limit = (count: number) => {
        max = count;
        return chain;
      };
      const result = () => ({ data: rows.slice(0, max), error: null });
      chain.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve);
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, queried };
}

const run = (overrides: Row = {}): Row => ({
  id: RUN_ID,
  workspace_id: WORKSPACE_ID,
  agent_id: AGENT_ID,
  status: "running",
  started_at: at(1),
  finished_at: null,
  created_at: at(0),
  ...overrides,
});

describe("loadRunView: not found and empty", () => {
  it("returns not-found and reads no agent or event data for another workspace's run", async () => {
    const { client, queried } = store({
      runs: [run({ workspace_id: OTHER_WORKSPACE_ID })],
      agents: [{ id: AGENT_ID, workspace_id: OTHER_WORKSPACE_ID, name: "Secret agent" }],
      run_events: [
        ev(
          1,
          "message.emitted",
          { role: "agent", summary: "secret" },
          1,
          RUN_ID,
          OTHER_WORKSPACE_ID,
        ),
      ],
    });
    const result = await loadRunView(WORKSPACE_ID, RUN_ID, client);
    expect(result).toEqual({ kind: "not_found" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(queried).toEqual(["runs"]);
  });

  it("returns not-found when no run has that id", async () => {
    const { client } = store({ runs: [run({ id: OTHER_RUN_ID })], agents: [], run_events: [] });
    expect(await loadRunView(WORKSPACE_ID, RUN_ID, client)).toEqual({ kind: "not_found" });
  });

  it.each([
    "",
    "not-a-uuid",
    "../../etc/passwd",
    "15300000-0000-4000-8000-0000000000a1'; drop table runs;--",
  ])("returns not-found for the invalid id %j without any query", async (badId) => {
    const { client, queried } = store({ runs: [run()], agents: [], run_events: [] });
    expect(await loadRunView(WORKSPACE_ID, badId, client)).toEqual({ kind: "not_found" });
    expect(queried).toHaveLength(0);
  });

  it("returns an empty, uncut log for a run with no events", async () => {
    const { client } = store({
      runs: [run({ status: "queued", started_at: null })],
      agents: [],
      run_events: [],
    });
    const result = await loadRunView(WORKSPACE_ID, RUN_ID, client);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rows).toEqual([]);
    expect(result.isCut).toBe(false);
    expect(result.run.agentName).toBeNull();
    expect(result.run.status).toBe("queued");
  });
});

describe("loadRunView: only this run's rows", () => {
  it("returns rows of this run only, never rows of another run or workspace with the same seq", async () => {
    const { client } = store({
      runs: [run()],
      agents: [{ id: AGENT_ID, workspace_id: WORKSPACE_ID, name: "Scout" }],
      run_events: [
        ev(1, "run.started"),
        ev(1, "run.started", {}, 1, OTHER_RUN_ID),
        ev(1, "run.started", {}, 1, RUN_ID, OTHER_WORKSPACE_ID),
        ev(2, "step.started", { step: 1 }),
      ],
    });
    const result = await loadRunView(WORKSPACE_ID, RUN_ID, client);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.rows.map((row) => [row.run_id, row.workspace_id, row.seq])).toEqual([
      [RUN_ID, WORKSPACE_ID, 1],
      [RUN_ID, WORKSPACE_ID, 2],
    ]);
    expect(result.run.agentName).toBe("Scout");
  });

  it("returns rows oldest first even when the store holds them out of order", async () => {
    const { client } = store({
      runs: [run()],
      agents: [],
      run_events: [ev(3, "run.started"), ev(1, "run.started"), ev(2, "run.started")],
    });
    const result = await loadRunView(WORKSPACE_ID, RUN_ID, client);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("cuts a log at the row cap and flags it so the live feed loads the rest", async () => {
    const total = MAX_RUN_VIEW_EVENTS + RUN_VIEW_PAGE_SIZE;
    const events = Array.from({ length: total }, (_, index) => ev(index + 1, "run.started"));
    const { client } = store({ runs: [run()], agents: [], run_events: events });
    const result = await loadRunView(WORKSPACE_ID, RUN_ID, client);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.isCut).toBe(true);
    expect(result.rows).toHaveLength(MAX_RUN_VIEW_EVENTS);
    expect(result.rows.at(-1)?.seq).toBe(MAX_RUN_VIEW_EVENTS);
  });
});
