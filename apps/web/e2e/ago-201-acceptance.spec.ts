import { randomInt, randomUUID } from "node:crypto";

import { expect, isLiveStack, test } from "./fixtures";
import { WorkspacePage } from "./pages/workspace-page";
import { createFaultInjector, type FaultInjector } from "./support/fault-injector";
import { signedInFreshUser } from "./support/fresh-user";
import { startAppServer, type AppServer } from "./support/sentry-ingest";

// AGO-201 (review follow-ups from waves 1-2), acceptance criteria as seen by a user or a caller:
//   AC2  GET /api/capabilities is rate limited with the AGO-66 limiter (429 + Retry-After)
//   AC3  getActiveWorkspace surfaces errors; the onboarding form keeps the input after a failed submit
//   AC5  X-Forwarded-For is trusted only behind a configured proxy (TRUST_PROXY_HEADERS)
// AC1 (redaction) is a library behaviour: apps/worker/src/redaction.qa.test.ts and
// packages/shared/src/redaction/redact.test.ts. AC4 (db-seed-qa) is scripts/ago-201-acceptance.test.mjs.
// Live specs need the local Supabase stack (E2E_SUPABASE=1); the rest run in CI too.

test.describe.configure({ timeout: 120_000 });

/** A random public-looking address, optionally followed by proxy hops. */
function uniqueIp(...hops: string[]): string {
  const first = `198.51.100.${String(randomInt(1, 254))}`;
  return [first, ...hops].join(", ");
}

async function isUp(baseUrl: string): Promise<boolean> {
  return (await fetch(`${baseUrl}/sign-in`)).status === 200;
}

