import { expect, isLiveStack, test } from "./fixtures";
import { svcRows } from "./support/rls-world";
import { signInWithSessionCookie } from "./support/session-cookie";
import {
  addMember,
  asAnon,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  softRemove,
} from "./support/stack-api";

// AGO-125 QA: acceptance-criteria probes for the capability catalog, written by the tester and kept
// apart from the implementer's capabilities-live.spec.ts. Local stack only (E2E_SUPABASE=1).
//
//   AC1  the catalog holds the 12 starter capabilities, with the documented tiers, scopes and defaults
//   AC2  a tier 3 or 4 capability can never be automatic in data (every role, every path)
//   AC3  the read API returns the catalog to members and viewers, and to nobody else
test.describe("AGO-125 QA: capability catalog acceptance (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  // The coordinator-confirmed v1 list (docs/tickets/AGO-125.md): key -> tier, scope, default mode.
  const STARTERS: Record<string, [number, string, string]> = {
    "vault.read": [0, "workspace", "automatic"],
    "vault.read_private": [0, "agent", "automatic"],
    "web.search": [1, "external", "automatic"],
    "tasks.manage": [1, "workspace", "automatic"],
    "vault.write_own": [2, "agent", "approval"],
    "vault.write_shared": [2, "workspace", "approval"],
    "code.run": [3, "sandbox", "approval"],
    "web.browse": [3, "external", "approval"],
    "message.send_outbound": [3, "external", "approval"],
    "integration.write": [3, "external", "approval"],
    "payments.execute": [4, "external", "approval"],
    "data.delete_irreversible": [4, "workspace", "approval"],
  };

  async function world() {
    const owner = await createUser("qa-owner");
    const member = await createUser("qa-member");
    const viewer = await createUser("qa-viewer");
    const stranger = await createUser("qa-stranger");
    const workspaceId = await onboard(owner, "QA Catalog Co");
    await addMember(workspaceId, member, "member");
    await addMember(workspaceId, viewer, "viewer");
    const otherWorkspaceId = await onboard(stranger, "QA Elsewhere Co");
    return { owner, member, viewer, stranger, workspaceId, otherWorkspaceId };
  }

  function catalogPath(workspaceId: string, key?: string) {
    const base = `/rest/v1/capabilities?workspace_id=eq.${workspaceId}`;
    return key ? `${base}&key=eq.${key}` : base;
  }

  async function storedStarters(workspaceId: string) {
    return svcRows(
      "capabilities",
      `workspace_id=eq.${workspaceId}&select=key,tier,scope,default_mode,enabled`,
    );
  }

  function asTable(rows: Awaited<ReturnType<typeof storedStarters>>): Record<string, unknown[]> {
    return Object.fromEntries(
      rows.map((r): [string, unknown[]] => [String(r.key), [r.tier, r.scope, r.default_mode]]),
    );
  }

  test("AC1: a workspace made by onboarding has exactly the 12 starters with the documented tiers, scopes and defaults", async () => {
    const { workspaceId } = await world();
    const rows = await storedStarters(workspaceId);
    expect(rows).toHaveLength(12);
    expect(asTable(rows)).toEqual(STARTERS);
    expect(rows.every((r) => r.enabled === true)).toBe(true);
  });

  test("AC1: a workspace created any other way (a bare insert) is seeded by the trigger, once", async () => {
    const created = await asServiceRole<{ id: string }[]>("/rest/v1/workspaces", {
      method: "POST",
      body: { name: "QA Bare Insert Co" },
      prefer: "return=representation",
    });
    expect(created.status).toBe(201);
    const id = created.body[0]?.id;
    if (!id) throw new Error("the workspace insert returned no id");

    const rows = await storedStarters(id);
    expect(rows).toHaveLength(12);
    expect(asTable(rows)).toEqual(STARTERS);

    // Idempotent: updating the workspace does not seed again (the trigger is AFTER INSERT only), and
    // the unique (workspace_id, key) constraint rejects a second copy of any starter.
    const rename = await asServiceRole(`/rest/v1/workspaces?id=eq.${id}`, {
      method: "PATCH",
      body: { name: "QA Bare Insert Co (renamed)" },
    });
    expect(rename.status).toBe(204);
    expect(await storedStarters(id)).toHaveLength(12);
    const duplicate = await asServiceRole<{ code?: string }>("/rest/v1/capabilities", {
      method: "POST",
      body: {
        workspace_id: id,
        key: "vault.read",
        name: "Again",
        tier: 0,
        scope: "workspace",
        default_mode: "automatic",
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("23505");
  });

  test("AC1: the oldest workspace (the seed and backfill case) already has its 12 starters", async () => {
    const oldest = await svcRows("workspaces", "select=id&order=created_at.asc&limit=1");
    const id = oldest[0]?.id;
    if (typeof id !== "string") throw new Error("no workspace exists on the local stack");
    const rows = await storedStarters(id);
    expect(rows).toHaveLength(12);
    expect(asTable(rows)).toEqual(STARTERS);
  });

  test("AC1 (negative): nobody can call the seeding function through the Data API", async () => {
    const { owner, workspaceId } = await world();
    const request = {
      method: "POST",
      body: { p_workspace_id: workspaceId },
      headers: { "Content-Profile": "private" },
    };
    const results = {
      service_role: await asServiceRole("/rest/v1/rpc/seed_workspace_capabilities", request),
      anon: await asAnon("/rest/v1/rpc/seed_workspace_capabilities", request),
      owner: await asUser(owner, "/rest/v1/rpc/seed_workspace_capabilities", request),
    };
    for (const [who, result] of Object.entries(results)) {
      expect
        .soft(result.status, `${who} must not reach private.seed_workspace_capabilities`)
        .toBeGreaterThanOrEqual(400);
    }
  });

  test("AC2: the database rejects every automatic tier 3 and tier 4 insert and update, even as service_role", async () => {
    const { workspaceId } = await world();
    const highTier = Object.entries(STARTERS).filter(([, [tier]]) => tier >= 3);
    expect(highTier).toHaveLength(6);

    for (const [key, [tier, scope]] of highTier) {
      const update = await asServiceRole<{ code?: string }>(catalogPath(workspaceId, key), {
        method: "PATCH",
        body: { default_mode: "automatic" },
      });
      expect.soft(update.body.code, `update ${key}`).toBe("23514");

      const insert = await asServiceRole<{ code?: string }>("/rest/v1/capabilities", {
        method: "POST",
        body: {
          workspace_id: workspaceId,
          key: `qa.${key}`,
          name: key,
          tier,
          scope,
          default_mode: "automatic",
        },
      });
      expect.soft(insert.body.code, `insert qa.${key}`).toBe("23514");
    }

    // Raising the tier of an automatic row is the same hole from the other side.
    const raise = await asServiceRole<{ code?: string }>(catalogPath(workspaceId, "vault.read"), {
      method: "PATCH",
      body: { tier: 4 },
    });
    expect(raise.body.code).toBe("23514");

    const stored = await storedStarters(workspaceId);
    expect(stored.filter((r) => Number(r.tier) >= 3 && r.default_mode !== "approval")).toEqual([]);
    expect(asTable(stored)).toEqual(STARTERS);
  });

  test("AC2: out-of-range tiers and unknown scopes, modes or keys are rejected in data", async () => {
    const { workspaceId } = await world();
    const bad = [
      { key: "qa.tier5", tier: 5, scope: "external", default_mode: "approval" },
      { key: "qa.tiernegative", tier: -1, scope: "external", default_mode: "approval" },
      { key: "qa.scope", tier: 1, scope: "galaxy", default_mode: "approval" },
      { key: "qa.mode", tier: 1, scope: "external", default_mode: "whenever" },
      { key: "Bad Key", tier: 1, scope: "external", default_mode: "approval" },
    ];
    for (const row of bad) {
      const result = await asServiceRole<{ code?: string }>("/rest/v1/capabilities", {
        method: "POST",
        body: { workspace_id: workspaceId, name: "QA", ...row },
      });
      expect.soft(result.status, JSON.stringify(row)).toBe(400);
      expect.soft(result.body.code, JSON.stringify(row)).toMatch(/^(23514|22P02)$/);
    }
    expect(await storedStarters(workspaceId)).toHaveLength(12);
  });

  test("AC2 (negative): an owner cannot insert, delete or move a capability through the Data API", async () => {
    const w = await world();
    const insert = await asUser<{ code?: string }>(w.owner, "/rest/v1/capabilities", {
      method: "POST",
      body: {
        workspace_id: w.workspaceId,
        key: "qa.owner_added",
        name: "Owner added",
        tier: 0,
        scope: "workspace",
        default_mode: "automatic",
      },
    });
    expect(insert.body.code).toBe("42501");

    const remove = await asUser<{ code?: string } | null>(
      w.owner,
      catalogPath(w.workspaceId, "code.run"),
      { method: "DELETE" },
    );
    expect(remove.body?.code).toBe("42501");

    const move = await asUser<{ code?: string }>(w.owner, catalogPath(w.workspaceId, "code.run"), {
      method: "PATCH",
      body: { workspace_id: w.otherWorkspaceId },
    });
    expect(move.body.code).toBe("42501");

    expect(asTable(await storedStarters(w.workspaceId))).toEqual(STARTERS);
    expect(asTable(await storedStarters(w.otherWorkspaceId))).toEqual(STARTERS);
  });

  test("AC2 (negative): the owner of another workspace changes nothing here, and anon cannot read or write", async () => {
    const w = await world();
    const path = catalogPath(w.workspaceId, "payments.execute");

    const crossUpdate = await asUser<unknown[]>(w.stranger, path, {
      method: "PATCH",
      body: { enabled: false, description: "hijacked" },
      prefer: "return=representation",
    });
    expect(crossUpdate.body).toEqual([]);

    const crossRead = await asUser<unknown[]>(w.stranger, catalogPath(w.workspaceId));
    expect(crossRead.status).toBe(200);
    expect(crossRead.body).toEqual([]);

    const anonRead = await asAnon<{ code?: string }>(catalogPath(w.workspaceId));
    expect(anonRead.status).toBeGreaterThanOrEqual(400);
    expect(anonRead.body.code).toBe("42501");
    for (const method of ["PATCH", "POST", "DELETE"]) {
      const anonWrite = await asAnon(path, {
        method,
        body: method === "DELETE" ? undefined : { enabled: false },
      });
      expect.soft(anonWrite.status, `anon ${method}`).toBeGreaterThanOrEqual(400);
    }

    const [row] = await svcRows(
      "capabilities",
      `workspace_id=eq.${w.workspaceId}&key=eq.payments.execute&select=enabled,description`,
    );
    expect(row?.enabled).toBe(true);
    expect(row?.description).not.toBe("hijacked");
  });

  test.describe("in the browser", () => {
    // Opening raw JSON in a tab makes the browser ask for /favicon.ico, which the app does not serve.
    // That is unrelated to this ticket, so only that one failed request (a 404) is allowed here. The
    // guard matches the message text, which does not include the URL.
    test.use({
      allowedConsoleErrors: [/Failed to load resource: the server responded with a status of 404/],
    });

    test("AC3: a member sees the catalog in the browser, and concurrent reads return the same answer", async ({
      page,
      baseURL,
    }, testInfo) => {
      if (!baseURL) throw new Error("baseURL is not configured");
      const w = await world();
      await signInWithSessionCookie(page.context(), baseURL, w.member);
      const url = `/api/capabilities?workspace_id=${w.workspaceId}`;

      const responses = await Promise.all(Array.from({ length: 6 }, () => page.request.get(url)));
      const bodies = await Promise.all(responses.map((r) => r.text()));
      expect(responses.map((r) => r.status())).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(bodies).size, "concurrent reads agree").toBe(1);

      const parsed = JSON.parse(bodies[0] ?? "{}") as {
        capabilities: { key: string; tier: number; scope: string; defaultMode: string }[];
      };
      expect(
        Object.fromEntries(
          parsed.capabilities.map((c) => [c.key, [c.tier, c.scope, c.defaultMode]]),
        ),
      ).toEqual(STARTERS);

      // Evidence for the QA report: what a member's browser shows for this URL.
      await page.goto(url);
      await expect(page.locator("body")).toContainText("payments.execute");
      await page.screenshot({ path: testInfo.outputPath("ac3-member-catalog.png") });
    });
  });

  test("AC3 (negative): a repeated workspace_id is authorized and queried on the same value (the first)", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await world();
    await signInWithSessionCookie(page.context(), baseURL, w.member);

    // The member's own workspace first: allowed, and only that workspace's rows come back.
    const own = await page.request.get(
      `/api/capabilities?workspace_id=${w.workspaceId}&workspace_id=${w.otherWorkspaceId}`,
    );
    expect(own.status()).toBe(200);
    const body = (await own.json()) as { capabilities: { workspaceId: string }[] };
    expect(body.capabilities).toHaveLength(12);
    expect(new Set(body.capabilities.map((c) => c.workspaceId))).toEqual(new Set([w.workspaceId]));

    // The other workspace first: refused. Smuggling a second value cannot change which one is checked.
    const other = await page.request.get(
      `/api/capabilities?workspace_id=${w.otherWorkspaceId}&workspace_id=${w.workspaceId}`,
      { failOnStatusCode: false },
    );
    expect(other.status()).toBe(403);
  });

  test("AC3 (negative): a bearer token without a session, and then a removed member, get nothing", async ({
    page,
    baseURL,
    request,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await world();
    const url = `/api/capabilities?workspace_id=${w.workspaceId}`;

    // A valid Supabase access token in an Authorization header is not a session: the route reads the
    // session cookie only, so a token-bearing script (an agent) is treated as signed out.
    const bearer = await request.get(url, {
      failOnStatusCode: false,
      headers: { authorization: `Bearer ${w.owner.accessToken}` },
    });
    expect(bearer.status()).toBe(401);
    expect(await bearer.json()).toEqual({ error: "unauthenticated" });

    await signInWithSessionCookie(page.context(), baseURL, w.viewer);
    expect((await page.request.get(url)).status(), "positive control: the viewer can read").toBe(
      200,
    );

    await softRemove(w.workspaceId, w.viewer);
    const removed = await page.request.get(url, { failOnStatusCode: false });
    expect(removed.status()).toBe(403);
    expect(await removed.json()).toEqual({ error: "forbidden" });
  });

  test("AC3 (negative): error answers carry only an error code, never a stack trace or a path", async ({
    page,
    baseURL,
    request,
  }) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const w = await world();

    const signedOut = await request.get(`/api/capabilities?workspace_id=${w.workspaceId}`, {
      failOnStatusCode: false,
    });
    await signInWithSessionCookie(page.context(), baseURL, w.member);
    const get = (query: string) =>
      page.request.get(`/api/capabilities?${query}`, { failOnStatusCode: false });
    const answers = [
      signedOut,
      await get(`workspace_id=${w.otherWorkspaceId}`),
      await get("workspace_id=not-a-uuid"),
      await get(`workspace_id=${w.workspaceId}&unknown=1`),
    ];
    const post = await page.request.post(`/api/capabilities?workspace_id=${w.workspaceId}`, {
      failOnStatusCode: false,
      data: {},
    });
    expect([...answers, post].map((a) => a.status())).toEqual([401, 403, 400, 400, 405]);

    for (const answer of answers) {
      const text = await answer.text();
      expect(text).not.toMatch(
        /node_modules|\.tsx?:|\bat\s+\S+\s*\(|stack|supabase|postgres|PGRST/i,
      );
      expect(Object.keys(JSON.parse(text) as object)).toContain("error");
    }
  });
});
