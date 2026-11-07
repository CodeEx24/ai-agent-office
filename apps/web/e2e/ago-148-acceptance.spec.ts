import { AUTH_STATE_PATH, expect, isLiveStack, test } from "./fixtures";
import { startProduction } from "./support/production-server";

// AGO-148 (per-agent identity and short-lived scoped credentials), acceptance criteria as an outside caller sees
// them. The credential rules themselves (AC1 expiry, AC2 scope, AC3 issuance log) have no screen: they are proved
// against the real worker and database in scripts/ago-148-qa.test.mjs and supabase/tests/agent_credentials_qa.test.sql.
// What a caller can observe over HTTP is the human-only guard: an agent credential is refused on every route.
// Stack-free cases run in CI; the signed-in cases need the local Supabase stack (E2E_SUPABASE=1).

// Shaped like a real credential (`ago_agt_<header>.<payload>.<signature>`); signed by nobody, because the guard
// looks at the prefix only and must refuse even a forged one.
const FAKE_TOKEN = "ago_agt_eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoidG9rZW4ifQ.c2lnbmF0dXJl";
const AGENT_HEADERS = { authorization: `Bearer ${FAKE_TOKEN}` };
const DENIED = { error: "agent_credential_not_allowed" };

const HUMAN_ONLY_PATHS = [
  "/",
  "/sign-in",
  "/app",
  "/app/agents",
  "/app/agents/new",
  "/app/skills",
  "/api/capabilities",
  "/api/approvals",
  "/app/approvals",
  "/auth/callback",
];

test.describe("AGO-148 AC2: an agent credential cannot act as a person", () => {
  for (const path of HUMAN_ONLY_PATHS) {
    test(`AC2: GET ${path} with an agent credential is refused with 403 and never echoes the token`, async ({
      request,
    }) => {
      const response = await request.get(path, {
        headers: AGENT_HEADERS,
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(DENIED);
      expect(response.headers()["cache-control"]).toContain("no-store");
      const raw = JSON.stringify(response.headers()) + (await response.text());
      expect(raw).not.toContain(FAKE_TOKEN);
      expect(raw).not.toContain("ago_agt_");
    });
  }

  test("AC2 (negative): the same request without the credential is not refused by the guard", async ({
    request,
  }) => {
    const response = await request.get("/api/capabilities", {
      failOnStatusCode: false,
      maxRedirects: 0,
    });

    // Whatever the route answers signed out (401 live, 400 against the stub auth server), it is not the
    // guard's 403, which proves the refusal above came from the credential.
    expect(response.status()).not.toBe(403);
    expect(await response.text()).not.toContain("agent_credential_not_allowed");
  });

  test("AC2 (negative): a human token that merely contains the prefix is not mistaken for a credential", async ({
    request,
  }) => {
    const response = await request.get("/api/capabilities", {
      headers: { authorization: "Bearer not-ago_agt_a-credential" },
      failOnStatusCode: false,
      maxRedirects: 0,
    });

    expect(response.status()).not.toBe(403);
  });

  for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
    test(`AC2 (negative): the "${scheme}" scheme spelling does not slip past the guard`, async ({
      request,
    }) => {
      const response = await request.get("/api/capabilities", {
        headers: { authorization: `${scheme} ${FAKE_TOKEN}` },
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(DENIED);
    });
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`AC2 (negative): ${method} to the capabilities route with an agent credential is refused`, async ({
      request,
    }) => {
      const response = await request.fetch("/api/capabilities", {
        method,
        headers: AGENT_HEADERS,
        data: {},
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual(DENIED);
    });
  }

  test("AC2 (negative): a create-agent server action call with an agent credential never reaches the action", async ({
    request,
  }) => {
    const response = await request.post("/app/agents/new", {
      headers: {
        ...AGENT_HEADERS,
        "next-action": "00".repeat(20),
        "content-type": "text/plain;charset=UTF-8",
      },
      data: "[]",
      failOnStatusCode: false,
      maxRedirects: 0,
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual(DENIED);
  });

  test("AC2 (negative): a path variant (trailing slash, doubled slash, other case) does not reach a route with an agent credential", async ({
    request,
  }) => {
    for (const path of ["/api/capabilities/", "/api//capabilities", "/API/capabilities"]) {
      // Redirects are followed (a trailing slash is a 308 to the canonical path): wherever the request
      // ends up, the credential must still be refused.
      const response = await request.get(path, {
        headers: AGENT_HEADERS,
        failOnStatusCode: false,
      });
      expect(response.status(), path).toBe(403);
      expect(await response.json(), path).toEqual(DENIED);
    }
  });

  test.describe("with a signed-in session", () => {
    test.skip(!isLiveStack, "needs the local Supabase stack");
    test.use({ storageState: AUTH_STATE_PATH });

    test("AC2 (negative): a valid session cookie does not let an agent credential through", async ({
      request,
    }) => {
      const asPerson = await request.get("/api/capabilities", { failOnStatusCode: false });
      expect(asPerson.status(), "the session alone is accepted").toBe(200);

      const withToken = await request.get("/api/capabilities", {
        headers: AGENT_HEADERS,
        failOnStatusCode: false,
      });

      expect(withToken.status()).toBe(403);
      expect(await withToken.json()).toEqual(DENIED);
    });

    test("AC2 (negative): the create-agent page refuses an agent credential even with a session", async ({
      request,
    }) => {
      const asPerson = await request.get("/app/agents/new", {
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(asPerson.status(), "the session alone is accepted").toBe(200);

      const withToken = await request.get("/app/agents/new", {
        headers: AGENT_HEADERS,
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      expect(withToken.status()).toBe(403);
    });
  });
});

// A deployed app without the signing secret must not start serving: a credential signed with a guessable key is
// worse than no credential. Public URLs here are placeholders; no real secret is used or printed.
const DEPLOYED_ENV = {
  APP_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://agent-office.example.test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
  DATABASE_URL: "postgresql://placeholder:placeholder@db.example.test:5432/postgres",
};
const SECRET_NAME = "AGENT_CREDENTIAL_SIGNING_SECRET";

test.describe("AGO-148 AC1/AC2: the signing secret is mandatory when deployed", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const appEnv of ["production", "preview"]) {
    test(`AC2 (negative): ${appEnv} without the signing secret never serves a page and names the variable`, async () => {
      const started = await startProduction({ ...DEPLOYED_ENV, APP_ENV: appEnv });

      expect(started.status).toBe(500);
      expect(started.body).not.toContain("Agent Office");
      expect(started.logs).toContain(`${SECRET_NAME}: missing`);
    });
  }

  test("AC2 (negative): a secret shorter than 32 characters is refused, and its value is never printed", async () => {
    const planted = "short-planted-secret-8c2d";
    const started = await startProduction({ ...DEPLOYED_ENV, [SECRET_NAME]: planted });

    expect(started.status).toBe(500);
    expect(started.logs).toContain(SECRET_NAME);
    expect(started.logs).not.toContain(planted);
    expect(started.body).not.toContain(planted);
  });

  test("AC2: a deployed config with a 32+ character secret passes the secret check, and the secret is never printed", async () => {
    const planted = "a-long-planted-signing-secret-for-the-e2e-test-7f3a";
    const started = await startProduction({ ...DEPLOYED_ENV, [SECRET_NAME]: planted });

    expect(started.logs).not.toContain(SECRET_NAME);
    expect(started.logs).not.toContain(planted);
    expect(started.body).not.toContain(planted);
  });
});
