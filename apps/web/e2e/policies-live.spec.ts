import { randomUUID } from "node:crypto";
import { expect, isLiveStack, test } from "./fixtures";
import {
  anHourAgo,
  getWorld,
  memberIdOf,
  must,
  seedApproval,
  send,
  svcInsert,
  svcRow,
  svcRows,
  uniq,
  type Row,
  type Tenant,
  type World,
} from "./support/rls-world";
import { asServiceRole, asUser, createUser, onboard, type TestUser } from "./support/stack-api";

// AGO-96: department hooks and the layered policies table, probed through the real Data API
// (PostgREST) with real user JWTs, the way a browser client reaches it. Local stack only
// (E2E_SUPABASE=1). The ticket has no UI: its observable surface is the Data API.
//
// Ground truth is always read back with service_role. An RLS-filtered write answers 2xx with zero
// rows, so a status code alone proves nothing; every denial also has a positive control, so a typo in
// a request body cannot pass as "denied".
//
//   AC1  Columns and the policies table exist with an RLS policy
//   AC2  Existing flows work unchanged with department_id null
//   AC3  A migration test proves rollback (scripts/ago-96-rollback.test.mjs, supabase/tests/*_qa.test.sql)
test.describe("AGO-96: department hooks and policies (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  const HOOK_TABLES = ["agents", "tasks", "approvals", "notes_index"] as const;
  const RULE = { version: 1, rules: [{ action: "tool.shell", effect: "require_approval" }] };
  const RULE_V2 = { version: 1, rules: [{ action: "tool.shell", effect: "deny" }] };
  const POSTGRES_CHECK_VIOLATION = "23514";
  const POSTGRES_UNIQUE_VIOLATION = "23505";
  const POSTGRES_INSUFFICIENT_PRIVILEGE = "42501";

  interface ErrorBody {
    code?: string;
  }

  const policiesOf = (workspaceId: string, query = "") =>
    svcRows("policies", `workspace_id=eq.${workspaceId}${query}`);

  /** An insert body for tenant `t`, written as its owner unless overridden. */
  function policyBody(t: Tenant, overrides: Row = {}): Row {
    return {
      workspace_id: t.id,
      level: "department",
      scope_id: randomUUID(),
      rule: RULE,
      created_by: t.ownerMemberId,
      updated_by: t.ownerMemberId,
      ...overrides,
    };
  }

  /** A policy written as service_role, to give the update and read tests something to act on. */
  const seedPolicy = (t: Tenant, overrides: Row = {}) =>
    svcInsert("policies", policyBody(t, overrides));

  const create = (user: TestUser | null, body: Row) =>
    send<Row[] & ErrorBody>({ user }, "/rest/v1/policies", {
      method: "POST",
      body,
      prefer: "return=representation",
    });

  const patch = (user: TestUser | null, id: string, body: Row) =>
    send<Row[] & ErrorBody>({ user }, `/rest/v1/policies?id=eq.${id}`, {
      method: "PATCH",
      body,
      prefer: "return=representation",
    });

  async function memberIds(world: World) {
    return {
      owner: world.a.ownerMemberId,
      member: must(await memberIdOf(world.a, world.memberA), "member A membership"),
      viewer: must(await memberIdOf(world.a, world.viewerA), "viewer A membership"),
    };
  }

  // ---- AC1: the department_id hooks ----------------------------------------------------------

  for (const table of HOOK_TABLES) {
    test(`AC1: ${table} has a department_id column, null on existing rows, readable by members only`, async () => {
      const world = await getWorld();
      const id = world.a.seeded[table];

      const asOwner = await send<Row[]>(
        { user: world.ownerA },
        `/rest/v1/${table}?id=eq.${id}&select=id,department_id`,
      );
      expect(asOwner.status).toBe(200);
      expect(asOwner.body).toEqual([{ id, department_id: null }]);

      // Workspace isolation is unchanged: the same read from another workspace, a stranger or anon finds nothing.
      for (const [label, user] of [
        ["owner of B", world.ownerB],
        ["signed-in stranger", world.stranger],
      ] as const) {
        const result = await send<Row[]>(
          { user },
          `/rest/v1/${table}?id=eq.${id}&select=id,department_id`,
        );
        expect.soft(result.body, label).toEqual([]);
      }
      const anon = await send<ErrorBody>(
        { user: null },
        `/rest/v1/${table}?select=id,department_id`,
      );
      expect(anon.status).toBe(401);
    });

    test(`AC1 (negative): ${table}.department_id cannot be set through the API (insert and update)`, async () => {
      const world = await getWorld();
      const department = randomUUID();

      // Update as the role that may normally update this table (approvals: only a pending, unexpired one).
      const target =
        table === "approvals"
          ? ((await seedApproval(world.a.id)).id as string)
          : world.a.seeded[table];
      expect((await svcRow(table, target))?.department_id).toBeNull();
      const update = await send<ErrorBody>(
        { user: world.ownerA },
        `/rest/v1/${table}?id=eq.${target}`,
        {
          method: "PATCH",
          body: { department_id: department },
        },
      );
      expect(update.status, "update with department_id").toBe(403);
      expect(update.body.code).toBe(POSTGRES_INSUFFICIENT_PRIVILEGE);
      expect(
        (await svcRow(table, target))?.department_id,
        "still null after the attempt",
      ).toBeNull();

      if (table === "approvals") return; // humans never create approvals (AGO-107), so there is no insert path
      const insertBody: Row =
        table === "agents"
          ? { workspace_id: world.a.id, name: uniq("agent"), department_id: department }
          : table === "tasks"
            ? { workspace_id: world.a.id, title: uniq("task"), department_id: department }
            : { workspace_id: world.a.id, path: `${uniq("note")}.md`, department_id: department };
      const insert = await send<ErrorBody>({ user: world.ownerA }, `/rest/v1/${table}`, {
        method: "POST",
        body: insertBody,
      });
      expect(insert.status, "insert with department_id").toBe(403);
      expect(insert.body.code).toBe(POSTGRES_INSUFFICIENT_PRIVILEGE);
      const leaked = await svcRows(table, `department_id=eq.${department}&select=id`);
      expect(leaked, "no row was written").toEqual([]);
    });
  }

  test("AC1: service_role (the runtime / future human-only path) can still set and clear department_id", async () => {
    const world = await getWorld();
    const department = randomUUID();
    const agent = await svcInsert("agents", {
      workspace_id: world.a.id,
      name: uniq("agent"),
      department_id: department,
    });
    expect(agent.department_id).toBe(department);
    // and a member reads it back through RLS, so AGO-108 will have something to filter on
    const read = await send<Row[]>(
      { user: world.memberA },
      `/rest/v1/agents?id=eq.${String(agent.id)}&select=department_id`,
    );
    expect(read.body).toEqual([{ department_id: department }]);
    const cleared = await asServiceRole(`/rest/v1/agents?id=eq.${String(agent.id)}`, {
      method: "PATCH",
      body: { department_id: null },
    });
    expect(cleared.status).toBe(204);
  });

  // ---- AC1: policies - reads -----------------------------------------------------------------

  test("AC1: owner, member and viewer of A read A's policies; nobody else reads them", async () => {
    const world = await getWorld();
    const policy = await seedPolicy(world.a);
    const id = policy.id as string;

    for (const [label, user] of [
      ["owner", world.ownerA],
      ["member", world.memberA],
      ["viewer", world.viewerA],
    ] as const) {
      const result = await send<Row[]>({ user }, `/rest/v1/policies?id=eq.${id}`);
      expect.soft(result.status, label).toBe(200);
      expect
        .soft(
          result.body.map((r) => r.id),
          label,
        )
        .toEqual([id]);
    }
    for (const [label, user] of [
      ["owner of B", world.ownerB],
      ["removed member of A", world.removedA],
      ["signed-in stranger", world.stranger],
    ] as const) {
      const result = await send<Row[]>({ user }, `/rest/v1/policies?id=eq.${id}`);
      expect.soft(result.status, label).toBe(200);
      expect.soft(result.body, label).toEqual([]);
    }
    const anon = await send<ErrorBody>({ user: null }, "/rest/v1/policies?select=*");
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(POSTGRES_INSUFFICIENT_PRIVILEGE);
  });

  test("AC1 (negative): a list of policies never contains another workspace's rows, even with filters that try to reach them", async () => {
    const world = await getWorld();
    const inA = await seedPolicy(world.a);
    const inB = await seedPolicy(world.b);

    const listed = await send<Row[]>({ user: world.ownerA }, "/rest/v1/policies?select=*");
    expect(listed.body.map((r) => r.workspace_id).filter((w) => w !== world.a.id)).toEqual([]);
    expect(listed.body.map((r) => r.id)).toContain(inA.id);
    expect(listed.body.map((r) => r.id)).not.toContain(inB.id);

    for (const query of [
      `id=eq.${String(inB.id)}`,
      `workspace_id=eq.${world.b.id}`,
      `or=(workspace_id.eq.${world.b.id},id.eq.${String(inB.id)})`,
    ]) {
      const probe = await send<Row[]>({ user: world.ownerA }, `/rest/v1/policies?${query}`);
      expect.soft(probe.body, `?${query}`).toEqual([]);
    }
    // the reverse, as a positive control: B's owner does see B's row
    const own = await send<Row[]>(
      { user: world.ownerB },
      `/rest/v1/policies?id=eq.${String(inB.id)}`,
    );
    expect(own.body.map((r) => r.id)).toEqual([inB.id]);
  });

  // ---- AC1: policies - inserts ---------------------------------------------------------------

  test("AC1: an owner inserts a policy and the row carries version 1, no archive and their attribution", async () => {
    const world = await getWorld();
    const scope = randomUUID();
    const result = await create(world.ownerA, policyBody(world.a, { scope_id: scope }));
    expect(result.status).toBe(201);
    const row = must(result.body[0], "inserted policy");
    expect(row).toMatchObject({
      workspace_id: world.a.id,
      level: "department",
      scope_id: scope,
      version: 1,
      archived_at: null,
      created_by: world.a.ownerMemberId,
      updated_by: world.a.ownerMemberId,
      rule: RULE,
    });
  });

  test("AC1 (negative): member, viewer, removed member, outsider and anon cannot insert a policy", async () => {
    const world = await getWorld();
    const ids = await memberIds(world);
    const attempts: { label: string; user: TestUser | null; as: string }[] = [
      { label: "member of A", user: world.memberA, as: ids.member },
      { label: "viewer of A", user: world.viewerA, as: ids.viewer },
      { label: "removed member of A", user: world.removedA, as: world.a.targetMemberId },
      { label: "owner of B writing into A", user: world.ownerB, as: world.a.ownerMemberId },
      { label: "signed-in stranger", user: world.stranger, as: world.a.ownerMemberId },
      { label: "anon", user: null, as: world.a.ownerMemberId },
    ];
    for (const attempt of attempts) {
      const scope = randomUUID();
      const result = await create(
        attempt.user,
        policyBody(world.a, { scope_id: scope, created_by: attempt.as, updated_by: attempt.as }),
      );
      expect.soft(result.status, `${attempt.label}: status`).toBeGreaterThanOrEqual(400);
      expect
        .soft(
          await policiesOf(world.a.id, `&scope_id=eq.${scope}`),
          `${attempt.label}: row written`,
        )
        .toEqual([]);
    }
    // positive control: the same body, from the owner, works
    const control = await create(world.ownerA, policyBody(world.a));
    expect(control.status).toBe(201);
  });

  test("AC1 (negative): an owner of A cannot write a policy into workspace B, and B's owner cannot write into A", async () => {
    const world = await getWorld();
    const intoB = randomUUID();
    const intoA = randomUUID();
    const fromA = await create(world.ownerA, policyBody(world.b, { scope_id: intoB }));
    const fromB = await create(world.ownerB, policyBody(world.a, { scope_id: intoA }));
    expect(fromA.status).toBeGreaterThanOrEqual(400);
    expect(fromB.status).toBeGreaterThanOrEqual(400);
    expect(await policiesOf(world.b.id, `&scope_id=eq.${intoB}`)).toEqual([]);
    expect(await policiesOf(world.a.id, `&scope_id=eq.${intoA}`)).toEqual([]);
    // positive control: B's owner into B
    expect((await create(world.ownerB, policyBody(world.b))).status).toBe(201);
  });

  test("AC1 (negative): created_by and updated_by are pinned to the caller, nobody writes in someone else's name", async () => {
    const world = await getWorld();
    const ids = await memberIds(world);
    for (const [label, overrides] of [
      ["created_by is another member", { created_by: ids.member }],
      ["updated_by is another member", { updated_by: ids.viewer }],
      [
        "both are a member of another workspace",
        { created_by: world.b.ownerMemberId, updated_by: world.b.ownerMemberId },
      ],
    ] as const) {
      const scope = randomUUID();
      const result = await create(
        world.ownerA,
        policyBody(world.a, { scope_id: scope, ...overrides }),
      );
      expect.soft(result.status, label).toBeGreaterThanOrEqual(400);
      expect.soft(await policiesOf(world.a.id, `&scope_id=eq.${scope}`), label).toEqual([]);
    }
  });

  test("AC1 (negative): version, archived_at, timestamps and id are not insertable", async () => {
    const world = await getWorld();
    for (const column of ["version", "archived_at", "created_at", "updated_at", "id"]) {
      const scope = randomUUID();
      const value =
        column === "version" ? 7 : column === "id" ? randomUUID() : new Date().toISOString();
      const result = await create(
        world.ownerA,
        policyBody(world.a, { scope_id: scope, [column]: value }),
      );
      expect.soft(result.status, column).toBe(403);
      expect.soft(result.body.code, column).toBe(POSTGRES_INSUFFICIENT_PRIVILEGE);
      expect.soft(await policiesOf(world.a.id, `&scope_id=eq.${scope}`), column).toEqual([]);
    }
  });

  test("AC1: the scope id must match the level (check constraint)", async () => {
    const world = await getWorld();
    // baseline must have no scope; the other three levels must have one
    const baselineWithScope = await create(
      world.ownerA,
      policyBody(world.a, { level: "baseline", scope_id: randomUUID() }),
    );
    expect(baselineWithScope.status).toBe(400);
    expect(baselineWithScope.body.code).toBe(POSTGRES_CHECK_VIOLATION);

    for (const level of ["department", "team", "agent"]) {
      const withoutScope = await create(
        world.ownerA,
        policyBody(world.a, { level, scope_id: null }),
      );
      expect.soft(withoutScope.status, `${level} without scope`).toBe(400);
      expect.soft(withoutScope.body.code, `${level} without scope`).toBe(POSTGRES_CHECK_VIOLATION);
      const withScope = await create(
        world.ownerA,
        policyBody(world.a, { level, scope_id: randomUUID() }),
      );
      expect.soft(withScope.status, `${level} with scope`).toBe(201);
    }
    expect(await policiesOf(world.a.id, "&level=eq.baseline&scope_id=not.is.null")).toEqual([]);
  });

  test("AC1 (negative): an unknown level or a rule that is not a JSON object is rejected", async () => {
    const world = await getWorld();
    const badLevel = await create(world.ownerA, policyBody(world.a, { level: "galaxy" }));
    expect(badLevel.status).toBe(400);
    expect(badLevel.body.code).toBe(POSTGRES_CHECK_VIOLATION);
    for (const [label, rule] of [
      ["an array", []],
      ["a string", "allow everything"],
      ["a number", 7],
      ["null", null],
    ] as const) {
      const scope = randomUUID();
      const result = await create(world.ownerA, policyBody(world.a, { scope_id: scope, rule }));
      expect.soft(result.status, label).toBe(400);
      expect.soft(await policiesOf(world.a.id, `&scope_id=eq.${scope}`), label).toEqual([]);
    }
  });

  test("AC1: one active policy per scope, one baseline per workspace; archiving frees the slot", async () => {
    const world = await getWorld();
    const scope = randomUUID();
    const first = await create(
      world.ownerA,
      policyBody(world.a, { level: "team", scope_id: scope }),
    );
    expect(first.status).toBe(201);

    // double submit: the same body again is a conflict, not a second row
    const second = await create(
      world.ownerA,
      policyBody(world.a, { level: "team", scope_id: scope }),
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe(POSTGRES_UNIQUE_VIOLATION);
    expect(await policiesOf(world.a.id, `&level=eq.team&scope_id=eq.${scope}`)).toHaveLength(1);

    // the same scope id at another level, or the same level in another workspace, is a different scope
    expect(
      (await create(world.ownerA, policyBody(world.a, { level: "agent", scope_id: scope }))).status,
    ).toBe(201);
    expect(
      (await create(world.ownerB, policyBody(world.b, { level: "team", scope_id: scope }))).status,
    ).toBe(201);

    // baseline (scope null): nulls not distinct, so a second active baseline conflicts
    const baseline = await create(
      world.ownerB,
      policyBody(world.b, { level: "baseline", scope_id: null }),
    );
    expect(baseline.status).toBe(201);
    const baselineAgain = await create(
      world.ownerB,
      policyBody(world.b, { level: "baseline", scope_id: null }),
    );
    expect(baselineAgain.status).toBe(409);
    expect(baselineAgain.body.code).toBe(POSTGRES_UNIQUE_VIOLATION);

    // archive the baseline: a replacement is then allowed, and the old row stays as history
    const archived = await patch(world.ownerB, must(baseline.body[0]?.id as string), {
      archived_at: new Date().toISOString(),
      updated_by: world.b.ownerMemberId,
    });
    expect(archived.status).toBe(200);
    expect(
      (await create(world.ownerB, policyBody(world.b, { level: "baseline", scope_id: null })))
        .status,
    ).toBe(201);
    expect(await policiesOf(world.b.id, "&level=eq.baseline")).toHaveLength(2);
  });

  // ---- AC1: policies - updates ---------------------------------------------------------------

  test("AC1: an owner changes the rule; version moves forward by one and a client-sent version is refused", async () => {
    const world = await getWorld();
    const policy = await seedPolicy(world.a);
    const id = policy.id as string;

    const changed = await patch(world.ownerA, id, {
      rule: RULE_V2,
      updated_by: world.a.ownerMemberId,
    });
    expect(changed.status).toBe(200);
    expect(changed.body[0]).toMatchObject({ rule: RULE_V2, version: 2 });

    // same rule again: no change, no bump
    const same = await patch(world.ownerA, id, {
      rule: RULE_V2,
      updated_by: world.a.ownerMemberId,
    });
    expect(same.body[0]?.version).toBe(2);

    const forged = await patch(world.ownerA, id, { version: 99 });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe(POSTGRES_INSUFFICIENT_PRIVILEGE);
    expect((await svcRow("policies", id))?.version).toBe(2);
  });

  test("AC1 (negative): member, viewer, removed member, outsider and anon cannot update a policy", async () => {
    const world = await getWorld();
    const ids = await memberIds(world);
    const policy = await seedPolicy(world.a);
    const id = policy.id as string;

    const attempts: { label: string; user: TestUser | null; as: string }[] = [
      { label: "member of A", user: world.memberA, as: ids.member },
      { label: "viewer of A", user: world.viewerA, as: ids.viewer },
      { label: "removed member of A", user: world.removedA, as: world.a.targetMemberId },
      { label: "owner of B", user: world.ownerB, as: world.b.ownerMemberId },
      { label: "signed-in stranger", user: world.stranger, as: world.a.ownerMemberId },
      { label: "anon", user: null, as: world.a.ownerMemberId },
    ];
    for (const attempt of attempts) {
      const result = await patch(attempt.user, id, { rule: RULE_V2, updated_by: attempt.as });
      expect.soft(result.status, `${attempt.label}: status`).toBeLessThan(500);
      const after = await svcRow("policies", id);
      expect.soft(after?.rule, `${attempt.label}: rule`).toEqual(RULE);
      expect.soft(after?.version, `${attempt.label}: version`).toBe(1);
      const archive = await patch(attempt.user, id, {
        archived_at: new Date().toISOString(),
        updated_by: attempt.as,
      });
      expect.soft(archive.status, `${attempt.label}: archive status`).toBeLessThan(500);
      expect
        .soft((await svcRow("policies", id))?.archived_at, `${attempt.label}: archived`)
        .toBeNull();
    }
    // positive control: the owner's identical request is applied
    const control = await patch(world.ownerA, id, {
      rule: RULE_V2,
      updated_by: world.a.ownerMemberId,
    });
    expect(control.body[0]?.version).toBe(2);
  });

  test("AC1 (negative): level, scope_id, workspace_id, created_by and created_at can never be changed through the API", async () => {
    const world = await getWorld();
    const policy = await seedPolicy(world.a, { level: "team" });
    const id = policy.id as string;
    const before = must(await svcRow("policies", id));

    for (const [column, value] of [
      ["level", "agent"],
      ["scope_id", randomUUID()],
      ["workspace_id", world.b.id],
      ["created_by", world.b.ownerMemberId],
      ["created_at", anHourAgo()],
      ["id", randomUUID()],
    ] as const) {
      const result = await patch(world.ownerA, id, { [column]: value });
      expect.soft(result.status, column).toBe(403);
      expect.soft(result.body.code, column).toBe(POSTGRES_INSUFFICIENT_PRIVILEGE);
    }
    const after = must(await svcRow("policies", id));
    expect(after).toEqual(before);
    // and the policy did not move into workspace B
    expect(await svcRows("policies", `id=eq.${id}&workspace_id=eq.${world.b.id}`)).toEqual([]);
  });

  test("AC1 (negative): updated_by must be the caller", async () => {
    const world = await getWorld();
    const ids = await memberIds(world);
    const policy = await seedPolicy(world.a);
    const id = policy.id as string;
    const forged = await patch(world.ownerA, id, { rule: RULE_V2, updated_by: ids.member });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect((await svcRow("policies", id))?.rule).toEqual(RULE);
    // positive control
    expect(
      (await patch(world.ownerA, id, { rule: RULE_V2, updated_by: world.a.ownerMemberId })).status,
    ).toBe(200);
  });

  test("AC1 (negative): nobody can delete a policy, not even the owner", async () => {
    const world = await getWorld();
    const policy = await seedPolicy(world.a);
    const id = policy.id as string;
    const users: [string, TestUser | null][] = [
      ["owner of A", world.ownerA],
      ["member of A", world.memberA],
      ["viewer of A", world.viewerA],
      ["owner of B", world.ownerB],
      ["anon", null],
    ];
    for (const [label, user] of users) {
      const result = await send<ErrorBody>({ user }, `/rest/v1/policies?id=eq.${id}`, {
        method: "DELETE",
      });
      expect.soft(result.status, label).toBeGreaterThanOrEqual(400);
      expect.soft(await svcRow("policies", id), `${label}: row still there`).toBeDefined();
    }
    // a filter-less delete is refused too (PostgREST needs a filter, and the grant is missing anyway)
    const bulk = await send<ErrorBody>({ user: world.ownerA }, "/rest/v1/policies", {
      method: "DELETE",
    });
    expect(bulk.status).toBeGreaterThanOrEqual(400);
    expect(await policiesOf(world.a.id)).not.toHaveLength(0);
  });

  test("AC1: an archived policy is frozen: its rule, its archive stamp and its attribution cannot change", async () => {
    const world = await getWorld();
    const policy = await seedPolicy(world.a);
    const id = policy.id as string;

    const archived = await patch(world.ownerA, id, {
      archived_at: new Date().toISOString(),
      updated_by: world.a.ownerMemberId,
    });
    expect(archived.status).toBe(200);
    const frozen = must(await svcRow("policies", id));
    expect(frozen.archived_at).not.toBeNull();

    for (const [label, body] of [
      ["edit the rule", { rule: RULE_V2, updated_by: world.a.ownerMemberId }],
      ["un-archive", { archived_at: null, updated_by: world.a.ownerMemberId }],
      [
        "re-stamp the archive",
        {
          archived_at: new Date(Date.now() + 86_400_000).toISOString(),
          updated_by: world.a.ownerMemberId,
        },
      ],
    ] as const) {
      const result = await patch(world.ownerA, id, body);
      // PostgREST answers an RLS-filtered update with 200 and an empty array: ground truth decides.
      expect.soft(result.status, label).toBeLessThan(500);
      expect.soft(result.body, `${label}: returned rows`).toEqual([]);
    }
    expect(await svcRow("policies", id)).toEqual(frozen);
    // an archived policy is still readable history
    const read = await send<Row[]>({ user: world.viewerA }, `/rest/v1/policies?id=eq.${id}`);
    expect(read.body).toHaveLength(1);
  });

  // ---- AC2: existing flows are unchanged with department_id null ------------------------------

  test("AC2: a member creates and edits an agent, a task and a note with no department, as before", async () => {
    const world = await getWorld();
    const agent = await send<Row[]>({ user: world.memberA }, "/rest/v1/agents", {
      method: "POST",
      body: { workspace_id: world.a.id, name: uniq("agent") },
      prefer: "return=representation",
    });
    expect(agent.status).toBe(201);
    expect(agent.body[0]?.department_id).toBeNull();

    const task = await send<Row[]>({ user: world.memberA }, "/rest/v1/tasks", {
      method: "POST",
      body: { workspace_id: world.a.id, title: uniq("task"), agent_id: agent.body[0]?.id },
      prefer: "return=representation",
    });
    expect(task.status).toBe(201);
    expect(task.body[0]?.department_id).toBeNull();
    const renamed = await send<Row[]>(
      { user: world.memberA },
      `/rest/v1/tasks?id=eq.${String(task.body[0]?.id)}`,
      {
        method: "PATCH",
        body: { title: "renamed" },
        prefer: "return=representation",
      },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body[0]).toMatchObject({ title: "renamed", department_id: null });

    const note = await send<Row[]>({ user: world.memberA }, "/rest/v1/notes_index", {
      method: "POST",
      body: { workspace_id: world.a.id, path: `${uniq("note")}.md` },
      prefer: "return=representation",
    });
    expect(note.status).toBe(201);
    expect(note.body[0]?.department_id).toBeNull();
  });

  test("AC2 (negative): a viewer still cannot write agents, tasks or notes, and a department-less row is still isolated", async () => {
    const world = await getWorld();
    for (const [table, body] of [
      ["agents", { workspace_id: world.a.id, name: uniq("agent") }],
      ["tasks", { workspace_id: world.a.id, title: uniq("task") }],
      ["notes_index", { workspace_id: world.a.id, path: `${uniq("note")}.md` }],
    ] as const) {
      const result = await send<ErrorBody>({ user: world.viewerA }, `/rest/v1/${table}`, {
        method: "POST",
        body,
      });
      expect.soft(result.status, table).toBe(403);
    }
    const crossRead = await send<Row[]>(
      { user: world.ownerB },
      `/rest/v1/agents?id=eq.${world.a.seeded.agents}`,
    );
    expect(crossRead.body).toEqual([]);
  });

  test("AC2: a member decides a pending approval, and an expired one is still denied (timeout means deny)", async () => {
    const world = await getWorld();
    const ids = await memberIds(world);

    const pending = await seedApproval(world.a.id);
    expect(pending.department_id).toBeNull();
    const decided = await send<Row[]>(
      { user: world.memberA },
      `/rest/v1/approvals?id=eq.${String(pending.id)}`,
      {
        method: "PATCH",
        body: { status: "approved", decided_by: ids.member, decided_at: new Date().toISOString() },
        prefer: "return=representation",
      },
    );
    expect(decided.status).toBe(200);
    expect(decided.body[0]).toMatchObject({ status: "approved", department_id: null });

    // An approval that has timed out can no longer be approved: the row is not even visible to the update.
    const expired = await seedApproval(world.a.id, { expires_at: anHourAgo() });
    const late = await send<Row[]>(
      { user: world.ownerA },
      `/rest/v1/approvals?id=eq.${String(expired.id)}`,
      {
        method: "PATCH",
        body: {
          status: "approved",
          decided_by: world.a.ownerMemberId,
          decided_at: new Date().toISOString(),
        },
        prefer: "return=representation",
      },
    );
    expect(late.body).toEqual([]);
    expect((await svcRow("approvals", expired.id as string))?.status).toBe("pending");

    // A viewer cannot decide at all.
    const another = await seedApproval(world.a.id);
    await send({ user: world.viewerA }, `/rest/v1/approvals?id=eq.${String(another.id)}`, {
      method: "PATCH",
      body: { status: "approved", decided_by: ids.viewer, decided_at: new Date().toISOString() },
    });
    expect((await svcRow("approvals", another.id as string))?.status).toBe("pending");
  });

  test("AC2: onboarding a new user still works and creates no policies and no department", async () => {
    const user = await createUser("qa-onboard-96");
    const workspaceId = await onboard(user, "AGO-96 Onboarding Co");
    // the workspace exists and its owner can read it; nothing in AGO-96 seeds a policy behind their back
    const workspace = await asUser<Row[]>(
      user,
      `/rest/v1/workspaces?id=eq.${workspaceId}&select=id,name`,
    );
    expect(workspace.body).toEqual([{ id: workspaceId, name: "AGO-96 Onboarding Co" }]);
    expect(await policiesOf(workspaceId)).toEqual([]);
    const agents = await asUser<Row[]>(user, "/rest/v1/agents?select=id,department_id");
    expect(agents.body.filter((a) => a.department_id !== null)).toEqual([]);
  });

  test("AC2: removing a workspace as service_role cascades its policies away", async () => {
    const owner = await createUser("qa-cascade-96");
    const workspaceId = await onboard(owner, "AGO-96 Cascade Co");
    const ownerMember = must(
      (await svcRows("members", `workspace_id=eq.${workspaceId}&select=id`))[0]?.id as string,
    );
    await svcInsert("policies", {
      workspace_id: workspaceId,
      level: "baseline",
      scope_id: null,
      rule: RULE,
      created_by: ownerMember,
      updated_by: ownerMember,
    });
    expect(await policiesOf(workspaceId)).toHaveLength(1);
    const removed = await asServiceRole(`/rest/v1/workspaces?id=eq.${workspaceId}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(await policiesOf(workspaceId)).toEqual([]);
  });
});
