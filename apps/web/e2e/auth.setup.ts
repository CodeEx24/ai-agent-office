import { expect, test as setup } from "./fixtures";
import { AUTH_STATE_PATH, uniqueEmail } from "./support/live-stack";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";

// Signs in once through the real email flow and saves the session for later specs that start
// signed in (`test.use({ storageState: AUTH_STATE_PATH })`). Runs only as the "setup" project,
// which exists when E2E_SUPABASE=1.
setup("sign in once and save the session", async ({ page }) => {
  const signIn = new SignInPage(page);
  await signIn.goto();
  await signIn.signInWithEmailCode(uniqueEmail("setup"));

  await expect(new WorkspacePage(page).heading).toBeVisible();
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
