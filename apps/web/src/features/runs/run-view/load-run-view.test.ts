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

import { RUN_VIEW_PAGE_SIZE, RunViewLoadError, loadRunView } from "./load-run-view";
import { AGENT_ID, RUN_ID, WORKSPACE_ID, at, ev } from "./run-view-fixtures";

interface Call {
  readonly table: string;
  readonly filters: [string, unknown][];
}

/** A chainable fake of the few PostgREST calls the loader makes; records every filter. */
function fakeClient(tables: {
  runs?: unknown;
  agents?: unknown;
  events?: readonly unknown[];
  error?: "runs" | "agents" | "run_events";
}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (tables.error === table) return { data: null, error: { code: "XX000" } };
        if (table === "runs") return { data: tables.runs ?? null, error: null };
        if (table === "agents") return { data: tables.agents ?? null, error: null };
        const after = (call.filters.find(([k]) => k === "gt:seq")?.[1] as number | undefined) ?? 0;
        const all = (tables.events ?? []) as { seq: number }[];
        return { data: all.filter((r) => r.seq > after).slice(0, RUN_VIEW_PAGE_SIZE), error: null };
      };
      for (const name of ["select", "order", "limit"]) chain[name] = () => chain;
      chain.eq = (k: string, v: unknown) => {
        call.filters.push([k, v]);
        return chain;
      };
      chain.gt = (k: string, v: unknown) => {
        call.filters.push([`gt:${k}`, v]);
        return chain;
      };
      chain.maybeSingle = () => Promise.resolve(result());
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const runRow = {
  id: RUN_ID,
  workspace_id: WORKSPACE_ID,
  agent_id: AGENT_ID,
  status: "running",
  started_at: at(1),
  finished_at: null,
  created_at: at(0),
};

describe("loadRunView", () => {
  it("returns the run, its agent name and its events, every query scoped by workspace", async () => {
    const { client, calls } = fakeClient({
      runs: runRow,
      agents: { name: "Scout" },
      events: [ev(1, "run.started"), ev(2, "step.started", { step: 1 })],
    });
    const result = await loadRunView(WORKSPACE_ID, RUN_ID, client);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.run).toMatchObject({ id: RUN_ID, agentName: "Scout", status: "running" });
    expect(result.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(result.isCut).toBe(false);
    for (const call of calls) expect(call.filters).toContainEqual(["workspace_id", WORKSPACE_ID]);
    expect(calls.map((c) => c.table)).toEqual(["runs", "agents", "run_events"]);
  });

  it("shows not-found, with no data, for a missing run or a run RLS hides (another workspace)", async () => {
    const { client, calls } = fakeClient({ runs: null });
    expect(await loadRunView(WORKSPACE_ID, RUN_ID, client)).toEqual({ kind: "not_found" });
    expect(calls.map((c) => c.table)).toEqual(["runs"]);
  });

  it("shows not-found for a malformed id without touching the database", async () => {
    const { client, calls } = fakeClient({ runs: runRow });
    expect(await loadRunView(WORKSPACE_ID, "../etc/passwd", client)).toEqual({
      kind: "not_found",
    });
    expect(calls).toHaveLength(0);
  });

  it("throws a generic error when a query fails (never an empty page)", async () => {
    for (const error of ["runs", "agents", "run_events"] as const) {
      const { client } = fakeClient({ runs: runRow, agents: { name: "Scout" }, error });
      await expect(loadRunView(WORKSPACE_ID, RUN_ID, client)).rejects.toBeInstanceOf(
        RunViewLoadError,
      );
    }
  });

  it("pages through a long log and keeps the order", async () => {
    const events = Array.from({ length: RUN_VIEW_PAGE_SIZE + 5 }, (_, i) =>
      ev(i + 1, "run.started"),
    );
    const { client } = fakeClient({ runs: runRow, agents: { name: "Scout" }, events });
    const result = await loadRunView(WORKSPACE_ID, RUN_ID, client);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.rows).toHaveLength(RUN_VIEW_PAGE_SIZE + 5);
    expect(result.rows.at(-1)?.seq).toBe(RUN_VIEW_PAGE_SIZE + 5);
  });
});
