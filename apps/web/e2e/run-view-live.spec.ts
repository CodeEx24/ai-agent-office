import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { hex64, svcInsert, svcRows, uniq, seedTask, type Row } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-153 device flow: the run view at /app/runs/<run id>, driven through the real UI. Local stack only (E2E_SUPABASE=1).
// The agent is hired as the workspace owner through the Data API; runs and run events are written as service_role
// (synthetic rows in the local database, never a real model call; `seq` is assigned by the database). Sign-in writes
// the session cookie of a real throw-away sign-up (no inbox, no secrets). Each run uses its own unique ids.
//
//   AC1  the log updates live: a row inserted while the page is open appears without a reload, also after the
//        realtime connection drops and comes back (caught up in order, each row once)
//   AC2  the shown tokens and cost equal the sum of the run's stored budget.usage rows
//   +    every state (queued, running, paused, stopped by budget, failed, completed, empty), the duration ticking
//        only while running, not-found for another workspace's run and a malformed id, hostile text as plain text,
//        a long message with an expand control, narrow and wide screens, light and dark
//
// Set E2E_SHOTS_DIR to also save a screenshot of every step (light and dark) into that folder (never committed).
const SHOTS_DIR = process.env.E2E_SHOTS_DIR;
const HOSTILE_IMG = "<img src=x onerror=window.__xss=1>";
const HOSTILE_SCRIPT = "<script>window.__xss=2</script>";

declare global {
  interface Window {
    __xss?: number;
    __noReload?: number;
  }
}

