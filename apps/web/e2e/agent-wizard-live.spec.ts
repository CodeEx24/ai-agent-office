import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { svcInsert, svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-141: the agent creation wizard, driven through the real UI and checked against the database.
// Local stack only (E2E_SUPABASE=1), and only once the AGO-141 migration is applied.
//
//   AC1  valid input creates an agent in Strict mode (with its skills and capability grants)
//   AC2  a new agent can be created in under two minutes (timed)
//   AC3  validation errors name the field
//   +    only owners reach and submit the wizard; Tier 3 and 4 capabilities can never be automatic, even with
//        a tampered request; another workspace's skills cannot be attached
test.describe("AGO-141: agent creation wizard (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  const TWO_MINUTES_MS = 120_000;

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("owner");
    const member = await createUser("member");
    const viewer = await createUser("viewer");
    const stranger = await createUser("stranger");
    const workspaceId = await onboard(owner, "Wizard Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    const otherWorkspaceId = await onboard(stranger, "Elsewhere Co");
    const skill = await svcInsert("skills", {
      workspace_id: workspaceId,
      name: "Research summary",
      body: "Summarise sources.",
    });
    const foreignSkill = await svcInsert("skills", {
      workspace_id: otherWorkspaceId,
      name: "Foreign skill",
      body: "Not yours.",
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
      foreignSkillId: foreignSkill.id as string,
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

  async function fillBasics(page: Page, name: string) {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Role", { exact: true }).fill("Researcher");
    await page.getByLabel("Model", { exact: true }).selectOption("claude-haiku-5-5");
    await page.getByLabel("Prompt", { exact: true }).fill("Find sources and summarise them.");
  }

  const next = (page: Page) => page.getByRole("button", { name: "Next" }).click();

  test("AC1 + AC2: an owner creates a Strict agent with skills and capabilities in under two minutes", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);

    const startedAt = Date.now();
    await page.goto("/app/agents/new");
    await fillBasics(page, "Scout");
    await next(page);
    await page.getByRole("checkbox", { name: /Research summary/ }).check();
    await next(page);
    await page.getByRole("checkbox", { name: new RegExp(w.low.name) }).check();
    await page.getByRole("checkbox", { name: new RegExp(w.high.name) }).check();
    await expect(page.getByText("Needs approval every time")).toBeVisible();
    await next(page);
    await expect(page.getByLabel(/Daily budget/)).toHaveValue("5.00");
    await next(page);

    // The review step shows everything, including the mode, before anything is created.
    const review = page.getByTestId("review");
    await expect(review).toContainText("Scout");
    await expect(review).toContainText("Strict");
    await page.getByRole("button", { name: "Create agent" }).click();

    await expect(page).toHaveURL(/\/app\/agents$/);
    await expect(page.getByTestId("agent-list")).toContainText("Scout");
    const elapsed = Date.now() - startedAt;
    test.info().annotations.push({ type: "wizard-seconds", description: String(elapsed / 1000) });
    expect(elapsed).toBeLessThan(TWO_MINUTES_MS);

    const [agent] = await agentsNamed(w.workspaceId, "Scout");
    expect(agent).toMatchObject({
      mode: "strict",
      role: "Researcher",
      model: "claude-haiku-5-5",
      daily_budget_cents: 500,
    });
    const skills = await svcRows(
      "agent_skills",
      `agent_id=eq.${String(agent?.id)}&select=skill_id`,
    );
    expect(skills.map((row) => row.skill_id)).toEqual([w.skillId]);
    const grants = await svcRows(
      "agent_capabilities",
      `agent_id=eq.${String(agent?.id)}&select=capability,tier,mode,granted_by&order=tier`,
    );
    expect(grants).toHaveLength(2);
    const high = grants.find((row) => row.capability === w.high.key);
    expect(high).toMatchObject({ mode: "approval" });
    expect(Number(high?.tier)).toBeGreaterThanOrEqual(3);
  });

  test("AC3: every validation error names its field, sits next to it and takes focus", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents/new");

    await next(page);
    await expect(page.locator("#agent-name-error")).toContainText("Name is required");
    await expect(page.locator("#agent-role-error")).toContainText("Role is required");
    await expect(page.locator("#agent-model-error")).toContainText("Model is required");
    await expect(page.locator("#agent-prompt-error")).toContainText("Prompt is required");
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveAttribute("aria-invalid", "true");

    await fillBasics(page, "Scout");
    await next(page);
    await next(page);
    await next(page);
    const budget = page.getByLabel(/Daily budget/);
    for (const [value, message] of [
      ["0", "Daily budget must be more than $0."],
      ["abc", "Daily budget must be a number of dollars"],
      ["51", "Daily budget can be at most $50.00."],
    ] as const) {
      await budget.fill(value);
      await next(page);
      await expect(page.locator("#agent-dailyBudget-error")).toContainText(message);
      await expect(budget).toBeFocused();
    }
    expect(await agentsNamed(w.workspaceId, "Scout")).toHaveLength(0);
  });

  test("a name that is already used is reported on the Name field, and the draft is kept", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await svcInsert("agents", { workspace_id: w.workspaceId, name: "Scout" });
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents/new");
    await fillBasics(page, "Scout");
    for (let i = 0; i < 4; i += 1) await next(page);
    await page.getByRole("button", { name: "Create agent" }).click();

    await expect(page.locator("#agent-name-error")).toContainText("Name is already used");
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Role", { exact: true })).toHaveValue("Researcher");
  });

  test("members and viewers cannot reach the wizard, create through the API, or insert an agent", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    for (const role of ["member", "viewer"] as const) {
      await signIn(page, baseURL, w[role]);
      await page.goto("/app/agents/new");
      await expect(page).toHaveURL(/\/app\/agents$/);
      await expect(page.getByRole("link", { name: "New agent" })).toHaveCount(0);
      await expect(page.getByText("Only workspace owners can create agents.")).toBeVisible();

      const rpc = await asUser(w[role], "/rest/v1/rpc/create_agent", {
        method: "POST",
        body: {
          p_workspace_id: w.workspaceId,
          p_name: `${role}-agent`,
          p_role: "R",
          p_model: "claude-haiku-5-5",
          p_prompt: "p",
          p_daily_budget_cents: 500,
          p_skill_ids: [],
          p_capabilities: [],
        },
      });
      expect(rpc.status).toBeGreaterThanOrEqual(400);
      const insert = await asUser(w[role], "/rest/v1/agents", {
        method: "POST",
        body: { workspace_id: w.workspaceId, name: `${role}-direct` },
      });
      expect(insert.status).toBe(403);
      expect(await agentsNamed(w.workspaceId, `${role}-agent`)).toHaveLength(0);
      expect(await agentsNamed(w.workspaceId, `${role}-direct`)).toHaveLength(0);
    }
  });

  test("a Tier 3 or 4 capability cannot be made automatic, even by tampering with the request", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents/new");
    await fillBasics(page, "Tamper");
    for (let i = 0; i < 4; i += 1) await next(page);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();

    // Change the hidden field the browser sends, as an attacker with dev tools would.
    await page.evaluate((key) => {
      const input = document.querySelector<HTMLInputElement>('input[name="capabilities"]');
      if (input) input.value = JSON.stringify([{ key, mode: "automatic" }]);
    }, w.high.key);
    await page.getByRole("button", { name: "Create agent" }).click();

    await expect(page.locator("#agent-capabilities-error")).toContainText("Capabilities");
    expect(await agentsNamed(w.workspaceId, "Tamper")).toHaveLength(0);

    // And straight at the Data API: the function and the CHECK refuse it too.
    const rpc = await asUser(w.owner, "/rest/v1/rpc/create_agent", {
      method: "POST",
      body: {
        p_workspace_id: w.workspaceId,
        p_name: "Tamper-api",
        p_role: "R",
        p_model: "claude-haiku-5-5",
        p_prompt: "p",
        p_daily_budget_cents: 500,
        p_skill_ids: [],
        p_capabilities: [{ key: w.high.key, mode: "automatic" }],
      },
    });
    expect(rpc.status).toBeGreaterThanOrEqual(400);
    expect(await agentsNamed(w.workspaceId, "Tamper-api")).toHaveLength(0);
  });

  test("a skill from another workspace cannot be attached, and the agent is not left half-created", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents/new");
    await fillBasics(page, "Foreign");
    for (let i = 0; i < 4; i += 1) await next(page);
    await page.evaluate((id) => {
      const input = document.querySelector<HTMLInputElement>('input[name="skillIds"]');
      if (input) input.value = JSON.stringify([id]);
    }, w.foreignSkillId);
    await page.getByRole("button", { name: "Create agent" }).click();

    await expect(page.locator("#agent-skillIds-error")).toContainText("Skills");
    expect(await agentsNamed(w.workspaceId, "Foreign")).toHaveLength(0);
  });

  test("the wizard only offers the workspace's own skills", async ({ page, baseURL }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    await page.goto("/app/agents/new");
    await fillBasics(page, "Offer");
    await next(page);
    await expect(page.getByRole("checkbox", { name: /Research summary/ })).toBeVisible();
    await expect(page.getByText("Foreign skill")).toHaveCount(0);
  });

  test("an agent cannot be given another mode through the Data API", async () => {
    const w = await world();
    const insert = await asUser(w.owner, "/rest/v1/agents", {
      method: "POST",
      body: { workspace_id: w.workspaceId, name: "Loose", mode: "permissive" },
    });
    expect(insert.status).toBe(403);
    expect(await agentsNamed(w.workspaceId, "Loose")).toHaveLength(0);
  });
});
