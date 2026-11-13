import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { AgentWizardPage } from "./pages/agent-wizard-page";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-138: the trifecta lint in the agent wizard, driven through the real UI. Local stack only
// (E2E_SUPABASE=1). Run inside the db lock: `node scripts/db-lock.mjs acquire AGO-138`.
//
//   AC1  untrusted + private + outbound is blocked with an explanation (live in the wizard, and on the server)
//   AC2  the Researcher and Analyst templates create agents without the lint error
// Set TRIFECTA_SHOT_DIR to also save a screenshot at every step.
test.describe("AGO-138: trifecta lint in the wizard (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  const SHOT_DIR = process.env.TRIFECTA_SHOT_DIR;
  const TRIPLE = [/Search the web/, /Read own private notes/, /Send outbound messages/] as const;

  async function shot(page: Page, name: string) {
    if (!SHOT_DIR) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, `AGO-138-${name}.png`), fullPage: true });
  }

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner: TestUser = await createUser("tri-owner");
    const workspaceId = await onboard(owner, "Trifecta Co");
    return { owner, workspaceId };
  }

  async function agentsNamed(workspaceId: string, name: string) {
    return svcRows(
      "agents",
      `workspace_id=eq.${workspaceId}&name=eq.${encodeURIComponent(name)}&select=*`,
    );
  }

  async function toCapabilities(wizard: AgentWizardPage, name: string) {
    await wizard.goto();
    await wizard.fillBasics({ name });
    await wizard.advance(2);
    await expect(wizard.capability(TRIPLE[0])).toBeVisible();
  }

  test("AC1: all three legs show the explanation live and block Next; removing one continues; creating works", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    const alert = page.locator("#agent-capabilities-error");
    await signIn(page, baseURL, w.owner);
    await toCapabilities(wizard, "Triple");
    await shot(page, "AC1-step-01-capabilities-empty");
    await expect(alert).toHaveCount(0);

    await wizard.capability(TRIPLE[0]).check();
    await wizard.capability(TRIPLE[1]).check();
    await shot(page, "AC1-step-02-two-legs-no-message");
    await expect(alert).toHaveCount(0);

    await wizard.capability(TRIPLE[2]).check();
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/untrusted/i);
    await expect(alert).toContainText("Search the web");
    await expect(alert).toContainText("Read own private notes");
    await expect(alert).toContainText("Send outbound messages");
    await shot(page, "AC1-step-03-three-legs-explanation");

    await wizard.next();
    await expect(wizard.capability(TRIPLE[0])).toBeVisible(); // still on the capabilities step
    await expect(wizard.dailyBudget).toHaveCount(0);
    await expect(alert).toBeVisible();
    await shot(page, "AC1-step-04-next-blocked");

    await wizard.capability(TRIPLE[2]).uncheck();
    // Next recomputes the lint, so the owner can continue; whether the old message disappears at once is
    // checked by the separate test below.
    await shot(page, "AC1-step-05-one-removed");
    await wizard.next();
    await expect(wizard.dailyBudget).toBeVisible();
    await shot(page, "AC1-step-06-continued-to-budget");
    await wizard.next();
    await expect(wizard.review).toBeVisible();
    await shot(page, "AC1-step-07-review");
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(wizard.agentList).toContainText("Triple");
    await shot(page, "AC1-step-08-created-two-legs");
    expect(await agentsNamed(w.workspaceId, "Triple")).toHaveLength(1);
  });

  test("AC1: removing a leg after Next was blocked clears the explanation at once", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    const alert = page.locator("#agent-capabilities-error");
    await signIn(page, baseURL, w.owner);
    await toCapabilities(wizard, "Stale");
    for (const name of TRIPLE) await wizard.capability(name).check();
    await wizard.next();
    await expect(alert).toBeVisible();
    await shot(page, "AC1-stale-step-01-blocked-after-next");
    await wizard.capability(TRIPLE[2]).uncheck();
    const isStale = (await alert.count()) > 0;
    await shot(page, `AC1-stale-step-02-one-removed${isStale ? "-FAIL" : ""}`);
    await expect(alert).toHaveCount(0);
  });

  test("AC1: the broad mapping counts (shared notes, browse, integration write) and every two-leg set is allowed", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    const alert = page.locator("#agent-capabilities-error");
    await signIn(page, baseURL, w.owner);
    await toCapabilities(wizard, "Broad");

    const broad = [/Browse the web/, /Read shared notes/, /Write to integrations/];
    for (const name of broad) await wizard.capability(name).check();
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Browse the web");
    await expect(alert).toContainText("Read shared notes");
    await expect(alert).toContainText("Write to integrations");
    await shot(page, "AC1-broad-step-01-broad-trifecta-blocked");
    for (const name of broad) await wizard.capability(name).uncheck();
    await expect(alert).toHaveCount(0);

    const pairs = [
      [TRIPLE[0], TRIPLE[1]],
      [TRIPLE[0], TRIPLE[2]],
      [TRIPLE[1], TRIPLE[2]],
    ] as const;
    let n = 2;
    for (const [a, b] of pairs) {
      await wizard.capability(a).check();
      await wizard.capability(b).check();
      await expect(alert).toHaveCount(0);
      await shot(page, `AC1-pairs-step-${String(n).padStart(2, "0")}-two-legs-allowed`);
      n += 1;
      await wizard.capability(a).uncheck();
      await wizard.capability(b).uncheck();
    }
    await wizard.capability(TRIPLE[0]).check();
    await wizard.capability(TRIPLE[1]).check();
    await wizard.next();
    await expect(wizard.dailyBudget).toBeVisible();
    expect(await agentsNamed(w.workspaceId, "Broad")).toHaveLength(0);
  });

  test("AC1: a tampered request with all three legs is refused by the server with the explanation and creates nothing", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await wizard.goto();
    await wizard.fillBasics({ name: "Sneaky" });
    await wizard.advance(4);
    await expect(wizard.review).toBeVisible();
    await wizard.tamper(
      "capabilities",
      JSON.stringify([
        { key: "web.search", mode: "approval" },
        { key: "vault.read_private", mode: "approval" },
        { key: "message.send_outbound", mode: "approval" },
      ]),
    );
    await wizard.createButton.click();
    await expect(wizard.fieldError("capabilities")).toContainText(/untrusted/i);
    await shot(page, "AC1-server-step-01-tampered-refused");
    await expect(page).toHaveURL(/\/app\/agents\/new$/);
    expect(await agentsNamed(w.workspaceId, "Sneaky")).toHaveLength(0);
  });

  test("AC2: the Researcher and Analyst templates create agents without the lint error (one click and the picker)", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents");
    await shot(page, "AC2-step-01-template-list");
    for (const [i, template] of ["Researcher", "Analyst"].entries()) {
      await page.getByRole("button", { name: `Create ${template}`, exact: true }).click();
      await expect(wizard.agentList).toContainText(template);
      await expect(page.getByText(/this combination is blocked/)).toHaveCount(0);
      await shot(page, `AC2-step-0${String(i + 2)}-${template.toLowerCase()}-created`);
      expect(await agentsNamed(w.workspaceId, template)).toHaveLength(1);
    }

    for (const [id, name] of [
      ["researcher", "Scout"],
      ["analyst", "Numbers"],
    ] as const) {
      await wizard.goto();
      await page.getByLabel("Start from a template (optional)").selectOption(id);
      await wizard.name.fill(name);
      await wizard.advance(2);
      await expect(page.locator("#agent-capabilities-error")).toHaveCount(0);
      await shot(page, `AC2-picker-${id}-step-01-capabilities-no-error`);
      await wizard.advance(2);
      await expect(wizard.review).toBeVisible();
      await wizard.createButton.click();
      await expect(page).toHaveURL(/\/app\/agents$/);
      await expect(wizard.agentList).toContainText(name);
      await shot(page, `AC2-picker-${id}-step-02-created`);
      expect(await agentsNamed(w.workspaceId, name)).toHaveLength(1);
    }
  });
});
