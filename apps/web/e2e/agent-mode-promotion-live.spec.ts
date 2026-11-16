import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { must, svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-99: new agents start in Strict; an owner promotes (or demotes) one with a confirm step; every change is
// logged; nobody else can change it. Driven through the real UI and checked against the database.
// Local stack only (E2E_SUPABASE=1), and only once the AGO-99 migration is applied.
//
//   AC1  new agents default to Strict (wizard, template)
//   AC2  promotion is logged (one agent_mode_changes row per change, with the owner's member id) and human-only
//        (members and viewers get no form; a replayed post as a member changes nothing; forged input is refused)
//
// Set E2E_SHOT_DIR to a folder to also save a numbered screenshot per step (the device tester does this).
test.describe("AGO-99: Strict default and human promotion (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  const CONFIRM_ERROR = "Tick the box to confirm you want to change this agent's mode.";
  const shotDir = process.env.E2E_SHOT_DIR;
  let shotNumber = 0;

  async function shot(page: Page, what: string) {
    if (!shotDir) return;
    mkdirSync(shotDir, { recursive: true });
    shotNumber += 1;
    const prefix = String(shotNumber).padStart(2, "0");
    await page.screenshot({ path: join(shotDir, `${prefix}-${what}.png`), fullPage: true });
  }

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await page.context().clearCookies();
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  const world: {
    owner?: TestUser;
    member?: TestUser;
    viewer?: TestUser;
    workspaceId?: string;
    scoutId?: string;
  } = {};

  async function agentByName(name: string) {
    const rows = await svcRows(
      "agents",
      `workspace_id=eq.${String(world.workspaceId)}&name=eq.${encodeURIComponent(name)}&select=id,mode,archived_at`,
    );
    expect(rows).toHaveLength(1);
    return rows[0] as { id: string; mode: string };
  }

  async function modeOf(agentId: string) {
    const rows = await svcRows("agents", `id=eq.${agentId}&select=mode`);
    return rows[0]?.mode;
  }

  async function logRows(agentId: string) {
    return svcRows(
      "agent_mode_changes",
      `agent_id=eq.${agentId}&select=from_mode,to_mode,changed_by,workspace_id&order=created_at`,
    );
  }

  async function ownerMemberId() {
    const rows = await svcRows(
      "members",
      `workspace_id=eq.${String(world.workspaceId)}&user_id=eq.${String(world.owner?.id)}&select=id`,
    );
    return rows[0]?.id as string;
  }

  test.beforeAll(async () => {
    world.owner = await createUser("owner");
    world.member = await createUser("member");
    world.viewer = await createUser("viewer");
    world.workspaceId = await onboard(world.owner, "Mode Co");
    await addMember(world.workspaceId, world.member, "member");
    await addMember(world.workspaceId, world.viewer, "viewer");
  });

  test("AC1: an agent from the wizard and one from a template start in Strict", async ({
    page,
    baseURL,
  }) => {
    await signIn(page, baseURL, must(world.owner));
    const next = () => page.getByRole("button", { name: "Next" }).click();

    // Wizard.
    await page.goto("/app/agents/new");
    await page.getByLabel("Name", { exact: true }).fill("Scout");
    await page.getByLabel("Role", { exact: true }).fill("Researcher");
    await page.getByLabel("Model", { exact: true }).selectOption("claude-haiku-5-5");
    await page.getByLabel("Prompt", { exact: true }).fill("Find sources and summarise them.");
    await next();
    await next();
    await next();
    await next();
    await expect(page.getByTestId("review")).toContainText("Strict");
    await shot(page, "ac1-wizard-review-shows-strict");
    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page).toHaveURL(/\/app\/agents$/);

    // Template.
    await page.getByRole("button", { name: "Create Researcher", exact: true }).click();
    await expect(page.getByRole("link", { name: "Edit Researcher" })).toBeVisible();
    await shot(page, "ac1-agent-list-after-wizard-and-template");

    const scout = await agentByName("Scout");
    const researcher = await agentByName("Researcher");
    expect(scout.mode).toBe("strict");
    expect(researcher.mode).toBe("strict");
    world.scoutId = scout.id;

    for (const [id, label] of [
      [scout.id, "wizard"],
      [researcher.id, "template"],
    ] as const) {
      await page.goto(`/app/agents/${id}`);
      await expect(page.getByTestId("agent-mode")).toContainText("Strict");
      await shot(page, `ac1-${label}-agent-detail-strict`);
    }
    expect(await logRows(scout.id)).toHaveLength(0);
  });

  test("AC2: an owner needs the confirm box, then promotes and demotes with a log row each time", async ({
    page,
    baseURL,
  }) => {
    const agentId = must(world.scoutId);
    await signIn(page, baseURL, must(world.owner));
    await page.goto(`/app/agents/${agentId}`);
    const form = page.getByRole("form", { name: "Change mode" });
    await expect(page.getByTestId("agent-mode")).toContainText("Strict");
    await shot(page, "ac2-owner-autonomy-section-strict");

    // No confirm: refused with a field error.
    await form.getByLabel("New mode").selectOption("standard");
    await form.getByRole("button", { name: "Change mode" }).click();
    await expect(form.getByText(CONFIRM_ERROR)).toBeVisible();
    await expect(page.getByTestId("agent-mode")).toContainText("Strict");
    await shot(page, "ac2-no-confirm-refused");
    expect(await modeOf(agentId)).toBe("strict");
    expect(await logRows(agentId)).toHaveLength(0);

    const MODE_LABEL = { standard: "Standard", relaxed: "Relaxed", strict: "Strict" } as const;
    const change = async (mode: keyof typeof MODE_LABEL, label: string) => {
      await form.getByLabel("New mode").selectOption(mode);
      await form.getByLabel(/I have decided to change/).check();
      await shot(page, `ac2-before-${label}`);
      await form.getByRole("button", { name: "Change mode" }).click();
      await expect(page.getByRole("status")).toContainText("Mode changed. The change is logged.");
      await expect(page.getByTestId("agent-mode")).toContainText(MODE_LABEL[mode]);
      await shot(page, `ac2-after-${label}`);
    };

    await change("standard", "promote-to-standard");
    await change("relaxed", "promote-to-relaxed");
    await change("strict", "demote-to-strict");

    const memberId = await ownerMemberId();
    const log = await logRows(agentId);
    expect(log.map((row) => [row.from_mode, row.to_mode])).toEqual([
      ["strict", "standard"],
      ["standard", "relaxed"],
      ["relaxed", "strict"],
    ]);
    for (const row of log) {
      expect(row.changed_by).toBe(memberId);
      expect(row.workspace_id).toBe(world.workspaceId);
    }
    expect(await modeOf(agentId)).toBe("strict");

    // Persistence: a reload shows the mode the database holds.
    await page.reload();
    await expect(page.getByTestId("agent-mode")).toContainText("Strict");
  });

  test("AC2: a forged mode or an extra field is refused and nothing changes", async ({
    page,
    baseURL,
  }) => {
    const agentId = must(world.scoutId);
    await signIn(page, baseURL, must(world.owner));
    await page.goto(`/app/agents/${agentId}`);
    const form = page.getByRole("form", { name: "Change mode" });
    const before = (await logRows(agentId)).length;

    // 'permissive' is not a mode: the select is edited as someone with dev tools would (after hydration, so
    // React does not see the edit as a server/client mismatch).
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>("#agent-mode-select");
      if (!select) throw new Error("no mode select");
      select.add(new Option("Permissive", "permissive"));
      select.value = "permissive";
    });
    await form.getByLabel(/I have decided to change/).check();
    await form.getByRole("button", { name: "Change mode" }).click();
    await expect(form.getByText("Pick one of the listed modes.")).toBeVisible();
    await shot(page, "ac2-forged-mode-permissive-refused");
    expect(await modeOf(agentId)).toBe("strict");

    // A field the schema does not know (who changed it).
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.evaluate((memberId) => {
      const formEl = document.querySelector<HTMLFormElement>('form[aria-label="Change mode"]');
      if (!formEl) throw new Error("no form");
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "changedBy";
      input.value = memberId;
      formEl.append(input);
    }, "00000000-0000-4000-8000-000000000000");
    await page.getByLabel("New mode").selectOption("relaxed");
    await page.getByLabel(/I have decided to change/).check();
    await page.getByRole("button", { name: "Change mode" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /\S/ }).first()).toBeVisible();
    await shot(page, "ac2-forged-changedby-refused");
    expect(await modeOf(agentId)).toBe("strict");
    expect(await logRows(agentId)).toHaveLength(before);
  });

  test("AC2: keyboard only - tab to the form, pick a mode, tick confirm, submit", async ({
    page,
    baseURL,
  }) => {
    const agentId = must(world.scoutId);
    await signIn(page, baseURL, must(world.owner));
    await page.goto(`/app/agents/${agentId}`);
    const select = page.getByLabel("New mode");
    await select.focus();
    await page.keyboard.press("ArrowDown"); // strict -> standard
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space"); // tick confirm
    await shot(page, "ac2-keyboard-before-submit");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter"); // Change mode
    await expect(page.getByRole("status")).toContainText("Mode changed");
    await expect(page.getByTestId("agent-mode")).toContainText("Standard");
    await shot(page, "ac2-keyboard-after-submit");
    expect(await modeOf(agentId)).toBe("standard");
  });

  test("AC2: a member and a viewer get no form; a replayed post as a member changes nothing", async ({
    page,
    baseURL,
    browser,
  }) => {
    const agentId = must(world.scoutId);
    const startMode = await modeOf(agentId);
    const startLog = (await logRows(agentId)).length;

    // Capture the owner's real form post (action ids and all) to replay it as a member.
    await signIn(page, baseURL, must(world.owner));
    await page.goto(`/app/agents/${agentId}`);
    const hidden = await page
      .locator('form[aria-label="Change mode"] input[type="hidden"]')
      .evaluateAll((inputs) =>
        inputs.map((input) => [
          (input as HTMLInputElement).name,
          (input as HTMLInputElement).value,
        ]),
      );

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, baseURL, must(world.member));
    await memberPage.goto(`/app/agents/${agentId}`);
    await expect(memberPage.getByTestId("agent-mode")).toContainText(
      "Only workspace owners can change it.",
    );
    await expect(memberPage.getByRole("form", { name: "Change mode" })).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Change mode" })).toHaveCount(0);
    await shot(memberPage, "ac2-member-no-form");

    const response = await memberPage.request.post(`/app/agents/${agentId}`, {
      headers: { origin: String(baseURL) },
      multipart: {
        ...(Object.fromEntries(hidden) as Record<string, string>),
        mode: "relaxed",
        confirm: "on",
      },
    });
    test.info().annotations.push({
      type: "member-replay-status",
      description: String(response.status()),
    });
    expect(await modeOf(agentId)).toBe(startMode);
    expect(await logRows(agentId)).toHaveLength(startLog);
    // The database itself refuses a member and a viewer calling the setter directly (the Data API, no UI).
    for (const user of [must(world.member), must(world.viewer)]) {
      const direct = await asUser(user, "/rest/v1/rpc/set_agent_mode", {
        method: "POST",
        body: { p_workspace_id: world.workspaceId, p_agent_id: agentId, p_mode: "relaxed" },
      });
      expect(direct.status).toBeGreaterThanOrEqual(400);
    }
    expect(await modeOf(agentId)).toBe(startMode);
    expect(await logRows(agentId)).toHaveLength(startLog);
    await memberContext.close();

    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await signIn(viewerPage, baseURL, must(world.viewer));
    await viewerPage.goto(`/app/agents/${agentId}`);
    await expect(viewerPage.getByTestId("agent-mode")).toContainText(
      "Only workspace owners can change it.",
    );
    await expect(viewerPage.getByRole("form", { name: "Change mode" })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: "Change mode" })).toHaveCount(0);
    await shot(viewerPage, "ac2-viewer-no-controls");
    await viewerContext.close();
  });

  test("an archived agent shows no mode form", async ({ page, baseURL }) => {
    const agentId = must(world.scoutId);
    await signIn(page, baseURL, must(world.owner));
    await page.goto("/app/agents");
    await page.getByRole("form", { name: "Archive Scout" }).getByRole("button").click();
    await expect(
      page.getByText("Archived agents keep their history but cannot receive tasks."),
    ).toBeVisible();
    await page.goto(`/app/agents/${agentId}`);
    await expect(
      page.getByText("This agent is archived. Unarchive it to change its mode."),
    ).toBeVisible();
    await expect(page.getByRole("form", { name: "Change mode" })).toHaveCount(0);
    await shot(page, "archived-agent-no-mode-form");
  });

  test("the owner form fits a phone screen", async ({ page, baseURL }) => {
    await signIn(page, baseURL, must(world.owner));
    await page.setViewportSize({ width: 375, height: 812 });
    const researcher = await agentByName("Researcher");
    await page.goto(`/app/agents/${researcher.id}`);
    await expect(page.getByRole("form", { name: "Change mode" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole("form", { name: "Change mode" }).scrollIntoViewIfNeeded();
    await shot(page, "phone-375-owner-mode-form");
  });
});
