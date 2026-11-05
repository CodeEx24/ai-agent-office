import { expect, isLiveStack, test } from "./fixtures";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";
import { readSessionCookie, tamper, writeSessionCookie } from "./support/session-cookie";
import { fetchMagicLink, uniqueEmail } from "./support/live-stack";

// AGO-67 session, sign-out and account-privacy checks. They need the local Supabase Auth server and
// mail catcher, so they run with E2E_SUPABASE=1 and are skipped in CI (see docs/auth.md).
test.describe("AGO-67 sessions and sign-out (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("AC3: an expired access token is refreshed and the user stays signed in", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("refresh");
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(email);
    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();
    const before = await readSessionCookie(context);

    // Pretend the access token expired an hour ago; the refresh token is still valid.
    const past = Math.floor(Date.now() / 1000) - 3600;
    await writeSessionCookie(context, before.cookie, { ...before.session, expires_at: past });
    await page.reload();

    await expect(workspace.signedInEmail).toHaveText(email);
    const after = await readSessionCookie(context);
    expect(after.session.access_token).not.toBe(before.session.access_token);
    expect(after.session.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("AC3: sign-out removes the session cookie from the browser", async ({ page, context }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(uniqueEmail("cookie"));
    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();

    await workspace.signOutButton.click();
    await expect(page).toHaveURL(/\/sign-in$/);

    const names = (await context.cookies()).map((cookie) => cookie.name);
    expect(
      names.filter((name) => /^sb-.*-auth-token/.test(name) && !name.includes("verifier")),
    ).toEqual([]);
  });

  // The app serves no /favicon.ico (only /icon.svg), so the browser's automatic request can 404.
  // Cosmetic and unrelated to auth (reported on the PR). The request is stubbed here, rather than
  // allowing console errors, so a real 404 for anything else would still fail the test.
  test.describe("back navigation", () => {
    test("AC3: the back button after sign-out does not show protected content", async ({
      page,
    }) => {
      await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
      const signIn = new SignInPage(page);
      await signIn.goto();
      await signIn.signInWithEmailCode(uniqueEmail("back"));
      const workspace = new WorkspacePage(page);
      await expect(workspace.heading).toBeVisible();
      await workspace.signOutButton.click();
      await expect(page).toHaveURL(/\/sign-in$/);

      await page.goBack();

      await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
      await expect(workspace.heading).toBeHidden();
      await expect(signIn.heading).toBeVisible();
    });
  });

  test("AC3: a GET to sign-out-looking URLs does not end the session", async ({ page }) => {
    const email = uniqueEmail("getout");
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(email);
    const workspace = new WorkspacePage(page);
    await expect(workspace.heading).toBeVisible();

    for (const path of ["/sign-out", "/auth/sign-out", "/auth/signout", "/logout"]) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(404);
    }

    await page.reload();
    await expect(workspace.signedInEmail).toHaveText(email);
  });

  test("AC2: a tampered session cookie is rejected", async ({ page, context }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(uniqueEmail("tamper"));
    await expect(new WorkspacePage(page).heading).toBeVisible();
    const { cookie, session } = await readSessionCookie(context);

    // Both tokens are altered, so neither the signature check nor a refresh can succeed.
    await writeSessionCookie(context, cookie, {
      ...session,
      access_token: tamper(session.access_token),
      refresh_token: tamper(session.refresh_token),
    });
    await page.goto("/app");

    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
    await expect(new WorkspacePage(page).heading).toBeHidden();
  });

  test("AC2: a forged session for another user id is rejected", async ({ page, context }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(uniqueEmail("forge"));
    await expect(new WorkspacePage(page).heading).toBeVisible();
    const { cookie, session } = await readSessionCookie(context);

    // Swap the payload of the access token for one claiming a different user, keep the signature.
    const [header, , signature] = session.access_token.split(".");
    const claims = JSON.parse(
      Buffer.from(session.access_token.split(".")[1] ?? "", "base64url").toString(),
    ) as Record<string, unknown>;
    const forged = Buffer.from(
      JSON.stringify({
        ...claims,
        sub: "00000000-0000-0000-0000-000000000000",
        email: "admin@example.test",
      }),
    ).toString("base64url");
    await writeSessionCookie(context, cookie, {
      ...session,
      access_token: `${header ?? ""}.${forged}.${signature ?? ""}`,
      refresh_token: tamper(session.refresh_token),
    });
    await page.goto("/app");

    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
  });
});

test.describe("AGO-67 sign-in edge cases (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("AC1: no token or code is left in the URL after signing in with a code", async ({
    page,
  }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInWithEmailCode(uniqueEmail("url"));

    await expect(page).toHaveURL(/\/app$/);
    expect(page.url()).not.toMatch(/token|code=|access_|refresh_/i);
  });

  test("AC1: no token or code is left in the URL after the magic link", async ({ page }) => {
    const email = uniqueEmail("linkurl");
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.requestCode(email);

    await page.goto(await fetchMagicLink(email));

    await expect(page).toHaveURL(/\/app$/);
    expect(page.url()).not.toMatch(/token|code=|access_|refresh_/i);
  });

  test("AC1: signing in with next=/..//evil.example never leaves this origin", async ({
    page,
    baseURL,
  }) => {
    const signIn = new SignInPage(page);
    await signIn.goto("/sign-in?next=%2F..%2F%2Fevil.example");

    await signIn.signInWithEmailCode(uniqueEmail("dotdot"));

    await page.waitForURL((url) => url.pathname !== "/sign-in");
    expect(new URL(page.url()).origin).toBe(baseURL);
  });

  test("AC1: an empty email is not submitted and no code step appears", async ({ page }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();

    await signIn.sendCodeButton.click();

    await expect(signIn.codeInput).toBeHidden();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("AC1: an empty code is not accepted", async ({ page }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.requestCode(uniqueEmail("emptycode"));

    await signIn.verifyButton.click();

    await expect(page).toHaveURL(/\/sign-in/);
    await expect(new WorkspacePage(page).heading).toBeHidden();
  });

  test("AC1: a double-clicked send button still reaches the code step", async ({ page }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.emailInput.fill(uniqueEmail("double"));

    await signIn.sendCodeButton.dblclick();

    await expect(signIn.codeInput).toBeVisible();
  });

  test("AC1: errors do not reveal whether an email already has an account", async ({
    page,
    browser,
  }) => {
    const known = uniqueEmail("known");
    const stranger = uniqueEmail("stranger");

    async function observe(email: string, context: typeof page) {
      const signIn = new SignInPage(context);
      await signIn.goto();
      await signIn.requestCode(email);
      const codeStep = (await context.getByRole("main").innerText()).replaceAll(email, "<email>");
      await signIn.codeInput.fill("000000");
      await signIn.verifyButton.click();
      await expect(signIn.alert).toBeVisible();
      const error = await signIn.alert.innerText();
      return { codeStep, error };
    }

    // `known` gets an account on first contact; the second visit is an existing user.
    await observe(known, page);
    const secondContext = await browser.newContext();
    const knownAgain = await observe(known, await secondContext.newPage());
    const unknown = await observe(stranger, await (await browser.newContext()).newPage());
    await secondContext.close();

    expect(knownAgain).toEqual(unknown);
  });
});
