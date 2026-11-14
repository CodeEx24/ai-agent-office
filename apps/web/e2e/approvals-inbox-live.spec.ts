import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { hex64, inAnHour, seedTask, svcInsert, svcRow, uniq, type Row } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-37 device flow: the approvals inbox, driven through the real UI and checked against the database.
// Local stack only (E2E_SUPABASE=1). Seeded the way the live Vitest test does: agents are hired as the workspace
// owner through the Data API (a service-role insert into agents is refused), runs, approvals and run events are
// written as service_role. Sign-in writes the session cookie of a real throw-away sign-up (no inbox, no secrets).
//
//   AC1  pending list with age and agent (and the Approvals link on /app)
//   AC2  a decision removes the card within 2 seconds (measured in the browser) and is stored
//   AC3  card shows reason, recent steps, cost and the payload fingerprint (the full payload is a recorded deferral)
//   +    Edit and Ask are disabled with a reason, a viewer sees no decide buttons, hostile agent text stays text
//
// Set E2E_SHOTS_DIR to also save a screenshot of every step into that folder (working files, never committed).
const SHOTS_DIR = process.env.E2E_SHOTS_DIR;
const BUDGET_MS = 2_000;
const HOSTILE_AGENT = "<img src=x onerror=window.__xss=1>Eve";
const HOSTILE_TOOL = "<script>window.__xss=2</script>send";

