import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { svcInsert, svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-128: the skill library with versions, driven through the real UI and checked against the
// database. Local stack only (E2E_SUPABASE=1).
//
//   AC1  saving an edit stores a new version and the old one remains
//   AC2  a skill can be assigned to and removed from an agent
//   AC3  skill text shows a preview (and hostile text never runs)
//   +    only owners write: a member and a viewer see the skill read-only, and the API refuses them
test.describe("AGO-128: skill library (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("owner");
    const member = await createUser("member");
    const viewer = await createUser("viewer");
    const stranger = await createUser("stranger");
    const workspaceId = await onboard(owner, "Skills Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    const otherWorkspaceId = await onboard(stranger, "Elsewhere Co");
    const agent = await svcInsert("agents", { workspace_id: workspaceId, name: "Scout" });
    return {
      owner,
      member,
      viewer,
      stranger,
      workspaceId,
      otherWorkspaceId,
      agentId: agent.id as string,
    };
  }

  async function seedSkillRow(workspaceId: string, name: string, body: string) {
    const row = await svcInsert("skills", { workspace_id: workspaceId, name, body });
    return row.id as string;
  }

  const bodyBox = (page: Page) => page.getByLabel("Skill text (Markdown)");
  const editorPreview = (page: Page) => page.getByRole("region", { name: "Preview" });

  test("AC1 + AC3: an owner creates a skill, sees a live preview, and each save adds a version while old ones stay", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);

    await page.goto("/app/skills");
    await page.getByLabel("Name", { exact: true }).fill("Research summary");
    await page
      .getByRole("form", { name: "New skill" })
      .getByLabel("Skill text (Markdown)")
      .fill("# Draft one\n\nFirst **version**.");
    await page.getByRole("button", { name: "Create skill" }).click();

    await expect(page.getByTestId("skill-name")).toHaveText("Research summary");
    await expect(page.getByTestId("skill-version")).toHaveText("Version 1");
    // AC3: the editor shows the Markdown rendered, not as source.
    await expect(editorPreview(page).getByRole("heading", { name: "Draft one" })).toBeVisible();
    await expect(editorPreview(page).locator("strong")).toHaveText("version");

    // The preview is live: it follows the text before anything is saved.
    await bodyBox(page).fill("# Draft two\n\n- a\n- b");
    await expect(editorPreview(page).getByRole("heading", { name: "Draft two" })).toBeVisible();
    await expect(editorPreview(page).getByRole("listitem")).toHaveCount(2);

    // AC1: saving stores version 2 and leaves version 1 in place.
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("save-status")).toContainText("version 2");
    await expect(page.getByTestId("skill-version")).toHaveText("Version 2");

    await bodyBox(page).fill("# Draft three");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("skill-version")).toHaveText("Version 3");

    const skillId = page.url().split("/").pop() ?? "";
    const versions = await svcRows(
      "skill_versions",
      `skill_id=eq.${skillId}&select=version,body&order=version.asc`,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.map((v) => v.body)).toEqual([
      "# Draft one\n\nFirst **version**.",
      "# Draft two\n\n- a\n- b",
      "# Draft three",
    ]);

    // The history lists every version, and an old one still shows its old text.
    const history = page.getByTestId("version-history");
    await expect(history.getByRole("listitem")).toHaveCount(3);
    await expect(page.getByTestId("version-3")).toContainText("(current)");
    await page.getByTestId("version-1").locator("summary").click();
    await expect(
      page.getByTestId("version-1").getByRole("heading", { name: "Draft one" }),
    ).toBeVisible();
  });

  test("AC1: saving without changing the text does not add a version", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "steady", "# same");
    await signIn(page, baseURL, w.owner);

    await page.goto(`/app/skills/${skillId}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("save-status")).toContainText("version 1");
    expect(await svcRows("skill_versions", `skill_id=eq.${skillId}`)).toHaveLength(1);
  });

  test("AC1: an editor that is behind cannot overwrite a newer save", async ({ page, baseURL }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "contended", "# start");
    await signIn(page, baseURL, w.owner);

    const stale = await page.context().newPage();
    await stale.goto(`/app/skills/${skillId}`);
    await page.goto(`/app/skills/${skillId}`);

    await bodyBox(page).fill("# first writer");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("skill-version")).toHaveText("Version 2");

    await bodyBox(stale).fill("# second writer");
    await stale.getByRole("button", { name: "Save" }).click();
    await expect(stale.getByRole("alert").filter({ hasText: "Someone saved" })).toContainText(
      "Someone saved a newer version",
    );

    const [skill] = await svcRows("skills", `id=eq.${skillId}&select=body,version`);
    expect(skill).toMatchObject({ body: "# first writer", version: 2 });
  });

  test("AC2: an owner assigns a skill to an agent and removes it again", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "assignable", "# hi");
    await signIn(page, baseURL, w.owner);
    await page.goto(`/app/skills/${skillId}`);

    await expect(page.getByText("No agent has this skill yet.")).toBeVisible();
    await page.getByLabel("Agent", { exact: true }).selectOption({ label: "Scout" });
    await page.getByRole("button", { name: "Assign" }).click();
    await expect(page.getByTestId("assignments")).toContainText("Scout");
    expect(await svcRows("agent_skills", `skill_id=eq.${skillId}`)).toHaveLength(1);

    await page.getByRole("button", { name: "Remove from Scout" }).click();
    await expect(page.getByText("No agent has this skill yet.")).toBeVisible();
    expect(await svcRows("agent_skills", `skill_id=eq.${skillId}`)).toHaveLength(0);
    // Removing an assignment never touches the skill or its versions.
    expect(await svcRows("skill_versions", `skill_id=eq.${skillId}`)).toHaveLength(1);
  });

  test("AC3 (security): hostile skill text is shown as text and never runs", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    const hostile = [
      "# Title",
      "<script>window.__xss = 'script'</script>",
      '<img src="x" onerror="window.__xss = \'img\'">',
      '<iframe src="https://evil.example"></iframe>',
      "[click me](javascript:window.__xss='link')",
      "![pixel](https://evil.example/pixel.png)",
      "[safe](https://example.com)",
    ].join("\n\n");
    const skillId = await seedSkillRow(w.workspaceId, "hostile", "# seed");

    await page.goto(`/app/skills/${skillId}`);
    await bodyBox(page).fill(hostile);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("skill-version")).toHaveText("Version 2");

    // Reload so the text comes back from the database, then open the history entry too.
    await page.goto(`/app/skills/${skillId}`);
    await page.getByTestId("version-2").locator("summary").click();
    const previews = page.getByTestId("markdown-preview");
    await expect(previews.first()).toBeVisible();
    for (const preview of await previews.all()) {
      await expect(preview.locator("script, iframe, img, svg, style")).toHaveCount(0);
      await expect(preview.locator("[onerror], [onload]")).toHaveCount(0);
      await expect(preview.locator('a[href^="javascript" i]')).toHaveCount(0);
    }
    // The one safe link survives, hardened.
    const safe = previews.first().getByRole("link", { name: "safe" });
    await expect(safe).toHaveAttribute("rel", "noopener noreferrer");
    await expect(safe).toHaveAttribute("target", "_blank");
    // The unsafe link is plain text.
    await expect(previews.first().getByText("click me")).toBeVisible();
    await expect(previews.first().getByRole("link", { name: "click me" })).toHaveCount(0);

    expect(
      await page.evaluate(() => (window as unknown as { __xss?: string }).__xss),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
    // The hostile text is stored verbatim (it is data), never sanitized away in the database.
    const [stored] = await svcRows("skills", `id=eq.${skillId}&select=body`);
    expect(String(stored?.body)).toContain("<script>");
  });

  test("AC1 (limit): skill text over the size limit is refused and no version is stored", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "big", "# small");
    await signIn(page, baseURL, w.owner);
    await page.goto(`/app/skills/${skillId}`);

    // The form caps typing at 20,000 characters, so bypass it the way a hostile client would.
    await page.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>("#skill-body")?.removeAttribute("maxlength");
    });
    await bodyBox(page).fill("x".repeat(20_001));
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "at most" })).toContainText(
      "at most 20,000 characters",
    );
    expect(await svcRows("skill_versions", `skill_id=eq.${skillId}`)).toHaveLength(1);
  });

  for (const role of ["member", "viewer"] as const) {
    test(`a ${role} reads the skill with its preview and history but cannot edit, assign or save`, async ({
      page,
      baseURL,
    }) => {
      const w = await world();
      const skillId = await seedSkillRow(w.workspaceId, "readable", "# Readable\n\ntext");
      await signIn(page, baseURL, w[role]);

      await page.goto("/app/skills");
      await expect(page.getByTestId("skill-list")).toContainText("readable");
      await expect(page.getByRole("form", { name: "New skill" })).toHaveCount(0);

      await page.goto(`/app/skills/${skillId}`);
      await expect(page.getByRole("heading", { name: "Readable", exact: true })).toBeVisible();
      await expect(page.getByTestId("version-history")).toBeVisible();
      await expect(page.getByLabel("Skill text (Markdown)")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Assign" })).toHaveCount(0);
      await expect(page.getByText("Only workspace owners can edit skills.")).toBeVisible();

      // The database refuses them too, whatever the UI shows.
      const user = w[role];
      const edit = await asUser(user, `/rest/v1/skills?id=eq.${skillId}`, {
        method: "PATCH",
        body: { body: `${role} was here` },
        prefer: "return=representation",
      });
      expect(edit.body).toEqual([]);
      const create = await asUser(user, "/rest/v1/skills", {
        method: "POST",
        body: { workspace_id: w.workspaceId, name: `${role}-skill`, body: "x" },
      });
      expect(create.status).toBe(403);
      const assign = await asUser(user, "/rest/v1/agent_skills", {
        method: "POST",
        body: { workspace_id: w.workspaceId, agent_id: w.agentId, skill_id: skillId },
      });
      expect(assign.status).toBe(403);

      const [skill] = await svcRows("skills", `id=eq.${skillId}&select=body,version`);
      expect(skill).toMatchObject({ body: "# Readable\n\ntext", version: 1 });
      expect(await svcRows("agent_skills", `skill_id=eq.${skillId}`)).toHaveLength(0);
    });
  }

  // The browser logs a console error for any 404 response; here the 404 is the expected result.
  test.describe("not found", () => {
    test.use({ allowedConsoleErrors: [/status of 404/] });

    test("isolation: an owner of another workspace cannot see, edit or version this skill", async ({
      page,
      baseURL,
    }) => {
      const w = await world();
      const skillId = await seedSkillRow(w.workspaceId, "private", "# secret");
      await signIn(page, baseURL, w.stranger);

      const response = await page.goto(`/app/skills/${skillId}`);
      expect(response?.status()).toBe(404);
      await expect(page.getByText("# secret")).toHaveCount(0);

      const edit = await asUser(w.stranger, `/rest/v1/skills?id=eq.${skillId}`, {
        method: "PATCH",
        body: { body: "stolen" },
        prefer: "return=representation",
      });
      expect(edit.body).toEqual([]);
      const versions = await asUser<unknown[]>(
        w.stranger,
        `/rest/v1/skill_versions?skill_id=eq.${skillId}`,
      );
      expect(versions.body).toEqual([]);
    });

    test("a malformed skill id is a 404, not an error page", async ({ page, baseURL }) => {
      const w = await world();
      await signIn(page, baseURL, w.owner);
      const response = await page.goto("/app/skills/not-a-uuid");
      expect(response?.status()).toBe(404);
    });
  });
});
