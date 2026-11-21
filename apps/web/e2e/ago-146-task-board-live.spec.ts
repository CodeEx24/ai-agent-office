import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { hex64, inAnHour, svcInsert, svcRow, svcRows, uniq, type Row } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-146 device flow: the task board at /app/board, driven through the real UI. Local stack only (E2E_SUPABASE=1).
// Agents are hired as the workspace owner through the Data API; tasks, runs, approvals and run events are written as
// service_role (synthetic rows in the local database, never a real model call). Sign-in writes the session cookie of
// a real throw-away sign-up (no inbox, no secrets).
//
//   AC1  cards move with run state in realtime (events inserted while the page is open, no reload; reconnect catch-up)
//   AC2  "Waiting on you" lists blocked approvals first, oldest first, each linking to its approval
//   +    six populated columns; loading, empty, error and reconnecting states; hostile text stays text; read-only;
//        375 px and desktop; light and dark; another workspace's board is empty; a viewer can read it
//
// Set E2E_SHOTS_DIR to also save a screenshot of every step into that folder (never committed).
const SHOTS_DIR = process.env.E2E_SHOTS_DIR;
const HOSTILE_TITLE = "<img src=x onerror=window.__xss=1>Hostile <b>title</b>";
const COLUMNS = [
  ["inbox", "Inbox"],
  ["assigned", "Assigned"],
  ["in_progress", "In progress"],
  ["in_review", "In review"],
  ["waiting_on_you", "Waiting on you"],
  ["done", "Done"],
] as const;

