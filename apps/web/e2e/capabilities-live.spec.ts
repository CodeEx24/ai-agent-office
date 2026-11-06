import type { Page } from "@playwright/test";

import { expect, isLiveStack, test } from "./fixtures";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import {
  addMember,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  type TestUser,
} from "./support/stack-api";

// AGO-125: the capability catalog and its read API (GET /api/capabilities), probed as each kind of
// caller through the running app and, for the data rules, through the real Data API. Local stack only
// (E2E_SUPABASE=1).
//
//   AC1  the catalog holds the 12 starter capabilities with tiers 0-4
//   AC2  a tier 3 or 4 capability cannot be made automatic in data
//   AC3  the read API returns the catalog to members (and viewers), and to nobody else
test.describe("AGO-125: capability catalog (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  interface CatalogBody {
    capabilities: {
      key: string;
      tier: number;
      scope: string;
      defaultMode: string;
      enabled: boolean;
      workspaceId: string;
    }[];
  }

  const EXPECTED_TIERS: Record<string, number> = {
    "vault.read": 0,
    "vault.read_private": 0,
    "web.search": 1,
    "tasks.manage": 1,
    "vault.write_own": 2,
    "vault.write_shared": 2,
    "code.run": 3,
    "web.browse": 3,
    "message.send_outbound": 3,
    "integration.write": 3,
    "payments.execute": 4,
    "data.delete_irreversible": 4,
  };

  // Writes the session cookie instead of going through the magic link: `/auth/callback` is rate
  // limited per IP and the rest of the suite already uses most of that budget.
  async function signIn(page: Page, baseURL: string | undefined, user: TestUser) {
    if (!baseURL) throw new Error("baseURL is not configured");
    await signInWithSessionCookie(page.context(), baseURL, user);
  }

  async function world() {
    const owner = await createUser("owner");
    const member = await createUser("member");
    const viewer = await createUser("viewer");
    const stranger = await createUser("stranger");
    const workspaceId = await onboard(owner, "Catalog Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    const otherWorkspaceId = await onboard(stranger, "Elsewhere Co");
    return { owner, member, viewer, stranger, workspaceId, otherWorkspaceId };
  }

  test("AC1: a new workspace has the 12 starter capabilities with their tiers", async () => {
    const { workspaceId } = await world();
    const rows = await svcRows(
      "capabilities",
      `workspace_id=eq.${workspaceId}&select=key,tier,default_mode,enabled`,
    );
    expect(rows).toHaveLength(12);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.tier]))).toEqual(EXPECTED_TIERS);
    expect(rows.every((r) => r.enabled === true)).toBe(true);
  });

  for (const role of ["member", "viewer"] as const) {
    test(`AC3: a ${role} gets the whole catalog from the read API, lowest tier first`, async ({
      page,
      baseURL,
    }) => {
      const w = await world();
      await signIn(page, baseURL, w[role]);

      const response = await page.request.get(`/api/capabilities?workspace_id=${w.workspaceId}`);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toContain("no-store");
      const body = (await response.json()) as CatalogBody;
      expect(body.capabilities).toHaveLength(12);
      expect(Object.fromEntries(body.capabilities.map((c) => [c.key, c.tier]))).toEqual(
        EXPECTED_TIERS,
      );
      expect(body.capabilities.map((c) => c.tier)).toEqual(
        [...body.capabilities.map((c) => c.tier)].sort((a, b) => a - b),
      );
      expect(body.capabilities.every((c) => c.workspaceId === w.workspaceId)).toBe(true);
      // AC2 through the API: nothing risky is automatic.
      expect(body.capabilities.filter((c) => c.tier >= 3 && c.defaultMode === "automatic")).toEqual(
        [],
      );

      // Bad input is rejected with 400. (These reuse this session: the sign-in endpoints are rate
      // limited per IP, so a spec should not sign in more often than it must.)
      for (const query of ["", "?workspace_id=not-a-uuid", `?workspace_id=${w.workspaceId}&x=1`]) {
        const bad = await page.request.get(`/api/capabilities${query}`, {
          failOnStatusCode: false,
        });
        expect.soft(bad.status(), `${role} ${query}`).toBe(400);
      }

      // There is no write route: tier, scope and default only change by migration.
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const write = await page.request[method](
          `/api/capabilities?workspace_id=${w.workspaceId}`,
          { failOnStatusCode: false, data: {} },
        );
        expect.soft(write.status(), `${role} ${method}`).toBe(405);
      }
    });
  }

  test("AC3 (negative): a signed-out caller gets 401 and no data", async ({ request }) => {
    const { workspaceId } = await world();
    const response = await request.get(`/api/capabilities?workspace_id=${workspaceId}`, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  test("AC3 (negative): a member of another workspace gets 403 and no data", async ({
    page,
    baseURL,
  }) => {
    const w = await world();
    await signIn(page, baseURL, w.stranger);

    const own = await page.request.get(`/api/capabilities?workspace_id=${w.otherWorkspaceId}`);
    expect(own.status(), "positive control: the stranger can read their own catalog").toBe(200);

    const response = await page.request.get(`/api/capabilities?workspace_id=${w.workspaceId}`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  test("AC2: the database rejects an automatic tier 3 or 4 capability, even for the runtime role", async () => {
    const { workspaceId } = await world();
    const attempts = [
      { key: "payments.execute", expected: "tier 4 flipped to automatic" },
      { key: "code.run", expected: "tier 3 flipped to automatic" },
    ];
    for (const { key, expected } of attempts) {
      const result = await asServiceRole<{ code?: string }>(
        `/rest/v1/capabilities?workspace_id=eq.${workspaceId}&key=eq.${key}`,
        { method: "PATCH", body: { default_mode: "automatic" } },
      );
      expect.soft(result.status, expected).toBe(400);
      expect.soft(result.body.code, expected).toBe("23514");
    }
    const insert = await asServiceRole<{ code?: string }>("/rest/v1/capabilities", {
      method: "POST",
      body: {
        workspace_id: workspaceId,
        key: "x.new_risky",
        name: "X",
        tier: 4,
        scope: "external",
        default_mode: "automatic",
      },
    });
    expect(insert.status).toBe(400);
    expect(insert.body.code).toBe("23514");

    const stored = await svcRows(
      "capabilities",
      `workspace_id=eq.${workspaceId}&key=in.(payments.execute,code.run)&select=key,default_mode`,
    );
    expect(stored.every((r) => r.default_mode === "approval")).toBe(true);
  });

  test("AC2/AC3: an owner can only change enabled and description through the Data API", async () => {
    const w = await world();
    const path = `/rest/v1/capabilities?workspace_id=eq.${w.workspaceId}&key=eq.payments.execute`;

    const safe = await asUser<{ enabled: boolean }[]>(w.owner, path, {
      method: "PATCH",
      body: { enabled: false, description: "Paused by the owner." },
      prefer: "return=representation",
    });
    expect(safe.body.map((r) => r.enabled)).toEqual([false]);

    for (const body of [{ tier: 0 }, { default_mode: "automatic" }, { key: "renamed.key" }]) {
      const denied = await asUser<{ code?: string }>(w.owner, path, { method: "PATCH", body });
      expect.soft(denied.body.code, JSON.stringify(body)).toBe("42501");
    }
    const still = await svcRows(
      "capabilities",
      `workspace_id=eq.${w.workspaceId}&key=eq.payments.execute&select=tier,default_mode`,
    );
    expect(still).toEqual([{ tier: 4, default_mode: "approval" }]);

    for (const [who, user] of [
      ["member", w.member],
      ["viewer", w.viewer],
    ] as const) {
      const result = await asUser<unknown[]>(user, path, {
        method: "PATCH",
        body: { enabled: true },
        prefer: "return=representation",
      });
      expect.soft(result.body, `${who} update must change nothing`).toEqual([]);
    }
  });
});
