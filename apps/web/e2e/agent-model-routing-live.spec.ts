import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { createUser, onboard } from "./support/stack-api";

// AGO-94 AC2 ("unknown model names are rejected at save time"), driven through the real wizard and checked
// against the database. Local stack only (E2E_SUPABASE=1). Run under the db lock, one worker.
//
// An owner tampers with the hidden `model` field the browser submits (as someone with dev tools would).
// The server action must refuse it with an error that names the Model field, and no agent may be created.
test.describe("AGO-94: unknown model is rejected at save time (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  const next = (page: Page) => page.getByRole("button", { name: "Next" }).click();

  async function fillBasics(page: Page, name: string) {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Role", { exact: true }).fill("Researcher");
    await page.getByLabel("Model", { exact: true }).selectOption("claude-sonnet-5-5");
    await page.getByLabel("Prompt", { exact: true }).fill("Find sources and summarise them.");
  }

  async function agentsNamed(workspaceId: string, name: string) {
    return svcRows(
      "agents",
      `workspace_id=eq.${workspaceId}&name=eq.${encodeURIComponent(name)}&select=id,model`,
    );
  }

  test("a tampered unknown model gets a field-named error and creates nothing", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const owner = await createUser("owner");
    const workspaceId = await onboard(owner, "Model Co");
    await signInWithSessionCookie(page.context(), baseURL, owner);

    for (const model of ["gpt-9", "claude-sonnet-4", "CLAUDE-SONNET-5-5"]) {
      // The wizard returns to the Model step after a rejected save, so walk through it again each time.
      await page.goto("/app/agents/new");
      await fillBasics(page, "Tampered");
      for (let i = 0; i < 4; i += 1) await next(page);
      await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
      await page.evaluate((value) => {
        const input = document.querySelector<HTMLInputElement>('input[name="model"]');
        if (input) input.value = value;
      }, model);
      await page.getByRole("button", { name: "Create agent" }).click();

      await expect(page.locator("#agent-model-error")).toContainText(
        "Model is not one of the available models",
      );
      await expect(page).toHaveURL(/\/app\/agents\/new$/);
      expect(await agentsNamed(workspaceId, "Tampered")).toHaveLength(0);
    }
  });

  test("an allowlisted model still saves, and the agent keeps exactly that model", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const owner = await createUser("owner");
    const workspaceId = await onboard(owner, "Model Ok Co");
    await signInWithSessionCookie(page.context(), baseURL, owner);

    await page.goto("/app/agents/new");
    await fillBasics(page, "Routed");
    for (let i = 0; i < 4; i += 1) await next(page);
    await page.getByRole("button", { name: "Create agent" }).click();

    await expect(page).toHaveURL(/\/app\/agents$/);
    const rows = await agentsNamed(workspaceId, "Routed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "claude-sonnet-5-5" });
  });
});