test.describe("AGO-146: task board (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 300_000 });
  // The read-error step aborts the board's own data requests on purpose; the browser logs each as a failed load.
  // Nothing else may log an error: the page guard still fails the test on any other console error.
  test.use({ allowedConsoleErrors: [/^Failed to load resource: net::ERR_FAILED$/] });

  if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });

  /** A screenshot, in light; `dark: true` adds the same view in dark (the page follows the system scheme). */
  async function shot(page: Page, name: string, opts: { dark?: boolean; target?: Locator } = {}) {
    if (!SHOTS_DIR) return;
    for (const scheme of opts.dark ? (["light", "dark"] as const) : (["light"] as const)) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^((?!dark).)*$/);
      const path = join(SHOTS_DIR, `${name}${scheme === "dark" ? "-dark" : ""}.png`);
      if (opts.target) await opts.target.screenshot({ path });
      else await page.screenshot({ path, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: "light" });
  }

  const column = (page: Page, id: string) => page.getByTestId(`board-column-${id}`);
  const titlesIn = (page: Page, id: string) =>
    column(page, id).locator('[data-testid="board-card"] [id^="board-card-"]').allInnerTexts();
  const cardIn = (page: Page, id: string, title: string) =>
    column(page, id).getByTestId("board-card").filter({ hasText: title });
  const live = (page: Page) =>
    expect(page.getByTestId("board-stream-status")).toHaveAttribute("data-status", "live", {
      timeout: 20_000,
    });

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
    if (created.status !== 201 || !row)
      throw new Error(`hiring an agent failed: ${String(created.status)}`);
    return row;
  }

  const task = (workspaceId: string, title: string, extra: Row = {}) =>
    svcInsert("tasks", { workspace_id: workspaceId, title, ...extra });

  async function event(runId: string, workspaceId: string, type: string, payload: Row = {}) {
    await svcInsert("run_events", {
      workspace_id: workspaceId,
      run_id: runId,
      type,
      payload: { version: 1, ...payload },
    });
  }

  /** A run for `t` that has started. */
  async function startRun(workspaceId: string, t: Row, agent: Row): Promise<string> {
    const run = await svcInsert("runs", {
      workspace_id: workspaceId,
      task_id: t.id,
      agent_id: agent.id,
    });
    const runId = run.id as string;
    await event(runId, workspaceId, "run.created", { agent_id: agent.id, task_id: t.id });
    await event(runId, workspaceId, "run.started");
    return runId;
  }

  /** The run asks for approval; the pending approvals row was requested `hoursAgo` hours ago. */
  async function requestApproval(
    workspaceId: string,
    runId: string,
    agent: Row,
    hoursAgo: number,
  ): Promise<string> {
    const hash = hex64();
    const approval = await svcInsert("approvals", {
      workspace_id: workspaceId,
      run_id: runId,
      agent_id: agent.id,
      action: "email.send",
      payload_hash: hash,
      status: "pending",
      expires_at: inAnHour(),
      created_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    });
    await event(runId, workspaceId, "step.started", { step: 1 });
    await event(runId, workspaceId, "approval.requested", {
      approval_id: approval.id,
      call_id: uniq("call"),
      payload_hash: hash,
      tier: 3,
      expires_at: inAnHour(),
    });
    return approval.id as string;
  }

  test("owner walks the board: six columns, waiting-on-you order, live moves, states", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    const owner = await createUser("board-owner");
    const workspaceId = await onboard(owner, "Board Co");
    const agent = await hireAgent(owner, workspaceId, uniq("Worker"));
    const agent2 = await hireAgent(owner, workspaceId, uniq("Planner"));

    // Inbox (no agent), Assigned (agent, no run), Done (status done)
    await task(workspaceId, "Inbox plain task");
    await task(workspaceId, HOSTILE_TITLE);
    await task(workspaceId, "Assigned waiting to start", { agent_id: agent.id });
    const mover = await task(workspaceId, "Mover starts later", { agent_id: agent2.id });
    await task(workspaceId, "Done shipped one", { status: "done" });
    await task(workspaceId, "Done shipped two", { status: "done" });
    // In progress
    const running = await task(workspaceId, "Running now", { agent_id: agent.id });
    const runningRun = await startRun(workspaceId, running, agent);
    await event(runningRun, workspaceId, "step.started", { step: 1 });
    // In review: latest run completed, task not done
    const finished = await task(workspaceId, "Finished run for review", { agent_id: agent.id });
    const finishedRun = await startRun(workspaceId, finished, agent);
    await event(finishedRun, workspaceId, "run.completed", { steps: 1 });
    // Waiting on you: three pending approvals (event order scrambled on purpose), then paused and failed
    const tA = await task(workspaceId, "Approval two hours old", { agent_id: agent.id });
    const tB = await task(workspaceId, "Approval one hour old", { agent_id: agent.id });
    const tC = await task(workspaceId, "Approval three hours old", { agent_id: agent.id });
    const runB = await startRun(workspaceId, tB, agent);
    const approvalB = await requestApproval(workspaceId, runB, agent, 1);
    const runC = await startRun(workspaceId, tC, agent);
    const approvalC = await requestApproval(workspaceId, runC, agent, 3);
    const runA = await startRun(workspaceId, tA, agent);
    const approvalA = await requestApproval(workspaceId, runA, agent, 2);
    const paused = await task(workspaceId, "Paused by the owner", { agent_id: agent.id });
    await event(await startRun(workspaceId, paused, agent), workspaceId, "run.paused", {
      requested_by: "human",
      reason: "owner_paused",
    });
    const failed = await task(workspaceId, "Run that failed", { agent_id: agent.id });
    await event(await startRun(workspaceId, failed, agent), workspaceId, "run.failed", {
      reason: "tool_error",
      message: "The tool call failed.",
    });

    await signInWithSessionCookie(page.context(), baseURL, owner);

    // ---- Entry point and AC "six columns populated" ---------------------------------------------------------------
    await page.goto("/app");
    await expect(page.getByRole("link", { name: "Board" })).toBeVisible();
    await shot(page, "AGO-146-OBS-step-01-app-home-has-board-link");
    await page.getByRole("link", { name: "Board" }).click();
    await expect(page).toHaveURL(/\/app\/board$/);
    await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
    await live(page);
    for (const [id, label] of COLUMNS) {
      await expect(
        column(page, id).getByRole("heading", { name: new RegExp(label) }),
      ).toBeVisible();
      await expect(column(page, id).getByTestId("board-card").first()).toBeVisible();
    }
    expect(await page.getByTestId("board-card").count()).toBe(13);
    await expect(page.getByTestId("board-column-loading")).toHaveCount(0);
    await shot(page, "AGO-146-OBS-step-02-six-columns-populated", { dark: true });

    expect(await titlesIn(page, "inbox")).toEqual(
      expect.arrayContaining(["Inbox plain task", HOSTILE_TITLE]),
    );
    expect(await titlesIn(page, "assigned")).toEqual(
      expect.arrayContaining(["Assigned waiting to start", "Mover starts later"]),
    );
    expect(await titlesIn(page, "in_progress")).toEqual(["Running now"]);
    expect(await titlesIn(page, "in_review")).toEqual(["Finished run for review"]);
    expect((await titlesIn(page, "done")).sort()).toEqual(["Done shipped one", "Done shipped two"]);

    // ---- AC2: Waiting on you, blocked approvals first, oldest first -----------------------------------------------
    const waiting = await titlesIn(page, "waiting_on_you");
    expect(waiting.slice(0, 3)).toEqual([
      "Approval three hours old",
      "Approval two hours old",
      "Approval one hour old",
    ]);
    expect(waiting.slice(3).sort()).toEqual(["Paused by the owner", "Run that failed"]);
    await shot(page, "AGO-146-AC2-step-01-waiting-on-you-oldest-approval-first", {
      dark: true,
      target: column(page, "waiting_on_you"),
    });
    // Each approval card links to its own approval; paused and failed cards have no link.
    const hrefOf = (title: string) =>
      cardIn(page, "waiting_on_you", title).getByTestId("board-card-approval-link");
    for (const [title, id] of [
      ["Approval three hours old", approvalC],
      ["Approval two hours old", approvalA],
      ["Approval one hour old", approvalB],
    ] as const) {
      await expect(hrefOf(title)).toHaveText("Open the approval");
      await expect(hrefOf(title)).toHaveAttribute(
        "href",
        new RegExp(`^/app/approvals\\?approval=${id}#approval-${id}-title$`),
      );
    }
    await expect(page.getByTestId("board-card-approval-link")).toHaveCount(3);
    await expect(cardIn(page, "waiting_on_you", "Paused by the owner")).toContainText("Paused");
    await expect(cardIn(page, "waiting_on_you", "Run that failed")).toContainText("Run failed");

    // Read-only: no approve, deny or edit control on the board; rows unchanged.
    await expect(
      page.getByRole("button", { name: /approve|deny|reject|edit|delete/i }),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="board"] button')).toHaveCount(0);

    // The link opens the approvals inbox at that approval; opening decides nothing.
    await hrefOf("Approval two hours old").click();
    await expect(page).toHaveURL(new RegExp(`/app/approvals\\?approval=${approvalA}#approval-`));
    await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible();
    await expect(page.locator(`#approval-${approvalA}-title`)).toBeVisible();
    await shot(page, "AGO-146-AC2-step-02-open-the-approval-lands-on-it");
    for (const id of [approvalA, approvalB, approvalC]) {
      expect((await svcRow("approvals", id))?.status).toBe("pending");
    }
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/board$/);
    await live(page);

    // ---- Hostile text stays text ---------------------------------------------------------------------------------
    const hostile = cardIn(page, "inbox", "Hostile");
    await expect(hostile).toContainText(HOSTILE_TITLE);
    expect(await hostile.locator("img, b, script").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    await shot(page, "AGO-146-OBS-step-03-hostile-title-is-plain-text", { target: hostile });

    // ---- AC1: cards move with run state, with no reload ----------------------------------------------------------
    await page.evaluate(() => {
      (window as unknown as { __noReload?: number }).__noReload = 1;
    });
    const moverTitle = "Mover starts later";
    await expect(cardIn(page, "assigned", moverTitle)).toBeVisible();
    await shot(page, "AGO-146-AC1-step-01-before-card-in-assigned", { dark: true });
    const moverRun = (
      await svcInsert("runs", {
        workspace_id: workspaceId,
        task_id: mover.id,
        agent_id: agent2.id,
      })
    ).id as string;
    await event(moverRun, workspaceId, "run.created", { agent_id: agent2.id, task_id: mover.id });
    await event(moverRun, workspaceId, "run.started");
    await event(moverRun, workspaceId, "step.started", { step: 1 });
    await expect(cardIn(page, "in_progress", moverTitle)).toBeVisible({ timeout: 20_000 });
    await expect(cardIn(page, "assigned", moverTitle)).toHaveCount(0);
    await expect(cardIn(page, "in_progress", moverTitle)).toContainText("Running");
    await shot(page, "AGO-146-AC1-step-02-run-started-card-in-progress", { dark: true });

    await event(moverRun, workspaceId, "run.paused", {
      requested_by: "human",
      reason: "owner_paused",
    });
    await expect(cardIn(page, "waiting_on_you", moverTitle)).toBeVisible({ timeout: 20_000 });
    await expect(cardIn(page, "in_progress", moverTitle)).toHaveCount(0);
    await shot(page, "AGO-146-AC1-step-03-run-paused-card-waiting-on-you");

    await event(moverRun, workspaceId, "run.resumed", { resumed_by: "human" });
    await expect(cardIn(page, "in_progress", moverTitle)).toBeVisible({ timeout: 20_000 });
    await shot(page, "AGO-146-AC1-step-04-run-resumed-back-in-progress");

    // An approval request lands it first in Waiting on you, above the older paused and failed cards.
    const moverApproval = await requestApproval(workspaceId, moverRun, agent2, 0.1);
    await expect(cardIn(page, "waiting_on_you", moverTitle)).toBeVisible({ timeout: 20_000 });
    await expect(cardIn(page, "waiting_on_you", moverTitle)).toContainText(
      "Waiting for your approval",
    );
    await expect(
      cardIn(page, "waiting_on_you", moverTitle).getByTestId("board-card-approval-link"),
    ).toHaveAttribute("href", new RegExp(`approval=${moverApproval}#`));
    // Poll catches up (5 s): the new approval row's age places the card after the older approvals, before paused.
    await expect
      .poll(async () => (await titlesIn(page, "waiting_on_you")).slice(0, 4), { timeout: 20_000 })
      .toEqual([
        "Approval three hours old",
        "Approval two hours old",
        "Approval one hour old",
        moverTitle,
      ]);
    await shot(page, "AGO-146-AC1-step-05-approval-requested-sorted-into-waiting", { dark: true });

    // The approval is decided: the card leaves Waiting on you at once, and stays out after the next poll.
    await event(moverRun, workspaceId, "approval.decided", {
      approval_id: moverApproval,
      outcome: "approved",
      decided_by: "human",
      payload_hash: hex64(),
    });
    await expect(cardIn(page, "waiting_on_you", moverTitle)).toHaveCount(0, { timeout: 20_000 });
    await expect(cardIn(page, "in_progress", moverTitle)).toBeVisible();
    await page.waitForTimeout(7_000); // one poll interval: the stale pending row must not pull it back
    await expect(cardIn(page, "waiting_on_you", moverTitle)).toHaveCount(0);
    await shot(page, "AGO-146-AC1-step-06-approval-decided-card-back-in-progress");

    // The run finishes: it moves to In review.
    await event(moverRun, workspaceId, "run.completed", { steps: 1 });
    await expect(cardIn(page, "in_review", moverTitle)).toBeVisible({ timeout: 20_000 });
    await expect(cardIn(page, "in_progress", moverTitle)).toHaveCount(0);
    await shot(page, "AGO-146-AC1-step-07-run-completed-card-in-review", { dark: true });
    // No reload happened during the whole walk, and the stream is still live.
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload),
    ).toBe(1);
    await live(page);

    // ---- Persistence: a reload rebuilds the same board from the stored rows and events ---------------------------
    await page.reload();
    await live(page);
    await expect(cardIn(page, "in_review", moverTitle)).toBeVisible();
    expect(await titlesIn(page, "waiting_on_you")).toEqual([
      "Approval three hours old",
      "Approval two hours old",
      "Approval one hour old",
      expect.stringMatching(/Paused by the owner|Run that failed/),
      expect.stringMatching(/Paused by the owner|Run that failed/),
    ]);
    await shot(page, "AGO-146-AC1-step-08-after-reload-same-columns");

    // ---- Widths: desktop scroll row, and 375 px stacked with no sideways page scroll -----------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "AGO-146-OBS-step-04-desktop-1440", { dark: true });
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByTestId("board-card")).toHaveCount(13);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "AGO-146-OBS-step-05-narrow-375-stacked", { dark: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    // ---- Error state: reads fail, last good board stays, then it recovers ----------------------------------------
    const blockRest = (route: { abort: () => Promise<void> }) => route.abort();
    await page.route("**/rest/v1/**", blockRest);
    await expect(page.getByTestId("board-load-error")).toContainText(
      "Couldn't refresh the tasks. Showing the last list",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("board-card")).toHaveCount(13);
    await shot(page, "AGO-146-OBS-step-06-read-error-keeps-last-board", { dark: true });
    await page.unroute("**/rest/v1/**", blockRest);
    await expect(page.getByTestId("board-load-error")).toHaveCount(0, { timeout: 40_000 });
    await shot(page, "AGO-146-OBS-step-07-recovered-after-error");

    // ---- Reconnecting: the realtime socket drops, cards stay, notice shows --------------------------------------
    const sockets: { close: () => Promise<void> }[] = [];
    let blockReconnect = false;
    await context.routeWebSocket(/realtime/, (ws) => {
      if (blockReconnect) return; // never connects
      ws.connectToServer();
      sockets.push({ close: () => ws.close() });
    });
    await page.reload();
    await live(page);
    blockReconnect = true;
    await Promise.all(sockets.map((s) => s.close()));
    await expect(page.getByTestId("board-stream-status")).toHaveAttribute(
      "data-status",
      /reconnecting|connecting/,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("board-stream-status")).toContainText(
      /Connection lost|Connecting to live updates|Reconnecting/,
    );
    await expect(page.getByTestId("board-card")).toHaveCount(13);
    await shot(page, "AGO-146-OBS-step-08-reconnecting-notice", { dark: true });

    // While disconnected a run changes; after the stream comes back the card is caught up, with no duplicate.
    const catchTask = await task(workspaceId, "Caught up after reconnect", {
      agent_id: agent.id,
    });
    const catchRun = await startRun(workspaceId, catchTask, agent);
    await event(catchRun, workspaceId, "step.started", { step: 1 });
    await event(runningRun, workspaceId, "run.completed", { steps: 1 });
    blockReconnect = false;
    await expect(page.getByTestId("board-stream-status")).toHaveAttribute("data-status", "live", {
      timeout: 90_000,
    });
    await expect(cardIn(page, "in_progress", "Caught up after reconnect")).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(cardIn(page, "in_review", "Running now")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText("Caught up after reconnect")).toHaveCount(1);
    await expect(page.getByText("Running now")).toHaveCount(1);
    expect(await page.getByTestId("board-card").count()).toBe(14);
    await shot(page, "AGO-146-AC1-step-09-reconnect-caught-up-no-duplicates", { dark: true });

    expect(problems).toEqual([]);
    // Nothing the board did wrote anything: the approvals are still pending.
    for (const id of [approvalA, approvalB, approvalC]) {
      expect((await svcRow("approvals", id))?.status).toBe("pending");
    }
    expect((await svcRows("tasks", `workspace_id=eq.${workspaceId}&select=id`)).length).toBe(14);
  });

  test("round 2: approval link name and tap target, waiting-on-you banner", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const owner = await createUser("board-banner");
    const workspaceId = await onboard(owner, "Banner Co");
    const agent = await hireAgent(owner, workspaceId, uniq("Worker"));
    const tOld = await task(workspaceId, "Banner approval older", { agent_id: agent.id });
    const tNew = await task(workspaceId, "Banner approval newer", { agent_id: agent.id });
    const runOld = await startRun(workspaceId, tOld, agent);
    const approvalOld = await requestApproval(workspaceId, runOld, agent, 2);
    const runNew = await startRun(workspaceId, tNew, agent);
    const approvalNew = await requestApproval(workspaceId, runNew, agent, 1);

    await signInWithSessionCookie(page.context(), baseURL, owner);

    // ---- Link name and 44 px hit area at 375 px, light and dark ---------------------------------------------------
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/app/board");
    await live(page);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^((?!dark).)*$/);
      for (const title of ["Banner approval older", "Banner approval newer"]) {
        const link = page.getByRole("link", { name: `Open the approval for ${title}` });
        await expect(link).toHaveCount(1);
        await link.evaluate((el) => {
          el.scrollIntoView({ block: "center" });
        });
        const box = await link.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        if (SHOTS_DIR && title === "Banner approval older") {
          await page.screenshot({
            path: join(SHOTS_DIR, `AGO-146-R2-step-01-link-name-and-hit-area-375-${scheme}.png`),
          });
        }
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await expect(
      page.getByRole("link", { name: "Open the approval for Banner approval older" }),
    ).toHaveAttribute("href", new RegExp(`approval=${approvalOld}#`));

    // ---- Banner at 1280 px, visible without scrolling -------------------------------------------------------------
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/app/board");
    await live(page);
    const banner = page.getByTestId("board-waiting-banner");
    await expect(banner).toHaveText("2 tasks are waiting on you. Jump to Waiting on you");
    await expect(banner).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await shot(page, "AGO-146-R2-step-02-banner-visible-1280", { dark: true });

    // ---- The jump link brings the Waiting on you column into view -------------------------------------------------
    await banner.getByRole("link", { name: "Jump to Waiting on you" }).click();
    await expect(page).toHaveURL(/#board-column-waiting_on_you-title$/);
    await expect(
      column(page, "waiting_on_you").getByRole("heading", { name: /Waiting on you/ }),
    ).toBeInViewport({ ratio: 1 });
    await shot(page, "AGO-146-R2-step-03-after-jump-waiting-column-in-view", { dark: true });

    // ---- The banner follows the board: fewer waiting, then none ---------------------------------------------------
    await event(runOld, workspaceId, "approval.decided", {
      approval_id: approvalOld,
      outcome: "approved",
      decided_by: "human",
      payload_hash: hex64(),
    });
    await expect(banner).toHaveText("1 task is waiting on you. Jump to Waiting on you", {
      timeout: 20_000,
    });
    await event(runNew, workspaceId, "approval.decided", {
      approval_id: approvalNew,
      outcome: "approved",
      decided_by: "human",
      payload_hash: hex64(),
    });
    await expect(banner).toHaveCount(0, { timeout: 20_000 });
    await shot(page, "AGO-146-R2-step-04-banner-gone-nothing-waiting-1280", { dark: true });

    // ---- A board with nothing waiting has no banner ---------------------------------------------------------------
    const quiet = await createUser("board-quiet");
    const quietWs = await onboard(quiet, "Quiet Co");
    await task(quietWs, "Only an inbox task");
    await page.context().clearCookies();
    await signInWithSessionCookie(page.context(), baseURL, quiet);
    await page.goto("/app/board");
    await live(page);
    await expect(cardIn(page, "inbox", "Only an inbox task")).toBeVisible();
    await expect(page.getByTestId("board-waiting-banner")).toHaveCount(0);
    await shot(page, "AGO-146-R2-step-05-no-banner-when-nothing-waits-1280", { dark: true });
  });

  test("an empty board, the loading state, and other people's boards", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");

    // Signed out: redirected to sign-in, no board.
    await page.goto("/app/board");
    await expect(page).not.toHaveURL(/\/app\/board$/);

    // Empty workspace.
    const empty = await createUser("board-empty");
    const emptyWs = await onboard(empty, "Empty Board Co");
    await signInWithSessionCookie(page.context(), baseURL, empty);
    await page.goto("/app/board");
    await live(page);
    await expect(page.getByTestId("board-empty")).toContainText("No tasks yet");
    await expect(page.getByTestId("board-column-empty")).toHaveCount(6);
    await expect(page.getByTestId("board-card")).toHaveCount(0);
    await shot(page, "AGO-146-OBS-step-09-empty-board", { dark: true });

    // Loading: the stream never connects, so no column claims a card it cannot place.
    await task(emptyWs, "Never placed while loading");
    let holdSocket = true;
    await context.routeWebSocket(/realtime/, (ws) => {
      if (!holdSocket) ws.connectToServer(); // while held, the socket never opens
    });
    await page.goto("/app/board");
    await expect(page.getByTestId("board-column-loading")).toHaveCount(6);
    await expect(page.getByTestId("board-card")).toHaveCount(0);
    await expect(page.getByTestId("board-stream-status")).toContainText(
      "Connecting to live updates",
    );
    await shot(page, "AGO-146-OBS-step-10-loading-state", { dark: true });
    holdSocket = false;

    // Negative: a member of another workspace never sees this workspace's task.
    const other = await createUser("board-other");
    await onboard(other, "Other Board Co");
    await context.clearCookies();
    await signInWithSessionCookie(page.context(), baseURL, other);
    await page.goto("/app/board");
    await live(page);
    await expect(page.getByText("Never placed while loading")).toHaveCount(0);
    await expect(page.getByTestId("board-empty")).toBeVisible();
    await shot(page, "AGO-146-OBS-step-11-other-workspace-sees-nothing");

    // A viewer of the first workspace can read the board (read-only for everyone).
    const viewer = await createUser("board-viewer");
    await addMember(emptyWs, viewer, "viewer");
    await context.clearCookies();
    await signInWithSessionCookie(page.context(), baseURL, viewer);
    await page.goto("/app/board");
    await live(page);
    await expect(cardIn(page, "inbox", "Never placed while loading")).toBeVisible();
    await shot(page, "AGO-146-OBS-step-12-viewer-can-read-board");
  });
});
