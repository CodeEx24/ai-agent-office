import { expect, isLiveStack, test } from "./fixtures";
import { uniqueEmail } from "./support/live-stack";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";

// AGO-82 flows that need the local Supabase stack: sign in, onboard, see the workspace.
// Run with E2E_SUPABASE=1 (see playwright.config.ts); skipped in CI, which has no stack.
test.describe("AGO-82 onboarding and workspace (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("AC1: a new user is asked to name a workspace and becomes its owner", async ({ page }) => {
    const email = uniqueEmail("onboard");
    await new SignInPage(page).goto("/sign-in?next=%2Fapp");
    await new SignInPage(page).signInWithMagicLink(email);

    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();
    // First sign-in: no membership yet, so the onboarding form is shown with a suggested name.
    await expect(workspace.nameInput).toHaveValue(/workspace$/);
    await expect(workspace.workspaceName).toHaveCount(0);

    await workspace.createWorkspace("Acme Robotics");

    await expect(workspace.workspaceName).toHaveText("Acme Robotics");
    await expect(workspace.workspaceRole).toHaveText("owner");
    await expect(workspace.createButton).toHaveCount(0);
  });

  test("AC1: refreshing or revisiting /app keeps the one workspace and never re-onboards", async ({
    page,
  }) => {
    await new SignInPage(page).goto();
    await new SignInPage(page).signInWithMagicLink(uniqueEmail("refresh"));
    const workspace = new WorkspacePage(page);
    await workspace.createWorkspace("Refresh Co");

    await page.reload();
    await expect(workspace.workspaceName).toHaveText("Refresh Co");
    await workspace.goto();
    await expect(workspace.workspaceName).toHaveText("Refresh Co");
    await expect(workspace.createButton).toHaveCount(0);
  });

  test("AC1: a double submit of the onboarding form creates one workspace", async ({ page }) => {
    await new SignInPage(page).goto();
    await new SignInPage(page).signInWithMagicLink(uniqueEmail("double"));
    const workspace = new WorkspacePage(page);
    await workspace.nameInput.fill("Double Co");

    await workspace.createButton.dblclick();

    await expect(workspace.workspaceName).toHaveText("Double Co");
    await expect(workspace.workspaceRole).toHaveText("owner");
  });

  test("AC1: an empty workspace name is rejected before anything is created", async ({ page }) => {
    await new SignInPage(page).goto();
    await new SignInPage(page).signInWithMagicLink(uniqueEmail("empty"));
    const workspace = new WorkspacePage(page);
    await workspace.nameInput.fill("   ");

    await workspace.createButton.click();

    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Give your workspace a name",
    );
    await expect(workspace.workspaceName).toHaveCount(0);
  });

  test("AC3: a second user sees their own workspace, never the first user's", async ({
    page,
    browser,
  }) => {
    await new SignInPage(page).goto();
    await new SignInPage(page).signInWithMagicLink(uniqueEmail("alice"));
    const alice = new WorkspacePage(page);
    await alice.createWorkspace("Alice Private Lab");

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await new SignInPage(otherPage).goto();
    await new SignInPage(otherPage).signInWithMagicLink(uniqueEmail("bob"));
    const bob = new WorkspacePage(otherPage);
    // Bob has no membership, so he is onboarded into a workspace of his own.
    await expect(bob.nameInput).toBeVisible();
    await expect(otherPage.getByText("Alice Private Lab")).toHaveCount(0);
    await bob.createWorkspace("Bob Studio");
    await expect(bob.workspaceName).toHaveText("Bob Studio");
    await expect(otherPage.getByText("Alice Private Lab")).toHaveCount(0);
    await otherContext.close();

    await page.reload();
    await expect(alice.workspaceName).toHaveText("Alice Private Lab");
  });
});
