import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { AgentWizardPage } from "./pages/agent-wizard-page";
import { svcInsert, svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-141 QA: acceptance criteria and attacks, one test per criterion, driven through the real UI.
// Local stack only (E2E_SUPABASE=1). Complements agent-wizard-live.spec.ts (the implementer's spec).
//
//   AC1  valid input creates an agent in Strict mode        AC2  creatable in under two minutes (timed)
//   AC3  validation errors name the field                    AC4  no regressions (role matrix, CSP, XSS)
test.describe("AGO-141 QA: agent creation wizard acceptance (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  const TWO_MINUTES_MS = 120_000;
  const XSS = `<img src=x onerror="window.__xss=1">`;
  type XssWindow = Window & { __xss?: number };

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("qa-owner");
    const member = await createUser("qa-member");
    const viewer = await createUser("qa-viewer");
    const stranger = await createUser("qa-stranger");
    const workspaceId = await onboard(owner, "QA Wizard Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    const otherWorkspaceId = await onboard(stranger, "QA Elsewhere Co");
    const skill = await svcInsert("skills", {
      workspace_id: workspaceId,
      name: "QA research",
      body: "Summarise sources.",
    });
    const catalog = await svcRows(
      "capabilities",
      `workspace_id=eq.${workspaceId}&enabled=eq.true&select=key,name,tier&order=tier,key`,
    );
    const low = catalog.find((row) => Number(row.tier) <= 2);
    const high = catalog.find((row) => Number(row.tier) >= 3);
    if (!low || !high) throw new Error("the seeded catalog has no low and high tier capability");
    return {
      owner,
      member,
      viewer,
      stranger,
      workspaceId,
      otherWorkspaceId,
      skillId: skill.id as string,
      low: { key: low.key as string, name: low.name as string },
      high: { key: high.key as string, name: high.name as string },
    };
  }

  async function agentsNamed(workspaceId: string, name: string) {
    return svcRows(
      "agents",
      `workspace_id=eq.${workspaceId}&name=eq.${encodeURIComponent(name)}&select=*`,
    );
  }

  /** Walks the wizard to the Review step with valid defaults (skills and capabilities left empty). */
  async function toReview(wizard: AgentWizardPage, name: string) {
    await wizard.goto();
    await wizard.fillBasics({ name });
    await wizard.advance(4);
    await expect(wizard.review).toBeVisible();
  }

  function createAgentBody(workspaceId: string, name: string, patch: Record<string, unknown> = {}) {
    return {
      p_workspace_id: workspaceId,
      p_name: name,
      p_role: "R",
      p_model: "claude-haiku-5-5",
      p_prompt: "p",
      p_daily_budget_cents: 500,
      p_skill_ids: [],
      p_capabilities: [],
      ...patch,
    };
  }

  test("AC1: valid inputs create an agent in Strict mode, with the chosen skills, capabilities and budget", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await wizard.goto();
    await wizard.fillBasics({ name: "Strict One", model: "claude-opus-5-5" });
    await wizard.next();
    await wizard.skill(/QA research/).check();
    await wizard.next();
    await wizard.capability(new RegExp(w.low.name)).check();
    await page.getByLabel(/Runs/).first().selectOption("automatic");
    await wizard.capability(new RegExp(w.high.name)).check();
    await wizard.next();
    await wizard.dailyBudget.fill("12.34");
    await wizard.next();
    await expect(wizard.review).toContainText("Strict");
    await expect(wizard.review).toContainText("$12.34");
    await wizard.createButton.click();

    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(wizard.agentList).toContainText("Strict One");
    await expect(page.getByTestId("agent-mode").first()).toHaveText("Strict");

    const [agent] = await agentsNamed(w.workspaceId, "Strict One");
    expect(agent).toMatchObject({
      mode: "strict",
      model: "claude-opus-5-5",
      daily_budget_cents: 1234,
    });
    const grants = await svcRows(
      "agent_capabilities",
      `agent_id=eq.${String(agent?.id)}&select=capability,tier,mode`,
    );
    expect(grants.find((row) => row.capability === w.low.key)).toMatchObject({ mode: "automatic" });
    expect(grants.find((row) => row.capability === w.high.key)).toMatchObject({ mode: "approval" });
    const skills = await svcRows(
      "agent_skills",
      `agent_id=eq.${String(agent?.id)}&select=skill_id`,
    );
    expect(skills.map((row) => row.skill_id)).toEqual([w.skillId]);
  });

  test("AC1: the draft is kept between steps and the review step comes before anything is created", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await wizard.goto();
    await wizard.fillBasics({ name: "Drafty", role: "Planner" });
    await wizard.next();
    await wizard.skill(/QA research/).check();
    await wizard.backButton.click();
    await expect(wizard.name).toHaveValue("Drafty");
    await expect(wizard.role).toHaveValue("Planner");
    await wizard.next();
    await expect(wizard.skill(/QA research/)).toBeChecked();
    await wizard.advance(3);
    await expect(wizard.review).toContainText("Drafty");
    await expect(wizard.review).toContainText("QA research");
    expect(await agentsNamed(w.workspaceId, "Drafty")).toHaveLength(0);
  });

  test("AC2: a new agent can be created in under two minutes in a timed test", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    const startedAt = Date.now();
    await toReview(wizard, "Timed");
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(wizard.agentList).toContainText("Timed");
    const elapsed = Date.now() - startedAt;
    test.info().annotations.push({ type: "wizard-seconds", description: String(elapsed / 1000) });
    expect(elapsed).toBeLessThan(TWO_MINUTES_MS);
    expect(await agentsNamed(w.workspaceId, "Timed")).toHaveLength(1);
  });

  test("AC3: each required field left empty is named in its message and takes focus", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await wizard.goto();
    await wizard.next();
    await expect(wizard.fieldError("name")).toContainText("Name is required");
    await expect(wizard.fieldError("role")).toContainText("Role is required");
    await expect(wizard.fieldError("model")).toContainText("Model is required");
    await expect(wizard.fieldError("prompt")).toContainText("Prompt is required");
    await expect(wizard.name).toBeFocused();
    await wizard.name.fill("   ");
    await wizard.next();
    await expect(wizard.fieldError("name")).toContainText("Name is required");
    // The browser stops typing at the limit; the server still names the field if the limit is bypassed.
    await expect(wizard.name).toHaveAttribute("maxlength", "120");
    await wizard.fillBasics({ name: "LongName" });
    await wizard.advance(4);
    await wizard.tamper("name", "x".repeat(121));
    await wizard.createButton.click();
    await expect(wizard.fieldError("name")).toContainText("Name can be at most 120");
    await expect(wizard.name).toBeFocused();
    expect(await agentsNamed(w.workspaceId, "x".repeat(121))).toHaveLength(0);
  });

  test("AC3: a server-side refusal (tampered budget, unknown model) names its field and creates nothing", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);

    for (const value of ["51", "50.01", "0", "-1", "1e2"]) {
      await toReview(wizard, "OverBudget");
      await wizard.tamper("dailyBudget", value);
      await wizard.createButton.click();
      await expect(wizard.fieldError("dailyBudget")).toContainText("Daily budget");
    }
    expect(await agentsNamed(w.workspaceId, "OverBudget")).toHaveLength(0);

    await toReview(wizard, "BadModel");
    await wizard.tamper("model", "gpt-4");
    await wizard.createButton.click();
    await expect(wizard.fieldError("model")).toContainText("Model");
    expect(await agentsNamed(w.workspaceId, "BadModel")).toHaveLength(0);
  });

  test("AC1: tampering with mode, status, tier or an unknown capability is refused and nothing is created", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    for (const [field, value] of [
      ["mode", "permissive"],
      ["status", "active"],
      ["tier", "1"],
    ] as const) {
      const name = `Extra-${field}`;
      await toReview(wizard, name);
      await wizard.inject(field, value);
      await wizard.createButton.click();
      await expect(page.getByRole("alert").first()).toBeVisible();
      expect(await agentsNamed(w.workspaceId, name)).toHaveLength(0);
    }

    await toReview(wizard, "Ghost-cap");
    await wizard.tamper(
      "capabilities",
      JSON.stringify([{ key: "no.such.capability", mode: "approval" }]),
    );
    await wizard.createButton.click();
    await expect(wizard.fieldError("capabilities")).toContainText("Capabilities");
    expect(await agentsNamed(w.workspaceId, "Ghost-cap")).toHaveLength(0);
  });

  test("AC1: a tampered workspaceId (another workspace) is refused and creates nothing in either workspace", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await toReview(wizard, "Hijack");
    await wizard.tamper("workspaceId", w.otherWorkspaceId);
    await wizard.createButton.click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page).toHaveURL(/\/app\/agents\/new$/);
    expect(await agentsNamed(w.workspaceId, "Hijack")).toHaveLength(0);
    expect(await agentsNamed(w.otherWorkspaceId, "Hijack")).toHaveLength(0);
  });

  test("AC1: through the API, another workspace's owner and an out-of-range budget are refused", async () => {
    const w = await world();
    const cross = await asUser(w.stranger, "/rest/v1/rpc/create_agent", {
      method: "POST",
      body: createAgentBody(w.workspaceId, "Cross-ws"),
    });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(await agentsNamed(w.workspaceId, "Cross-ws")).toHaveLength(0);

    for (const [label, cents] of [
      ["cap", 5001],
      ["zero", 0],
    ] as const) {
      const res = await asUser(w.owner, "/rest/v1/rpc/create_agent", {
        method: "POST",
        body: createAgentBody(w.workspaceId, `Api-${label}`, { p_daily_budget_cents: cents }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await agentsNamed(w.workspaceId, `Api-${label}`)).toHaveLength(0);
    }
  });

  test("AC1: a member or viewer who submits the owner's open wizard (the server action) is refused", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    for (const role of ["member", "viewer"] as const) {
      await signIn(page, baseURL, w.owner);
      const name = `Swap-${role}`;
      await toReview(wizard, name);
      await signIn(page, baseURL, w[role]); // same page, session replaced under the open form
      await wizard.createButton.click();
      await expect(page.getByText("Only workspace owners can create agents.")).toBeVisible();
      expect(await agentsNamed(w.workspaceId, name)).toHaveLength(0);
    }
  });

  // An ended session is stopped by the proxy, which redirects the server action to sign-in; the Next client
  // reports that as "An unexpected response was received from the server". Expected here, scoped here.
  test.describe("an ended session", () => {
    test.use({ allowedConsoleErrors: [/unexpected response was received from the server/i] });

    test("AC1: a session that has ended means deny, so nothing is created", async ({
      page,
      baseURL,
    }) => {
      const w = await world();
      const wizard = new AgentWizardPage(page);
      await signIn(page, baseURL, w.owner);
      await toReview(wizard, "Expired");
      await page.context().clearCookies();
      const answered = page.waitForResponse((r) => r.request().method() === "POST");
      await wizard.createButton.click();
      await answered;
      await expect(wizard.agentList).toHaveCount(0);
      expect(await agentsNamed(w.workspaceId, "Expired")).toHaveLength(0);
    });
  });

  test("AC1: a double submit creates one agent", async ({ page, baseURL }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await signIn(page, baseURL, w.owner);
    await toReview(wizard, "Twice");
    let posts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) posts += 1;
    });
    await wizard.createButton.dblclick();
    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(wizard.agentList).toContainText("Twice");
    expect(await agentsNamed(w.workspaceId, "Twice")).toHaveLength(1);
    test.info().annotations.push({ type: "server-action-posts", description: String(posts) });
  });

  test("AC4: markup in name, role and prompt is shown as text on Review and in the list, and never runs", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });
    await signIn(page, baseURL, w.owner);
    await wizard.goto();
    await wizard.fillBasics({
      name: `A ${XSS}`,
      role: XSS,
      prompt: `${XSS}\n<script>window.__xss=2</script>`,
    });
    await wizard.advance(4);
    await expect(wizard.review).toContainText(XSS);
    expect(await page.evaluate(() => (window as XssWindow).__xss)).toBeUndefined();
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(wizard.agentList).toContainText(XSS);
    expect(await page.evaluate(() => (window as XssWindow).__xss)).toBeUndefined();
    await expect(wizard.agentList.locator("img")).toHaveCount(0);
    expect(dialogs).toBe(0);
    expect(await agentsNamed(w.workspaceId, `A ${XSS}`)).toHaveLength(1);
  });

  test("AC4: the wizard steps and the list page raise no CSP violation", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const wizard = new AgentWizardPage(page);
    await page.addInitScript(() => {
      const win = window as Window & { __csp?: string[] };
      win.__csp = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        win.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await signIn(page, baseURL, w.owner);
    await wizard.goto();
    await wizard.fillBasics({ name: "Csp" });
    const seen: string[] = [];
    const collect = async () => {
      seen.push(
        ...(await page.evaluate(() => (window as Window & { __csp?: string[] }).__csp ?? [])),
      );
    };
    for (let i = 0; i < 4; i += 1) {
      await wizard.next();
      await collect();
    }
    await wizard.createButton.click();
    await expect(page).toHaveURL(/\/app\/agents$/);
    await collect();
    expect(seen).toEqual([]);
  });

  test("AC4: members and viewers can read the list but are sent back from the wizard (role matrix)", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await svcInsert("agents", { workspace_id: w.workspaceId, name: "Existing" });
    for (const role of ["member", "viewer"] as const) {
      await signIn(page, baseURL, w[role]);
      await page.goto("/app/agents");
      await expect(new AgentWizardPage(page).agentList).toContainText("Existing");
      await page.goto("/app/agents/new");
      await expect(page).toHaveURL(/\/app\/agents$/);
    }
  });
});
