import { AUTH_STATE_PATH, expect, isLiveStack, test } from "./fixtures";
import { fetchMagicLink, uniqueEmail } from "./support/live-stack";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";

// AGO-67 flows that need the local Supabase Auth server and mail catcher. Run with
// E2E_SUPABASE=1 (see playwright.config.ts); skipped in CI, which has no stack.
test.describe("AGO-67 email sign-in (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("AC1: signing in with an emailed code lands on the protected workspace page", async ({
    page,
  }) => {
    const email = uniqueEmail("code");
    const signIn = new SignInPage(page);
    await signIn.goto("/sign-in?next=%2Fapp");

    await signIn.signInWithEmailCode(email);

    await expect(page).toHaveURL(/\/app$/);
    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();
    await expect(workspace.signedInEmail).toHaveText(email);
  });

  test("AC1: the magic link in the same email also signs in", async ({ page }) => {
    const email = uniqueEmail("link");
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.requestCode(email);

    await page.goto(await fetchMagicLink(email));

    await expect(page).toHaveURL(/\/app$/);
    await expect(new WorkspacePage(page).signedInEmail).toHaveText(email);
  });

  test("AC1: a wrong code is rejected and keeps the user signed out", async ({ page }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.requestCode(uniqueEmail("wrong"));

    await signIn.codeInput.fill("000000");
    await signIn.verifyButton.click();

    await expect(signIn.alert).toContainText("invalid or expired");
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("AC1: a signed-in visit to /sign-in goes straight to the next path", async ({ page }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(uniqueEmail("again"));
    await expect(page).toHaveURL(/\/app$/);

    await page.goto("/sign-in");

    await expect(page).toHaveURL(/\/app$/);
  });
});

test.describe("AGO-67 session and sign-out (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("AC3: the session persists across a reload", async ({ page }) => {
    const email = uniqueEmail("reload");
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(email);
    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();

    await page.reload();

    await expect(workspace.signedInEmail).toHaveText(email);
  });

  test("AC3: sign-out clears the session, and the old cookies stop working", async ({
    page,
    browser,
  }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(uniqueEmail("out"));
    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();
    const signedInState = await page.context().storageState();

    await workspace.signOutButton.click();

    await expect(page).toHaveURL(/\/sign-in$/);
    await workspace.goto();
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);

    // A copy of the pre-sign-out cookies is a revoked session: it must be refused, not trusted.
    const stale = await browser.newContext({ storageState: signedInState });
    const stalePage = await stale.newPage();
    await stalePage.goto("/app");
    await expect(stalePage).toHaveURL(/\/sign-in\?next=%2Fapp$/);
    await stale.close();
  });
});

test.describe("AGO-67 shared auth-state fixture (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.use({ storageState: AUTH_STATE_PATH });

  test("a spec can start signed in from the saved state", async ({ page }) => {
    await new WorkspacePage(page).goto();

    await expect(new WorkspacePage(page).heading).toBeVisible();
    await expect(page).toHaveURL(/\/app$/);
  });
});
