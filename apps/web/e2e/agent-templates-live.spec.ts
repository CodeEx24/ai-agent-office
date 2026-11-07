import type { Page } from "@playwright/test";
import { AGENT_TEMPLATES } from "@ago/shared/agent-templates";

import { expect, isLiveStack, test } from "./fixtures";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-136: the eight role templates, driven through the real UI and checked against the database.
// Local stack only (E2E_SUPABASE=1). Run inside the db lock: `node scripts/db-lock.mjs acquire AGO-136`.
//
//   AC1  each of the eight templates creates a valid agent in one click (a Strict agent with its grants)
//   AC2  Researcher: web search, no private notes. Analyst: private notes, no web
//   AC3  suggested models are Opus, Sonnet or Fable
//   +    members and viewers cannot use it; the wizard's picker pre-fills and stays reviewable
test.describe("AGO-136: role templates (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("tpl-owner");
    const member = await createUser("tpl-member");
    const viewer = await createUser("tpl-viewer");
    const workspaceId = await onboard(owner, "Templates Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    return { owner, member, viewer, workspaceId };
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

  test("AC1: every template creates a valid Strict agent in one click", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents");

    for (const template of AGENT_TEMPLATES) {
      await page.getByRole("button", { name: `Create ${template.name}`, exact: true }).click();
      await expect(page.getByTestId("agent-list")).toContainText(template.name);

      const agent = await agentNamed(w.workspaceId, template.name);
      expect(agent, template.id).toMatchObject({
        mode: "strict",
        role: template.role,
        model: template.model,
        daily_budget_cents: template.dailyBudgetCents,
      });
      const grants = await grantsOf(String(agent?.id));
      expect(grants.map((g) => g.capability).sort(), template.id).toEqual(
        template.capabilities.map((c) => c.key).sort(),
      );
      for (const grant of grants) {
        const wanted = template.capabilities.find((c) => c.key === grant.capability);
        expect(grant.mode, `${template.id} ${String(grant.capability)}`).toBe(wanted?.mode);
        // no Tier 3 or 4 capability is ever automatic
        if (Number(grant.tier) >= 3) expect(grant.mode).toBe("approval");
      }
      await page.goto("/app/agents");
    }
    expect(await svcRows("agents", `workspace_id=eq.${w.workspaceId}&select=id`)).toHaveLength(
      AGENT_TEMPLATES.length,
    );
  });

  test("AC2 + AC3: Researcher has web and no private notes, Analyst the reverse; models are allowed", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents");
    await page.getByRole("button", { name: "Create Researcher", exact: true }).click();
    await expect(page.getByTestId("agent-list")).toContainText("Researcher");
    await page.getByRole("button", { name: "Create Analyst", exact: true }).click();
    await expect(page.getByTestId("agent-list")).toContainText("Analyst");

    const researcher = await agentNamed(w.workspaceId, "Researcher");
    const analyst = await agentNamed(w.workspaceId, "Analyst");
    const researcherKeys = (await grantsOf(String(researcher?.id))).map((g) => g.capability);
    const analystKeys = (await grantsOf(String(analyst?.id))).map((g) => g.capability);
    expect(researcherKeys).toContain("web.search");
    expect(researcherKeys).not.toContain("vault.read_private");
    expect(analystKeys).toContain("vault.read_private");
    expect(analystKeys.some((key) => String(key).startsWith("web."))).toBe(false);

    const allowed = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];
    expect(allowed).toContain(researcher?.model);
    expect(allowed).toContain(analyst?.model);
  });

  test("a second click on the same template makes a second agent with a numbered name", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents");
    await page.getByRole("button", { name: "Create Writer", exact: true }).click();
    await expect(page.getByTestId("agent-list")).toContainText("Writer");
    await page.getByRole("button", { name: "Create Writer", exact: true }).click();
    await expect(page.getByTestId("agent-list")).toContainText("Writer 2");
  });

  test("members and viewers see no templates and cannot open the wizard", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    for (const user of [w.member, w.viewer]) {
      await page.context().clearCookies();
      await signIn(page, baseURL, user);
      await page.goto("/app/agents");
      await expect(page.getByText("Only workspace owners can create agents.")).toBeVisible();
      await expect(page.getByTestId("template-list")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Create / })).toHaveCount(0);
      await page.goto("/app/agents/new");
      await expect(page).toHaveURL(/\/app\/agents$/);
    }
    expect(await svcRows("agents", `workspace_id=eq.${w.workspaceId}&select=id`)).toHaveLength(0);
  });

  test("the wizard's template picker pre-fills the fields and the owner still reviews before creating", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents/new");

    await page.getByLabel("Start from a template (optional)").selectOption("analyst");
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Analyst");
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("claude-opus-5-5");
    await page.getByLabel("Name", { exact: true }).fill("Numbers");
    const next = () => page.getByRole("button", { name: "Next" }).click();
    await next();
    await next();
    await expect(page.getByRole("checkbox", { name: /Read own private notes/ })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /Search the web/ })).not.toBeChecked();
    await next();
    await next();
    await expect(page.getByTestId("review")).toContainText("Strict");
    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page).toHaveURL(/\/app\/agents$/);

    const agent = await agentNamed(w.workspaceId, "Numbers");
    expect(agent).toMatchObject({ mode: "strict", role: "Analyst" });
  });
});
