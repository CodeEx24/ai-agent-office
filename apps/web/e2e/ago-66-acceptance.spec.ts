import { randomBytes, randomInt } from "node:crypto";

import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { SignInPage } from "./pages/sign-in-page";
import { signedInFreshUser } from "./support/fresh-user";
import { fetchSignInCode, uniqueEmail } from "./support/live-stack";

// AGO-66 acceptance criteria, one spec per criterion (QA pass, written independently of the
// implementer's csp.spec.ts / rate-limit.spec.ts):
//   AC1  Every route validates input with Zod
//   AC2  Rate limits return 429 with retry hints
//   AC3  CSP blocks inline scripts
// Every request carries its own x-forwarded-for so a test fills only its own bucket and never
// the shared "unknown" one (which parallel specs on 127.0.0.1 also use).

/** A random documentation-range IPv6 address: ~2^64 values, so two tests never share a bucket by chance. */
function uniqueIp(): string {
  const group = () => randomBytes(2).toString("hex");
  return `2001:db8:${group()}:${group()}:${group()}:${group()}`;
}

function uniqueIpPair(): string {
  return `${uniqueIp()}, 10.1.${String(randomInt(1, 254))}.${String(randomInt(1, 254))}`;
}

/** An action POST for an id that does not exist: reaches the proxy, never runs real code. */
const FAKE_ACTION = { "next-action": "00".repeat(20), "content-type": "text/plain;charset=UTF-8" };

const STACK_TRACE = /\n\s+at\s+\S+.*\(.*:\d+:\d+\)|Error:|node_modules|webpack-internal/;

interface Violations {
  __pwned?: number;
  __violations?: { directive: string; blocked: string }[];
}

/** Records every `securitypolicyviolation` event on the page, so tests need not parse console text. */
async function recordCspViolations(page: Page) {
  await page.addInitScript(() => {
    const store: { directive: string; blocked: string }[] = [];
    (window as unknown as Violations).__violations = store;
    document.addEventListener("securitypolicyviolation", (event) => {
      store.push({ directive: event.violatedDirective, blocked: event.blockedURI });
    });
  });
}

/** Serves the real page (real CSP header, real nonce) with `markup` appended to the body. */
async function injectIntoDocument(page: Page, urlPattern: string, markup: string) {
  await page.route(urlPattern, async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace("</body>", `${markup}</body>`);
    return route.fulfill({ response, body });
  });
}

/** Submits whatever form button `click` presses and waits for the server action's response. */
async function submitAndWait(page: Page, click: () => Promise<void>) {
  const responded = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/sign-in"),
  );
  await click();
  await responded;
}

