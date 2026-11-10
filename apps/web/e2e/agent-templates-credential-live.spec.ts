import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { AgentTemplatesPage } from "./pages/agent-templates-page";
import { AgentWizardPage } from "./pages/agent-wizard-page";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-136 + AGO-148 QA: an agent credential (`Authorization: Bearer ago_agt_...`) can never create an agent, not
// through the one-click template action and not through the wizard action, even when it rides on a signed-in
// owner's session. Local stack only (E2E_SUPABASE=1). Run inside the db lock: `node scripts/db-lock.mjs acquire AGO-136-qa`.
test.describe("AGO-136 QA: an agent credential cannot create agents (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 180_000 });
  // The refused server action answers 403 JSON: the browser logs the failed load and Next reports an unexpected response.
  // One combined pattern: Playwright reads a two-element array option as a [value, options] tuple.
  test.use({
    allowedConsoleErrors: [
      /unexpected response was received from the server|Failed to load resource: the server responded with a status of 403/i,
    ],
  });

  // Shaped like a real credential; signed by nobody, because the guard looks at the prefix only.
  const FAKE_TOKEN = "ago_agt_eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoidG9rZW4ifQ.c2lnbmF0dXJl";
  const DENIED = { error: "agent_credential_not_allowed" };

  async function world() {
    const owner = await createUser("tcred-owner");
    const workspaceId = await onboard(owner, "Credential QA Co");
    return { owner, workspaceId };
  }

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function agentsIn(workspaceId: string) {
    return svcRows("agents", `workspace_id=eq.${workspaceId}&select=*&order=created_at`);
  }

  interface SeenResponse {
    status: number;
    body: string;
  }

  /**
   * Makes every server-action POST from this page carry an agent credential, as a forwarded request would, and
   * records the answer. The body is read here because the page consumes the streamed response itself.
   */
  async function attachAgentCredential(page: Page): Promise<SeenResponse[]> {
    const seen: SeenResponse[] = [];
    await page.route("**/app/agents**", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({
        headers: { ...route.request().headers(), authorization: `Bearer ${FAKE_TOKEN}` },
      });
      seen.push({ status: response.status(), body: await response.text() });
      return route.fulfill({ response });
    });
    return seen;
  }

  async function detachAgentCredential(page: Page) {
    await page.unroute("**/app/agents**");
  }

  test("AC4: the one-click template action refuses an agent credential, even on an owner's session, and creates nothing", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);
    await gallery.goto();

    const seen = await attachAgentCredential(page);
    await gallery.createButton("Writer").click();
    await expect.poll(() => seen.length).toBe(1);

    expect(seen[0]?.status).toBe(403);
    expect(JSON.parse(seen[0]?.body ?? "null")).toEqual(DENIED);
    expect(seen[0]?.body).not.toContain(FAKE_TOKEN);
    expect(await agentsIn(w.workspaceId)).toHaveLength(0);

    // Control: the same click as a person (no credential) works, so the refusal above came from the credential.
    await detachAgentCredential(page);
    await gallery.goto();
    await gallery.createButton("Writer").click();
    await expect(gallery.agentList).toContainText("Writer");
    expect(await agentsIn(w.workspaceId)).toHaveLength(1);
  });

  test("AC4: the wizard's create action refuses an agent credential, even on an owner's session, and creates nothing", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);

    const fillToReview = async () => {
      await wizard.goto();
      await wizard.fillBasics({ name: "Credential Probe", model: "claude-opus-5-5" });
      await wizard.advance(4);
      await expect(wizard.review).toContainText("Strict");
    };

    await fillToReview();
    const seen = await attachAgentCredential(page);
    await wizard.createButton.click();
    await expect.poll(() => seen.length).toBe(1);

    expect(seen[0]?.status).toBe(403);
    expect(JSON.parse(seen[0]?.body ?? "null")).toEqual(DENIED);
    expect(seen[0]?.body).not.toContain(FAKE_TOKEN);
    expect(await agentsIn(w.workspaceId)).toHaveLength(0);

    // Control: the same wizard run as a person creates the agent.
    await detachAgentCredential(page);
    await fillToReview();
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(wizard.agentList).toContainText("Credential Probe");
    expect(await agentsIn(w.workspaceId)).toHaveLength(1);
  });

  test("AC4: a forged server-action call with an agent credential from a member's session creates nothing", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const member = await createUser("tcred-member");
    await addMember(w.workspaceId, member, "member");
    await signIn(page, baseURL, member);
    await page.goto("/app/agents");

    const forged = await page.request.post("/app/agents", {
      headers: {
        authorization: `Bearer ${FAKE_TOKEN}`,
        "next-action": "00".repeat(20),
        "content-type": "text/plain;charset=UTF-8",
      },
      data: "[]",
      failOnStatusCode: false,
      maxRedirects: 0,
    });

    expect(forged.status()).toBe(403);
    expect(await forged.json()).toEqual(DENIED);
    expect(await agentsIn(w.workspaceId)).toHaveLength(0);
  });
});
