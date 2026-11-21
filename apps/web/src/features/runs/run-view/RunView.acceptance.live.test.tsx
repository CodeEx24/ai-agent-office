// AGO-153 AC1 ("Log updates live") proven with the REAL browser client against the local Supabase stack (real RLS,
// real Realtime). It needs the shared stack, so it only runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-153 --wait-min 180 && pnpm exec supabase db reset && \
//   RUN_DB_TESTS=1 pnpm --filter @ago/web exec vitest run src/features/runs/run-view/RunView.acceptance.live.test.tsx; \
//   node scripts/db-lock.mjs release AGO-153
// It renders <RunView> with NO injected source, so the source is `createRunLiveSource(url, anonKey)`: the AGO-150
// browser client over `createSupabaseOfficeSource`. Rows are inserted straight into run_events (as the worker would)
// and must appear on the page without a reload. Another workspace's rows must never appear.
// Keys come from `supabase status` at run time and are never printed. Test passwords are built at runtime.
import { execFile, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import { promisify } from "node:util";
import { render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createSupabaseBrowserClient } from "../../../lib/supabase/browser";
import { RunView } from "./RunView";

const run = promisify(execFile);
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_agent-office";
const enabled = process.env.RUN_DB_TESTS === "1";
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

async function psql(sql: string): Promise<string> {
  const { stdout } = await run("docker", [
    "exec",
    "-i",
    DB_CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-At",
    "-c",
    sql,
  ]);
  return stdout.trim();
}

function localStackEnv(): { url: string; serviceKey: string; anonKey: string } {
  const out = execSync("pnpm exec supabase status -o env", { encoding: "utf8" });
  const read = (name: string): string =>
    new RegExp(`^${name}="?([^"\\r\\n]+)"?`, "m").exec(out)?.[1] ?? "";
  return { url: read("API_URL"), serviceKey: read("SERVICE_ROLE_KEY"), anonKey: read("ANON_KEY") };
}

describe.skipIf(!enabled)("AGO-153 run view, live updates with the real browser client", () => {
  const wsA = randomUUID();
  const wsB = randomUUID();
  const wsW = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  const agentW = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const runW = randomUUID();
  const password = ["pw", randomUUID()].join("-");
  const stack = enabled ? localStackEnv() : { url: "", serviceKey: "", anonKey: "" };
  const userIds: string[] = [];
  // The same singleton the run view's source uses (createBrowserClient caches one per page), so signing in here
  // signs the run view's client in as well.
  const client = enabled ? createSupabaseBrowserClient(stack.url, stack.anonKey) : null;

  // Node's built-in WebSocket (undici) dispatches Node's own Event, which jsdom's replaced global `Event` rejects
  // ("The event argument must be an instance of Event"). Put Node's Event back for the socket, taken from the
  // prototype chain of a worker_threads message event (those are Node's own). Test-only: a real browser has one Event.
  beforeAll(async () => {
    const { port1, port2 } = new MessageChannel();
    const nodeEvent = await new Promise<unknown>((resolve) => {
      port1.addEventListener("message", (message: unknown) => {
        resolve(
          (Object.getPrototypeOf(Object.getPrototypeOf(message)) as { constructor: unknown })
            .constructor,
        );
      });
      port1.start();
      port2.postMessage(1);
    });
    port1.close();
    vi.stubGlobal("Event", nodeEvent);
    return () => {
      vi.unstubAllGlobals();
    };
  });

  const insertRow = (ws: string, runId: string, type: string, payload: string): Promise<string> =>
    psql(
      `insert into public.run_events (workspace_id, run_id, type, payload) values ('${ws}', '${runId}', '${type}', '${payload}')`,
    );

  beforeAll(async () => {
    const email = `ago153-${randomUUID()}@example.test`;
    const res = await fetch(`${stack.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: stack.serviceKey,
        Authorization: `Bearer ${stack.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const user = (await res.json()) as { id: string };
    userIds.push(user.id);
    await psql(`
      insert into public.workspaces (id, name) values ('${wsA}', 'AGO-153 A'), ('${wsB}', 'AGO-153 B'), ('${wsW}', 'AGO-153 warm-up');
      insert into public.members (workspace_id, user_id, role) values ('${wsA}', '${user.id}', 'member'), ('${wsW}', '${user.id}', 'member');
      insert into public.agents (id, workspace_id, name) values ('${agentA}', '${wsA}', 'a'), ('${agentB}', '${wsB}', 'b'), ('${agentW}', '${wsW}', 'w');
      insert into public.runs (id, workspace_id, agent_id) values ('${runA}', '${wsA}', '${agentA}'), ('${runB}', '${wsB}', '${agentB}'), ('${runW}', '${wsW}', '${agentW}')`);
    const { error } = await client!.auth.signInWithPassword({ email, password });
    if (error) throw new Error("test sign-in failed");
    await warmUpRealtime();
  });

  /** Right after `supabase db reset` Realtime says SUBSCRIBED before it delivers; probe in a separate workspace. */
  async function warmUpRealtime(): Promise<void> {
    const probe = { received: false };
    const channel = client!
      .channel(`ago153-warmup-${wsW}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "run_events",
          filter: `workspace_id=eq.${wsW}`,
        },
        () => {
          probe.received = true;
        },
      )
      .subscribe();
    const end = Date.now() + 45_000;
    while (!probe.received && Date.now() < end) {
      await insertRow(wsW, runW, "run.started", '{"version":1}');
      await new Promise((r) => setTimeout(r, 1500));
    }
    await client!.removeChannel(channel);
  }

  afterAll(async () => {
    if (!enabled) return;
    await client!.removeAllChannels();
    await client!.realtime.disconnect();
    const ids = `'${wsA}', '${wsB}', '${wsW}'`;
    // Test-only teardown (run_events is append-only): see scripts/run-events-teardown.mjs.
    await psql(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in (${ids});
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.workspaces where id in (${ids});
      delete from auth.users where id in (${userIds.map((u) => `'${u}'`).join(", ")});
      commit;`);
  });

  it("AC1: rows inserted after the page loaded appear without a reload; another workspace's rows never do", async () => {
    await insertRow(
      wsA,
      runA,
      "run.created",
      `{"version":1,"agent_id":"${agentA}","task_id":null}`,
    );
    const nowIso = new Date().toISOString();
    render(
      <RunView
        run={{
          id: runA,
          workspaceId: wsA,
          agentId: agentA,
          agentName: "a",
          status: "running",
          startedAt: nowIso,
          finishedAt: null,
          createdAt: nowIso,
        }}
        initialRows={[]}
        serverNowMs={Date.now()}
        supabaseUrl={stack.url}
        supabaseAnonKey={stack.anonKey}
      />,
    );

    // The feed subscribes and catches up: the row inserted before the subscribe is read in, so no gap.
    await waitFor(
      () => {
        expect(screen.getByText("Live")).toBeTruthy();
      },
      { timeout: 60_000 },
    );
    expect(screen.getByTestId("usage-calls").textContent).toContain("0");

    // A model call settles while the page is open; the worker writes one budget.usage row.
    await insertRow(
      wsA,
      runA,
      "budget.usage",
      '{"version":1,"input_tokens":1200,"output_tokens":300,"cost_cents":7}',
    );
    await waitFor(
      () => {
        expect(screen.getByTestId("usage-calls").textContent).toContain("1");
      },
      {
        timeout: 30_000,
      },
    );
    expect(screen.getByTestId("usage-cost").textContent).toContain("0.07");
    expect(screen.getByTestId("usage-input").textContent).toContain("1,200");

    // Another workspace's usage must never reach this page (RLS, and the feed filters by run).
    await insertRow(
      wsB,
      runB,
      "budget.usage",
      '{"version":1,"input_tokens":999,"output_tokens":999,"cost_cents":99}',
    );
    await insertRow(
      wsA,
      runA,
      "budget.usage",
      '{"version":1,"input_tokens":100,"output_tokens":50,"cost_cents":12}',
    );
    await waitFor(
      () => {
        expect(screen.getByTestId("usage-calls").textContent).toContain("2");
      },
      {
        timeout: 30_000,
      },
    );
    // 7 + 12 cents, and nothing from workspace B.
    expect(screen.getByTestId("usage-cost").textContent).toContain("0.19");
    expect(screen.getByTestId("usage-input").textContent).not.toContain("999");
  });
});
