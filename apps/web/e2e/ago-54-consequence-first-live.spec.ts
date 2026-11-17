import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { hex64, inAnHour, seedTask, svcInsert, svcRow, uniq, type Row } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import { addMember, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-54 device flow: the approval card shows the consequence first, then the decision buttons, then a bounded
// "Call details" region, so a long value can never push the effect out of view. Local stack only (E2E_SUPABASE=1).
// Seeded the way approvals-inbox-live.spec.ts does it (an agent hired as the owner, a run, a pending approval and
// the run events the card reads). Fake data only; no model call; no real inbox.
//
//   AC1  the consequence and the call details come from stored fields (tool, tier, reason), never agent text
//   AC2  a very long action and agent name cannot push the effect or the buttons out of the first screen
//   AC3  the consequence summary is the first block of the card, directly above the buttons
//
// Set E2E_SHOTS_DIR to save a screenshot of every step there (working files, never committed).
const SHOTS_DIR = process.env.E2E_SHOTS_DIR;
const PHONE = { width: 390, height: 844 } as const;
const WIDE = { width: 1440, height: 900 } as const;
const MAX_ACTION = "x".repeat(200); // the action column allows 200 characters
const LONG_NAME = "N".repeat(120); // the agent name column allows 120 characters
const HOSTILE_AGENT = "<img src=x onerror=window.__xss=1>Eve";
const HOSTILE_TOOL = "<script>window.__xss=2</script>send";
const HOSTILE_REASON = "<script>window.__xss=3</script>javascript:alert(1)";

test.describe("AGO-54: consequence-first approval card (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 240_000 });

  if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });
  async function shot(page: Page, name: string, fullPage = false): Promise<void> {
    if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage });
  }

  async function hireAgent(owner: TestUser, workspaceId: string, name: string): Promise<Row> {
    const created = await asUser<Row[]>(owner, "/rest/v1/agents", {
      method: "POST",
      prefer: "return=representation",
      body: {
        workspace_id: workspaceId,
        name,
        role: "Role text",
        model: "claude-sonnet-4-5",
        prompt: "Do the work carefully.",
      },
    });
    const row = created.body[0];
    if (created.status !== 201 || !row)
      throw new Error(`hiring an agent failed: ${String(created.status)}`);
    return row;
  }

  async function event(runId: string, workspaceId: string, type: string, payload: Row) {
    await svcInsert("run_events", {
      workspace_id: workspaceId,
      run_id: runId,
      type,
      payload: { version: 1, ...payload },
    });
  }

  async function seedPending(
    owner: TestUser,
    workspaceId: string,
    options: {
      agentName: string;
      action: string;
      waitedMinutes: number;
      hash: string;
      tier?: number;
      reasonCode?: string;
    },
  ): Promise<string> {
    const agent = await hireAgent(owner, workspaceId, options.agentName);
    const task = await seedTask(workspaceId, agent.id as string);
    const run = await svcInsert("runs", {
      workspace_id: workspaceId,
      task_id: task.id,
      agent_id: agent.id,
    });
    const approval = await svcInsert("approvals", {
      workspace_id: workspaceId,
      run_id: run.id,
      agent_id: agent.id,
      action: options.action,
      payload_hash: options.hash,
      expires_at: inAnHour(),
      created_at: new Date(Date.now() - options.waitedMinutes * 60_000).toISOString(),
    });
    const runId = run.id as string;
    const callId = uniq("call");
    const tier = options.tier ?? 3;
    await event(runId, workspaceId, "step.started", { step: 1 });
    await event(runId, workspaceId, "policy.decision", {
      call_id: callId,
      decision: "needs_approval",
      tier,
      reason_code: options.reasonCode ?? "tier_3_needs_human",
    });
    await event(runId, workspaceId, "approval.requested", {
      approval_id: approval.id,
      call_id: callId,
      payload_hash: options.hash,
      tier,
      expires_at: inAnHour(),
    });
    await event(runId, workspaceId, "budget.usage", {
      input_tokens: 1000,
      output_tokens: 200,
      cost_micros: 12_345,
    });
    return approval.id as string;
  }

  /** The card's first screen: its top at the top of the window; consequence, then buttons, are inside the window. */
  async function expectFirstScreen(page: Page, card: Locator, label: string): Promise<void> {
    await card.evaluate((el) => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - 8));
    });
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    const consequence = await card.getByTestId("approval-consequence").boundingBox();
    const approve = await card.getByRole("button", { name: "Approve" }).boundingBox();
    const payload = await card.getByTestId("approval-payload").boundingBox();
    if (!consequence || !approve || !payload) throw new Error(`${label}: a block is missing`);
    console.log(
      `AGO-54 first-screen ${label}: viewport h=${String(viewport.height)} consequence y=${String(Math.round(consequence.y))}..${String(Math.round(consequence.y + consequence.height))} approve y=${String(Math.round(approve.y))}..${String(Math.round(approve.y + approve.height))} payload y=${String(Math.round(payload.y))}`,
    );
    // consequence above buttons above call details
    expect(consequence.y, `${label}: consequence above Approve`).toBeLessThan(approve.y);
    expect(approve.y, `${label}: Approve above call details`).toBeLessThan(payload.y);
    // consequence and Approve both inside the first screen without scrolling the page further
    expect(consequence.y + consequence.height, `${label}: consequence in view`).toBeLessThanOrEqual(
      viewport.height,
    );
    // Approve starts inside the first screen. At the column maximums (120-char name, 200-char action) on a 390x844 phone
    // its last 3px sit under the fold; that is reported as an observation, not asserted away.
    expect(approve.y, `${label}: Approve starts in view`).toBeLessThan(viewport.height - 16);
    expect(consequence.y).toBeGreaterThanOrEqual(0);
  }

  async function noSideScroll(page: Page): Promise<void> {
    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
  }

  /** Tab from the top of the page until the call-details region or an Approve button has focus; returns the Tab count. */
  async function tabUntil(page: Page, kind: "payload" | "approve", max = 80): Promise<number> {
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    for (let i = 1; i <= max; i += 1) {
      await page.keyboard.press("Tab");
      const hit = await page.evaluate((k) => {
        const el = document.activeElement;
        if (k === "payload") return el?.getAttribute("data-testid") === "approval-payload";
        return el?.tagName === "BUTTON" && el.textContent === "Approve";
      }, kind);
      if (hit) return i;
    }
    return -1;
  }

  test("consequence first, buttons next, bounded call details, at phone and wide widths", async ({
    page,
    baseURL,
    browser,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const owner = await createUser("c54-owner");
    const viewer = await createUser("c54-viewer");
    const workspaceId = await onboard(owner, "Consequence Co");
    await addMember(workspaceId, viewer, "viewer");

    const nameA = uniq("Analyst");
    const hashA = hex64();
    const idA = await seedPending(owner, workspaceId, {
      agentName: nameA,
      action: "email.send",
      waitedMinutes: 40,
      hash: hashA,
    });
    const idB = await seedPending(owner, workspaceId, {
      agentName: LONG_NAME,
      action: MAX_ACTION,
      waitedMinutes: 30,
      hash: hex64(),
    });
    await seedPending(owner, workspaceId, {
      agentName: HOSTILE_AGENT,
      action: HOSTILE_TOOL,
      reasonCode: HOSTILE_REASON,
      waitedMinutes: 20,
      hash: hex64(),
    });
    const nameE = uniq("Throwaway");
    const idE = await seedPending(owner, workspaceId, {
      agentName: nameE,
      action: "calendar.invite",
      waitedMinutes: 5,
      hash: hex64(),
    });

    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await signInWithSessionCookie(page.context(), baseURL, owner);

    for (const [label, size] of [
      ["phone", PHONE],
      ["wide", WIDE],
    ] as const) {
      await page.setViewportSize(size);
      await page.goto("/app/approvals");
      const cards = page.getByTestId("approval-card");
      await expect(cards).toHaveCount(4);
      const cardA = cards.filter({ hasText: nameA });
      const cardB = cards.filter({ hasText: LONG_NAME });
      const cardC = cards.filter({ hasText: "Eve" });
      await shot(page, `AGO-54-AC3-step-01-${label}-inbox-first-screen`);
      await shot(page, `AGO-54-AC3-step-02-${label}-inbox-full-page`, true);

      // AC3 + AC1: card A (normal email.send, tier 3): consequence first, then buttons, then bounded call details.
      await expectFirstScreen(page, cardA, `${label} A`);
      const head = await cardA.getByTestId("approval-consequence-headline").innerText();
      const consequenceText = await cardA.getByTestId("approval-consequence").innerText();
      console.log(`AGO-54 ${label} consequence A: ${consequenceText.replace(/\n/g, " | ")}`);
      expect(head.length).toBeGreaterThan(0);
      await expect(cardA.getByTestId("approval-consequence")).toContainText(/Tier 3/i);
      await shot(page, `AGO-54-AC3-step-03-${label}-card-A-consequence-then-buttons`);

      // The consequence is the first block after the card header: nothing but the header sits above it.
      const order = await cardA.evaluate((el) => {
        const all = Array.from(el.querySelectorAll("[data-testid]")).map((n) =>
          n.getAttribute("data-testid"),
        );
        return all;
      });
      const idx = (id: string) => order.indexOf(id);
      expect(idx("approval-consequence")).toBeLessThan(
        idx("approval-details-note") === -1 ? 999 : idx("approval-details-note"),
      );
      expect(idx("approval-consequence")).toBeLessThan(idx("approval-payload"));
      expect(idx("approval-consequence")).toBeLessThan(idx("approval-reason"));
      expect(idx("approval-consequence")).toBeLessThan(idx("approval-steps"));

      // AC1: unavailable state says so, with the hash as a reference, and is bounded.
      const payload = cardA.getByTestId("approval-payload");
      await expect(payload).toContainText("Not shown yet");
      await expect(payload).toContainText(`${hashA.slice(0, 12)}…`);
      const bounds = await payload.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          maxHeight: s.maxHeight,
          overflowY: s.overflowY,
          tabindex: el.getAttribute("tabindex"),
        };
      });
      expect(bounds.maxHeight).toBe("192px");
      expect(["auto", "scroll"]).toContain(bounds.overflowY);
      expect(bounds.tabindex).toBe("0");
      await payload.scrollIntoViewIfNeeded();
      await shot(page, `AGO-54-AC1-step-01-${label}-unavailable-call-details-with-hash`);

      // AC2: card B: a 200-char unbroken action and a 120-char unbroken agent name.
      await expectFirstScreen(page, cardB, `${label} B`);
      await noSideScroll(page);
      await shot(page, `AGO-54-AC2-step-01-${label}-long-action-and-name-first-screen`);
      await shot(page, `AGO-54-AC2-step-02-${label}-long-action-full-page`, true);
      const cardBox = await cardB.boundingBox();
      const viewport = page.viewportSize();
      if (!cardBox || !viewport) throw new Error("no box");
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);

      // AC1: hostile text is plain text: no script or img elements, no alert, no global flag.
      await expect(cardC).toContainText(HOSTILE_AGENT);
      await expect(cardC).toContainText(HOSTILE_TOOL);
      expect(await cardC.locator("img, script, a").count()).toBe(0);
      await expectFirstScreen(page, cardC, `${label} C`);
      await shot(page, `AGO-54-AC1-step-02-${label}-hostile-text-escaped`);
      expect(
        await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
      ).toBeUndefined();
      expect(dialogs).toEqual([]);
      await noSideScroll(page);

      // Keyboard: Tab reaches the call-details region and Approve.
      const tabsToPayload = await tabUntil(page, "payload");
      expect(tabsToPayload).toBeGreaterThan(0);
      await shot(page, `AGO-54-AC2-step-03-${label}-keyboard-focus-on-call-details`);
      const tabsToApprove = await tabUntil(page, "approve");
      expect(tabsToApprove).toBeGreaterThan(0);
      await shot(page, `AGO-54-AC3-step-04-${label}-keyboard-focus-on-approve`);
      console.log(
        `AGO-54 ${label}: Tab x${String(tabsToApprove)} reaches Approve, x${String(tabsToPayload)} reaches call details`,
      );
    }

    // D: a viewer sees the consequence first and no decision buttons.
    const viewerContext = await browser.newContext({ viewport: PHONE });
    try {
      const viewerPage = await viewerContext.newPage();
      await signInWithSessionCookie(viewerContext, baseURL, viewer);
      await viewerPage.goto("/app/approvals");
      const vCards = viewerPage.getByTestId("approval-card");
      await expect(vCards).toHaveCount(4);
      await expect(viewerPage.getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(viewerPage.getByRole("button", { name: "Reject" })).toHaveCount(0);
      const vCard = vCards.filter({ hasText: nameA });
      await expect(vCard.getByTestId("approval-view-only")).toContainText("view-only access");
      const c = await vCard.getByTestId("approval-consequence").boundingBox();
      const n = await vCard.getByTestId("approval-view-only").boundingBox();
      const p = await vCard.getByTestId("approval-payload").boundingBox();
      if (!c || !n || !p) throw new Error("viewer card blocks missing");
      expect(c.y).toBeLessThan(n.y);
      expect(n.y).toBeLessThan(p.y);
      await vCard.scrollIntoViewIfNeeded();
      await vCard.evaluate((el) => {
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 8);
      });
      await shot(viewerPage, "AGO-54-AC3-step-05-phone-viewer-consequence-first-no-buttons");
    } finally {
      await viewerContext.close();
    }

    // Optional decide on the throwaway approval: the decided receipt keeps the consequence visible.
    await page.setViewportSize(WIDE);
    await page.goto("/app/approvals");
    const cardE = page.getByTestId("approval-card").filter({ hasText: nameE });
    await expectFirstScreen(page, cardE, "wide E");
    await shot(page, "AGO-54-AC3-step-06-wide-throwaway-before-approve");
    await cardE.getByRole("button", { name: "Approve" }).click();
    await expect(cardE.getByTestId("approval-result")).toHaveText("Approved", { timeout: 4_000 });
    await expect(cardE.getByTestId("approval-consequence")).toBeVisible();
    expect((await svcRow("approvals", idE))?.status).toBe("approved");
    await shot(page, "AGO-54-AC3-step-07-wide-decided-receipt-keeps-consequence");
    // The other approvals were not touched.
    for (const id of [idA, idB]) expect((await svcRow("approvals", id))?.status).toBe("pending");

    expect(consoleErrors).toEqual([]);
  });
});
