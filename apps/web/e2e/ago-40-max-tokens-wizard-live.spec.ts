import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { AgentWizardPage } from "./pages/agent-wizard-page";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-40: "Limits can be set in the agent wizard" (AC3), driven through the real UI and checked in the database.
// Local stack only (E2E_SUPABASE=1). One flow: set the optional "Max tokens per run", save, see it persist;
// reject bad values with a clear message; the Daily budget still works; an empty field is fine; the edit
// form leaves the stored limit alone. Set E2E_SHOT_DIR to also save a screenshot at every step.
test.describe("AGO-40: Max tokens per run in the agent wizard (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  const NOT_WHOLE = "Max tokens per run must be a whole number, for example 50000.";
  const OUT_OF_RANGE = "Max tokens per run must be between 1,000 and 5,000,000.";

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("owner");
    const workspaceId = await onboard(owner, "Limits Co");
    return { owner, workspaceId };
  }

  let shotNo = 0;
  async function shot(page: Page, name: string) {
    const dir = process.env.E2E_SHOT_DIR;
    if (!dir) return;
    shotNo += 1;
    await page.screenshot({
      path: `${dir}/${name.replace("{nn}", String(shotNo).padStart(2, "0"))}.png`,
      fullPage: true,
    });
  }

  async function agentRow(workspaceId: string, name: string) {
    const rows = await svcRows(
      "agents",
      `workspace_id=eq.${workspaceId}&name=eq.${encodeURIComponent(name)}&select=id,daily_budget_cents,run_limits,mode`,
    );
    return rows[0];
  }

  /** Fills the basics and clicks Next through Skills and Capabilities to land on the Budget step. */
  async function toBudgetStep(wizard: AgentWizardPage, page: Page, name: string) {
    await wizard.goto();
    await wizard.fillBasics({ name });
    await wizard.advance(3);
    await expect(wizard.dailyBudget).toBeVisible();
    await expect(page.getByLabel(/Max tokens per run/)).toBeVisible();
  }

  test("set, reject, persist, empty, daily budget and edit", async ({ page, baseURL }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    const wizard = new AgentWizardPage(page);
    const maxTokens = page.getByLabel(/Max tokens per run/);

    // Valid value: saved and visible on the review step, then stored.
    await toBudgetStep(wizard, page, "Limited");
    await shot(page, "AGO-40-AC3-step-{nn}-budget-step-empty-fields");
    await maxTokens.fill("250000");
    await shot(page, "AGO-40-AC3-step-{nn}-max-tokens-typed");
    await wizard.next();
    await expect(wizard.review).toContainText("Max tokens per run");
    await expect(wizard.review).toContainText("250,000");
    await shot(page, "AGO-40-AC3-step-{nn}-review-shows-250000");
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(wizard.agentList).toContainText("Limited");
    await shot(page, "AGO-40-AC3-step-{nn}-agent-created");
    const saved = await agentRow(w.workspaceId, "Limited");
    expect(saved?.run_limits).toMatchObject({ maxTokens: 250000 });
    expect(saved?.daily_budget_cents).toBe(500);
    expect(saved?.mode).toBe("strict");

    // Persistence: reload the list and the edit page; the stored value is unchanged and the agent opens.
    await page.reload();
    await expect(wizard.agentList).toContainText("Limited");
    await page.goto(`/app/agents/${saved?.id as string}`);
    await expect(page.getByLabel(/Daily budget/)).toHaveValue("5.00");
    await shot(page, "AGO-40-AC3-step-{nn}-edit-page-reopened");

    // Invalid values are refused with a clear message and nothing is created.
    const invalid: [string, string, string][] = [
      ["-5", NOT_WHOLE, "negative"],
      ["0", OUT_OF_RANGE, "zero"],
      ["999", OUT_OF_RANGE, "below-min"],
      ["1500.5", NOT_WHOLE, "non-integer"],
      ["abc", NOT_WHOLE, "text"],
      ["5000001", OUT_OF_RANGE, "above-max"],
      ["99999999999", OUT_OF_RANGE, "huge"],
    ];
    await toBudgetStep(wizard, page, "Rejected");
    for (const [value, message, label] of invalid) {
      await maxTokens.fill(value);
      await wizard.next();
      await expect(wizard.fieldError("maxTokens")).toHaveText(message);
      await expect(maxTokens).toHaveAttribute("aria-invalid", "true");
      await expect(wizard.review).toHaveCount(0);
      await shot(page, `AGO-40-AC3-step-{nn}-invalid-${label}`);
    }
    expect(await agentRow(w.workspaceId, "Rejected")).toBeUndefined();

    // Bounds themselves are accepted.
    for (const edge of ["1000", "5000000"]) {
      await maxTokens.fill(edge);
      await wizard.next();
      await expect(wizard.review).toBeVisible();
      await wizard.backButton.click();
      await expect(maxTokens).toBeVisible();
    }
    await shot(page, "AGO-40-AC3-step-{nn}-bounds-1000-and-5000000-accepted");

    // The existing Daily budget still works: bad values refused, a good one saved as cents.
    await maxTokens.fill("");
    for (const bad of ["0", "-1", "abc", "50.01"]) {
      await wizard.dailyBudget.fill(bad);
      await wizard.next();
      await expect(wizard.fieldError("dailyBudget")).toBeVisible();
      await shot(page, `AGO-40-AC3-step-{nn}-daily-budget-invalid-${bad.replace("-", "neg")}`);
    }
    await wizard.dailyBudget.fill("12.34");
    await wizard.next();
    await expect(wizard.review).toContainText("12.34");
    await shot(page, "AGO-40-AC3-step-{nn}-review-daily-12-34");
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app/);
    await expect(wizard.agentList).toContainText("Rejected");
    const daily = await agentRow(w.workspaceId, "Rejected");
    expect(daily?.daily_budget_cents).toBe(1234);

    // Empty Max tokens per run is fine: no override is stored.
    expect(daily?.run_limits ?? {}).not.toHaveProperty("maxTokens");
    await shot(page, "AGO-40-AC3-step-{nn}-empty-max-tokens-agent-created");

    // A tampered request (hidden field changed after the client check) is refused by the server.
    await toBudgetStep(wizard, page, "Tampered");
    await wizard.next();
    await expect(wizard.review).toBeVisible();
    await wizard.tamper("maxTokens", "999999999");
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents\/new/);
    await shot(page, "AGO-40-AC3-step-{nn}-tampered-request-refused");
    expect(await agentRow(w.workspaceId, "Tampered")).toBeUndefined();

    // Edit draft path: the edit form has no Max tokens field, and saving it keeps the stored limit.
    await page.goto(`/app/agents/${saved?.id as string}`);
    await expect(page.getByLabel(/Max tokens per run/)).toHaveCount(0);
    await page.getByLabel("Role", { exact: true }).fill("Senior researcher");
    await shot(page, "AGO-40-AC3-step-{nn}-edit-form-role-changed");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Version 2").first()).toBeVisible();
    await expect(page.getByLabel("Role", { exact: true })).toHaveValue("Senior researcher");
    await shot(page, "AGO-40-AC3-step-{nn}-edit-saved");
    const after = await svcRows(
      "agents",
      `id=eq.${saved?.id as string}&select=role,run_limits,daily_budget_cents`,
    );
    expect(after[0]).toMatchObject({
      role: "Senior researcher",
      run_limits: { maxTokens: 250000 },
      daily_budget_cents: 500,
    });
  });
});