test.describe("AGO-201 AC2: GET /api/capabilities is rate limited", () => {
  test("AC2: past 120 reads a minute the route answers 429 with Retry-After and RateLimit headers, before running", async ({
    request,
  }) => {
    const headers = { "x-forwarded-for": uniqueIp() };
    const get = () => request.get("/api/capabilities", { headers, failOnStatusCode: false });

    for (let attempt = 1; attempt <= 120; attempt++) {
      const status = (await get()).status();
      // Signed out the route answers 401: the limiter let the request through.
      expect(status, `attempt ${String(attempt)}`).not.toBe(429);
    }
    const blocked = await get();

    expect(blocked.status()).toBe(429);
    const responseHeaders = blocked.headers();
    expect(Number(responseHeaders["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(responseHeaders["retry-after"])).toBeLessThanOrEqual(60);
    expect(responseHeaders["ratelimit-limit"]).toBe("120");
    expect(responseHeaders["ratelimit-remaining"]).toBe("0");
    expect(responseHeaders["ratelimit-policy"]).toBe("120;w=60");
    expect(responseHeaders["cache-control"]).toBe("no-store");
    expect(await blocked.json()).toMatchObject({
      error: "rate_limited",
      retryAfterSeconds: Number(responseHeaders["retry-after"]),
    });
  });

  test("AC2 (negative): the budget is per caller, so another address still reaches the route", async ({
    request,
  }) => {
    const noisy = { "x-forwarded-for": uniqueIp() };
    for (let attempt = 0; attempt < 121; attempt++) {
      await request.get("/api/capabilities", { headers: noisy, failOnStatusCode: false });
    }
    const limited = await request.get("/api/capabilities", {
      headers: noisy,
      failOnStatusCode: false,
    });
    const other = await request.get("/api/capabilities", {
      headers: { "x-forwarded-for": uniqueIp() },
      failOnStatusCode: false,
    });

    expect(limited.status()).toBe(429);
    expect(other.status()).not.toBe(429);
  });

  test("AC2 (negative): other pages are not touched by the capabilities limit", async ({
    request,
  }) => {
    const headers = { "x-forwarded-for": uniqueIp() };
    for (let attempt = 0; attempt < 125; attempt++) {
      await request.get("/api/capabilities", { headers, failOnStatusCode: false });
    }

    expect((await request.get("/sign-in", { headers })).status()).toBe(200);
  });

  test.describe("signed in (local stack)", () => {
    test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

    test("AC2: a signed-in user is limited per user: new addresses do not reset the budget, and another user is unaffected", async ({
      browser,
      baseURL,
    }) => {
      const busy = await signedInFreshUser(browser, baseURL ?? "", "ac2-busy");
      const calm = await signedInFreshUser(browser, baseURL ?? "", "ac2-calm");
      try {
        // Every read claims a different address; only the user can be what counts.
        const read = (user: typeof busy) =>
          user.context.request.get(`/api/capabilities?workspace_id=${randomUUID()}`, {
            headers: { "x-forwarded-for": uniqueIp() },
            failOnStatusCode: false,
          });
        for (let attempt = 1; attempt <= 120; attempt++) {
          // 403: signed in (a signed-out caller gets 401) but not a member of that workspace.
          expect((await read(busy)).status(), `attempt ${String(attempt)}`).toBe(403);
        }
        const blocked = await read(busy);
        const untouched = await read(calm);

        expect(blocked.status()).toBe(429);
        expect(Number(blocked.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(untouched.status()).toBe(403);
      } finally {
        await busy.context.close();
        await calm.context.close();
      }
    });
  });
});

test.describe("AGO-201 AC3: workspace lookup errors and the onboarding form (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  let faults: FaultInjector;
  let app: AppServer;

  // One app instance whose server-side Supabase calls can be made to fail on demand: the shared
  // database stays untouched and no other spec is affected. Each test heals it when it is done.
  test.beforeAll(async () => {
    faults = createFaultInjector();
    app = await startAppServer({}, isUp, faults.env);
  });

  test.afterAll(async () => {
    await app.stop();
    faults.dispose();
  });

  test.afterEach(() => {
    faults.failWhen(null);
  });

  test("AC3: when the workspace lookup fails an existing user sees an error state, never the onboarding form or an empty workspace", async ({
    browser,
  }) => {
    const user = await signedInFreshUser(browser, app.baseUrl, "ac3-lookup");
    const page = await user.context.newPage();
    const workspace = new WorkspacePage(page);
    try {
      // Healthy first: the user onboards and has a workspace.
      await page.goto("/app");
      await workspace.createWorkspace("Fault Co");
      await expect(workspace.workspaceName).toHaveText("Fault Co");

      // The workspace lookup now fails (the members query answers 500).
      faults.failWhen(/^GET \/rest\/v1\/members\?/);
      await page.reload();

      const alert = page.getByRole("main").getByRole("alert");
      await expect(alert).toHaveText("We could not load your workspace. Please try again.");
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      // Not the first-run form, not an empty workspace, and no internals on screen.
      await expect(workspace.nameInput).toHaveCount(0);
      await expect(workspace.createButton).toHaveCount(0);
      await expect(workspace.workspaceName).toHaveCount(0);
      const html = await page.content();
      expect(html).not.toContain("injected fault");
      expect(html).not.toMatch(/rest\/v1|PGRST/i);
      expect(faults.failedCount()).toBeGreaterThan(0);
      await page.screenshot({ path: "test-results/ago-201-ac3-lookup-error.png" });

      // Still failing: Try again keeps showing the error instead of a blank or onboarding page.
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(alert).toBeVisible();
      await expect(workspace.nameInput).toHaveCount(0);

      // And a plain reload once the outage ends shows the real workspace, not the first-run form.
      faults.failWhen(null);
      await page.reload();
      await expect(workspace.workspaceName).toHaveText("Fault Co");
      await expect(workspace.nameInput).toHaveCount(0);
    } finally {
      await user.context.close();
    }
  });

  test("AC3: once the outage ends, Try again loads the workspace without a manual page reload", async ({
    browser,
  }) => {
    const user = await signedInFreshUser(browser, app.baseUrl, "ac3-retry");
    const page = await user.context.newPage();
    const workspace = new WorkspacePage(page);
    try {
      await page.goto("/app");
      await workspace.createWorkspace("Retry Co");
      faults.failWhen(/^GET \/rest\/v1\/members\?/);
      await page.reload();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "We could not load your workspace",
      );

      faults.failWhen(null);
      await page.getByRole("button", { name: "Try again" }).click();

      await expect(workspace.workspaceName).toHaveText("Retry Co");
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    } finally {
      await user.context.close();
    }
  });

  test("AC3: a user with no workspace yet still gets the onboarding form once the lookup works (null means 'no membership' only)", async ({
    browser,
  }) => {
    const user = await signedInFreshUser(browser, app.baseUrl, "ac3-null");
    const page = await user.context.newPage();
    const workspace = new WorkspacePage(page);
    try {
      faults.failWhen(/^GET \/rest\/v1\/members\?/);
      await page.goto("/app");
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "We could not load your workspace",
      );
      await expect(workspace.nameInput).toHaveCount(0);

      faults.failWhen(null);
      await page.reload();
      await expect(workspace.nameInput).toBeVisible();
      await expect(workspace.nameInput).toHaveValue(/workspace$/);
    } finally {
      await user.context.close();
    }
  });

  test("AC3: a failed onboarding submit keeps what the user typed, and resubmitting works", async ({
    browser,
  }) => {
    const user = await signedInFreshUser(browser, app.baseUrl, "ac3-keep");
    const page = await user.context.newPage();
    const workspace = new WorkspacePage(page);
    try {
      await page.goto("/app");
      faults.failWhen(/^POST \/rest\/v1\/rpc\/onboard_current_user/);

      await workspace.nameInput.fill("My Typed Workspace Name");
      const responded = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/app"),
      );
      await workspace.createButton.click();
      await responded;

      await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "Something went wrong. Please try again.",
      );
      // React resets the form after the action; the typed value must come back, not the suggestion.
      await expect(workspace.nameInput).toHaveValue("My Typed Workspace Name");
      expect(faults.failedCount()).toBeGreaterThan(0);
      expect(await user.memberships()).toBe(0);
      await page.screenshot({ path: "test-results/ago-201-ac3-failed-submit-keeps-input.png" });

      faults.failWhen(null);
      await workspace.createButton.click();
      await expect(workspace.workspaceName).toHaveText("My Typed Workspace Name");
      await expect(workspace.workspaceRole).toHaveText("owner");
    } finally {
      await user.context.close();
    }
  });
});

