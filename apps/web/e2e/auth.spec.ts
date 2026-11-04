import { expect, test } from "./fixtures";
import { SignInPage } from "./pages/sign-in-page";

// AGO-67 checks that need no Supabase stack, so they also run in CI.
// Provider buttons and redirects are proven by what the app asks the browser to open; real
// Google/GitHub sign-in is verified once the owner adds OAuth credentials (docs/auth.md).
test.describe("AGO-67 signed-out behaviour", () => {
  test("AC2: a signed-out visit to /app redirects to sign-in and remembers the target", async ({
    page,
  }) => {
    await page.goto("/app");

    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
    await expect(new SignInPage(page).heading).toBeVisible();
  });

  test("AC2: nested protected routes redirect too, keeping the query", async ({ page }) => {
    await page.goto("/app/anything?tab=agents");

    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fanything%3Ftab%3Dagents$/);
  });

  test("AC2: a garbage session cookie is treated as signed out", async ({ page, context }) => {
    // Cookie name is sb-<project ref>-auth-token; for http://127.0.0.1:<port> the ref is "127".
    await context.addCookies([
      { name: "sb-127-auth-token", value: "not-a-real-session", url: "http://127.0.0.1" },
    ]);
    await page.goto("/app");

    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
  });

  test("the public home page stays reachable while signed out", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.ok()).toBe(true);
    await expect(page).not.toHaveURL(/sign-in/);
  });
});

test.describe("AGO-67 provider buttons", () => {
  for (const [provider, button] of [
    ["google", "googleButton"],
    ["github", "githubButton"],
  ] as const) {
    test(`AC1: the ${provider} button sends the browser to the ${provider} authorize URL`, async ({
      page,
      baseURL,
    }) => {
      // Stub the Auth server's authorize endpoint: without the owner's OAuth credentials it
      // would answer 400, and we only need to see where the browser was sent.
      await page.route("**/auth/v1/authorize**", (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "stub" }),
      );
      const signIn = new SignInPage(page);
      await signIn.goto("/sign-in?next=%2Fapp");

      const authorize = page.waitForRequest("**/auth/v1/authorize**");
      await signIn[button].click();
      const url = new URL((await authorize).url());

      expect(url.pathname).toBe("/auth/v1/authorize");
      expect(url.searchParams.get("provider")).toBe(provider);
      expect(url.searchParams.get("redirect_to")).toBe(
        `${baseURL ?? ""}/auth/callback?next=%2Fapp`,
      );
      expect(url.searchParams.get("code_challenge_method")).toBe("s256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
    });
  }
});

test.describe("AGO-67 callback security", () => {
  test("an open-redirect attempt via next= is rejected, never followed", async ({
    page,
    baseURL,
  }) => {
    // Without a valid code the callback fails; either way it must stay on our origin.
    await page.goto("/auth/callback?code=bogus&next=https%3A%2F%2Fevil.example%2Fsteal");

    expect(new URL(page.url()).origin).toBe(baseURL);
    await expect(page).toHaveURL(/\/sign-in\?error=callback$/);
    await expect(new SignInPage(page).alert).toContainText("could not be completed");
  });

  test("a protocol-relative next= on sign-in falls back to /app", async ({ page }) => {
    const signIn = new SignInPage(page);
    await signIn.goto("/sign-in?next=%2F%2Fevil.example");

    await expect(signIn.heading).toBeVisible();
    // The hidden field the forms submit carries the sanitised target.
    await expect(page.locator('input[name="next"]').first()).toHaveValue("/app");
  });

  test("the callback with no code reports an error instead of signing in", async ({ page }) => {
    await page.goto("/auth/callback");

    await expect(page).toHaveURL(/\/sign-in\?error=callback$/);
  });
});
