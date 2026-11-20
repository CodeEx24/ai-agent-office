import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import {
  hex64,
  inAnHour,
  seedTask,
  svcInsert,
  svcRow,
  svcRows,
  uniq,
  type Row,
} from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-150 device flow: the agent cards at /app/office, driven through the real UI. Local stack only (E2E_SUPABASE=1).
// Agents are hired as the workspace owner through the Data API; runs, approvals and run events are written as
// service_role (synthetic rows in the local database, never a real model call). Sign-in writes the session cookie of
// a real throw-away sign-up (no inbox, no secrets).
//
//   AC1  six states, each with its own text label and shape (also with all color removed), light and dark
//   AC2  "Waiting on you" is a red badge; it opens /app/approvals at that approval and decides nothing
//   +    a decided or missing approval gets the "no longer pending" cue; empty, loading and reconnecting states;
//        agent text such as <script> in a name stays text; a live event changes a card without a reload
//
// Set E2E_SHOTS_DIR to also save a screenshot of every step (light and dark) into that folder (never committed).
const SHOTS_DIR = process.env.E2E_SHOTS_DIR;
const HOSTILE_NAME = "<script>window.__xss=1</script>Mallory";
const HOSTILE_ROLE = "<img src=x onerror=window.__xss=2>Role";
const STATE_LABELS = [
  "Idle",
  "Working",
  "Thinking",
  "Collaborating",
  "Waiting on you",
  "Error or paused",
] as const;

