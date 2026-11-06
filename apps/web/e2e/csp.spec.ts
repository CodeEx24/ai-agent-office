import { expect, test } from "./fixtures";

// AGO-66 AC3: the Content-Security-Policy blocks inline scripts. These run against the production
// build (`next start`), where script-src has no 'unsafe-inline'. The auto console-error guard in
// ./fixtures already fails any test whose page logs a CSP violation, so every "page renders" test
// below also proves the policy does not break the page. /app needs a session: see csp-live.spec.ts.

const PAGES = ["/", "/sign-in", "/dev/ui", "/dev/3d"] as const;

function scriptSrc(csp: string | undefined): string[] {
  const part = csp?.split("; ").find((directive) => directive.startsWith("script-src "));
  return part ? part.split(" ").slice(1) : [];
}

interface WithPwned {
  __pwned?: number;
}

test.describe("AGO-66 AC3: CSP header", () => {
  for (const path of PAGES) {
    test(`${path} is served with a nonce-based, enforcing CSP`, async ({ request }) => {
      const response = await request.get(path);

      expect(response.ok()).toBe(true);
      const headers = response.headers();
      // Enforcing header, not Content-Security-Policy-Report-Only.
      expect(headers["content-security-policy-report-only"]).toBeUndefined();
      const sources = scriptSrc(headers["content-security-policy"]);
      expect(sources.some((source) => /^'nonce-[A-Za-z0-9+/=]+'$/.test(source))).toBe(true);
      expect(sources).toContain("'strict-dynamic'");
      expect(sources).not.toContain("'unsafe-inline'");
      expect(sources).not.toContain("'unsafe-eval'");
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(headers["content-security-policy"]).toContain("object-src 'none'");
    });
  }

  test("the nonce is new on every request and is on every inline script", async ({ request }) => {
    const first = await request.get("/");
    const second = await request.get("/");
    const nonceOf = (csp: string | undefined) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1];

    const firstNonce = nonceOf(first.headers()["content-security-policy"]);
    expect(firstNonce).toBeTruthy();
    expect(firstNonce).not.toBe(nonceOf(second.headers()["content-security-policy"]));

    const html = await first.text();
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>/g)];
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const [, attributes] of inlineScripts) {
      expect(attributes).toContain(`nonce="${firstNonce ?? ""}"`);
    }
  });

  test("baseline security headers are present on pages and static assets", async ({ request }) => {
    const page = await request.get("/");
    const asset = /\/_next\/static\/[^"]+\.css/.exec(await page.text())?.[0];
    expect(asset).toBeTruthy();

    for (const response of [page, await request.get(asset ?? "")]) {
      const headers = response.headers();
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"]).toContain("camera=()");
      expect(headers["x-frame-options"]).toBe("DENY");
    }
  });
});

test.describe("AGO-66 AC3: pages still render and hydrate under the CSP", () => {
  for (const path of PAGES) {
    test(`${path} loads with no CSP violation or console error`, async ({ page }) => {
      const response = await page.goto(path);

      expect(response?.ok()).toBe(true);
      await expect(page.locator("main")).toBeVisible();
    });
  }

  test("/ hydrates: the nonced theme script runs and the client toggle responds", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const html = page.locator("html");
    // The pre-paint inline script (carries the nonce) applied the system theme.
    await expect(html).toHaveClass(/\bdark\b/);

    // Client JS: system -> light on the first click proves hydration under the CSP.
    await page.getByTestId("theme-toggle").click();
    await expect(html).toHaveClass(/\blight\b/);
  });

  test("/dev/3d renders the WebGL canvas under the CSP", async ({ page }) => {
    await page.goto("/dev/3d");

    await expect(page.getByTestId("dev-3d-viewer")).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("AGO-66 AC3: an injected inline script does not execute", () => {
  // The violation is expected here; every other console error still fails the test.
  test.use({ allowedConsoleErrors: [/Content Security Policy|Refused to execute inline script/i] });

  test("a parser-inserted <script> in the document is blocked and reported", async ({ page }) => {
    // Serve the real page (real CSP header, real nonce) with an attacker-style inline script
    // added, i.e. what a stored/reflected XSS would produce. It has no nonce.
    await page.route("**/sign-in", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "</body>",
        "<script>window.__pwned = 1; document.title = 'pwned';</script></body>",
      );
      return route.fulfill({ response, body });
    });
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });

    await page.goto("/sign-in");
    await expect(page.locator("main")).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as WithPwned).__pwned)).toBeUndefined();
    await expect(page).not.toHaveTitle("pwned");
    expect(violations.some((text) => /inline script/i.test(text))).toBe(true);
  });

  test("an inline event handler attribute is blocked", async ({ page }) => {
    await page.route("**/sign-in", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "</body>",
        // A data: URI that is not an image fires `error` without any network request.
        `<img src="data:image/png;base64,AAAA" onerror="window.__pwned = 1" alt=""></body>`,
      );
      return route.fulfill({ response, body });
    });

    await page.goto("/sign-in");
    await page.waitForLoadState("networkidle");

    expect(await page.evaluate(() => (window as unknown as WithPwned).__pwned)).toBeUndefined();
  });
});