test.describe("AC1: every route validates input with Zod", () => {
  test("AC1: GET /sign-in treats a hostile or oversized next/error value as missing", async ({
    page,
  }) => {
    const hostile = [
      "https://evil.example/steal",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "a".repeat(5000),
    ];
    for (const next of hostile) {
      const response = await page.goto(
        `/sign-in?next=${encodeURIComponent(next)}&error=${"e".repeat(500)}`,
      );

      expect(response?.status(), next.slice(0, 40)).toBe(200);
      // The value that will be used after sign-in is a same-origin path, never the injected one.
      const forwarded = await page.locator('input[name="next"]').first().inputValue();
      expect(forwarded, next.slice(0, 40)).toMatch(/^\/(?![/\\])/);
      expect(forwarded).not.toContain("evil.example");
      expect(await page.content()).not.toMatch(STACK_TRACE);
    }
  });

  test("AC1: repeated, prototype-polluting and array-style query keys do not break /sign-in", async ({
    request,
  }) => {
    const query = "next=%2Fapp&next=%2Fother&__proto__=x&constructor=y&next[]=z&error=a&error=b";
    const response = await request.get(`/sign-in?${query}`);

    expect(response.status()).toBe(200);
    expect(await response.text()).not.toMatch(STACK_TRACE);
  });

  test("AC1: GET /auth/callback with an oversized, malformed or hostile query redirects to sign-in, never 500", async ({
    request,
  }) => {
    const queries = [
      `code=${"x".repeat(5000)}`,
      `code=${"x".repeat(5000)}&next=${"y".repeat(5000)}`,
      "code=&next=",
      "code=bogus&next=https%3A%2F%2Fevil.example",
      "code=bogus&next=%2F%2Fevil.example",
      "code=bogus&code=bogus2&__proto__=1",
    ];
    for (const query of queries) {
      const response = await request.get(`/auth/callback?${query}`, {
        headers: { "x-forwarded-for": uniqueIp() },
        maxRedirects: 0,
      });

      const label = query.slice(0, 50);
      expect(response.status(), label).toBe(307);
      const location = new URL(response.headers().location ?? "", "http://placeholder.invalid");
      expect(location.pathname, label).toBe("/sign-in");
      expect(location.searchParams.get("error"), label).toBe("callback");
      expect(await response.text(), label).not.toMatch(STACK_TRACE);
    }
  });

  test("AC1: the sign-in form rejects an empty, malformed or oversized email without contacting the auth server", async ({
    page,
  }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();
    // Take the browser's own checks out of the way: this tests the server, not the input type.
    await signIn.emailInput.evaluate((input: HTMLInputElement) => {
      input.form?.setAttribute("novalidate", "");
      input.removeAttribute("required");
    });

    for (const email of ["", "not-an-email", `${"a".repeat(300)}@example.test`, "a@b@c.test"]) {
      await signIn.emailInput.fill(email);
      await submitAndWait(page, () => signIn.sendCodeButton.click());

      await expect(signIn.alert, JSON.stringify(email.slice(0, 20))).toContainText(
        "Enter a valid email address.",
      );
      expect(await page.content()).not.toMatch(STACK_TRACE);
    }
    // Still on step one: no code was sent.
    await expect(signIn.codeInput).toHaveCount(0);
  });

  test("AC1: a server action given a forged request body answers without a stack trace", async ({
    request,
  }) => {
    for (const body of ["[]", "not json", "[1,2,3]", "{".repeat(1000), "x".repeat(200_000)]) {
      const response = await request.post("/sign-in", {
        headers: { ...FAKE_ACTION, "x-forwarded-for": uniqueIp() },
        data: body,
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      expect(response.status(), body.slice(0, 20)).not.toBe(429);
      expect(await response.text(), body.slice(0, 20)).not.toMatch(STACK_TRACE);
    }
  });

  test("AC1 (negative): a signed-out POST to the protected /app is redirected to sign-in, not processed", async ({
    request,
  }) => {
    const response = await request.post("/app", {
      headers: { ...FAKE_ACTION, "x-forwarded-for": uniqueIp() },
      data: "[]",
      failOnStatusCode: false,
      maxRedirects: 0,
    });

    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location ?? "", "http://x.invalid").pathname).toBe(
      "/sign-in",
    );
  });

  test.describe("onboarding (local stack)", () => {
    test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

    test("AC1: onboarding rejects an empty and an over-long workspace name and writes nothing", async ({
      browser,
      baseURL,
    }) => {
      const user = await signedInFreshUser(browser, baseURL ?? "", "ac1-onboard");
      const page = await user.context.newPage();
      await page.goto("/app");
      const name = page.getByLabel("Workspace name");
      // The form is prefilled; React resets it to that default after every action.
      const defaultName = await name.inputValue();
      // Remove the client-side limits: the server must enforce its own.
      await name.evaluate((input: HTMLInputElement) => {
        input.removeAttribute("maxlength");
        input.removeAttribute("required");
        input.form?.setAttribute("novalidate", "");
      });

      const cases: [string, string][] = [
        ["", "Give your workspace a name."],
        ["   ", "Give your workspace a name."],
        ["w".repeat(121), "Keep the name under 120 characters."],
        ["w".repeat(100_000), "Keep the name under 120 characters."],
      ];
      for (const [value, message] of cases) {
        await name.fill(value);
        const responded = page.waitForResponse(
          (response) => response.request().method() === "POST" && response.url().endsWith("/app"),
        );
        await page.getByRole("button", { name: "Create workspace" }).click();
        await responded;
        await expect(page.getByRole("main").getByRole("alert")).toContainText(message);
        // React resets the form once the action settles; typing before that would be wiped.
        await expect(name).toHaveValue(defaultName);
        expect(await page.content()).not.toMatch(STACK_TRACE);
      }

      // No partial write: the database holds nothing for this user.
      expect(await user.memberships()).toBe(0);
      await user.context.close();
    });

    test("AC1: double-submitting a valid workspace name creates exactly one workspace", async ({
      browser,
      baseURL,
    }) => {
      const user = await signedInFreshUser(browser, baseURL ?? "", "ac1-double");
      const page = await user.context.newPage();
      await page.goto("/app");
      await page.getByLabel("Workspace name").fill("Double Submit");

      await page.getByRole("button", { name: "Create workspace" }).dblclick();

      await expect(page.getByTestId("workspace-name")).toHaveText("Double Submit");
      expect(await user.memberships()).toBe(1);
      await user.context.close();
    });
  });
});