test.describe("AGO-153: run view (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 240_000 });
  // The not-found checks navigate to pages that answer 404; the browser logs each one as a failed resource.
  test.use({ allowedConsoleErrors: [/status of 404/] });

  if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });

  /** A screenshot in light and in dark (the page follows the system scheme). */
  async function shot(page: Page, name: string, target?: Locator): Promise<void> {
    if (!SHOTS_DIR) return;
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^((?!dark).)*$/);
      const path = join(SHOTS_DIR, `${name}-${scheme}.png`);
      if (target) await target.screenshot({ path });
      else await page.screenshot({ path, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: "light" });
  }

  const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

  async function hireAgent(owner: TestUser, workspaceId: string, name: string): Promise<Row> {
    const created = await asUser<Row[]>(owner, "/rest/v1/agents", {
      method: "POST",
      prefer: "return=representation",
      body: {
        workspace_id: workspaceId,
        name,
        role: "Role text",
        model: "claude-sonnet-4-5",
        prompt: "Do the work carefully.",
      },
    });
    const row = created.body[0];
    if (created.status !== 201 || !row) throw new Error(`hiring failed: ${String(created.status)}`);
    return row;
  }

  interface World {
    workspaceId: string;
    agent: Row;
    owner: TestUser;
  }

  /** A run row plus a writer for its events. `createdAt` (seconds ago) pins an event's timestamp. */
  async function newRun(w: World): Promise<{
    id: string;
    ev: (type: string, payload?: Row, agoSeconds?: number) => Promise<void>;
  }> {
    const task = await seedTask(w.workspaceId, w.agent.id as string);
    const run = await svcInsert("runs", {
      workspace_id: w.workspaceId,
      task_id: task.id,
      agent_id: w.agent.id,
    });
    const id = run.id as string;
    const ev = async (type: string, payload: Row = {}, agoSeconds?: number) => {
      await svcInsert("run_events", {
        workspace_id: w.workspaceId,
        run_id: id,
        type,
        payload: { version: 1, ...payload },
        ...(agoSeconds === undefined ? {} : { created_at: secondsAgo(agoSeconds) }),
      });
    };
    await ev("run.created", { agent_id: w.agent.id, task_id: task.id }, 600);
    return { id, ev };
  }

  async function storedUsage(runId: string) {
    const rows = await svcRows(
      "run_events",
      `run_id=eq.${runId}&type=eq.budget.usage&select=payload`,
    );
    let input = 0;
    let output = 0;
    let cents = 0;
    for (const r of rows) {
      const p = r.payload as { input_tokens: number; output_tokens: number; cost_cents?: number };
      input += p.input_tokens;
      output += p.output_tokens;
      cents += p.cost_cents ?? 0;
    }
    return { input, output, cents, calls: rows.length };
  }

  const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
  const phase = (page: Page) => page.getByTestId("run-phase");
  const feed = (page: Page) => page.getByTestId("feed-status");
  const logRows = (page: Page) => page.getByTestId("run-log").locator("> li");

  async function setup(label: string): Promise<World> {
    const owner = await createUser(label);
    const workspaceId = await onboard(owner, `${label} Co`);
    const agent = await hireAgent(owner, workspaceId, uniq("Atlas"));
    return { owner, workspaceId, agent };
  }

  /**
   * Realtime cold start: right after `supabase db reset` the Realtime service can report the channel as subscribed
   * (the page shows "Live") yet not push the first inserts for a while. Before the test writes the rows it asserts on,
   * insert rows into a second run of the workspace (the page ignores them) until a pushed `run_events` INSERT frame has
   * reached the browser. Nothing of the run under test is touched. The frame listener must be set up before `goto`.
   */
  function watchRealtimePushes(page: Page): { readonly hasPush: () => boolean } {
    let seen = false;
    page.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        // A pushed row, not the subscribe reply (which also names postgres_changes).
        const text = String(frame.payload);
        if (text.includes('"table":"run_events"') && text.includes('"type":"INSERT"')) seen = true;
      });
    });
    return { hasPush: () => seen };
  }

  async function warmRealtime(w: World, watch: { readonly hasPush: () => boolean }): Promise<void> {
    const probe = await newRun(w);
    for (let i = 0; i < 40 && !watch.hasPush(); i += 1) {
      await probe.ev("message.emitted", { role: "system", summary: "realtime warm-up probe" });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(watch.hasPush(), "Realtime pushed no row within 80 s of the page going Live").toBe(true);
  }

  test("AC1: the log updates live without a reload, and catches up after a dropped connection", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await setup("runview-live");
    const run = await newRun(w);
    await run.ev("run.started", {}, 120);
    await run.ev("step.started", { step: 1 }, 110);
    await signInWithSessionCookie(context, baseURL, w.owner);

    // Hold the realtime socket so the test can drop it and keep it down.
    const sockets: { close: () => Promise<void> }[] = [];
    let blockReconnect = false;
    await context.routeWebSocket(/realtime/, (ws) => {
      if (blockReconnect) return; // never connects
      ws.connectToServer();
      sockets.push({ close: () => ws.close() });
    });

    const pushes = watchRealtimePushes(page);
    await page.goto(`/app/runs/${run.id}`);
    await expect(page.getByRole("heading", { name: /^Run [0-9a-f]{8}$/ })).toBeVisible();
    await expect(page.getByTestId("run-short-id")).toHaveAttribute("title", run.id);
    await expect(page.getByRole("link", { name: "Back to the office" })).toHaveAttribute(
      "href",
      "/app/office",
    );
    await expect(page.getByRole("link", { name: String(w.agent.name) })).toHaveAttribute(
      "href",
      `/app/agents/${String(w.agent.id)}`,
    );
    await expect(feed(page)).toHaveText("Live", { timeout: 30_000 });
    await warmRealtime(w, pushes);
    await expect(phase(page)).toHaveText("Running");
    await expect(logRows(page)).toHaveCount(3);
    await page.evaluate(() => {
      window.__noReload = 1; // gone after a reload
    });
    await shot(page, "AGO-153-AC1-step-01-running-log-3-rows");

    // A new row arrives while the page is open.
    await run.ev("message.emitted", {
      role: "agent",
      summary: "First live message from the agent",
    });
    await expect(page.getByText("First live message from the agent")).toBeVisible({
      timeout: 20_000,
    });
    await expect(logRows(page)).toHaveCount(4);
    await run.ev("tool_call.requested", {
      call_id: "call-live-1",
      tool_name: "web.search",
      tier: 1,
      input_hash: hex64(),
    });
    await run.ev("tool_call.completed", { call_id: "call-live-1", duration_ms: 420 });
    await expect(page.getByRole("region", { name: "Tool calls" })).toContainText("web.search");
    await expect(page.getByRole("region", { name: "Tool calls" })).toContainText("Completed");
    await expect(logRows(page)).toHaveCount(6);
    expect(await page.evaluate(() => window.__noReload)).toBe(1);
    await shot(page, "AGO-153-AC1-step-02-live-rows-appeared-no-reload");

    // Drop the connection; rows written while it is down arrive in order, once each, after it comes back.
    blockReconnect = true;
    await Promise.all(sockets.map((s) => s.close()));
    await expect(feed(page)).toHaveText(/Reconnecting|Connecting|Catching up/, { timeout: 30_000 });
    await run.ev("message.emitted", { role: "agent", summary: "Written while offline A" });
    await run.ev("message.emitted", { role: "system", summary: "Written while offline B" });
    await expect(page.getByText("Written while offline A")).toHaveCount(0);
    await shot(page, "AGO-153-AC1-step-03-connection-dropped");
    blockReconnect = false;
    await expect(page.getByText("Written while offline A")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Written while offline B")).toBeVisible();
    await expect(feed(page)).toHaveText("Live", { timeout: 60_000 });
    await expect(logRows(page)).toHaveCount(8);
    const texts = await logRows(page).allInnerTexts();
    const a = texts.findIndex((t) => t.includes("Written while offline A"));
    const b = texts.findIndex((t) => t.includes("Written while offline B"));
    expect(a).toBeGreaterThan(-1);
    expect(b).toBe(a + 1); // in order
    expect(texts.filter((t) => t.includes("Written while offline"))).toHaveLength(2); // each once
    expect(await page.evaluate(() => window.__noReload)).toBe(1);
    await shot(page, "AGO-153-AC1-step-04-caught-up-in-order");

    // The run finishes live: the phase flips and the duration freezes.
    await run.ev("run.completed", { steps: 1, summary: "All done" });
    await expect(phase(page)).toHaveText("Completed", { timeout: 20_000 });
    const frozen = await page.getByTestId("run-duration").innerText();
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("run-duration")).toHaveText(frozen);
    await shot(page, "AGO-153-AC1-step-05-completed-live");

    // Persistence: a reload shows the same stored log.
    await page.reload();
    await expect(logRows(page)).toHaveCount(9);
    await expect(phase(page)).toHaveText("Completed");
  });

  test("AC2: cost and tokens equal the stored budget.usage rows", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await setup("runview-usage");
    const run = await newRun(w);
    await run.ev("run.started", {}, 300);
    await run.ev("step.started", { step: 1 }, 290);
    await run.ev("budget.usage", { input_tokens: 1200, output_tokens: 300, cost_cents: 7 }, 280);
    await run.ev("budget.usage", { input_tokens: 4321, output_tokens: 876, cost_cents: 112 }, 270);
    await run.ev("budget.usage", { input_tokens: 15, output_tokens: 5, cost_cents: 3 }, 260);
    await run.ev(
      "budget.exceeded",
      { scope: "run", reason: "run_token_limit_reached", limit: 4000, used: 4000 },
      250,
    );
    await run.ev("run.stopped", { stopped_by: "budget", reason: "budget_exceeded" }, 245);
    await signInWithSessionCookie(context, baseURL, w.owner);

    await page.goto(`/app/runs/${run.id}`);
    await expect(phase(page)).toContainText("Stopped");
    const budget = page.getByTestId("budget-stop");
    await expect(budget).toContainText("This run was stopped: it reached its token budget.");
    await expect(budget).toContainText("Used 4,000 tokens of 4,000 tokens.");
    await expect(budget).toContainText("Next step:");
    await expect(budget.getByRole("link", { name: /agent/i })).toHaveAttribute(
      "href",
      `/app/agents/${String(w.agent.id)}`,
    );
    const sum = await storedUsage(run.id);
    expect(sum).toEqual({ input: 1200 + 4321 + 15, output: 300 + 876 + 5, cents: 122, calls: 3 });
    await expect(page.getByTestId("usage-input")).toHaveText(fmt(sum.input));
    await expect(page.getByTestId("usage-output")).toHaveText(fmt(sum.output));
    await expect(page.getByTestId("usage-cost")).toHaveText(`$${(sum.cents / 100).toFixed(2)}`);
    await expect(page.getByTestId("usage-calls")).toHaveText(String(sum.calls));
    await shot(page, "AGO-153-AC2-step-01-stopped-by-budget-totals");

    // The totals follow a new usage row live, and still equal the stored sum.
    await expect(feed(page)).toHaveText("Live", { timeout: 30_000 });
    await run.ev("budget.usage", { input_tokens: 100, output_tokens: 50, cost_cents: 12 });
    await expect(page.getByTestId("usage-calls")).toHaveText("4", { timeout: 20_000 });
    const after = await storedUsage(run.id);
    await expect(page.getByTestId("usage-input")).toHaveText(fmt(after.input));
    await expect(page.getByTestId("usage-output")).toHaveText(fmt(after.output));
    await expect(page.getByTestId("usage-cost")).toHaveText(`$${(after.cents / 100).toFixed(2)}`);
    await shot(page, "AGO-153-AC2-step-02-totals-follow-new-usage");

    // A call with no recorded cost: never shown as $0, and the page says so.
    const free = await newRun(w);
    await free.ev("run.started", {}, 100);
    await free.ev("budget.usage", { input_tokens: 10, output_tokens: 20 }, 90);
    await page.goto(`/app/runs/${free.id}`);
    await expect(page.getByTestId("usage-cost")).toHaveText("not reported");
    await expect(page.getByText("no recorded cost")).toBeVisible();
    await expect(page.getByText("1 model call has no recorded cost")).toBeVisible();
    await expect(page.getByTestId("usage-input")).toHaveText("10");
    await shot(page, "AGO-153-AC2-step-03-no-cost-reported");

    // No usage at all.
    const none = await newRun(w);
    await none.ev("run.started", {}, 50);
    await page.goto(`/app/runs/${none.id}`);
    await expect(page.getByTestId("usage-calls")).toHaveText("0");
    await expect(page.getByTestId("usage-cost")).toHaveText("not reported");
  });

  test("states, duration, tool calls, hostile and long text, not found, screen sizes", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await setup("runview-states");

    // running, with hostile text and a long message
    const running = await newRun(w);
    await running.ev("run.started", {}, 95);
    await running.ev("step.started", { step: 1 }, 90);
    await running.ev(
      "message.emitted",
      {
        role: "agent",
        summary: `${HOSTILE_IMG} ${HOSTILE_SCRIPT} **bold** [link](javascript:alert(3))`,
      },
      85,
    );
    const longText = `Start. ${"Long message sentence that goes on. ".repeat(50)}END-MARKER`;
    await running.ev(
      "message.emitted",
      { role: "agent", summary: longText.slice(0, 1900) + "END-MARKER" },
      80,
    );
    await running.ev(
      "tool_call.requested",
      { call_id: "c-ok", tool_name: "web.search", tier: 1, input_hash: hex64() },
      70,
    );
    await running.ev(
      "policy.decision",
      { call_id: "c-ok", decision: "allow", tier: 1, reason_code: "tier_allowed" },
      69,
    );
    await running.ev("tool_call.completed", { call_id: "c-ok", duration_ms: 1500 }, 68);
    await running.ev(
      "tool_call.requested",
      { call_id: "c-deny", tool_name: "email.send", tier: 3, input_hash: hex64() },
      60,
    );
    await running.ev(
      "policy.decision",
      { call_id: "c-deny", decision: "deny", tier: 3, reason_code: "tier_blocked" },
      59,
    );
    await running.ev(
      "tool_call.requested",
      { call_id: "c-wait", tool_name: "files.write", tier: 2, input_hash: hex64() },
      50,
    );
    await running.ev(
      "policy.decision",
      { call_id: "c-wait", decision: "needs_approval", tier: 2, reason_code: "needs_human" },
      49,
    );
    await running.ev(
      "tool_call.requested",
      { call_id: "c-fail", tool_name: HOSTILE_IMG, tier: 1, input_hash: hex64() },
      40,
    );
    await running.ev(
      "tool_call.failed",
      { call_id: "c-fail", error_code: "tool_error", message: `${HOSTILE_SCRIPT} boom` },
      39,
    );
    await running.ev("step.completed", { step: 1, outcome: "ok" }, 30);

    // paused: started 10 min ago, paused 5 min ago -> frozen at 5 min
    const paused = await newRun(w);
    await paused.ev("run.started", {}, 600);
    await paused.ev("run.paused", { requested_by: "human", reason: "owner_paused" }, 300);

    // failed, long error message
    const failed = await newRun(w);
    await failed.ev("run.started", {}, 200);
    await failed.ev(
      "run.failed",
      { reason: "model_error", message: `Model said: ${"x".repeat(450)}` },
      100,
    );

    // completed: 3 min
    const done = await newRun(w);
    await done.ev("run.started", {}, 300);
    await done.ev("run.completed", { steps: 2, summary: "Finished the report" }, 120);

    // queued (created only) and empty (no events at all)
    const queued = await newRun(w);
    const emptyTask = await seedTask(w.workspaceId, w.agent.id as string);
    const empty = await svcInsert("runs", {
      workspace_id: w.workspaceId,
      task_id: emptyTask.id,
      agent_id: w.agent.id,
    });

    // another workspace's run
    const other = await createUser("runview-other");
    const otherWs = await onboard(other, "Other Co");
    const otherAgent = await hireAgent(other, otherWs, uniq("Other"));
    const otherRun = await newRun({ owner: other, workspaceId: otherWs, agent: otherAgent });

    await signInWithSessionCookie(context, baseURL, w.owner);

    // ---- running ----
    await page.goto(`/app/runs/${running.id}`);
    await expect(feed(page)).toHaveText("Live", { timeout: 30_000 });
    await expect(phase(page)).toHaveText("Running");
    const dur1 = await page.getByTestId("run-duration").innerText();
    await expect(page.getByTestId("run-duration")).not.toHaveText(dur1, { timeout: 5_000 }); // ticks
    await shot(page, "STATES-step-01-running");

    // tool call statuses
    const tools = page.getByRole("region", { name: "Tool calls" });
    await expect(tools).toContainText("Completed");
    await expect(tools).toContainText("Denied by policy");
    await expect(tools).toContainText("Waiting for approval");
    await expect(tools).toContainText("Failed");
    await expect(tools).toContainText("tool_error");

    // hostile text stays text
    const log = page.getByTestId("run-log");
    await expect(log).toContainText(HOSTILE_IMG);
    await expect(log).toContainText(HOSTILE_SCRIPT);
    expect(await page.locator("main img, main script, [data-testid=run-log] a").count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await shot(page, "STATES-step-02-hostile-text-is-plain");

    // long message: cut with an expand control
    await expect(log).not.toContainText("END-MARKER");
    const more = log.getByRole("button", { name: /Show more/ }).first();
    await expect(more).toBeVisible();
    await more.click();
    await expect(log).toContainText("END-MARKER");
    await expect(log.getByRole("button", { name: "Show less" })).toBeVisible();
    await shot(page, "STATES-step-03-long-message-expanded");

    // ---- narrow screen: no sideways scroll ----
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "STATES-step-04-running-narrow-375");
    await page.setViewportSize({ width: 1280, height: 800 });

    // ---- paused: frozen at 5 min ----
    await page.goto(`/app/runs/${paused.id}`);
    await expect(phase(page)).toContainText("Paused");
    await expect(page.getByText("paused and waiting for a person")).toBeVisible();
    await expect(page.getByTestId("run-duration")).toHaveText("5 min 00 s");
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("run-duration")).toHaveText("5 min 00 s");
    await shot(page, "STATES-step-05-paused-frozen");

    // ---- failed ----
    await page.goto(`/app/runs/${failed.id}`);
    await expect(phase(page)).toContainText("Failed");
    await expect(page.locator("main [role=alert]")).toContainText("Run failed: model error");
    await expect(
      page.locator("main [role=alert]").getByRole("button", { name: /Show more/ }),
    ).toBeVisible();
    // A long unbroken failure message must wrap inside the page, never scroll sideways, on a phone and on a desktop.
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, `horizontal overflow at ${String(width)}px`).toBeLessThanOrEqual(0);
      await shot(page, `ROUND2-OVERFLOW-failed-${String(width)}-collapsed`);
      const more = page.locator("main [role=alert]").getByRole("button", { name: /Show more/ });
      await more.click();
      const expanded = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(expanded, `horizontal overflow, expanded, at ${String(width)}px`).toBeLessThanOrEqual(
        0,
      );
      await shot(page, `ROUND2-OVERFLOW-failed-${String(width)}-expanded`);
      await page.reload();
    }
    await shot(page, "STATES-step-06-failed");

    // ---- completed: fixed 3 min ----
    await page.goto(`/app/runs/${done.id}`);
    await expect(phase(page)).toHaveText("Completed");
    await expect(page.getByTestId("run-duration")).toHaveText("3 min 00 s");
    await expect(page.getByText("Finished the report")).toBeVisible();
    await shot(page, "STATES-step-07-completed");

    // ---- queued and empty ----
    await page.goto(`/app/runs/${queued.id}`);
    await expect(phase(page)).toHaveText("Queued");
    await expect(page.getByTestId("run-duration")).toHaveText("not started");
    await shot(page, "STATES-step-08-queued");
    await page.goto(`/app/runs/${String(empty.id)}`);
    await expect(phase(page)).toHaveText("Queued");
    await expect(page.getByText("Nothing has happened yet")).toBeVisible();
    await shot(page, "STATES-step-09-empty");

    // ---- not found: another workspace's run, a missing id, a malformed id ----
    for (const [step, path] of [
      ["10-other-workspace", `/app/runs/${otherRun.id}`],
      ["11-missing-id", `/app/runs/${crypto.randomUUID()}`],
      ["12-malformed-id", "/app/runs/not-a-uuid"],
    ] as const) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to the office" })).toBeVisible();
      await expect(page.getByTestId("run-phase")).toHaveCount(0);
      await expect(page.getByText("Atlas")).toHaveCount(0);
      // Still inside the signed-in app shell, with links back.
      await expect(page.getByTestId("signed-in-email")).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to the office" })).toHaveAttribute(
        "href",
        "/app/office",
      );
      await expect(page.getByRole("link", { name: "See your agents" })).toHaveAttribute(
        "href",
        "/app/agents",
      );
      await shot(page, `STATES-step-${step}-not-found`);
    }
    // The link back works.
    await page.getByRole("link", { name: "See your agents" }).click();
    await expect(page).toHaveURL(/\/app\/agents$/);
  });

  test("round 2: stale banner while the live connection is down, then recovery", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await setup("runview-stale");
    const run = await newRun(w);
    await run.ev("run.started", {}, 120);
    await run.ev("step.started", { step: 1 }, 110);
    await signInWithSessionCookie(context, baseURL, w.owner);

    const sockets: { close: () => Promise<void> }[] = [];
    let blockReconnect = false;
    await context.routeWebSocket(/realtime/, (ws) => {
      // Held down: refuse every attempt at once (a network that is down), so the client keeps retrying and fails.
      if (blockReconnect) {
        void ws.close();
        return;
      }
      ws.connectToServer();
      sockets.push({ close: () => ws.close() });
    });

    await page.goto(`/app/runs/${run.id}`);
    await expect(feed(page)).toHaveText("Live", { timeout: 30_000 });
    await expect(phase(page)).toHaveText("Running");
    await expect(page.getByTestId("stale-banner")).toHaveCount(0);
    await expect(page.getByTestId("run-duration")).not.toContainText("(not updating)");
    const tick = await page.getByTestId("run-duration").innerText();
    await expect(page.getByTestId("run-duration")).not.toHaveText(tick, { timeout: 5_000 }); // ticking while live
    await shot(page, "ROUND2-STALE-step-01-live-ticking");

    // Drop the socket and hold it down: banner, "last known", duration frozen and labelled.
    blockReconnect = true;
    await Promise.all(sockets.map((s) => s.close()));
    const banner = page.getByTestId("stale-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("This page may be out of date");
    await expect(phase(page)).toContainText("last known");
    await expect(page.getByTestId("run-duration")).toContainText("(not updating)");
    const frozen = await page.getByTestId("run-duration").innerText();
    await page.waitForTimeout(3000);
    await expect(page.getByTestId("run-duration")).toHaveText(frozen);
    await shot(page, "ROUND2-STALE-step-02-banner-frozen-not-updating");

    // Still down a while later: the banner stays and nothing counts up.
    await page.waitForTimeout(3000);
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("run-duration")).toHaveText(frozen);
    await shot(page, "ROUND2-STALE-step-03-still-down");

    // Recovery: the connection comes back, the banner goes, the duration counts again.
    blockReconnect = false;
    await expect(feed(page)).toHaveText("Live", { timeout: 60_000 });
    await expect(banner).toHaveCount(0);
    await expect(phase(page)).not.toContainText("last known");
    await expect(page.getByTestId("run-duration")).not.toContainText("(not updating)");
    const back = await page.getByTestId("run-duration").innerText();
    await expect(page.getByTestId("run-duration")).not.toHaveText(back, { timeout: 5_000 });
    await shot(page, "ROUND2-STALE-step-04-recovered-live");
  });

  test("round 2: budget stop wording per scope, and the heading and agent link", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await setup("runview-budget");
    const daily = await newRun(w);
    await daily.ev("run.started", {}, 300);
    await daily.ev(
      "budget.exceeded",
      {
        scope: "agent_daily",
        reason: "agent_daily_limit_would_be_exceeded",
        limit: 500,
        used: 480,
      },
      250,
    );
    await daily.ev("run.stopped", { stopped_by: "budget", reason: "budget_exceeded" }, 245);
    const monthly = await newRun(w);
    await monthly.ev("run.started", {}, 300);
    await monthly.ev(
      "budget.exceeded",
      {
        scope: "workspace_monthly",
        reason: "workspace_monthly_limit_would_be_exceeded",
        limit: 5000,
        used: 4990,
      },
      250,
    );
    await monthly.ev("run.stopped", { stopped_by: "budget", reason: "budget_exceeded" }, 245);
    const pricing = await newRun(w);
    await pricing.ev("run.started", {}, 300);
    await pricing.ev(
      "budget.exceeded",
      { scope: "pricing", reason: "model_not_priced", limit: 0, used: 0 },
      250,
    );
    await pricing.ev("run.stopped", { stopped_by: "budget", reason: "budget_exceeded" }, 245);
    await signInWithSessionCookie(context, baseURL, w.owner);
    const agentHref = `/app/agents/${String(w.agent.id)}`;

    await page.goto(`/app/runs/${daily.id}`);
    let budget = page.getByTestId("budget-stop");
    await expect(budget).toContainText("This run was stopped: the agent reached its daily budget.");
    await expect(budget).toContainText("Used $4.80 of $5.00 today.");
    await expect(budget).toContainText("resets at midnight UTC");
    await expect(budget.getByRole("link", { name: /agent/i })).toHaveAttribute("href", agentHref);
    await shot(page, "ROUND2-BUDGET-step-01-agent-daily");

    await page.goto(`/app/runs/${monthly.id}`);
    budget = page.getByTestId("budget-stop");
    await expect(budget).toContainText(
      "This run was stopped: the workspace reached its monthly budget.",
    );
    await expect(budget).toContainText("Used $49.90 of $50.00 this month.");
    await expect(budget).toContainText("ask a workspace owner");
    await expect(budget.getByRole("link")).toHaveCount(0);
    await expect(budget).not.toContainText(/agent can (raise|change)/i);
    await shot(page, "ROUND2-BUDGET-step-02-workspace-monthly");

    await page.goto(`/app/runs/${pricing.id}`);
    budget = page.getByTestId("budget-stop");
    await expect(budget).toContainText("its budget could not be checked safely");
    await expect(budget).not.toContainText("Used ");
    await shot(page, "ROUND2-BUDGET-step-03-pricing-not-a-limit");

    // Heading with the short id, the agent link and the way back; the link goes to the agent page.
    await expect(page.getByRole("heading", { name: /^Run [0-9a-f]{8}$/ })).toBeVisible();
    await expect(page.getByTestId("run-short-id")).toHaveAttribute("title", pricing.id);
    await expect(page.getByRole("link", { name: "Back to the office" })).toHaveAttribute(
      "href",
      "/app/office",
    );
    await shot(page, "ROUND2-HEADING-step-01-short-id-agent-link");
    await page.getByRole("link", { name: String(w.agent.name) }).click();
    await expect(page).toHaveURL(new RegExp(`${agentHref}$`));
  });
});