test.describe("AGO-201 AC3: validation errors keep the input (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");

  test("AC3: a rejected name (blank, over-long) stays in the box exactly as typed", async ({
    browser,
    baseURL,
  }) => {
    const user = await signedInFreshUser(browser, baseURL ?? "", "ac3-validate");
    const page = await user.context.newPage();
    const workspace = new WorkspacePage(page);
    try {
      await page.goto("/app");
      // Remove the client-side limits so the server's own checks answer.
      await workspace.nameInput.evaluate((input: HTMLInputElement) => {
        input.removeAttribute("maxlength");
        input.removeAttribute("required");
        input.form?.setAttribute("novalidate", "");
      });
      const cases: [string, string][] = [
        ["   ", "Give your workspace a name."],
        ["w".repeat(121), "Keep the name under 120 characters."],
      ];
      for (const [typed, message] of cases) {
        await workspace.nameInput.fill(typed);
        const responded = page.waitForResponse(
          (response) => response.request().method() === "POST" && response.url().endsWith("/app"),
        );
        await workspace.createButton.click();
        await responded;
        await expect(page.getByRole("main").getByRole("alert")).toContainText(message);
        await expect(workspace.nameInput).toHaveValue(typed);
      }
      expect(await user.memberships()).toBe(0);
    } finally {
      await user.context.close();
    }
  });
});

test.describe("AGO-201 AC3 (negative): signed out", () => {
  test("AC3 (negative): a signed-out visitor to /app is sent to sign-in, never shown a workspace or the error state", async ({
    page,
  }) => {
    await page.goto("/app");

    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByText("We could not load your workspace")).toHaveCount(0);
    await expect(page.getByLabel("Workspace name")).toHaveCount(0);
  });
});

