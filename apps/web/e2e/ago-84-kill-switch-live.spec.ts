import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { SignInPage } from "./pages/sign-in-page";
import { WorkspacePage } from "./pages/workspace-page";
import {
  addMember,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  type ApiResult,
  type TestUser,
} from "./support/stack-api";

// AGO-84 (kill switch and drill), as a person uses it. An owner opens /app, pulls the kill switch through its
// confirmation, and every live credential in the workspace is revoked and every live run is flagged to stop, with
// nothing deleted. New credential issuance is refused until an owner releases the switch (there is no release button
// yet: release is POST /api/control/kill/release). A member and an agent credential are refused with 403.
// Needs the local Supabase stack (E2E_SUPABASE=1) and no real model: runs and credentials are seeded rows.
// Set E2E_SHOT_DIR to also save a screenshot at every step.

const SHOT_DIR = process.env.E2E_SHOT_DIR;

async function shot(page: Page, ac: number, step: number, what: string): Promise<void> {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  const nn = String(step).padStart(2, "0");
  await page.screenshot({ path: join(SHOT_DIR, `AGO-84-AC${String(ac)}-step-${nn}-${what}.png`) });
}

/** Writes an API answer onto the page so a screenshot can show it (the screens have no place for it). */
async function showAnswer(page: Page, label: string, status: number, body: string): Promise<void> {
  await page.evaluate(
    ({ text }) => {
      document.querySelector("[data-testid=api-answer]")?.remove();
      const pre = document.createElement("pre");
      pre.setAttribute("data-testid", "api-answer");
      pre.textContent = text;
      pre.style.cssText =
        "position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;margin:0;padding:1rem;background:#fff;color:#111;border:2px solid #555;font:14px monospace;white-space:pre-wrap";
      // On <html>, not <body>: React owns the body's children and would drop a node added there.
      document.documentElement.append(pre);
    },
    { text: `${label}\nHTTP ${String(status)}\n${body}` },
  );
}

// Shaped like a real credential; signed by nobody. The guard looks at the prefix only.
const FAKE_AGENT_TOKEN = "ago_agt_eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoidG9rZW4ifQ.c2lnbmF0dXJl";

interface IdRow {
  id: string;
}
interface CredentialRow {
  id: string;
  revoked_at: string | null;
}

async function seedAgent(owner: TestUser, workspaceId: string, name: string): Promise<string> {
  // Through the real create_agent function as the owner (the table has no direct insert path).
  const result = await asUser<string | { id: string }>(owner, "/rest/v1/rpc/create_agent", {
    method: "POST",
    body: {
      p_workspace_id: workspaceId,
      p_name: name,
      p_role: "Drill",
      p_model: "claude-haiku-5-5",
      p_prompt: "Drill agent. No model is ever called.",
      p_daily_budget_cents: 100,
      p_skill_ids: [],
      p_capabilities: [],
    },
  });
  expect(result.status).toBe(200);
  return typeof result.body === "string" ? result.body : result.body.id;
}

async function seedRun(
  workspaceId: string,
  agentId: string,
  status: "queued" | "running",
): Promise<string> {
  const result = await asServiceRole<IdRow[]>("/rest/v1/runs", {
    method: "POST",
    body: { workspace_id: workspaceId, agent_id: agentId, status },
    prefer: "return=representation",
  });
  expect(result.status).toBe(201);
  return result.body[0]?.id ?? "";
}