test.describe("AGO-150: agent cards (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 240_000 });

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

  async function hireAgent(
    owner: TestUser,
    workspaceId: string,
    name: string,
    role = "Role text",
  ): Promise<Row> {
    const created = await asUser<Row[]>(owner, "/rest/v1/agents", {
      method: "POST",
      prefer: "return=representation",
      body: {
        workspace_id: workspaceId,
        name,
        role,
        model: "claude-sonnet-4-5",
        prompt: "Do the work carefully.",
      },
    });
    const row = created.body[0];
    if (created.status !== 201 || !row)
      throw new Error(`hiring an agent failed: ${String(created.status)}`);
    return row;
  }

  async function event(runId: string, workspaceId: string, type: string, payload: Row) {
    await svcInsert("run_events", {
      workspace_id: workspaceId,
      run_id: runId,
      type,
      payload: { version: 1, ...payload },
    });
  }

  async function startRun(workspaceId: string, agent: Row): Promise<string> {
    const task = await seedTask(workspaceId, agent.id as string);
    const run = await svcInsert("runs", {
      workspace_id: workspaceId,
      task_id: task.id,
      agent_id: agent.id,
    });
    const runId = run.id as string;
    await event(runId, workspaceId, "run.created", { agent_id: agent.id, task_id: task.id });
    await event(runId, workspaceId, "run.started", {});
    return runId;
  }

  /** A run that asks for approval. `row`: the approvals row exists as `pending`, `approved`, or not at all. */
  async function seedWaiting(
    workspaceId: string,
    agent: Row,
    row: "pending" | "approved" | "missing",
  ): Promise<string> {
    const runId = await startRun(workspaceId, agent);
    const hash = hex64();
    const callId = uniq("call");
    let approvalId = crypto.randomUUID();
    if (row !== "missing") {
      const approval = await svcInsert("approvals", {
        workspace_id: workspaceId,
        run_id: runId,
        agent_id: agent.id,
        action: "email.send",
        payload_hash: hash,
        status: row,
        expires_at: inAnHour(),
      });
      approvalId = approval.id as string;
    }
    await event(runId, workspaceId, "step.started", { step: 1 });
    await event(runId, workspaceId, "approval.requested", {
      approval_id: approvalId,
      call_id: callId,
      payload_hash: hash,
      tier: 3,
      expires_at: inAnHour(),
    });
    return approvalId;
  }

  const card = (page: Page, name: string) =>
    page.getByTestId("agent-card").filter({ hasText: name });

  test("owner walks the six states and the waiting-on-you link", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const owner = await createUser("cards-owner");
    const workspaceId = await onboard(owner, "Cards Co");

    // One agent per state, plus the extras the criteria need.
    const names = {
      idle: uniq("Idle"),
      working: uniq("Working"),
      thinking: uniq("Thinking"),
      collaborating: uniq("Collab"),
      target: uniq("Target"),
      waitingA: uniq("WaitA"),
      waitingB: uniq("WaitB"),
      waitingC: uniq("WaitC"),
      paused: uniq("Paused"),
      decided: uniq("Decided"),
      missing: uniq("Missing"),
    };
    await hireAgent(owner, workspaceId, names.idle);
    const working = await hireAgent(owner, workspaceId, names.working);
    const thinking = await hireAgent(owner, workspaceId, names.thinking);
    const collab = await hireAgent(owner, workspaceId, names.collaborating);
    const target = await hireAgent(owner, workspaceId, names.target);
    const waitA = await hireAgent(owner, workspaceId, names.waitingA);
    const waitB = await hireAgent(owner, workspaceId, names.waitingB);
    const waitC = await hireAgent(owner, workspaceId, names.waitingC);
    const paused = await hireAgent(owner, workspaceId, names.paused);
    const decided = await hireAgent(owner, workspaceId, names.decided);
    const missing = await hireAgent(owner, workspaceId, names.missing);
    const hostile = await hireAgent(owner, workspaceId, HOSTILE_NAME, HOSTILE_ROLE);

    // working: a tool call in flight
    const workingRun = await startRun(workspaceId, working);
    await event(workingRun, workspaceId, "step.started", { step: 1 });
    await event(workingRun, workspaceId, "tool_call.requested", {
      call_id: uniq("call"),
      tool_name: "web.search",
      tier: 1,
      input_hash: hex64(),
    });
    // thinking: a step with no tool
    await event(await startRun(workspaceId, thinking), workspaceId, "step.started", { step: 1 });
    // collaborating: an open handoff (the receiving agent shows it too)
    await event(await startRun(workspaceId, collab), workspaceId, "handoff.created", {
      handoff_id: uniq("handoff"),
      to_agent_id: target.id,
      reason: "needs a review",
    });
    // waiting on you: three agents; the last one is the one the click test uses
    const approvalA = await seedWaiting(workspaceId, waitA, "pending");
    const approvalB = await seedWaiting(workspaceId, waitB, "pending");
    const approvalC = await seedWaiting(workspaceId, waitC, "pending");
    // error or paused
    await event(await startRun(workspaceId, paused), workspaceId, "run.paused", {
      requested_by: "human",
      reason: "owner_paused",
    });
    // waiting, but the request was already decided, or was never in the inbox
    const approvalDecided = await seedWaiting(workspaceId, decided, "approved");
    const approvalMissing = await seedWaiting(workspaceId, missing, "missing");
    // hostile text in the name and role, in a working state
    const hostileRun = await startRun(workspaceId, hostile);
    await event(hostileRun, workspaceId, "step.started", { step: 1 });
    await event(hostileRun, workspaceId, "tool_call.requested", {
      call_id: uniq("call"),
      tool_name: "web.search",
      tier: 1,
      input_hash: hex64(),
    });

    await signInWithSessionCookie(page.context(), baseURL, owner);

    // ---- AC1: six states, each with its own label and shape ------------------------------------------------------
    await page.goto("/app");
    await expect(page.getByTestId("workspace-role")).toHaveText("owner");
    await shot(page, "AGO-150-AC1-step-01-home");
    await page.goto("/app/office");
    await expect(page.getByRole("heading", { name: "Office" })).toBeVisible();
    await expect(page.getByTestId("office-stream-status")).toHaveAttribute("data-status", "live");
    const cards = page.getByTestId("agent-card");
    await expect(cards).toHaveCount(12);
    await expect(page.getByText("Loading state…")).toHaveCount(0);
    await shot(page, "AGO-150-AC1-step-02-all-cards");

    const expected: Record<string, (typeof STATE_LABELS)[number]> = {
      [names.idle]: "Idle",
      [names.working]: "Working",
      [names.thinking]: "Thinking",
      [names.collaborating]: "Collaborating",
      [names.target]: "Collaborating",
      [names.waitingA]: "Waiting on you",
      [names.waitingB]: "Waiting on you",
      [names.waitingC]: "Waiting on you",
      [names.paused]: "Error or paused",
      [names.decided]: "Waiting on you",
      [names.missing]: "Waiting on you",
      [HOSTILE_NAME]: "Working",
    };
    for (const [name, label] of Object.entries(expected)) {
      const badge = card(page, name).getByTestId("agent-state-badge");
      await expect(badge).toHaveText(label);
      await expect(badge).toBeVisible();
    }
    // Six distinct labels and six distinct shapes across the grid.
    const labels = await page.getByTestId("agent-state-badge").allInnerTexts();
    expect(new Set(labels.map((l) => l.trim()))).toEqual(new Set(STATE_LABELS));
    const shapes = await page
      .getByTestId("agent-state-badge")
      .locator("svg")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-shape")));
    expect(new Set(shapes).size).toBe(6);
    await shot(page, "AGO-150-AC1-step-03-one-card-per-state", card(page, names.thinking));

    // Color-independent: with all color removed, the label and the shape still tell the states apart.
    const grayscale = await page.addStyleTag({ content: "html{filter:grayscale(1) !important}" });
    await shot(page, "AGO-150-AC1-step-04-grayscale-labels-still-distinct");
    await grayscale.evaluate((el) => el.parentNode?.removeChild(el));

    // ---- AC2: waiting on you is red, and opens the approval -------------------------------------------------------
    const waitingCard = card(page, names.waitingC);
    const badge = waitingCard.getByTestId("agent-state-badge");
    const toRgb = (el: HTMLElement) => {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const [r, g, b] = await badge.evaluate(toRgb);
    expect(r ?? 0).toBeGreaterThan(150);
    expect(r ?? 0).toBeGreaterThan((g ?? 255) + 60);
    expect(r ?? 0).toBeGreaterThan((b ?? 255) + 60);
    // No other state is red.
    const idleRgb = await card(page, names.idle).getByTestId("agent-state-badge").evaluate(toRgb);
    expect((idleRgb[0] ?? 0) - (idleRgb[1] ?? 0)).toBeLessThan(40);
    await waitingCard.scrollIntoViewIfNeeded();
    await shot(page, "AGO-150-AC2-step-01-red-waiting-badge", waitingCard);

    const link = waitingCard.getByTestId("agent-approval-link");
    await expect(link).toHaveAttribute(
      "href",
      new RegExp(`^/app/approvals\\?approval=${approvalC}#approval-${approvalC}-title$`),
    );
    await expect(link).toHaveAccessibleName(/Agent state: Waiting on you/);
    // Only the waiting cards link; the other states have no link.
    await expect(page.getByTestId("agent-approval-link")).toHaveCount(5);
    expect(await card(page, names.working).locator("a, button").count()).toBe(0);

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/app/approvals\\?approval=${approvalC}#approval-`));
    await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible();
    await expect(page.getByTestId("approval-link-not-pending")).toHaveCount(0);
    const approvalCards = page.getByTestId("approval-card");
    await expect(approvalCards).toHaveCount(3);
    const target3 = page.locator(`#approval-${approvalC}-title`);
    await expect(target3).toBeVisible();
    await expect(target3).toBeInViewport();
    await expect(page.getByText(`${names.waitingC} wants to run email.send`)).toBeVisible();
    await shot(page, "AGO-150-AC2-step-02-approvals-opened-at-request");
    // Nothing was decided by opening it.
    for (const id of [approvalA, approvalB, approvalC]) {
      expect((await svcRow("approvals", id))?.status).toBe("pending");
    }
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(3);
    await expect(page.getByTestId("approval-result")).toHaveCount(0);

    // ---- A decided or a missing approval: the "no longer pending" cue --------------------------------------------
    for (const [step, name, id] of [
      ["03-decided", names.decided, approvalDecided],
      ["04-missing", names.missing, approvalMissing],
    ] as const) {
      await page.goto("/app/office");
      await expect(card(page, name).getByTestId("agent-approval-link")).toBeVisible();
      await card(page, name).getByTestId("agent-approval-link").click();
      await expect(page).toHaveURL(new RegExp(`/app/approvals\\?approval=${id}#approval-`));
      await expect(page.getByTestId("approval-link-not-pending")).toContainText(
        "That request is no longer pending",
      );
      await expect(page.getByTestId("approval-card")).toHaveCount(3);
      await shot(page, `AGO-150-AC2-step-${step}-no-longer-pending-cue`);
    }
    expect((await svcRow("approvals", approvalDecided))?.status).toBe("approved");
    for (const id of [approvalA, approvalB, approvalC]) {
      expect((await svcRow("approvals", id))?.status).toBe("pending");
    }

    // ---- Hostile agent text stays text ---------------------------------------------------------------------------
    await page.goto("/app/office");
    await expect(page.getByTestId("office-stream-status")).toHaveAttribute("data-status", "live");
    const hostileCard = card(page, "Mallory");
    await expect(hostileCard).toContainText(HOSTILE_NAME);
    await expect(hostileCard).toContainText(HOSTILE_ROLE);
    expect(await hostileCard.locator("script, img").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    await hostileCard.scrollIntoViewIfNeeded();
    await shot(page, "AGO-150-AC1-step-05-hostile-text-is-plain", hostileCard);

    // ---- A live event changes a card without a reload ------------------------------------------------------------
    const cardA = card(page, names.waitingA);
    await expect(cardA.getByTestId("agent-approval-link")).toBeVisible();
    const runA = (await svcRows("runs", `agent_id=eq.${String(waitA.id)}&select=id`))[0]?.id;
    await event(runA as string, workspaceId, "approval.decided", {
      approval_id: approvalA,
      outcome: "approved",
      decided_by: "human",
      payload_hash: hex64(),
    });
    await expect(cardA.getByTestId("agent-state-badge")).toHaveText("Thinking", {
      timeout: 15_000,
    });
    await expect(cardA.getByTestId("agent-approval-link")).toHaveCount(0);
    await shot(page, "AGO-150-AC2-step-05-live-card-updated-no-link");

    // ---- Persistence: a reload rebuilds the same states from the stored events -----------------------------------
    await page.reload();
    await expect(page.getByTestId("office-stream-status")).toHaveAttribute("data-status", "live");
    await expect(card(page, names.paused).getByTestId("agent-state-badge")).toHaveText(
      "Error or paused",
    );
    await expect(card(page, names.waitingA).getByTestId("agent-state-badge")).toHaveText(
      "Thinking",
    );
    await expect(card(page, names.waitingB).getByTestId("agent-state-badge")).toHaveText(
      "Waiting on you",
    );

    // ---- Narrow screen: no sideways scroll -----------------------------------------------------------------------
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(cards).toHaveCount(12);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "AGO-150-AC1-step-06-narrow-375");
    await page.setViewportSize({ width: 1280, height: 800 });

    // ---- Stream states: reconnecting after the realtime socket drops ----------------------------------------------
    const sockets: { close: () => Promise<void> }[] = [];
    let blockReconnect = false;
    await context.routeWebSocket(/realtime/, (ws) => {
      if (blockReconnect) return; // never connects: the channel times out
      ws.connectToServer();
      sockets.push({ close: () => ws.close() });
    });
    await page.reload();
    await expect(page.getByTestId("office-stream-status")).toHaveAttribute("data-status", "live", {
      timeout: 20_000,
    });
    blockReconnect = true;
    await Promise.all(sockets.map((s) => s.close()));
    await expect(page.getByTestId("office-stream-status")).toHaveAttribute(
      "data-status",
      /reconnecting|connecting/,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("office-stream-status")).toContainText(
      /Connection lost|Connecting to live updates/,
    );
    await shot(page, "AGO-150-AC3-step-01-reconnecting-banner");
    await expect(cards).toHaveCount(12);
  });

  test("an empty office, and the loading state before the stream connects", async ({
    page,
    baseURL,
    context,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const owner = await createUser("cards-empty");
    const workspaceId = await onboard(owner, "Empty Cards Co");
    await signInWithSessionCookie(page.context(), baseURL, owner);

    await page.goto("/app/office");
    await expect(page.getByTestId("agent-cards-empty")).toContainText("No agents yet");
    await expect(page.getByTestId("agent-card")).toHaveCount(0);
    await shot(page, "AGO-150-AC3-step-02-empty-no-agents");

    // Loading: an agent exists, but the stream never connects, so no card claims a state it does not know.
    const agent = await hireAgent(owner, workspaceId, uniq("Loader"));
    await event(await startRun(workspaceId, agent), workspaceId, "step.started", { step: 1 });
    await context.routeWebSocket(/realtime/, () => {
      // hold the socket: it never opens
    });
    await page.goto("/app/office");
    const only = page.getByTestId("agent-card");
    await expect(only).toHaveCount(1);
    await expect(only).toHaveAttribute("data-state", "loading");
    await expect(page.getByText("Loading state…")).toBeVisible();
    await expect(page.getByTestId("agent-state-badge")).toHaveCount(0);
    await expect(page.getByTestId("office-stream-status")).toContainText(
      "Connecting to live updates",
    );
    await shot(page, "AGO-150-AC3-step-03-loading-state");
  });
});
