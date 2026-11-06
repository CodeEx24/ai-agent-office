import { execFileSync } from "node:child_process";

import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { SkillsPage } from "./pages/skills-page";
import { svcInsert, svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import {
  addMember,
  asAnon,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  type TestUser,
} from "./support/stack-api";

// AGO-128 QA, re-test after gate fix round 2 (head d928b5c). Local stack only (E2E_SUPABASE=1).
//   1. skill_versions is append-only for every role, including bulk emptying (no-key DELETE, TRUNCATE)
//   2. links like /\evil.com, //evil.com, \\evil.com and /%5Cevil.com never become a way off the site
// The CI-safe counterpart of (2) is src/features/skills/MarkdownPreview.gate-fixes.test.tsx.
const BS = String.fromCharCode(92);
const DB_CONTAINER = process.env.E2E_DB_CONTAINER ?? "supabase_db_agent-office";

/** Runs SQL inside the local Postgres container as the superuser. Returns the outcome, never throws. */
function psql(sql: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, output };
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return { ok: false, output: e.stderr ?? e.message };
  }
}

type Call = (path: string, init: object) => Promise<{ status: number; body: unknown }>;

test.describe("AGO-128 QA gate fixes (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  async function world() {
    const owner = await createUser("gf-owner");
    const viewer = await createUser("gf-viewer");
    const workspaceId = await onboard(owner, "Gate Fix Co");
    await addMember(workspaceId, viewer, "viewer");
    return { owner, viewer, workspaceId };
  }

  const versions = (skillId: string) =>
    svcRows("skill_versions", `skill_id=eq.${skillId}&select=version,body&order=version.asc`);

  test("skill_versions: update, delete and bulk emptying fail for anon, owner, service_role and postgres; owner edits still version", async () => {
    const w = await world();
    const skill = await svcInsert("skills", {
      workspace_id: w.workspaceId,
      name: "ledger",
      body: "v1",
    });
    const skillId = skill.id as string;

    // The owner edits through the Data API: a new version appears and v1 stays.
    const edit = await asUser(w.owner, `/rest/v1/skills?id=eq.${skillId}`, {
      method: "PATCH",
      body: { body: "v2" },
    });
    expect(edit.status).toBeLessThan(300);
    const before = await versions(skillId);
    expect(before).toEqual([
      { version: 1, body: "v1" },
      { version: 2, body: "v2" },
    ]);

    // Data API paths. The bulk requests match every row the caller could possibly touch.
    const callers: [string, Call][] = [
      ["anon", (p, init) => asAnon(p, init)],
      ["owner", (p, init) => asUser(w.owner, p, init)],
      ["viewer", (p, init) => asUser(w.viewer, p, init)],
      ["service_role", (p, init) => asServiceRole(p, init)],
    ];
    const one = `/rest/v1/skill_versions?skill_id=eq.${skillId}&version=eq.1`;
    const all = "/rest/v1/skill_versions?version=gte.0";
    for (const [who, call] of callers) {
      const attempts: [string, string, object][] = [
        ["UPDATE one", one, { method: "PATCH", body: { body: `${who} rewrote it` } }],
        ["UPDATE all", all, { method: "PATCH", body: { body: "bulk rewrite" } }],
        ["DELETE one", one, { method: "DELETE" }],
        ["DELETE all (bulk)", all, { method: "DELETE" }],
      ];
      for (const [label, path, init] of attempts) {
        const result = await call(path, init);
        expect(result.status, `${who} ${label}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(await versions(skillId)).toEqual(before);

    // Direct SQL paths: the superuser, the API roles, and replica mode (which skips ordinary triggers).
    test.skip(!psql("select 1").ok, `docker exec into ${DB_CONTAINER} is not available`);
    const where = `skill_id = '${skillId}'`;
    const asRole = (role: string, sql: string) => `begin; set local role ${role}; ${sql}; commit`;
    const replica = (sql: string) =>
      `begin; set local session_replication_role = replica; ${sql}; commit`;
    const sqlAttempts: [string, string][] = [
      ["postgres UPDATE", `update public.skill_versions set body = 'x' where ${where}`],
      ["postgres DELETE", `delete from public.skill_versions where ${where}`],
      ["postgres DELETE all", "delete from public.skill_versions"],
      ["postgres TRUNCATE", "truncate public.skill_versions"],
      ["postgres TRUNCATE CASCADE from skills", "truncate public.skills cascade"],
      ["postgres replica-mode DELETE", replica(`delete from public.skill_versions where ${where}`)],
      ["postgres replica-mode TRUNCATE", replica("truncate public.skill_versions")],
      [
        "service_role UPDATE",
        asRole("service_role", `update public.skill_versions set body = 'x' where ${where}`),
      ],
      ["service_role DELETE all", asRole("service_role", "delete from public.skill_versions")],
      ["service_role TRUNCATE", asRole("service_role", "truncate public.skill_versions")],
      ["authenticated DELETE all", asRole("authenticated", "delete from public.skill_versions")],
      ["authenticated TRUNCATE", asRole("authenticated", "truncate public.skill_versions")],
      ["anon TRUNCATE", asRole("anon", "truncate public.skill_versions")],
    ];
    for (const [label, sql] of sqlAttempts) {
      const result = psql(sql);
      expect(result.ok, `${label} must fail, got: ${result.output}`).toBe(false);
      expect(result.output, label).toMatch(/append-only|permission denied|42501/i);
    }
    expect(await versions(skillId)).toEqual(before);
  });

  /** [case, link text, target]: the bad ones carry a backslash, a second slash or a script scheme. */
  const BAD_LINKS: [string, string, string][] = [
    ["slash-backslash", "bad-slash-bs", `/${BS}evil.com`],
    ["protocol-relative", "bad-proto-rel", "//evil.com"],
    ["double backslash", "bad-double-bs", `${BS}${BS}evil.com`],
    ["encoded backslash", "bad-encoded-bs", "/%5Cevil.com"],
    ["javascript scheme", "bad-js", "javascript:alert(1)"],
  ];
  const BODY = [
    "# Links",
    ...BAD_LINKS.map(([, text, target]) => `[${text}](<${target}>)`),
    "[good-https](https://ok.example)",
    "[good-path](/app/skills)",
  ].join("\n\n");

  async function expectLinksContained(page: Page, origin: string) {
    const preview = page.getByTestId("markdown-preview").first();
    await expect(preview.getByRole("heading", { name: "Links" })).toBeVisible();
    // Bad links: the text is still shown, but there is no link to follow.
    for (const [name, text] of BAD_LINKS) {
      await expect(preview.getByText(text), name).toBeVisible();
      await expect(preview.getByRole("link", { name: text }), name).toHaveCount(0);
    }
    // Good links: present and working.
    await expect(preview.getByRole("link", { name: "good-https" })).toHaveAttribute(
      "href",
      "https://ok.example",
    );
    await expect(preview.getByRole("link", { name: "good-path" })).toHaveAttribute(
      "href",
      "/app/skills",
    );
    // Nothing the preview links to leaves the site except the one allowed external address.
    const targets = await preview
      .locator("a")
      .evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
    for (const href of targets) {
      expect([origin, "https://ok.example"], href).toContain(new URL(href).origin);
    }
    expect(targets.some((href) => /evil/i.test(href))).toBe(false);
  }

  test("links with a backslash or a second slash are plain text; good links work (editor, saved page, viewer)", async ({
    page,
    browser,
    baseURL,
  }, testInfo) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const origin = new URL(baseURL).origin;
    const w = await world();
    const skill = await svcInsert("skills", {
      workspace_id: w.workspaceId,
      name: "links",
      body: "# seed",
    });
    const skillId = skill.id as string;
    const dialogs: string[] = [];
    const watch = (target: Page) =>
      target.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
    watch(page);
    const signIn = (target: Page, user: TestUser) =>
      signInWithSessionCookie(target.context(), baseURL, user);

    await signIn(page, w.owner);
    const skills = new SkillsPage(page);
    await skills.gotoSkill(skillId);
    await skills.body.fill(BODY);
    await expectLinksContained(page, origin); // live preview, before saving
    await skills.saveButton.click();
    await expect(skills.version).toHaveText("Version 2");
    await skills.gotoSkill(skillId);
    await expectLinksContained(page, origin); // after a reload
    await page.screenshot({ path: testInfo.outputPath("links-owner.png"), fullPage: true });

    // A viewer sees the same containment on the read-only page.
    const viewerContext = await browser.newContext({ baseURL });
    const viewerPage = await viewerContext.newPage();
    watch(viewerPage);
    await signIn(viewerPage, w.viewer);
    await new SkillsPage(viewerPage).gotoSkill(skillId);
    await expectLinksContained(viewerPage, origin);
    await viewerPage.screenshot({ path: testInfo.outputPath("links-viewer.png"), fullPage: true });
    await viewerContext.close();

    // The good relative link really navigates, in the same tab, to this site.
    await page
      .getByTestId("markdown-preview")
      .first()
      .getByRole("link", { name: "good-path" })
      .click();
    await expect(page).toHaveURL(`${origin}/app/skills`);

    expect(dialogs).toEqual([]);
    expect((await svcRows("skills", `id=eq.${skillId}&select=body`))[0]).toMatchObject({
      body: BODY,
    });
  });
});