/** One credential insert, exactly what the worker's issuer does (service role); returns the raw answer. */
function insertCredential(workspaceId: string, agentId: string, runId: string): Promise<ApiResult> {
  return asServiceRole("/rest/v1/agent_credentials", {
    method: "POST",
    body: {
      workspace_id: workspaceId,
      agent_id: agentId,
      run_id: runId,
      token_hash: randomBytes(32).toString("hex"),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  });
}

async function credentialsOf(workspaceId: string): Promise<CredentialRow[]> {
  const result = await asServiceRole<CredentialRow[]>(
    `/rest/v1/agent_credentials?workspace_id=eq.${workspaceId}&select=id,revoked_at&order=issued_at`,
  );
  return result.body;
}

async function runCount(workspaceId: string): Promise<number> {
  const result = await asServiceRole<IdRow[]>(
    `/rest/v1/runs?workspace_id=eq.${workspaceId}&select=id`,
  );
  return result.body.length;
}

async function signInTo(page: Page, user: TestUser): Promise<void> {
  const signIn = new SignInPage(page);
  await signIn.goto("/sign-in?next=%2Fapp");
  await signIn.signInWithEmailCode(user.email);
  await expect(new WorkspacePage(page).workspaceName).toBeVisible();
}

test.describe("AGO-84: the kill switch (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.setTimeout(120_000);

  test("an owner pulls it: credentials revoked, runs flagged, state kept, issuance refused, release works, non-owners refused", async ({
    page,
    browser,
    request,
  }, testInfo) => {
    const owner = await createUser("owner");
    const member = await createUser("member");
    const workspaceId = await onboard(owner, "Drill Co");
    await addMember(workspaceId, member, "member");

    // Seed: two agents, one running run each, one live credential each (no model is called).
    const agentOne = await seedAgent(owner, workspaceId, "Drill agent one");
    const agentTwo = await seedAgent(owner, workspaceId, "Drill agent two");
    const runOne = await seedRun(workspaceId, agentOne, "running");
    const runTwo = await seedRun(workspaceId, agentTwo, "running");
    expect((await insertCredential(workspaceId, agentOne, runOne)).status).toBe(201);
    expect((await insertCredential(workspaceId, agentTwo, runTwo)).status).toBe(201);

    await signInTo(page, owner);
    const workspace = new WorkspacePage(page);

    await test.step("AC1: the owner sees the kill switch button", async () => {
      await expect(workspace.workspaceRole).toHaveText("owner");
      await expect(page.getByRole("button", { name: "Kill switch" })).toBeVisible();
      expect((await credentialsOf(workspaceId)).map((row) => row.revoked_at)).toEqual([null, null]);
      await shot(page, 1, 1, "owner-sees-kill-switch-button");
    });

    await test.step("AC1: the first click only asks; Cancel changes nothing", async () => {
      await page.getByRole("button", { name: "Kill switch" }).click();
      const confirmation = page.getByRole("group", { name: "Confirm kill switch" });
      await expect(confirmation).toContainText("stops every run of this workspace");
      await expect(confirmation).toContainText("revokes its credentials");
      await expect(confirmation).toContainText("All records are kept");
      await expect(page.getByRole("button", { name: "Confirm kill" })).toBeVisible();
      await shot(page, 1, 2, "confirmation-asks-first");
      expect((await credentialsOf(workspaceId)).map((row) => row.revoked_at)).toEqual([null, null]);

      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("button", { name: "Kill switch" })).toBeVisible();
      await expect(confirmation).toHaveCount(0);
      expect((await credentialsOf(workspaceId)).map((row) => row.revoked_at)).toEqual([null, null]);
      await shot(page, 1, 3, "cancelled-nothing-changed");
    });

    await test.step("AC1: Confirm kill revokes both credentials and flags both runs", async () => {
      await page.getByRole("button", { name: "Kill switch" }).click();
      await page.getByRole("button", { name: "Confirm kill" }).click();
      await expect(page.getByRole("status")).toContainText(
        "Kill switch active for this workspace: 2 runs are stopping and 2 credentials were revoked. Nothing was deleted.",
      );
      await shot(page, 1, 4, "kill-active-2-runs-2-credentials");

      const credentials = await credentialsOf(workspaceId);
      expect(credentials).toHaveLength(2);
      for (const row of credentials) expect(row.revoked_at).not.toBeNull();
    });

    await test.step("AC2: state is preserved (credential rows and runs are all still there)", async () => {
      const credentials = await credentialsOf(workspaceId);
      expect(credentials).toHaveLength(2);
      expect(await runCount(workspaceId)).toBe(2);
      await showAnswer(
        page,
        "Ground truth after the kill (service role read): agent_credentials rows, runs rows",
        200,
        `agent_credentials: ${String(credentials.length)} rows, revoked_at set on ${String(
          credentials.filter((row) => row.revoked_at !== null).length,
        )}, none deleted\nruns: ${String(await runCount(workspaceId))} rows, none deleted`,
      );
      await shot(page, 2, 1, "rows-kept-credentials-revoked-not-deleted");
    });

    await test.step("AC1: new credential issuance is refused while the switch is latched", async () => {
      const newRun = await seedRun(workspaceId, agentOne, "queued");
      const refused = await insertCredential(workspaceId, agentOne, newRun);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(refused.body)).toMatch(/kill switch/i);
      expect(await credentialsOf(workspaceId)).toHaveLength(2);
      await showAnswer(
        page,
        "Issue a credential for a new run, as the worker would",
        refused.status,
        JSON.stringify(refused.body, null, 2),
      );
      await shot(page, 1, 5, "new-issuance-refused-by-database");
    });

    await test.step("AC1: the latch survives a reload; a second pull revokes nothing more and flags only the run queued since", async () => {
      await workspace.goto();
      await expect(page.getByRole("button", { name: "Kill switch" })).toBeVisible();
      await shot(page, 1, 6, "after-reload-button-idle-no-latched-indicator");
      await page.getByRole("button", { name: "Kill switch" }).click();
      await page.getByRole("button", { name: "Confirm kill" }).click();
      await expect(page.getByRole("status")).toContainText(
        "1 runs are stopping and 0 credentials were revoked",
      );
      await shot(page, 1, 7, "second-pull-only-the-new-queued-run");
      // The two credentials were already revoked, so nothing more is revoked; the run queued after the kill is flagged.
      expect(await credentialsOf(workspaceId)).toHaveLength(2);
    });

    await test.step("AC1: a member does not see the button and is refused on both routes", async () => {
      const memberContext = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
      });
      try {
        const memberPage = await memberContext.newPage();
        await signInTo(memberPage, member);
        await expect(new WorkspacePage(memberPage).workspaceRole).toHaveText("member");
        await expect(memberPage.getByRole("button", { name: "Kill switch" })).toHaveCount(0);
        await shot(memberPage, 1, 8, "member-sees-no-kill-switch");

        const body = { workspace_id: workspaceId, scope: "workspace" };
        const kill = await memberContext.request.post("/api/control/kill", { data: body });
        expect(kill.status()).toBe(403);
        await showAnswer(
          memberPage,
          "member POST /api/control/kill",
          kill.status(),
          await kill.text(),
        );
        await shot(memberPage, 1, 9, "member-kill-refused-403");

        const release = await memberContext.request.post("/api/control/kill/release", {
          data: body,
        });
        expect(release.status()).toBe(403);
        await showAnswer(
          memberPage,
          "member POST /api/control/kill/release",
          release.status(),
          await release.text(),
        );
        await shot(memberPage, 1, 10, "member-release-refused-403");
      } finally {
        await memberContext.close();
      }
    });

    await test.step("AC1: an agent credential is refused on both routes", async () => {
      const body = { workspace_id: workspaceId, scope: "workspace" };
      for (const [path, step] of [
        ["/api/control/kill", 11],
        ["/api/control/kill/release", 12],
      ] as const) {
        const response = await request.post(path, {
          headers: { authorization: `Bearer ${FAKE_AGENT_TOKEN}` },
          data: body,
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        expect(response.status()).toBe(403);
        const text = await response.text();
        expect(text).toContain("agent_credential_not_allowed");
        expect(text).not.toContain(FAKE_AGENT_TOKEN);
        await showAnswer(page, `agent credential POST ${path}`, response.status(), text);
        await shot(
          page,
          1,
          step,
          `agent-credential-refused-403-${step === 11 ? "kill" : "release"}`,
        );
      }
    });

    await test.step("AC1: the owner releases through the route; issuance works again; stopped runs stay stopped", async () => {
      const released = await page.request.post("/api/control/kill/release", {
        data: { workspace_id: workspaceId, scope: "workspace" },
      });
      expect(released.status()).toBe(200);
      const releasedBody = await released.text();
      expect(JSON.parse(releasedBody)).toMatchObject({ scope: "workspace", status: "released" });
      await showAnswer(
        page,
        "owner POST /api/control/kill/release",
        released.status(),
        releasedBody,
      );
      await shot(page, 1, 13, "owner-release-200");

      const freshRun = await seedRun(workspaceId, agentTwo, "queued");
      const issued = await insertCredential(workspaceId, agentTwo, freshRun);
      expect(issued.status).toBe(201);
      const credentials = await credentialsOf(workspaceId);
      expect(credentials).toHaveLength(3);
      // The two credentials revoked by the kill stay revoked; only the new one is live.
      expect(credentials.filter((row) => row.revoked_at === null)).toHaveLength(1);
      await showAnswer(
        page,
        "After release: issue a credential for a new run",
        issued.status,
        `agent_credentials: ${String(credentials.length)} rows, ${String(
          credentials.filter((row) => row.revoked_at !== null).length,
        )} still revoked, 1 new live`,
      );
      await shot(page, 1, 14, "after-release-issuance-allowed-old-credentials-stay-revoked");
    });
  });
});
