import path from "node:path";

import type { Page } from "@playwright/test";
import { GOAL_MESSAGES } from "@ago/shared/goal-limits";

import { expect, isLiveStack, test } from "./fixtures";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-113 device test (round 1): the goal inbox as a person uses it, on the local stack (E2E_SUPABASE=1).
// Run inside the db lock: `node scripts/db-lock.mjs acquire AGO-113`. One test per acceptance criterion:
//   AC1  submitting a goal creates a goal record and a Manager task
//   AC2  empty goals are rejected (and a workspace with no Manager is refused cleanly)
//   AC3  another workspace's account cannot see or submit into it (tests pass, no regressions)
// Set E2E_SCREENSHOT_DIR to also save step-by-step screenshots, in light and dark.
test.describe("AGO-113: goal inbox (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 180_000 });

  // Characters are built from code points so no invisible character sits in the source.
  const cp = (codePoint: number) => String.fromCodePoint(codePoint);
  const GOAL = "Grow weekly signups by 20% this quarter";

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  // The service role cannot insert agents (the run-limits check is executable by signed-in users only), so the
  // Manager is made the way the product makes one: the owner calls create_agent.
  async function addManager(owner: TestUser, workspaceId: string): Promise<string> {
    const result = await asUser<string>(owner, "/rest/v1/rpc/create_agent", {
      method: "POST",
      body: {
        p_workspace_id: workspaceId,
        p_name: "Manager",
        p_role: "Manager",
        p_model: "claude-sonnet-5-5",
        p_prompt: "You turn goals into tasks.",
        p_daily_budget_cents: 500,
        p_skill_ids: [],
        p_capabilities: [],
      },
    });
    if (result.status !== 200) throw new Error("create_agent failed: " + String(result.status));
    return result.body;
  }

  /** Saves the page in light and dark when E2E_SCREENSHOT_DIR is set; does nothing otherwise. */
  async function shoot(page: Page, name: string) {
    const dir = process.env.E2E_SCREENSHOT_DIR;
    if (!dir) return;
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${scheme}\\b`));
      await page.screenshot({ path: path.join(dir, `${name}-${scheme}.png`), fullPage: true });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveClass(/\blight\b/);
  }

  async function world() {
    const member = await createUser("g113-member");
    const viewer = await createUser("g113-viewer");
    const stranger = await createUser("g113-stranger");
    const nomanager = await createUser("g113-nomanager");
    const workspaceId = await onboard(member, "Goal Inbox Co");
    await addMember(workspaceId, viewer, "viewer");
    const managerId = await addManager(member, workspaceId);
    const otherWorkspaceId = await onboard(stranger, "Goal Inbox Elsewhere Co");
    await addManager(stranger, otherWorkspaceId);
    const noManagerWorkspaceId = await onboard(nomanager, "Goal Inbox No Manager Co");
    return {
      member,
      viewer,
      stranger,
      nomanager,
      workspaceId,
      managerId,
      otherWorkspaceId,
      noManagerWorkspaceId,
    };
  }

  const goalsIn = (workspaceId: string) =>
    svcRows("goals", `workspace_id=eq.${workspaceId}&select=*&order=created_at`);
  const tasksIn = (workspaceId: string) =>
    svcRows("tasks", `workspace_id=eq.${workspaceId}&select=*&order=created_at`);

  test("AC1: a member submits a goal and it lands with a Manager task", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.member);
    await page.goto("/app/goals");
    await expect(page.getByRole("heading", { level: 1, name: "Goals" })).toBeVisible();
    await expect(page.getByTestId("goal-list-empty")).toBeVisible();
    await shoot(page, "ac1-01-empty-inbox");

    const box = page.getByRole("textbox", { name: "Goal", exact: true });
    await box.fill(`  ${GOAL}  `);
    await shoot(page, "ac1-02-goal-typed");
    await page.getByRole("button", { name: "Submit goal" }).click();

    await expect(page.getByTestId("goal-submitted")).toBeVisible();
    await expect(box).toHaveValue("");
    const list = page.getByRole("list", { name: "Submitted goals" });
    await expect(list).toContainText(GOAL);
    await shoot(page, "ac1-03-goal-submitted");

    // Ground truth in the database: one goal, one task for the Manager, linked, in the same workspace.
    const goals = await goalsIn(w.workspaceId);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ text: GOAL, workspace_id: w.workspaceId });
    const tasks = await tasksIn(w.workspaceId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      goal_id: goals[0]?.id,
      agent_id: w.managerId,
      workspace_id: w.workspaceId,
    });
    expect(String(tasks[0]?.title)).toContain("Plan goal: Grow weekly signups");

    // It persists: a reload still lists the goal.
    await page.reload();
    await expect(page.getByRole("list", { name: "Submitted goals" })).toContainText(GOAL);
  });

  test("AC2: empty, whitespace-only and zero-width-only goals are refused with clear copy", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.member);
    await page.goto("/app/goals");

    let actionRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) actionRequests += 1;
    });

    const box = page.getByRole("textbox", { name: "Goal", exact: true });
    const submit = page.getByRole("button", { name: "Submit goal" });
    const attempts: [string, string][] = [
      ["empty", ""],
      ["whitespace", "     \n\t  "],
      ["zero-width", [cp(0x200b), cp(0x200d), cp(0xfeff)].join("")],
    ];
    for (const [name, text] of attempts) {
      await box.fill(text);
      await submit.click();
      const error = page.getByTestId("goal-field-error");
      await expect(error, name).toHaveText(GOAL_MESSAGES.required);
      await expect(box, name).toHaveAttribute("aria-invalid", "true");
      if (name === "empty") await shoot(page, "ac2-01-empty-refused");
      if (name === "whitespace") await shoot(page, "ac2-02-whitespace-refused");
      if (name === "zero-width") await shoot(page, "ac2-03-zero-width-refused");
    }

    // Nothing was sent and nothing was stored.
    expect(actionRequests, "no request reaches the server for a blank goal").toBe(0);
    expect(await goalsIn(w.workspaceId)).toHaveLength(0);
    expect(await tasksIn(w.workspaceId)).toHaveLength(0);

    // Typing clears the message, and a real goal then goes through.
    await box.fill(GOAL);
    await expect(page.getByTestId("goal-field-error")).toBeEmpty();
    await submit.click();
    await expect(page.getByTestId("goal-submitted")).toBeVisible();
    expect(await goalsIn(w.workspaceId)).toHaveLength(1);
  });

  test("AC2: a workspace with no Manager is refused cleanly and nothing is stored", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.nomanager);
    await page.goto("/app/goals");
    const box = page.getByRole("textbox", { name: "Goal", exact: true });
    await box.fill(GOAL);
    await page.getByRole("button", { name: "Submit goal" }).click();

    await expect(page.getByTestId("goal-form-error")).toHaveText(GOAL_MESSAGES.noManager);
    await expect(box).toHaveValue(GOAL);
    await expect(page.getByTestId("goal-submitted")).toHaveCount(0);
    await shoot(page, "ac2-04-no-manager");

    expect(await goalsIn(w.noManagerWorkspaceId)).toHaveLength(0);
    expect(await tasksIn(w.noManagerWorkspaceId)).toHaveLength(0);
  });

  test("AC3: an account in another workspace cannot see or submit into the goal", async ({
    page,
    browser,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.member);
    await page.goto("/app/goals");
    await page.getByRole("textbox", { name: "Goal", exact: true }).fill(GOAL);
    await page.getByRole("button", { name: "Submit goal" }).click();
    await expect(page.getByTestId("goal-submitted")).toBeVisible();

    // A second account in a different workspace, in its own browser session.
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage();
      await signIn(otherPage, baseURL, w.stranger);
      await otherPage.goto("/app/goals");
      await expect(otherPage.getByTestId("goal-list-empty")).toBeVisible();
      await expect(otherPage.locator("main")).not.toContainText(GOAL);
      await shoot(otherPage, "ac3-01-other-workspace-sees-nothing");
    } finally {
      await other.close();
    }

    // Directly against the Data API, too: no goals visible, and a submit into the first workspace is refused.
    const visible = await asUser<unknown[]>(w.stranger, "/rest/v1/goals?select=id");
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual([]);
    const attempt = await asUser(w.stranger, "/rest/v1/rpc/submit_goal", {
      method: "POST",
      body: { p_workspace_id: w.workspaceId, p_text: "sneaking in" },
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(await goalsIn(w.workspaceId)).toHaveLength(1);
    expect(await tasksIn(w.workspaceId)).toHaveLength(1);
  });

  test("AC3: a viewer reads the goals but has no form and cannot submit", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    // The goals table has no insert grant for anyone, so the owner submits it the way the product does.
    const seeded = await asUser(w.member, "/rest/v1/rpc/submit_goal", {
      method: "POST",
      body: { p_workspace_id: w.workspaceId, p_text: GOAL },
    });
    expect(seeded.status).toBe(200);
    await signIn(page, baseURL, w.viewer);
    await page.goto("/app/goals");
    await expect(page.getByRole("list", { name: "Submitted goals" })).toContainText(GOAL);
    await expect(page.getByRole("textbox", { name: "Goal", exact: true })).toHaveCount(0);
    await expect(page.getByText("Only members can submit them.")).toBeVisible();
    await shoot(page, "ac3-02-viewer-read-only");

    const attempt = await asUser(w.viewer, "/rest/v1/rpc/submit_goal", {
      method: "POST",
      body: { p_workspace_id: w.workspaceId, p_text: "viewer goal" },
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(await goalsIn(w.workspaceId)).toHaveLength(1);
  });
});
