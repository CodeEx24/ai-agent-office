import type { Page } from "@playwright/test";
import { AGENT_TEMPLATES } from "@ago/shared/agent-templates";

import { expect, isLiveStack, test } from "./fixtures";
import { AgentTemplatesPage } from "./pages/agent-templates-page";
import { AgentWizardPage } from "./pages/agent-wizard-page";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-136 QA: acceptance criteria and attacks, one test per criterion, driven through the real UI.
// Local stack only (E2E_SUPABASE=1). Run inside the db lock: `node scripts/db-lock.mjs acquire AGO-136-qa`.
// Complements agent-templates-live.spec.ts (the implementer's spec).
//
//   AC1  each template creates a valid agent in one click   AC2  Researcher: web, no private notes; Analyst: reverse
//   AC3  suggested models are Opus, Sonnet or Fable          AC4  no regressions (role matrix, double click, expiry)
test.describe("AGO-136 QA: role templates acceptance (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 180_000 });

  const ALLOWED_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];
  const MIN_NEVER_AUTOMATIC_TIER = 3;

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("tqa-owner");
    const member = await createUser("tqa-member");
    const viewer = await createUser("tqa-viewer");
    const stranger = await createUser("tqa-stranger");
    const workspaceId = await onboard(owner, "Template QA Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    const otherWorkspaceId = await onboard(stranger, "Template QA Elsewhere Co");
    return { owner, member, viewer, stranger, workspaceId, otherWorkspaceId };
  }

  async function agentsIn(workspaceId: string) {
    return svcRows("agents", `workspace_id=eq.${workspaceId}&select=*&order=created_at`);
  }

  async function agentNamed(workspaceId: string, name: string) {
    const [agent] = await svcRows(
      "agents",
      `workspace_id=eq.${workspaceId}&name=eq.${encodeURIComponent(name)}&select=*`,
    );
    return agent;
  }

  async function grantsOf(agentId: string) {
    return svcRows(
      "agent_capabilities",
      `agent_id=eq.${agentId}&select=capability,tier,mode&order=capability`,
    );
  }

  test("AC1: each of the eight templates creates a valid Strict agent in one click, with its prompt, model, budget and grants", async ({
    page,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);
    await gallery.goto();
    await expect(gallery.gallery.getByRole("listitem")).toHaveCount(8);
    await page.screenshot({ path: testInfo.outputPath("gallery.png"), fullPage: true });

    for (const template of AGENT_TEMPLATES) {
      await gallery.createButton(template.name).click();
      await expect(gallery.agentList).toContainText(template.name);

      const agent = await agentNamed(w.workspaceId, template.name);
      expect(agent, template.id).toMatchObject({
        mode: "strict",
        role: template.role,
        model: template.model,
        prompt: template.prompt,
        daily_budget_cents: template.dailyBudgetCents,
      });
      const grants = await grantsOf(String(agent?.id));
      expect(grants.map((g) => g.capability).sort(), template.id).toEqual(
        template.capabilities.map((c) => c.key).sort(),
      );
      for (const grant of grants) {
        const wanted = template.capabilities.find((c) => c.key === grant.capability);
        expect(grant.mode, `${template.id} ${String(grant.capability)}`).toBe(wanted?.mode);
        if (Number(grant.tier) >= MIN_NEVER_AUTOMATIC_TIER) expect(grant.mode).toBe("approval");
      }
      await gallery.goto();
    }
    await expect(page.getByTestId("agent-mode")).toHaveCount(AGENT_TEMPLATES.length);
    for (const label of await page.getByTestId("agent-mode").allTextContents()) {
      expect(label).toBe("Strict");
    }
    await page.screenshot({ path: testInfo.outputPath("eight-agents.png"), fullPage: true });
    expect(await agentsIn(w.workspaceId)).toHaveLength(AGENT_TEMPLATES.length);
  });

  test("AC1: the wizard's template picker pre-fills name, role, model, prompt, budget and grants for every template and stays editable", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);

    for (const template of AGENT_TEMPLATES) {
      await wizard.goto();
      await page.getByLabel("Start from a template (optional)").selectOption(template.id);
      await expect(wizard.name).toHaveValue(template.name);
      await expect(wizard.role).toHaveValue(template.role);
      await expect(wizard.model).toHaveValue(template.model);
      await expect(wizard.prompt).toHaveValue(template.prompt);
      await expect(wizard.name).toBeEditable();
      await expect(wizard.prompt).toBeEditable();

      await wizard.advance(2);
      await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(
        template.capabilities.length,
      );
      await wizard.advance(1);
      await expect(wizard.dailyBudget).toHaveValue((template.dailyBudgetCents / 100).toFixed(2));
    }
    expect(await agentsIn(w.workspaceId)).toHaveLength(0);
  });

  test("AC1: picking Developer in the wizard forces code.run (Tier 3) to approval, and review shows Strict", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await wizard.goto();
    await page.getByLabel("Start from a template (optional)").selectOption("developer");
    await wizard.advance(2);
    await expect(page.getByText("Needs approval every time")).toBeVisible();
    await wizard.advance(2);
    await expect(wizard.review).toContainText("Strict");
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents$/);

    const agent = await agentNamed(w.workspaceId, "Developer");
    expect(agent).toMatchObject({ mode: "strict" });
    const grants = await grantsOf(String(agent?.id));
    const code = grants.find((g) => g.capability === "code.run");
    expect(code).toMatchObject({ mode: "approval" });
    expect(Number(code?.tier)).toBeGreaterThanOrEqual(MIN_NEVER_AUTOMATIC_TIER);
  });

  test("AC2: Researcher has web search and no private notes; Analyst has private notes and no web", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);
    await gallery.goto();
    await gallery.createButton("Researcher").click();
    await expect(gallery.agentList).toContainText("Researcher");
    await gallery.createButton("Analyst").click();
    await expect(gallery.agentList).toContainText("Analyst");

    const researcher = await agentNamed(w.workspaceId, "Researcher");
    const analyst = await agentNamed(w.workspaceId, "Analyst");
    const researcherKeys = (await grantsOf(String(researcher?.id))).map((g) =>
      String(g.capability),
    );
    const analystKeys = (await grantsOf(String(analyst?.id))).map((g) => String(g.capability));
    expect(researcherKeys).toContain("web.search");
    expect(researcherKeys).not.toContain("vault.read_private");
    expect(analystKeys).toContain("vault.read_private");
    expect(analystKeys.filter((key) => key.startsWith("web."))).toEqual([]);
  });

  test("AC2: no template combines web access with private notes (no trifecta)", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);
    await gallery.goto();
    for (const template of AGENT_TEMPLATES) {
      await gallery.createButton(template.name).click();
      await expect(gallery.agentList).toContainText(template.name);
      await gallery.goto();
    }
    for (const agent of await agentsIn(w.workspaceId)) {
      const keys = (await grantsOf(String(agent.id))).map((g) => String(g.capability));
      const hasWeb = keys.some((key) => key.startsWith("web."));
      const hasPrivate = keys.includes("vault.read_private");
      expect(hasWeb && hasPrivate, String(agent.name)).toBe(false);
    }
  });

  test("AC3: every suggested model is Opus, Sonnet or Fable from the catalog, in the created agents", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);
    for (const template of AGENT_TEMPLATES) expect(ALLOWED_MODELS).toContain(template.model);
    await gallery.goto();
    for (const template of AGENT_TEMPLATES) {
      await gallery.createButton(template.name).click();
      await expect(gallery.agentList).toContainText(template.name);
      await gallery.goto();
    }
    for (const agent of await agentsIn(w.workspaceId)) {
      expect(ALLOWED_MODELS, String(agent.name)).toContain(agent.model);
      expect(String(agent.model)).not.toMatch(/haiku/i);
    }
  });

  test("AC4: members and viewers see no templates and cannot open the wizard", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    for (const user of [w.member, w.viewer]) {
      await page.context().clearCookies();
      await signIn(page, baseURL, user);
      await gallery.goto();
      await expect(page.getByText("Only workspace owners can create agents.")).toBeVisible();
      await expect(gallery.gallery).toHaveCount(0);
      await page.goto("/app/agents/new");
      await expect(page).toHaveURL(/\/app\/agents$/);
    }
    expect(await agentsIn(w.workspaceId)).toHaveLength(0);
  });

  test("AC4: an owner's open gallery submitted after the session turns into a member or viewer is refused", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    for (const role of ["member", "viewer"] as const) {
      await page.context().clearCookies();
      await signIn(page, baseURL, w.owner);
      await gallery.goto();
      await signIn(page, baseURL, w[role]); // same page, session replaced under the open form
      await gallery.createButton("Writer").click();
      await expect(gallery.alert.first()).toBeVisible();
      expect(await agentsIn(w.workspaceId), role).toHaveLength(0);
    }
  });

  test("AC4: through the API, a member, a viewer and another workspace's owner cannot create an agent with a template's grants", async () => {
    const w = await world();
    const developer = AGENT_TEMPLATES.find((t) => t.id === "developer");
    if (!developer) throw new Error("no developer template");
    const body = (name: string) => ({
      p_workspace_id: w.workspaceId,
      p_name: name,
      p_role: developer.role,
      p_model: developer.model,
      p_prompt: developer.prompt,
      p_daily_budget_cents: developer.dailyBudgetCents,
      p_skill_ids: [],
      p_capabilities: developer.capabilities,
    });
    for (const [label, user] of [
      ["member", w.member],
      ["viewer", w.viewer],
      ["stranger", w.stranger],
    ] as const) {
      const res = await asUser(user, "/rest/v1/rpc/create_agent", {
        method: "POST",
        body: body(`Api-${label}`),
      });
      expect(res.status, label).toBeGreaterThanOrEqual(400);
    }
    // a Tier 3 grant can never be automatic, even for the owner
    const automatic = await asUser(w.owner, "/rest/v1/rpc/create_agent", {
      method: "POST",
      body: { ...body("Api-automatic"), p_capabilities: [{ key: "code.run", mode: "automatic" }] },
    });
    expect(automatic.status).toBeGreaterThanOrEqual(400);
    expect(await agentsIn(w.workspaceId)).toHaveLength(0);
    expect(await agentsIn(w.otherWorkspaceId)).toHaveLength(0);
  });

  test("AC4: tampering with the one-click request (unknown template, extra fields, other workspace) is refused and creates nothing", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);

    const attempts: [string, () => Promise<void>][] = [
      ["unknown template", () => gallery.tamper("Writer", "templateId", "root-admin")],
      ["empty template", () => gallery.tamper("Writer", "templateId", "")],
      ["foreign workspace", () => gallery.tamper("Writer", "workspaceId", w.otherWorkspaceId)],
      ["malformed workspace", () => gallery.tamper("Writer", "workspaceId", "not-a-uuid")],
      [
        "extra capabilities",
        () =>
          gallery.inject("Writer", "capabilities", '[{"key":"payments.send","mode":"automatic"}]'),
      ],
      ["extra tier", () => gallery.inject("Writer", "tier", "1")],
      ["extra mode", () => gallery.inject("Writer", "mode", "permissive")],
      ["extra status", () => gallery.inject("Writer", "status", "active")],
    ];
    for (const [label, tamper] of attempts) {
      await gallery.goto();
      await tamper();
      await gallery.createButton("Writer").click();
      await expect(gallery.alert.first(), label).toBeVisible();
      expect(await agentsIn(w.workspaceId), label).toHaveLength(0);
      expect(await agentsIn(w.otherWorkspaceId), label).toHaveLength(0);
    }
  });

  test("AC4: a double click on a template creates one agent", async ({ page, baseURL }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);
    await gallery.goto();
    await gallery.createButton("Reviewer").dblclick();
    await expect(gallery.agentList).toContainText("Reviewer");
    expect(await agentsIn(w.workspaceId)).toHaveLength(1);
  });

  test("AC4: a second, separate click makes a second agent with a numbered name", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const gallery = new AgentTemplatesPage(page);
    await signIn(page, baseURL, w.owner);
    await gallery.goto();
    await gallery.createButton("Librarian").click();
    await expect(gallery.agentList).toContainText("Librarian");
    await gallery.createButton("Librarian").click();
    await expect(gallery.agentList).toContainText("Librarian 2");
    expect(await agentsIn(w.workspaceId)).toHaveLength(2);
  });

  // An ended session is stopped by the proxy, which redirects the server action to sign-in; the Next client
  // reports that as "An unexpected response was received from the server". Expected here, scoped here.
  test.describe("an ended session", () => {
    test.use({ allowedConsoleErrors: [/unexpected response was received from the server/i] });

    test("AC4: a session that has ended means deny, so nothing is created", async ({
      page,
      baseURL,
    }) => {
      const w = await world();
      const gallery = new AgentTemplatesPage(page);
      await signIn(page, baseURL, w.owner);
      await gallery.goto();
      await page.context().clearCookies();
      const answered = page.waitForResponse((r) => r.request().method() === "POST");
      await gallery.createButton("Manager").click();
      await answered;
      expect(await agentsIn(w.workspaceId)).toHaveLength(0);
    });
  });
});