test.describe("AC2: rate limits return 429 with retry hints", () => {
  test("AC2: the 61st sign-in POST from one IP is 429 with Retry-After and RateLimit headers", async ({
    request,
  }) => {
    const headers = { ...FAKE_ACTION, "x-forwarded-for": uniqueIpPair() };
    const post = () =>
      request.post("/sign-in", { headers, data: "[]", failOnStatusCode: false, maxRedirects: 0 });

    for (let attempt = 1; attempt <= 60; attempt++) {
      expect((await post()).status(), `attempt ${String(attempt)}`).not.toBe(429);
    }
    const blocked = await post();

    expect(blocked.status()).toBe(429);
    const responseHeaders = blocked.headers();
    expect(Number(responseHeaders["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(responseHeaders["retry-after"])).toBeLessThanOrEqual(60);
    expect(responseHeaders["ratelimit-limit"]).toBe("60");
    expect(responseHeaders["ratelimit-remaining"]).toBe("0");
    expect(responseHeaders["cache-control"]).toBe("no-store");
    const body = (await blocked.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(Number(responseHeaders["retry-after"]));
  });

  test("AC2: the 31st /auth/callback request from one IP is 429; another IP is unaffected", async ({
    request,
  }) => {
    const noisy = { "x-forwarded-for": uniqueIp() };
    const get = (headers: Record<string, string>) =>
      request.get("/auth/callback?code=bogus", { headers, maxRedirects: 0 });

    for (let attempt = 1; attempt <= 30; attempt++) {
      expect((await get(noisy)).status(), `attempt ${String(attempt)}`).toBe(307);
    }
    const blocked = await get(noisy);
    const other = await get({ "x-forwarded-for": uniqueIp() });

    expect(blocked.status()).toBe(429);
    expect(Number(blocked.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers()["ratelimit-limit"]).toBe("30");
    expect(other.status()).toBe(307);
  });

  test("AC2 (negative): a signed-out visitor hammering POST /app is limited per IP", async ({
    request,
  }) => {
    const headers = { ...FAKE_ACTION, "x-forwarded-for": uniqueIp() };
    const post = () =>
      request.post("/app", { headers, data: "[]", failOnStatusCode: false, maxRedirects: 0 });

    for (let attempt = 1; attempt <= 60; attempt++) {
      expect((await post()).status(), `attempt ${String(attempt)}`).toBe(307);
    }
    const blocked = await post();

    expect(blocked.status()).toBe(429);
    expect(blocked.headers()["retry-after"]).toBeTruthy();
  });

  test("AC2 (negative): requesting codes for one email is limited to 5, and rotating the IP does not escape it", async ({
    page,
  }) => {
    const signIn = new SignInPage(page);
    const email = uniqueEmail("ac2-send");
    const limited = /Too many attempts\. Try again in \d+ (seconds|minutes)\./;

    for (let attempt = 1; attempt <= 6; attempt++) {
      // A different client address on every attempt: only the per-email budget can stop this.
      await page.setExtraHTTPHeaders({ "x-forwarded-for": uniqueIp() });
      await signIn.goto();
      await signIn.emailInput.fill(email);
      await submitAndWait(page, () => signIn.sendCodeButton.click());

      if (attempt <= 5) {
        await expect(signIn.alert.or(signIn.codeInput), `attempt ${String(attempt)}`).toBeVisible();
        await expect(signIn.alert.filter({ hasText: limited })).toHaveCount(0);
      } else {
        await expect(signIn.alert).toContainText(limited);
      }
    }

    // A different address is not affected by that email's budget.
    await signIn.goto();
    await signIn.emailInput.fill(uniqueEmail("ac2-other"));
    await submitAndWait(page, () => signIn.sendCodeButton.click());
    await expect(signIn.alert.or(signIn.codeInput)).toBeVisible();
    await expect(signIn.alert.filter({ hasText: limited })).toHaveCount(0);
  });

  test.describe("local stack", () => {
    test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

    test("AC2 (negative): guessing the sign-in code is limited to 8 tries per email, even from rotating IPs", async ({
      page,
    }) => {
      const signIn = new SignInPage(page);
      const email = uniqueEmail("ac2-verify");
      await signIn.goto();
      await signIn.requestCode(email);
      // A real code exists in the mailbox; the guesses below are all wrong.
      const real = await fetchSignInCode(email);
      const wrong = real === "000000" ? "111111" : "000000";

      for (let attempt = 1; attempt <= 9; attempt++) {
        await page.setExtraHTTPHeaders({ "x-forwarded-for": uniqueIp() });
        await signIn.codeInput.fill(wrong);
        await submitAndWait(page, () => signIn.verifyButton.click());

        if (attempt <= 8) {
          await expect(signIn.alert, `attempt ${String(attempt)}`).toContainText(
            "That code is invalid or expired.",
          );
          // React resets the form once the action settles; typing before that would be wiped.
          await expect(signIn.codeInput).toHaveValue("");
        } else {
          await expect(signIn.alert).toContainText(/Too many attempts\. Try again in \d+/);
        }
      }
    });

    test("AC2: POSTs to /app are limited per signed-in user; another user and a rotated IP behave as expected", async ({
      browser,
      baseURL,
    }) => {
      const userA = await signedInFreshUser(browser, baseURL ?? "", "ac2-user-a");
      const userB = await signedInFreshUser(browser, baseURL ?? "", "ac2-user-b");
      const sharedIp = uniqueIp();
      const post = (user: typeof userA, ip: string) =>
        user.context.request.post("/app", {
          headers: { ...FAKE_ACTION, "x-forwarded-for": ip },
          data: "[]",
          failOnStatusCode: false,
          maxRedirects: 0,
        });

      for (let attempt = 1; attempt <= 60; attempt++) {
        expect((await post(userA, sharedIp)).status(), `attempt ${String(attempt)}`).not.toBe(429);
      }
      const blocked = await post(userA, sharedIp);
      // Same user from a brand-new address: the per-user bucket still applies.
      const rotated = await post(userA, uniqueIp());
      // A different user on the very same address is not affected.
      const neighbour = await post(userB, sharedIp);

      expect(blocked.status()).toBe(429);
      expect(Number(blocked.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(blocked.headers()["ratelimit-limit"]).toBe("60");
      expect(rotated.status()).toBe(429);
      expect(neighbour.status()).not.toBe(429);
      await userA.context.close();
      await userB.context.close();
    });
  });
});

test.describe("AC3: the CSP blocks inline scripts", () => {
  // Chromium logs each blocked injection as a console error; those are expected here and only here.
  test.use({ allowedConsoleErrors: [/Content Security Policy|Refused to (execute|run|load)/i] });

  test("AC3: a parser-inserted inline <script> without the nonce does not run and is reported", async ({
    page,
  }) => {
    await recordCspViolations(page);
    await injectIntoDocument(
      page,
      "**/sign-in",
      "<script>window.__pwned = 1; document.title = 'pwned';</script>",
    );

    await page.goto("/sign-in");
    await expect(page.locator("main")).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as Violations).__pwned)).toBeUndefined();
    await expect(page).not.toHaveTitle("pwned");
    const violations = await page.evaluate(() => (window as unknown as Violations).__violations);
    expect(violations?.some((v) => v.directive.startsWith("script-src"))).toBe(true);
  });

  test("AC3: a script that reuses a nonce from an earlier response is blocked (the nonce is per request)", async ({
    page,
    request,
  }) => {
    await recordCspViolations(page);
    const earlier = await request.get("/sign-in");
    const staleNonce = /'nonce-([^']+)'/.exec(
      earlier.headers()["content-security-policy"] ?? "",
    )?.[1];
    expect(staleNonce).toBeTruthy();
    await injectIntoDocument(
      page,
      "**/sign-in",
      `<script nonce="${staleNonce ?? ""}">window.__pwned = 1;</script>`,
    );

    await page.goto("/sign-in");
    await expect(page.locator("main")).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as Violations).__pwned)).toBeUndefined();
    const violations = await page.evaluate(() => (window as unknown as Violations).__violations);
    expect(violations?.some((v) => v.directive.startsWith("script-src"))).toBe(true);
  });

  test("AC3: an inline event-handler attribute does not run and is reported", async ({ page }) => {
    await recordCspViolations(page);
    // A data: URI that is not an image fires `error` without any network request.
    await injectIntoDocument(
      page,
      "**/sign-in",
      `<img src="data:image/png;base64,AAAA" onerror="window.__pwned = 1" alt="">`,
    );

    await page.goto("/sign-in");
    await expect(page.locator("main")).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as Violations).__pwned)).toBeUndefined();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Violations).__violations?.length ?? 0))
      .toBeGreaterThan(0);
  });

  test("AC3: a javascript: URL does not run when the link is clicked", async ({ page }) => {
    await recordCspViolations(page);
    await injectIntoDocument(
      page,
      "**/sign-in",
      `<a id="evil" href="javascript:window.__pwned=1">click me</a>`,
    );

    await page.goto("/sign-in");
    await page.locator("#evil").click();

    expect(await page.evaluate(() => (window as unknown as Violations).__pwned)).toBeUndefined();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Violations).__violations?.length ?? 0))
      .toBeGreaterThan(0);
  });

  test("AC3: markup injected as HTML text (innerHTML) cannot run a script", async ({ page }) => {
    // The realistic DOM-XSS path: attacker text reaches innerHTML. Scripts set that way never
    // execute in any browser, and an inline handler in it is blocked by the CSP. (A script
    // *created with createElement* by code that is already running is allowed by 'strict-dynamic'
    // by design, so it is not a meaningful test of this policy.)
    await recordCspViolations(page);
    await page.goto("/sign-in");

    await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML =
        '<script>window.__pwned = 1</script><img src="data:image/png;base64,AAAA" onerror="window.__pwned = 2">';
      document.body.append(host);
    });

    await expect
      .poll(() => page.evaluate(() => (window as unknown as Violations).__violations?.length ?? 0))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as Violations).__pwned)).toBeUndefined();
  });

  test("AC3 (negative): request headers sent by a client cannot weaken the response CSP", async ({
    request,
  }) => {
    const response = await request.get("/sign-in", {
      headers: {
        "x-nonce": "attacker-nonce",
        "content-security-policy": "script-src 'unsafe-inline' 'unsafe-eval'",
      },
    });

    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp).not.toContain("attacker-nonce");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(await response.text()).not.toContain("attacker-nonce");
  });

  test("AC3: the baseline security headers are also on the callback redirect and on a 429", async ({
    request,
  }) => {
    const ip = uniqueIp();
    const get = () =>
      request.get("/auth/callback?code=bogus", {
        headers: { "x-forwarded-for": ip },
        maxRedirects: 0,
      });
    const redirect = await get();
    for (let attempt = 0; attempt < 29; attempt++) await get();
    const limited = await get();

    expect(redirect.status()).toBe(307);
    expect(limited.status()).toBe(429);
    for (const response of [redirect, limited]) {
      const headers = response.headers();
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"]).toContain("camera=()");
    }
  });

  test.describe("signed in (local stack)", () => {
    test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

    test("AC3: /app renders and hydrates under a strict nonce CSP with no violation", async ({
      browser,
      baseURL,
    }) => {
      const user = await signedInFreshUser(browser, baseURL ?? "", "ac3-app");
      const page = await user.context.newPage();
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      page.on("pageerror", (error) => problems.push(error.message));
      await recordCspViolations(page);

      const response = await page.goto("/app");
      await expect(page.getByRole("heading", { level: 1, name: "Your workspace" })).toBeVisible();
      // A client-driven server action only works if hydration succeeded.
      await page.getByLabel("Workspace name").fill("CSP Hydration");
      await page.getByRole("button", { name: "Create workspace" }).click();
      await expect(page.getByTestId("workspace-name")).toHaveText("CSP Hydration");

      const csp = response?.headers()["content-security-policy"] ?? "";
      expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
      expect(await page.evaluate(() => (window as unknown as Violations).__violations)).toEqual([]);
      expect(problems).toEqual([]);
      await user.context.close();
    });
  });
});