test.describe("AGO-37: approvals inbox (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 180_000 });

  if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });
  async function shot(page: Page, name: string): Promise<void> {
    if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage: true });
  }

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

  async function event(runId: string, workspaceId: string, type: string, payload: Row) {
    await svcInsert("run_events", {
      workspace_id: workspaceId,
      run_id: runId,
      type,
      payload: { version: 1, ...payload },
    });
  }

  /** A pending approval for a freshly hired agent, with the run events the card reads. */
  async function seedPending(
    owner: TestUser,
    workspaceId: string,
    options: { agentName: string; action: string; waitedMinutes: number; hash: string },
  ): Promise<string> {
    const agent = await hireAgent(owner, workspaceId, options.agentName);
    const task = await seedTask(workspaceId, agent.id as string);
    const run = await svcInsert("runs", {
      workspace_id: workspaceId,
      task_id: task.id,
      agent_id: agent.id,
    });
    const approval = await svcInsert("approvals", {
      workspace_id: workspaceId,
      run_id: run.id,
      agent_id: agent.id,
      action: options.action,
      payload_hash: options.hash,
      expires_at: inAnHour(),
      created_at: new Date(Date.now() - options.waitedMinutes * 60_000).toISOString(),
    });
    const runId = run.id as string;
    const callId = uniq("call");
    await event(runId, workspaceId, "step.started", { step: 1 });
    await event(runId, workspaceId, "policy.decision", {
      call_id: callId,
      decision: "needs_approval",
      tier: 3,
      reason_code: "tier_3_needs_human",
    });
    await event(runId, workspaceId, "approval.requested", {
      approval_id: approval.id,
      call_id: callId,
      payload_hash: options.hash,
      tier: 3,
      expires_at: inAnHour(),
    });
    await event(runId, workspaceId, "budget.usage", {
      input_tokens: 1000,
      output_tokens: 200,
      cost_micros: 12_345,
    });
    return approval.id as string;
  }

  test("owner walks the inbox; a viewer only reads it", async ({ page, baseURL, browser }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const owner = await createUser("inbox-owner");
    const viewer = await createUser("inbox-viewer");
    const workspaceId = await onboard(owner, "Inbox Co");
    await addMember(workspaceId, viewer, "viewer");

    const hashA = hex64();
    const hashB = hex64();
    const hashHostile = hex64();
    const nameA = uniq("Analyst");
    const nameB = uniq("Writer");
    const idA = await seedPending(owner, workspaceId, {
      agentName: nameA,
      action: "email.send",
      waitedMinutes: 25,
      hash: hashA,
    });
    const idB = await seedPending(owner, workspaceId, {
      agentName: nameB,
      action: "calendar.invite",
      waitedMinutes: 2,
      hash: hashB,
    });
    const idHostile = await seedPending(owner, workspaceId, {
      agentName: HOSTILE_AGENT,
      action: HOSTILE_TOOL,
      waitedMinutes: 0,
      hash: hashHostile,
    });

    await signInWithSessionCookie(page.context(), baseURL, owner);

    // AC1: from the home page, the Approvals link opens the inbox.
    await page.goto("/app");
    await expect(page.getByTestId("workspace-role")).toHaveText("owner");
    await shot(page, "01-ac1-home-approvals-link");
    await page.getByRole("link", { name: "Approvals" }).click();
    await expect(page).toHaveURL(/\/app\/approvals$/);
    await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
    const cards = page.getByTestId("approval-card");
    await expect(cards).toHaveCount(3);
    await shot(page, "02-ac1-list");

    // AC1: each card names the agent and how long it has waited.
    const cardA = cards.filter({ hasText: nameA });
    await expect(cardA).toContainText(`${nameA} wants to run email.send`);
    await expect(cardA.getByTestId("approval-age")).toHaveText(/^Waiting 2[5-7] min$/);
    const cardB = cards.filter({ hasText: nameB });
    await expect(cardB.getByTestId("approval-age")).toHaveText(/^Waiting [2-4] min$/);
    await shot(page, "03-ac1-agent-and-age");

    // AC3: reason, tool, payload fingerprint (full payload is a recorded deferral), steps and cost.
    await expect(cardA.getByTestId("approval-reason")).toHaveText("tier_3_needs_human");
    await expect(cardA).toContainText("Tier 3");
    await expect(cardA.getByTestId("approval-payload")).toContainText(`${hashA.slice(0, 12)}…`);
    await expect(cardA.getByTestId("approval-payload")).toContainText(
      "the full payload is not stored yet",
    );
    await expect(cardA.getByTestId("approval-steps")).toContainText("Approval requested");
    await expect(cardA.getByTestId("approval-cost")).toContainText("$0.01");
    await expect(cardA.getByTestId("approval-cost")).toContainText("1,200 tokens");
    await cardA.scrollIntoViewIfNeeded();
    await shot(page, "04-ac3-card-content");

    // Edit and Ask are visibly disabled and carry the reason.
    for (const name of ["Edit", "Ask"]) {
      const button = cardA.getByRole("button", { name, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("title", /Not available yet/);
    }
    await cardA.getByRole("button", { name: "Edit", exact: true }).hover({ force: true });
    await shot(page, "05-edit-ask-disabled");

    // Hostile agent text is shown as text and never runs or becomes markup.
    const hostile = cards.filter({ hasText: "wants to run" }).filter({ hasText: "Eve" });
    await expect(hostile).toContainText(HOSTILE_AGENT);
    await expect(hostile).toContainText(HOSTILE_TOOL);
    expect(await hostile.locator("img, script").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    await hostile.scrollIntoViewIfNeeded();
    await shot(page, "06-hostile-text-inert");

    // A viewer sees the same inbox with no Approve or Reject.
    const viewerContext = await browser.newContext();
    const viewerErrors: string[] = [];
    try {
      const viewerPage = await viewerContext.newPage();
      viewerPage.on("console", (m) => {
        if (m.type() === "error") viewerErrors.push(m.text());
      });
      viewerPage.on("pageerror", (e) => viewerErrors.push(e.message));
      await signInWithSessionCookie(viewerContext, baseURL, viewer);
      await viewerPage.goto("/app/approvals");
      await expect(viewerPage.getByTestId("approval-card")).toHaveCount(3);
      await expect(viewerPage.getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(viewerPage.getByRole("button", { name: "Reject" })).toHaveCount(0);
      await expect(
        viewerPage.getByText("Only members can decide an approval.").first(),
      ).toBeVisible();
      await shot(viewerPage, "07-viewer-read-only");
    } finally {
      await viewerContext.close();
    }
    expect(viewerErrors).toEqual([]);

    // AC2: approve card A and measure, in the page, from the click to the card leaving the list.
    await page.evaluate((cardSelector) => {
      const w = window as unknown as { __clickAt?: number; __goneAt?: number };
      w.__clickAt = undefined;
      w.__goneAt = undefined;
      document.addEventListener(
        "click",
        (e) => {
          const target = e.target as HTMLElement | null;
          if (target?.closest("button")?.textContent === "Approve" && w.__clickAt === undefined) {
            w.__clickAt = performance.now();
          }
        },
        true,
      );
      const list = document.querySelector("[data-testid=approvals-list]");
      const watcher = new MutationObserver(() => {
        const names = [...document.querySelectorAll(cardSelector)].map((el) => el.textContent);
        if (
          w.__clickAt !== undefined &&
          w.__goneAt === undefined &&
          !names.some((t) => t.includes("email.send"))
        ) {
          w.__goneAt = performance.now();
        }
      });
      if (list) watcher.observe(list, { childList: true, subtree: true, characterData: true });
    }, "[data-testid=approval-card]");
    await shot(page, "08-ac2-before-approve");
    await cardA.getByRole("button", { name: "Approve" }).click();
    await expect(cards.filter({ hasText: nameA })).toHaveCount(0, { timeout: BUDGET_MS * 2 });
    const latencyMs = await page.evaluate(() => {
      const w = window as unknown as { __clickAt?: number; __goneAt?: number };
      return w.__clickAt !== undefined && w.__goneAt !== undefined
        ? w.__goneAt - w.__clickAt
        : null;
    });
    await shot(page, "09-ac2-after-approve");
    console.log(
      `AGO-37 approve latency (click to card gone, in the page): ${String(latencyMs)} ms`,
    );
    expect(latencyMs).not.toBeNull();
    expect(latencyMs ?? Infinity).toBeLessThan(BUDGET_MS);
    expect((await svcRow("approvals", idA))?.status).toBe("approved");
    expect(typeof (await svcRow("approvals", idA))?.decided_by).toBe("string");

    // AC2: reject card B; it leaves the list and is stored as denied.
    const rejectStart = Date.now();
    await cardB.getByRole("button", { name: "Reject" }).click();
    await expect(cards.filter({ hasText: nameB })).toHaveCount(0, { timeout: BUDGET_MS * 2 });
    console.log(
      `AGO-37 reject latency (click to card gone, from the test): ${String(Date.now() - rejectStart)} ms`,
    );
    expect((await svcRow("approvals", idB))?.status).toBe("denied");
    await shot(page, "10-ac2-after-reject");

    // Persistence: after a reload the decided cards stay gone and the other one is still pending.
    await page.reload();
    await expect(cards).toHaveCount(1);
    await expect(page.getByTestId("approval-card").filter({ hasText: "Eve" })).toBeVisible();
    expect((await svcRow("approvals", idHostile))?.status).toBe("pending");
    await shot(page, "11-persisted-after-reload");

    // Narrow screen: the card stays readable with no sideways scroll.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(cards).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "12-narrow-375");

    // Empty state once everything is decided.
    await page.setViewportSize({ width: 1280, height: 800 });
    await cards.first().getByRole("button", { name: "Reject" }).click();
    await expect(page.getByTestId("approvals-empty")).toHaveText("Nothing is waiting for you.", {
      timeout: BUDGET_MS * 2,
    });
    await shot(page, "13-empty-state");
  });
});
