import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";
import { describe, expect, it } from "vitest";

import { BoardLoadError, loadBoardData } from "./load-board-data";

const WS = "00000001-0000-4000-8000-000000000001";

interface Call {
  table: string;
  filters: [string, ...unknown[]][];
}

/** A fake query builder: records every filter and resolves to the table's canned rows. */
function fakeClient(rows: Record<string, unknown[]>, failing?: string) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "is", "not", "gt", "order", "limit"]) {
        builder[name] = (...args: unknown[]) => {
          call.filters.push([name, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          table === failing
            ? { data: null, error: { code: "XX000", message: "secret detail" } }
            : { data: rows[table] ?? [], error: null },
        );
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

describe("loadBoardData", () => {
  it("scopes every read to the workspace and reads only", async () => {
    const { client, calls } = fakeClient({});
    await loadBoardData(client, WS);
    expect(calls.map((c) => c.table).sort()).toEqual(["agents", "approvals", "runs", "tasks"]);
    for (const call of calls) {
      expect(call.filters, call.table).toContainEqual(["eq", "workspace_id", WS]);
      expect(
        call.filters.some(([name]) =>
          ["insert", "update", "delete", "upsert", "rpc"].includes(name),
        ),
      ).toBe(false);
    }
  });

  it("asks only for pending, unconsumed, unexpired approvals, and only runs that belong to a task", async () => {
    const { client, calls } = fakeClient({});
    await loadBoardData(client, WS);
    const approvals = calls.find((c) => c.table === "approvals");
    expect(approvals?.filters).toContainEqual(["eq", "status", "pending"]);
    expect(approvals?.filters).toContainEqual(["is", "consumed_at", null]);
    expect(approvals?.filters.some(([name, col]) => name === "gt" && col === "expires_at")).toBe(
      true,
    );
    expect(calls.find((c) => c.table === "runs")?.filters).toContainEqual([
      "not",
      "task_id",
      "is",
      null,
    ]);
  });

  it("maps rows to board data and drops a run with no task", async () => {
    const { client } = fakeClient({
      tasks: [
        { id: "t1", title: "T", status: "todo", agent_id: "a1", created_at: "c", updated_at: "u" },
      ],
      runs: [
        { id: "r1", task_id: "t1", agent_id: "a1", status: "queued", created_at: "c" },
        { id: "r2", task_id: null, agent_id: "a1", status: "queued", created_at: "c" },
      ],
      approvals: [{ id: "p1", run_id: "r1", created_at: "c" }],
      agents: [{ id: "a1", name: "Ada" }],
    });
    const data = await loadBoardData(client, WS);
    expect(data.tasks).toEqual([
      { id: "t1", title: "T", status: "todo", agentId: "a1", createdAt: "c", updatedAt: "u" },
    ]);
    expect(data.runs.map((r) => r.id)).toEqual(["r1"]);
    expect(data.approvals).toEqual([{ id: "p1", runId: "r1", createdAt: "c" }]);
    expect(data.agents).toEqual([{ id: "a1", name: "Ada" }]);
  });

  it("fails with a fixed message that never carries the database detail", async () => {
    const { client } = fakeClient({}, "approvals");
    const error = await loadBoardData(client, WS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoardLoadError);
    expect((error as Error).message).toBe("Could not load the task board.");
    expect((error as Error).message).not.toMatch(/secret/);
  });
});

describe("board client bundle", () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  it("never imports values from the root @ago/shared barrel or reads env or server-only code", () => {
    for (const [file, source] of sources) {
      const rootValueImports = (
        source.match(/^import\s[^;]*?from\s+"@ago\/shared";/gms) ?? []
      ).filter((s) => !/^import\s+type\s/.test(s));
      expect(rootValueImports, file).toEqual([]);
      expect(source, file).not.toMatch(/process\.env|server-only|service_role|SERVICE_ROLE/);
      expect(source, file).not.toMatch(/from\s+"[^"]*\/lib\/env"/);
    }
  });

  it("has no write path: no mutation calls and no server action", () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
      expect(source, file).not.toMatch(/"use server"/);
    }
  });
});
