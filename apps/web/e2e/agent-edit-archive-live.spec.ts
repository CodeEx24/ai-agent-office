import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-89: edit, duplicate and archive agents, driven through the real UI and checked against the database.
// Local stack only (E2E_SUPABASE=1), and only once the AGO-89 migration is applied.
//
//   AC1  edits are versioned and audited (history entry names the changed fields; a stale tab is refused)
//   AC2  archived agents cannot receive tasks (the list moves them to Archived; the detail page is locked)
//   AC3  duplicate copies skills and capabilities and starts in Strict mode
//   +    members and viewers see no row actions and a read-only detail page
test.describe("AGO-89: edit, duplicate and archive agents (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("owner");
    const viewer = await createUser("viewer");
    const workspaceId = await onboard(owner, "Edit Co");
    await addMember(workspaceId, viewer, "viewer");
    return { owner, viewer, workspaceId };
  }

  async function createResearcher(page: Page) {
    await page.goto("/app/agents");
    await page.getByRole("button", { name: "Create Researcher" }).click();
    await expect(page.getByRole("link", { name: "Edit Researcher" })).toBeVisible();
  }

  test("owner flow: duplicate (Strict), edit with history, stale tab refused, archive and unarchive", async ({
    page,
    baseURL,
    browser,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await createResearcher(page);

    // AC3: duplicate.
    await page.getByText("Duplicate Researcher", { exact: true }).click();
    await page.getByLabel("Name of the copy").fill("Researcher two");
    await page.getByRole("button", { name: "Create copy" }).click();
    await expect(page).toHaveURL(/\/app\/agents\/[0-9a-f-]{36}$/);
    const copies = await svcRows(
      "agents",
      `workspace_id=eq.${w.workspaceId}&name=eq.Researcher%20two&select=id,mode,version`,
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.mode).toBe("strict");
    const copyId = copies[0]?.id as string;

    // AC1: edit and see the history entry; open a stale copy of the page first.
    const stale = await browser.newContext({ storageState: await page.context().storageState() });
    const stalePage = await stale.newPage();
    await stalePage.goto(`/app/agents/${copyId}`, { waitUntil: "load" });

    await page.getByLabel("Name", { exact: true }).fill("Researcher prime");
    await page.getByLabel("Daily budget (US dollars)").fill("7.50");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved. This agent is now at version 2.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Version history" })).toContainText(
      "Changed name, daily budget",
    );

    // AC1: the stale tab is refused and nothing is overwritten.
    await stalePage.getByLabel("Name", { exact: true }).fill("Stale overwrite");
    await stalePage.getByRole("button", { name: "Save changes" }).click();
    await expect(stalePage.getByText(/Someone else changed this agent/)).toBeVisible();
    const after = await svcRows("agents", `id=eq.${copyId}&select=name,version`);
    expect(after[0]?.name).toBe("Researcher prime");
    expect(after[0]?.version).toBe(2);
    await stale.close();

    // AC2: archive from the list, see it under Archived, the detail page is locked, then unarchive.
    await page.goto("/app/agents");
    await page.getByRole("form", { name: "Archive Researcher prime" }).getByRole("button").click();
    await expect(
      page.getByText("Archived agents keep their history but cannot receive tasks."),
    ).toBeVisible();
    await page.getByRole("link", { name: "View Researcher prime" }).click();
    await expect(
      page.getByText("This agent is archived. Unarchive it to change its settings."),
    ).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toBeDisabled();
    await page.goto("/app/agents");
    await page
      .getByRole("form", { name: "Unarchive Researcher prime" })
      .getByRole("button")
      .click();
    await expect(page.getByRole("link", { name: "Edit Researcher prime" })).toBeVisible();
  });

  test("viewer sees no row actions and a read-only detail page", async ({ page, baseURL }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await createResearcher(page);
    const rows = await svcRows("agents", `workspace_id=eq.${w.workspaceId}&select=id`);
    const agentId = rows[0]?.id as string;

    await page.context().clearCookies();
    await signIn(page, baseURL, w.viewer);
    await page.goto("/app/agents");
    await expect(page.getByRole("link", { name: "Researcher" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
    await expect(page.getByText("Duplicate Researcher")).toHaveCount(0);
    await page.goto(`/app/agents/${agentId}`);
    await expect(page.getByText("Only workspace owners can edit agents.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  });

  // Found by the device tester in round 1: after a save that changed Model or Thinking effort the selects
  // flip back to the old value on screen, and the next save in the same page session sends that old value.
  // Un-fixme once fixed.
  test.fixme("a second save in the same session keeps the model and thinking effort", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await createResearcher(page);
    await page.getByRole("link", { name: "Edit Researcher" }).click();
    await page.getByLabel("Model", { exact: true }).selectOption("claude-haiku-5-5");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved. This agent is now at version 2.")).toBeVisible();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("claude-haiku-5-5");
    await page.getByLabel("Role", { exact: true }).fill("Lead researcher");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved. This agent is now at version 3.")).toBeVisible();
    const row = await svcRows("agents", `workspace_id=eq.${w.workspaceId}&select=model`);
    expect(row[0]?.model).toBe("claude-haiku-5-5");
  });
});
