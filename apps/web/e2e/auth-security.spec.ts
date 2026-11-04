import { expect, test } from "./fixtures";
import { SignInPage } from "./pages/sign-in-page";

// AGO-67 security negatives that need no Supabase stack (they also run in CI).
const EVIL_NEXT_VALUES = [
  "//evil.example",
  "https://evil.example",
  "/\\evil.example",
  "%2F%2Fevil.example",
  "%5C%5Cevil.example",
  "/%5Cevil.example",
  "https:%2F%2Fevil.example",
  "javascript:alert(1)",
  "/%09/evil.example",
  "/..//evil.example",
  "%252F%252Fevil.example",
];
// `/..//evil.example` is kept as a path by sign-in (it resolves to a same-origin path), so only
// the redirect property is asserted for it, not the sanitised field value.
const SANITISED_TO_APP = EVIL_NEXT_VALUES.filter((value) => value !== "/..//evil.example");

test.describe("AGO-67 open redirect via next=", () => {
  for (const value of EVIL_NEXT_VALUES) {
    test(`AC1: the callback never redirects off-site for next=${value}`, async ({ request }) => {
      const response = await request.get(`/auth/callback?code=bogus&next=${value}`, {
        maxRedirects: 0,
      });

      expect(response.status()).toBe(307);
      const location = new URL(response.headers().location ?? "", response.url());
      expect(location.origin).toBe(new URL(response.url()).origin);
      expect(location.pathname).toBe("/sign-in");
    });
  }

  for (const value of SANITISED_TO_APP) {
    test(`AC1: sign-in sanitises next=${value} to /app`, async ({ page }) => {
      await new SignInPage(page).goto(`/sign-in?next=${value}`);

      await expect(page.locator('input[name="next"]').first()).toHaveValue("/app");
    });
  }
});

test.describe("AGO-67 protected routes without a browser", () => {
  test("AC2: a direct request to /app is redirected to sign-in, not served", async ({
    request,
  }) => {
    const response = await request.get("/app", { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    expect(response.headers().location).toContain("/sign-in?next=%2Fapp");
    expect(await response.text()).not.toContain("Your workspace");
  });

  test("AC2: a bearer token (the anon key as an agent token would be) is not a session", async ({
    request,
  }) => {
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key-no-stack";
    const response = await request.get("/app", {
      maxRedirects: 0,
      headers: { authorization: `Bearer ${anonKey}`, apikey: anonKey },
    });

    expect(response.status()).toBe(307);
    expect(response.headers().location).toContain("/sign-in");
  });

  test("AC3: sign-out cannot be triggered by a GET to any plausible URL", async ({ request }) => {
    for (const path of ["/sign-out", "/signout", "/auth/sign-out", "/auth/signout", "/logout"]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(404);
    }
  });
});

test.describe("AGO-67 secrets in the client bundle", () => {
  test("no token other than the anon key, and no service-role key, ships to the browser", async ({
    page,
    request,
  }) => {
    const scripts: string[] = [];
    page.on("response", (response) => {
      if (response.url().endsWith(".js") || response.url().includes(".js?")) {
        scripts.push(response.url());
      }
    });
    await new SignInPage(page).goto();
    await page.waitForLoadState("networkidle");
    const html = await page.content();
    expect(scripts.length).toBeGreaterThan(0);

    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key-no-stack";
    const jwtPattern = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;
    const bodies = [html];
    for (const url of scripts) bodies.push(await (await request.get(url)).text());
    const jwts = new Set(bodies.flatMap((body) => body.match(jwtPattern) ?? []));

    for (const jwt of jwts) {
      expect(jwt).toBe(anonKey);
      const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as {
        role?: string;
      };
      expect(payload.role).toBe("anon");
    }
    for (const body of bodies) {
      expect(body).not.toMatch(/service_role|SERVICE_ROLE/);
      expect(body).not.toMatch(/SUPABASE_AUTH_EXTERNAL_\w+_SECRET/);
    }
  });
});