test.describe("AGO-201 AC5: X-Forwarded-For is trusted only behind a configured proxy", () => {
  // Rate-limit budgets (src/lib/rate-limit/rules.ts): 60 sign-in POSTs/min, 30 auth callbacks/min per IP.
  const actionHeaders = { "next-action": "00".repeat(20) };

  test.describe("TRUST_PROXY_HEADERS unset (the default)", () => {
    let app: AppServer;

    test.beforeAll(async () => {
      app = await startAppServer({}, isUp);
    });

    test.afterAll(async () => {
      await app.stop();
    });

    test("AC5: a spoofed X-Forwarded-For on every request creates no new bucket: the 61st sign-in POST is still 429", async ({
      request,
    }) => {
      const post = (spoofed: string) =>
        request.post(`${app.baseUrl}/sign-in`, {
          headers: { ...actionHeaders, "x-forwarded-for": spoofed },
          data: "[]",
          failOnStatusCode: false,
          maxRedirects: 0,
        });

      for (let attempt = 1; attempt <= 60; attempt++) {
        const status = (await post(uniqueIp())).status();
        expect(status, `attempt ${String(attempt)}`).not.toBe(429);
      }
      const blocked = await post(uniqueIp());

      expect(blocked.status()).toBe(429);
      expect(Number(blocked.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
    });

    test("AC5: a spoofed X-Real-IP is ignored too: the 31st auth callback is 429 whatever address it claims", async ({
      request,
    }) => {
      const callback = (spoofed: string) =>
        request.get(`${app.baseUrl}/auth/callback?code=bogus`, {
          headers: { "x-real-ip": spoofed },
          maxRedirects: 0,
          failOnStatusCode: false,
        });

      for (let attempt = 1; attempt <= 30; attempt++) {
        const status = (await callback(`203.0.113.${String(attempt)}`)).status();
        expect(status, `attempt ${String(attempt)}`).not.toBe(429);
      }

      expect((await callback("203.0.113.200")).status()).toBe(429);
    });
  });

  test("AC5 (negative): a typo in TRUST_PROXY_HEADERS stops the server at startup instead of silently trusting or ignoring the header", async ({
    request,
  }) => {
    for (const typo of ["yes", "TRUE"]) {
      // Ready as soon as anything answers: a refused configuration answers 500 for every request.
      const app = await startAppServer(
        {},
        async (url) => (await fetch(`${url}/sign-in`)).status > 0,
        {
          TRUST_PROXY_HEADERS: typo,
        },
      );
      try {
        const response = await request.get(`${app.baseUrl}/sign-in`, { failOnStatusCode: false });

        expect(response.status(), typo).toBe(500);
        await expect.poll(() => app.logs(), typo).toContain("TRUST_PROXY_HEADERS: invalid");
        // The value itself is never printed (the error names the variable, not its content).
        expect(app.logs()).not.toContain(`=${typo}`);
      } finally {
        await app.stop();
      }
    }
  });

  test("AC5: with TRUST_PROXY_HEADERS=true the first hop picks the bucket: later hops change nothing, another first hop is separate", async ({
    request,
  }) => {
    // The suite's own web server runs with the switch on (playwright.config.ts).
    const firstHop = uniqueIp();
    const callback = (header: string) =>
      request.get("/auth/callback?code=bogus", {
        headers: { "x-forwarded-for": header },
        maxRedirects: 0,
        failOnStatusCode: false,
      });

    for (let attempt = 1; attempt <= 30; attempt++) {
      // Same first hop, a different tail each time: still one caller.
      expect((await callback(`${firstHop}, 10.0.0.${String(attempt)}`)).status()).toBe(307);
    }
    const blocked = await callback(`${firstHop}, 10.9.9.9`);
    const other = await callback(uniqueIp("10.0.0.1"));

    expect(blocked.status()).toBe(429);
    expect(other.status()).toBe(307);
  });
});
