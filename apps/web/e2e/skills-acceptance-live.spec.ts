import type { APIResponse, BrowserContext, Page, Request } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { SkillsPage } from "./pages/skills-page";
import { svcInsert, svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import {
  addMember,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  type TestUser,
} from "./support/stack-api";

// AGO-128 QA: acceptance-criteria probes for the skill library, written by the tester and kept apart
// from the implementer's skills-live.spec.ts. Local stack only (E2E_SUPABASE=1).
//
//   AC1  a saved edit stores a new version and the old one remains
//   AC2  a skill can be assigned to and removed from an agent
//   AC3  skill text shows a preview (and hostile text never runs)
//   Not applicable to this ticket: "timeout means deny" (no approval path) and "agent token on a
//   human-only route" (the skill pages have no HTTP API route; agents have no membership and no
//   grant, which the cross-workspace and role tests below cover).
test.describe("AGO-128 QA: skill library acceptance (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("qa-owner");
    const member = await createUser("qa-member");
    const viewer = await createUser("qa-viewer");
    const stranger = await createUser("qa-stranger");
    const workspaceId = await onboard(owner, "QA Skills Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    const otherWorkspaceId = await onboard(stranger, "QA Elsewhere Co");
    const agent = await svcInsert("agents", { workspace_id: workspaceId, name: "Scout" });
    const otherAgent = await svcInsert("agents", { workspace_id: otherWorkspaceId, name: "Rival" });
    return {
      owner,
      member,
      viewer,
      stranger,
      workspaceId,
      otherWorkspaceId,
      agentId: agent.id as string,
      otherAgentId: otherAgent.id as string,
    };
  }

  async function seedSkillRow(workspaceId: string, name: string, body: string) {
    const row = await svcInsert("skills", { workspace_id: workspaceId, name, body });
    return row.id as string;
  }

  const versionsOf = (skillId: string) =>
    svcRows("skill_versions", `skill_id=eq.${skillId}&select=version,body&order=version.asc`);
  const skillRow = async (skillId: string) =>
    (await svcRows("skills", `id=eq.${skillId}&select=body,version,description,name`))[0];

  // ---------------------------------------------------------------- AC1: versions

  test("AC1: saving an edit stores the next version and every older version keeps its text", async ({
    page,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "versioned", "# one");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    for (const [index, text] of ["# two", "# three", "# four"].entries()) {
      await skills.body.fill(text);
      await skills.saveButton.click();
      await expect(skills.version).toHaveText(`Version ${String(index + 2)}`);
    }

    expect(await versionsOf(skillId)).toEqual([
      { version: 1, body: "# one" },
      { version: 2, body: "# two" },
      { version: 3, body: "# three" },
      { version: 4, body: "# four" },
    ]);
    await expect(skills.history.getByRole("listitem")).toHaveCount(4);
    await expect(skills.versionEntry(4)).toContainText("(current)");
    await skills.versionEntry(1).locator("summary").click();
    await expect(skills.versionEntry(1).getByRole("heading", { name: "one" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("AC1-version-history.png"), fullPage: true });
  });

  test("AC1: a description-only edit adds no version", async ({ page, baseURL }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "described", "# same");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    await skills.description.fill("a new description");
    await skills.saveButton.click();
    await expect(skills.saveStatus).toContainText("version 1");
    expect((await skillRow(skillId))?.description).toBe("a new description");
    expect(await versionsOf(skillId)).toHaveLength(1);
  });

  test("AC1: double-clicking Save stores exactly one new version", async ({ page, baseURL }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "double-save", "# before");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    await skills.body.fill("# after");
    await skills.saveButton.dblclick();
    await expect(skills.version).toHaveText("Version 2");
    await expect(skills.saveButton).toBeEnabled();

    expect(await versionsOf(skillId)).toEqual([
      { version: 1, body: "# before" },
      { version: 2, body: "# after" },
    ]);
  });

  test("AC1: double-clicking Create skill makes exactly one skill with one version", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoList();

    await skills.newName.fill("double-create");
    await skills.newBody.fill("# once");
    await skills.createButton.dblclick();
    await expect(skills.name).toHaveText("double-create");

    const rows = await svcRows(
      "skills",
      `workspace_id=eq.${w.workspaceId}&name=eq.double-create&select=id,version`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
    expect(await versionsOf(rows[0]?.id as string)).toHaveLength(1);
  });

  test("AC1: an empty or blank name is refused and no skill is created", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoList();

    // Browser validation stops an empty name ...
    await skills.createButton.click();
    await expect(page).toHaveURL(/\/app\/skills$/);
    // ... and the server stops a blank one that gets past it.
    await skills.newName.fill("   ");
    await skills.createButton.click();
    await expect(skills.formAlert.first()).toBeVisible();
    await expect(page).toHaveURL(/\/app\/skills$/);
    expect(await svcRows("skills", `workspace_id=eq.${w.workspaceId}&select=id`)).toHaveLength(0);
  });

  test("AC1: text of exactly 20,000 characters is accepted, and the database refuses one more", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "limit", "# start");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    await skills.body.fill("x".repeat(20_000));
    await skills.saveButton.click();
    await expect(skills.version).toHaveText("Version 2");

    // Past the form and the server action: the owner's own Data API call hits the CHECK.
    const tooLong = await asUser(w.owner, `/rest/v1/skills?id=eq.${skillId}`, {
      method: "PATCH",
      body: { body: "x".repeat(20_001) },
    });
    expect(tooLong.status).toBeGreaterThanOrEqual(400);
    expect((await skillRow(skillId))?.version).toBe(2);
    expect(await versionsOf(skillId)).toHaveLength(2);
  });

  test("AC1: an edit made through the Data API stores a version too, and a forged version number is refused", async () => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "api-edit", "# api one");

    const forged = await asUser(w.owner, `/rest/v1/skills?id=eq.${skillId}`, {
      method: "PATCH",
      body: { body: "# api two", version: 99 },
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(await skillRow(skillId)).toMatchObject({ body: "# api one", version: 1 });

    const edit = await asUser(w.owner, `/rest/v1/skills?id=eq.${skillId}`, {
      method: "PATCH",
      body: { body: "# api two" },
      prefer: "return=representation",
    });
    expect(edit.status).toBe(200);
    expect(await versionsOf(skillId)).toEqual([
      { version: 1, body: "# api one" },
      { version: 2, body: "# api two" },
    ]);
  });

  test("AC1 (security): the version history is immutable, for the owner, a member and service_role", async () => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "immutable", "# original");
    const before = await versionsOf(skillId);
    const path = `/rest/v1/skill_versions?skill_id=eq.${skillId}`;

    for (const [who, call] of [
      ["owner", (p: string, init: object) => asUser(w.owner, p, init)],
      ["member", (p: string, init: object) => asUser(w.member, p, init)],
      ["service_role", (p: string, init: object) => asServiceRole(p, init)],
    ] as const) {
      const update = await call(path, { method: "PATCH", body: { body: `${who} rewrote it` } });
      expect(update.status, `${who} UPDATE`).toBeGreaterThanOrEqual(400);
      const remove = await call(path, { method: "DELETE" });
      expect(remove.status, `${who} DELETE`).toBeGreaterThanOrEqual(400);
    }
    const insert = await asUser(w.owner, "/rest/v1/skill_versions", {
      method: "POST",
      body: { workspace_id: w.workspaceId, skill_id: skillId, version: 2, body: "forged" },
    });
    expect(insert.status).toBeGreaterThanOrEqual(400);

    expect(await versionsOf(skillId)).toEqual(before);
    expect(await skillRow(skillId)).toMatchObject({ body: "# original", version: 1 });
  });

  test("AC1: every skill is at the version of its newest history row, with no gaps (seeded skills are at 1)", async () => {
    await world();
    const skills = await svcRows("skills", "select=id,version");
    const history = await svcRows("skill_versions", "select=skill_id,version");
    expect(skills.length).toBeGreaterThan(0);
    const bySkill = new Map<string, number[]>();
    for (const row of history) {
      const list = bySkill.get(String(row.skill_id)) ?? [];
      list.push(Number(row.version));
      bySkill.set(String(row.skill_id), list);
    }
    for (const skill of skills) {
      const versions = (bySkill.get(String(skill.id)) ?? []).sort((a, b) => a - b);
      const expected = Array.from({ length: Number(skill.version) }, (_, i) => i + 1);
      expect(versions, `skill ${String(skill.id)}`).toEqual(expected);
    }
  });

  // ---------------------------------------------------------------- AC1: write paths (security)

  /** Captures the browser's own server-action POST, so it can be replayed as someone else. */
  async function captureSave(page: Page, skills: SkillsPage) {
    const posted: Promise<Request> = page.waitForRequest(
      (request) => request.method() === "POST" && "next-action" in request.headers(),
    );
    await skills.body.fill("# captured edit");
    await skills.saveButton.click();
    const request = await posted;
    await expect(skills.version).toHaveText("Version 2");
    const dropped = new Set(["cookie", "host", "content-length", "connection"]);
    const headers = Object.fromEntries(
      Object.entries(request.headers()).filter(([name]) => !dropped.has(name)),
    );
    return {
      url: request.url(),
      headers,
      body: request.postDataBuffer()?.toString("utf8") ?? "",
    };
  }

  async function replay(
    context: BrowserContext,
    captured: Awaited<ReturnType<typeof captureSave>>,
    swaps: [string, string][],
  ): Promise<APIResponse> {
    let body = captured.body;
    for (const [from, to] of swaps) body = body.replaceAll(from, to);
    return context.request.post(captured.url, {
      headers: captured.headers,
      data: Buffer.from(body, "utf8"),
    });
  }

  test("AC1 (security): a replayed Save is applied for the owner and refused for member, viewer, stranger and a signed-out caller", async ({
    page,
    browser,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const skillA = await seedSkillRow(w.workspaceId, "capture-source", "# a");
    const control = await seedSkillRow(w.workspaceId, "replay-control", "# control");
    const target = await seedSkillRow(w.workspaceId, "replay-target", "# target");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillA);
    const captured = await captureSave(page, skills);
    expect(captured.body).toContain(skillA);

    // Positive control: the replay mechanism works, so the refusals below mean something.
    const ownerContext = await browser.newContext({ baseURL });
    await signIn(await ownerContext.newPage(), baseURL, w.owner);
    await replay(ownerContext, captured, [[skillA, control]]);
    expect(await skillRow(control)).toMatchObject({ body: "# captured edit", version: 2 });
    await ownerContext.close();

    const callers: [string, TestUser | null][] = [
      ["member", w.member],
      ["viewer", w.viewer],
      ["stranger", w.stranger],
      ["signed-out", null],
    ];
    for (const [label, user] of callers) {
      const context = await browser.newContext({ baseURL });
      if (user) await signIn(await context.newPage(), baseURL, user);
      const response = await replay(context, captured, [[skillA, target]]);
      expect(response.status(), label).toBeLessThan(500);
      await context.close();
      expect(await skillRow(target), `${label} must not change the skill`).toMatchObject({
        body: "# target",
        version: 1,
      });
      expect(await versionsOf(target), label).toHaveLength(1);
    }
    await page.screenshot({ path: testInfo.outputPath("AC1-owner-only-writes.png") });
  });

  test("AC1 (security): an owner cannot write a skill of another workspace by swapping ids in the request", async ({
    page,
    browser,
    baseURL,
  }) => {
    const w = await world();
    const skillA = await seedSkillRow(w.workspaceId, "mine", "# mine");
    const foreign = await seedSkillRow(w.otherWorkspaceId, "theirs", "# theirs");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillA);
    const captured = await captureSave(page, skills);

    // Owner of workspace A aims the same request at workspace B's skill, keeping A's workspace id.
    const context = await browser.newContext({ baseURL });
    await signIn(await context.newPage(), baseURL, w.owner);
    await replay(context, captured, [[skillA, foreign]]);
    // And with B's workspace id: the caller has no role there.
    await replay(context, captured, [
      [skillA, foreign],
      [w.workspaceId, w.otherWorkspaceId],
    ]);
    await context.close();

    expect(await skillRow(foreign)).toMatchObject({ body: "# theirs", version: 1 });
    expect(await versionsOf(foreign)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- AC2: assignment

  test("AC2: assigning twice and removing twice leaves one assignment, then none", async ({
    page,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "assign-twice", "# hi");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    await expect(skills.noAssignments).toBeVisible();
    await skills.agentSelect.selectOption({ label: "Scout" });
    await skills.assignButton.dblclick();
    await expect(skills.assignments).toContainText("Scout");
    expect(await svcRows("agent_skills", `skill_id=eq.${skillId}`)).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("AC2-assigned.png") });

    await skills.removeButton("Scout").dblclick();
    await expect(skills.noAssignments).toBeVisible();
    expect(await svcRows("agent_skills", `skill_id=eq.${skillId}`)).toHaveLength(0);
    // Assigning and removing never changes the skill or its history.
    expect(await skillRow(skillId)).toMatchObject({ body: "# hi", version: 1 });
    expect(await versionsOf(skillId)).toHaveLength(1);
  });

  test("AC2: the agent picker offers only this workspace's agents, and an assigned agent is not offered again", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "picker", "# hi");
    await svcInsert("agent_skills", {
      workspace_id: w.workspaceId,
      agent_id: w.agentId,
      skill_id: skillId,
    });
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    await expect(skills.assignments).toContainText("Scout");
    await expect(page.getByText("Rival")).toHaveCount(0);
    await expect(page.getByText("Every active agent already has this skill.")).toBeVisible();
  });

  test("AC2 (security): member and viewer cannot assign or remove, and nobody can assign across workspaces", async () => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "guarded", "# hi");
    await svcInsert("agent_skills", {
      workspace_id: w.workspaceId,
      agent_id: w.agentId,
      skill_id: skillId,
    });

    for (const user of [w.member, w.viewer, w.stranger]) {
      const remove = await asUser(
        user,
        `/rest/v1/agent_skills?skill_id=eq.${skillId}&agent_id=eq.${w.agentId}`,
        { method: "DELETE", prefer: "return=representation" },
      );
      expect(remove.status === 200 ? remove.body : [], "a delete must remove nothing").toEqual([]);
    }
    expect(await svcRows("agent_skills", `skill_id=eq.${skillId}`)).toHaveLength(1);

    // A member cannot assign either.
    const second = await seedSkillRow(w.workspaceId, "guarded-two", "# two");
    const asMember = await asUser(w.member, "/rest/v1/agent_skills", {
      method: "POST",
      body: { workspace_id: w.workspaceId, agent_id: w.agentId, skill_id: second },
    });
    expect(asMember.status).toBeGreaterThanOrEqual(400);

    // An owner may not attach their skill to an agent that lives in another workspace.
    const crossAgent = await asUser(w.owner, "/rest/v1/agent_skills", {
      method: "POST",
      body: { workspace_id: w.workspaceId, agent_id: w.otherAgentId, skill_id: second },
    });
    expect(crossAgent.status).toBeGreaterThanOrEqual(400);
    // Nor claim the other workspace as their own.
    const crossWorkspace = await asUser(w.owner, "/rest/v1/agent_skills", {
      method: "POST",
      body: { workspace_id: w.otherWorkspaceId, agent_id: w.otherAgentId, skill_id: second },
    });
    expect(crossWorkspace.status).toBeGreaterThanOrEqual(400);
    // The stranger cannot attach this workspace's skill to their own agent.
    const stolen = await asUser(w.stranger, "/rest/v1/agent_skills", {
      method: "POST",
      body: { workspace_id: w.otherWorkspaceId, agent_id: w.otherAgentId, skill_id: second },
    });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect(await svcRows("agent_skills", `skill_id=eq.${second}`)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- AC3: preview

  test("AC3: the preview renders headings, emphasis, lists, quotes and code, and follows the text live", async ({
    page,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "preview", "# start");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    await skills.body.fill(
      [
        "# Heading",
        "## Sub",
        "**bold** and _italic_",
        "- one\n- two",
        "1. first\n2. second",
        "> quoted",
        "```\nconst x = 1;\n```",
        "`inline`",
      ].join("\n\n"),
    );
    const preview = skills.preview;
    await expect(preview.getByRole("heading", { name: "Heading", level: 1 })).toBeVisible();
    await expect(preview.getByRole("heading", { name: "Sub", level: 2 })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("bold");
    await expect(preview.locator("em")).toHaveText("italic");
    await expect(preview.getByRole("listitem")).toHaveCount(4);
    await expect(preview.locator("blockquote")).toHaveText("quoted");
    await expect(preview.locator("pre")).toContainText("const x = 1;");
    // Nothing was saved just by typing.
    expect(await versionsOf(skillId)).toHaveLength(1);

    await skills.body.fill("");
    await expect(preview.getByText("Nothing to preview yet.")).toBeVisible();
    await skills.body.fill("# back");
    await page.screenshot({ path: testInfo.outputPath("AC3-live-preview.png"), fullPage: true });
  });

  test("AC3: a viewer sees the same rendered text and history, read-only", async ({
    page,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "for-viewers", "# Shown\n\n- a\n- b");
    await signIn(page, baseURL, w.viewer);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    const shown = page.getByTestId("markdown-preview").first();
    await expect(shown.getByRole("heading", { name: "Shown" })).toBeVisible();
    await expect(shown.getByRole("listitem")).toHaveCount(2);
    await expect(skills.editor).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("AC3-viewer-read-only.png") });
  });

  const HOSTILE_LINES = [
    "# Hostile",
    "<script>window.__xss = 'script'</script>",
    "<img src=x onerror=\"window.__xss = 'img'\">",
    "<svg onload=\"window.__xss = 'svg'\"></svg>",
    "<a href=\"javascript:window.__xss='raw-a'\">raw anchor</a>",
    '<iframe src="https://evil.example"></iframe>',
    "<iframe srcdoc=\"<script>parent.__xss='srcdoc'</script>\"></iframe>",
    "<style>body{display:none}</style>",
    '<form action="https://evil.example"><input name=card></form>',
    "[js](javascript:window.__xss='js')",
    "[js-tab](java\tscript:window.__xss='tab')",
    "[js-case](JaVaScRiPt:window.__xss='case')",
    "[vb](vbscript:msgbox(1))",
    "[data](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9J2RhdGEnPC9zY3JpcHQ+)",
    "[proto-relative](//evil.example/path)",
    "<javascript:window.__xss='autolink'>",
    "[ref][r]",
    "[r]: javascript:window.__xss='ref'",
    "![data-image](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
    "![remote](https://evil.example/pixel.png)",
    "&lt;script&gt;window.__xss = 'entity'&lt;/script&gt;",
    "&#60;img src=x onerror=&quot;window.__xss='numeric'&quot;&#62;",
    "[safe](https://example.com/page)",
    "[mail](mailto:someone@example.com)",
    "[anchor](#section)",
    "[local](/app/skills)",
  ];

  test("AC3 (security): hostile Markdown is inert in the editor preview, the history and the read-only page", async ({
    page,
    browser,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "hostile-two", "# seed");
    const dialogs: string[] = [];
    const watch = (target: Page) => {
      target.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
    };
    watch(page);
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    const hostile = HOSTILE_LINES.join("\n\n");
    await skills.body.fill(hostile);
    // The live preview first (before anything is saved) ...
    await expect(skills.preview.getByRole("heading", { name: "Hostile" })).toBeVisible();
    await skills.saveButton.click();
    await expect(skills.version).toHaveText("Version 2");

    const expectInert = async (target: Page) => {
      for (const preview of await target.getByTestId("markdown-preview").all()) {
        await expect(
          preview.locator("script, iframe, img, svg, style, form, input, object, embed"),
        ).toHaveCount(0);
        await expect(preview.locator("[onerror], [onload], [onclick], [srcdoc]")).toHaveCount(0);
        const hrefs = await preview
          .locator("a")
          .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
        for (const href of hrefs) {
          expect(href, "every link target is on the allow-list").toMatch(
            /^(https?:\/\/|mailto:|#|\/(?!\/))/i,
          );
        }
        for (const link of await preview.getByRole("link").all()) {
          await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        }
      }
      // Entity-encoded markup stays literal text, it is never turned into elements.
      await expect(
        target
          .getByTestId("markdown-preview")
          .filter({ hasText: "<script>window.__xss = 'entity'</script>" })
          .first(),
      ).toBeVisible();
      expect(
        await target.evaluate(() => (window as unknown as { __xss?: string }).__xss),
      ).toBeUndefined();
    };

    // ... the owner's page after a reload, with the saved version open in the history ...
    await skills.gotoSkill(skillId);
    await skills.versionEntry(2).locator("summary").click();
    await expectInert(page);
    await expect(skills.preview.getByRole("link", { name: "safe" })).toHaveAttribute(
      "target",
      "_blank",
    );
    await page.screenshot({ path: testInfo.outputPath("AC3-hostile-owner.png"), fullPage: true });

    // ... and what a viewer sees.
    const viewerContext = await browser.newContext({ baseURL });
    const viewerPage = await viewerContext.newPage();
    watch(viewerPage);
    await signIn(viewerPage, baseURL, w.viewer);
    await new SkillsPage(viewerPage).gotoSkill(skillId);
    await expect(viewerPage.getByTestId("markdown-preview").first()).toBeVisible();
    await expectInert(viewerPage);
    await viewerPage.screenshot({
      path: testInfo.outputPath("AC3-hostile-viewer.png"),
      fullPage: true,
    });
    await viewerContext.close();

    expect(dialogs).toEqual([]);
    // The text is stored as typed: it is data, never rewritten.
    expect((await skillRow(skillId))?.body).toBe(hostile);
  });

  test("AC3 (security): the skill pages raise no Content-Security-Policy violation", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "csp-quiet", "# plain text");
    await page.addInitScript(() => {
      const win = window as unknown as { __csp: string[] };
      win.__csp = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        win.__csp.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}`);
      });
    });
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    for (const open of [() => skills.gotoList(), () => skills.gotoSkill(skillId)]) {
      await open();
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(
        [],
      );
    }
  });

  test("AC3 (security): a hostile name and description are shown as text on the list and the skill page", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    const name = "<img src=x onerror=\"window.__xss='name'\">";
    const description = "<script>window.__xss='description'</script>";
    const skillId = (
      await svcInsert("skills", { workspace_id: w.workspaceId, name, description, body: "# ok" })
    ).id as string;
    page.on("dialog", (dialog) => void dialog.dismiss());
    await signIn(page, baseURL, w.viewer);
    const skills = new SkillsPage(page);

    await skills.gotoList();
    await expect(skills.skillList).toContainText(name);
    await expect(skills.skillList.locator("img, script")).toHaveCount(0);
    await skills.gotoSkill(skillId);
    await expect(skills.name).toHaveText(name);
    await expect(page.locator("main img, main script")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: string }).__xss),
    ).toBeUndefined();
  });

  test("AC3 (security): very long text with no spaces neither breaks the layout nor the page", async ({
    page,
    baseURL,
  }, testInfo) => {
    const w = await world();
    const skillId = await seedSkillRow(w.workspaceId, "long", "# start");
    await signIn(page, baseURL, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);

    const wall = `# ${"W".repeat(19_000)}\n\n[link](https://example.com/${"a".repeat(900)})\n\n\`\`\`\n${"c".repeat(3_000)}\n\`\`\``;
    await skills.body.fill(wall);
    await skills.saveButton.click();
    await expect(skills.version).toHaveText("Version 2");
    await skills.gotoSkill(skillId);
    await expect(skills.preview.getByRole("heading").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page must not scroll sideways").toBeLessThanOrEqual(1);
    const code = skills.preview.locator("pre").first();
    await expect(code).toBeVisible();
    const box = await code.evaluate((el) => ({
      scrolls: el.scrollWidth > el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(box.scrolls, "the code block scrolls inside its own box").toBe(true);
    expect(["auto", "scroll"]).toContain(box.overflowX);
    await page.screenshot({ path: testInfo.outputPath("AC3-long-text.png") });
  });
});
