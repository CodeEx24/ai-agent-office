import { randomUUID } from "node:crypto";
import { expect, isLiveStack, test } from "./fixtures";
import {
  RANK,
  ROLE_MATRIX,
  TABLES,
  actors,
  anHourAgo,
  deletePlan,
  getWorld,
  hex64,
  insertPlan,
  inAnHour,
  memberIdOf,
  must,
  seedAgent,
  seedApproval,
  seedRow,
  seedSkill,
  seedTask,
  send,
  svcRow,
  svcRows,
  tenantOf,
  uniq,
  updatePlan,
  type Row,
  type TableName,
  type World,
} from "./support/rls-world";
import { asAnon, asServiceRole, asUser, createUser, onboard } from "./support/stack-api";

// AGO-107: row-level security on every table, probed through the real Data API (PostgREST) with
// real user JWTs, the way a browser client reaches it. Needs the local stack (E2E_SUPABASE=1).
//
// Independent of the implementer's pgTAP matrix: the role matrix is transcribed from the ticket,
// each attempt is judged by what service_role finds in the table afterwards (an RLS-filtered write
// answers 2xx with zero rows, so a status code alone proves nothing), and every denial has a
// positive control so a typo in a request body cannot pass as "denied".
//
//   AC1  A queries any table: no B rows return
//   AC2  select, insert, update and delete are covered for every table
//   AC3  a table without a policy fails the run (catalog test: supabase/tests/rls_every_table_qa.test.sql)
test.describe("AGO-107: RLS on every table (local stack)", () => {
  test.skip(!isLiveStack, "needs the local Supabase stack (E2E_SUPABASE=1)");
  test.describe.configure({ mode: "default", timeout: 120_000 });

  const ownerColumn = (table: TableName) => (table === "workspaces" ? "id" : "workspace_id");
  const now = () => new Date().toISOString();

  // ---- AC1: reads ---------------------------------------------------------------------------

  for (const table of TABLES) {
    test(`AC1: ${table} - A reads A's rows and none of B's, B the reverse`, async () => {
      const world = await getWorld();
      const column = ownerColumn(table);
      const readers = [
        { label: "owner of A", user: world.ownerA, own: world.a, other: world.b },
        { label: "member of A", user: world.memberA, own: world.a, other: world.b },
        { label: "viewer of A", user: world.viewerA, own: world.a, other: world.b },
        { label: "owner of B", user: world.ownerB, own: world.b, other: world.a },
      ];

      for (const reader of readers) {
        const all = await send<Row[]>(reader, `/rest/v1/${table}?select=*`);
        expect.soft(all.status, `${reader.label} list`).toBe(200);
        const rows = all.body;
        expect
          .soft(
            rows.map((r) => r[column]).filter((id) => id !== reader.own.id),
            `${reader.label}: rows from any other workspace`,
          )
          .toEqual([]);
        expect
          .soft(
            rows.map((r) => r.id),
            `${reader.label}: sees own seeded row`,
          )
          .toContain(reader.own.seeded[table]);
        expect
          .soft(
            rows.map((r) => r.id),
            `${reader.label}: sees the other tenant's seeded row`,
          )
          .not.toContain(reader.other.seeded[table]);

        // Asking for the other tenant's row by id, by workspace and with an OR filter returns nothing.
        for (const query of [
          `id=eq.${reader.other.seeded[table]}`,
          `${column}=eq.${reader.other.id}`,
          `or=(${column}.eq.${reader.other.id},id.eq.${reader.other.seeded[table]})`,
        ]) {
          const probe = await send<Row[]>(reader, `/rest/v1/${table}?${query}`);
          expect.soft(probe.body, `${reader.label}: ?${query}`).toEqual([]);
        }
      }
    });

    test(`AC1 (negative): ${table} - a removed member, a signed-in stranger and anon read nothing`, async () => {
      const world = await getWorld();
      for (const [label, reader] of [
        ["removed member of A", { user: world.removedA }],
        ["signed-in user with no workspace", { user: world.stranger }],
      ] as const) {
        const result = await send<Row[]>(reader, `/rest/v1/${table}?select=*`);
        expect.soft(result.status, label).toBe(200);
        expect.soft(result.body, label).toEqual([]);
      }
      const anon = await send<{ code: string }>({ user: null }, `/rest/v1/${table}?select=*`);
      expect.soft(anon.status, "anon").toBe(401);
      expect.soft(anon.body.code, "anon").toBe("42501");
    });
  }

  test("AC1: a third workspace sees nothing of A or B on any table", async () => {
    const world = await getWorld();
    const loner = await createUser("qa-loner");
    const lonerWorkspace = await onboard(loner, "QA Loner Co");
    for (const table of TABLES) {
      const rows = (await send<Row[]>({ user: loner }, `/rest/v1/${table}?select=*`)).body;
      const foreign = rows.filter((row) => row[ownerColumn(table)] !== lonerWorkspace);
      expect.soft(foreign, `${table}: rows outside the loner's own workspace`).toEqual([]);
      expect
        .soft(
          rows.map((r) => r.id),
          `${table}: sees A's seeded row`,
        )
        .not.toContain(world.a.seeded[table]);
      expect
        .soft(
          rows.map((r) => r.id),
          `${table}: sees B's seeded row`,
        )
        .not.toContain(world.b.seeded[table]);
    }
  });

  // pg_graphql is not enabled on the local stack ("pg_graphql extension is not enabled"), so this
  // endpoint answers with an error and no data today. The test pins the property that matters
  // either way: if GraphQL is ever switched on, it must not return another workspace's rows.
  test("AC1 (negative): the GraphQL endpoint never returns another workspace's rows", async () => {
    const world = await getWorld();
    interface Gql {
      data?: { tasksCollection: { edges: { node: { workspace_id: string } }[] } } | null;
      errors?: unknown[];
    }
    const query = { query: "{ tasksCollection { edges { node { id workspace_id } } } }" };
    for (const [label, user, own] of [
      ["member of A", world.memberA, world.a.id],
      ["owner of B", world.ownerB, world.b.id],
    ] as const) {
      const result = await asUser<Gql>(user, "/graphql/v1", { method: "POST", body: query });
      const nodes = result.body.data?.tasksCollection.edges.map((e) => e.node) ?? [];
      expect
        .soft(
          nodes.filter((n) => n.workspace_id !== own),
          `${label}: foreign tasks via GraphQL`,
        )
        .toEqual([]);
    }
    const anon = await asAnon<Gql>("/graphql/v1", { method: "POST", body: query });
    expect
      .soft(anon.body.data?.tasksCollection.edges ?? [], "anon sees no tasks via GraphQL")
      .toEqual([]);
  });

  // ---- AC2: writes follow the role matrix -----------------------------------------------------

  // Tables that other tests lean on (workspaces, members) go last, so a bug that lets a write
  // through there cannot corrupt the fixtures of the rest of the run.
  const writeOrder: TableName[] = [
    ...TABLES.filter((table) => table !== "workspaces" && table !== "members"),
    "workspaces",
    "members",
  ];

  for (const table of writeOrder) {
    const rule = ROLE_MATRIX[table];

    test(`AC2: ${table} - INSERT is allowed from ${rule.insert ?? "nobody"} up, and only into the caller's own workspace`, async () => {
      const world = await getWorld();
      for (const actor of actors(world)) {
        const plan = await insertPlan(table, tenantOf(world, actor), world);
        const res = await send(actor, `/rest/v1/${table}`, {
          method: "POST",
          body: plan.body,
          prefer: "return=minimal",
        });
        const allowed = rule.insert !== null && actor.rank >= RANK[rule.insert];
        const detail = `${actor.label}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`;
        expect.soft(await plan.count(), detail).toBe(allowed ? 1 : 0);
        expect.soft(res.status, `${detail} (never a server error)`).toBeLessThan(500);
        if (!actor.user) expect.soft(res.status, detail).toBe(401);
      }
    });

    test(`AC2: ${table} - UPDATE is allowed from ${rule.update ?? "nobody"} up, and leaves other workspaces alone`, async () => {
      const world = await getWorld();
      for (const actor of actors(world)) {
        const tenant = tenantOf(world, actor);
        const callerMember = actor.user ? await memberIdOf(tenant, actor.user) : undefined;
        const plan = await updatePlan(table, tenant, callerMember ?? tenant.ownerMemberId);
        const res = await send(actor, plan.path, {
          method: "PATCH",
          body: plan.body,
          prefer: "return=representation",
        });
        const allowed = rule.update !== null && actor.rank >= RANK[rule.update];
        const detail = `${actor.label}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`;
        expect.soft(await plan.changed(), detail).toBe(allowed);
        expect.soft(res.status, `${detail} (never a server error)`).toBeLessThan(500);
        if (!actor.user) expect.soft(res.status, detail).toBe(401);
      }
    });

    test(`AC2: ${table} - DELETE is allowed from ${rule.delete ?? "nobody"} up, and leaves other workspaces alone`, async () => {
      const world = await getWorld();
      for (const actor of actors(world)) {
        const plan = await deletePlan(table, tenantOf(world, actor));
        const res = await send(actor, plan.path, {
          method: "DELETE",
          prefer: "return=representation",
        });
        const allowed = rule.delete !== null && actor.rank >= RANK[rule.delete];
        const detail = `${actor.label}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`;
        expect.soft(await plan.exists(), detail).toBe(!allowed);
        expect.soft(res.status, `${detail} (never a server error)`).toBeLessThan(500);
        if (!actor.user) expect.soft(res.status, detail).toBe(401);
      }
    });
  }

  // ---- AC2: a row cannot change workspace, and children cannot point across workspaces ----------

  test("AC2 (negative): no UPDATE can move a row to another workspace, or change its id", async () => {
    const world = await getWorld();
    const cases: [TableName, "ownerA" | "memberA"][] = [
      ["agents", "ownerA"],
      ["skills", "ownerA"],
      ["tasks", "memberA"],
      ["notes_index", "memberA"],
      ["budgets_usage", "ownerA"],
      ["approvals", "ownerA"],
      ["workspaces", "ownerA"],
    ];
    for (const [table, who] of cases) {
      const row = await seedRow(table, world.a);
      const id = row.id as string;
      const before = JSON.stringify(await svcRow(table, id));
      for (const body of [
        table === "workspaces" ? { id: randomUUID() } : { workspace_id: world.b.id },
        { id: randomUUID() },
      ]) {
        const res = await send({ user: world[who] }, `/rest/v1/${table}?id=eq.${id}`, {
          method: "PATCH",
          body,
          prefer: "return=representation",
        });
        expect
          .soft(res.status, `${table} ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`)
          .toBe(403);
      }
      expect.soft(JSON.stringify(await svcRow(table, id)), `${table} unchanged`).toBe(before);
    }
  });

  test("AC2 (negative): an INSERT cannot name an id of its own (no id squatting or overwrite)", async () => {
    const world = await getWorld();
    const chosen = randomUUID();
    const res = await send({ user: world.memberA }, "/rest/v1/tasks", {
      method: "POST",
      body: { id: chosen, workspace_id: world.a.id, title: uniq("squat") },
    });
    expect.soft(res.status).toBe(403);
    expect.soft(await svcRow("tasks", chosen)).toBeUndefined();
  });

  test("AC2 (negative): a child row cannot point at a parent in another workspace", async () => {
    const world = await getWorld();
    const aOwner = { user: world.ownerA };
    const bAgent = world.b.seeded.agents;
    const bSkill = world.b.seeded.skills;
    const bTask = world.b.seeded.tasks;
    const aAgent = (await seedAgent(world.a.id)).id as string;
    const aSkill = (await seedSkill(world.a.id)).id as string;
    const aTask = (await seedTask(world.a.id)).id as string;
    const a1 = (await seedAgent(world.a.id)).id as string;

    const attempts: { name: string; table: TableName; body: Row; column: string; value: string }[] =
      [];
    const add = (name: string, table: TableName, body: Row, column: string, value: string) =>
      attempts.push({ name, table, body, column, value });

    const t1 = uniq("xt");
    add(
      "task assigned to B's agent",
      "tasks",
      { workspace_id: world.a.id, title: t1, agent_id: bAgent },
      "title",
      t1,
    );
    const t2 = uniq("xt");
    add(
      "task attributed to B's member",
      "tasks",
      { workspace_id: world.a.id, title: t2, created_by: world.b.ownerMemberId },
      "title",
      t2,
    );
    add(
      "A's agent linked to B's skill",
      "agent_skills",
      { workspace_id: world.a.id, agent_id: a1, skill_id: bSkill },
      "agent_id",
      a1,
    );
    add(
      "B's agent linked to A's skill",
      "agent_skills",
      { workspace_id: world.a.id, agent_id: bAgent, skill_id: aSkill },
      "skill_id",
      aSkill,
    );
    const cap1 = uniq("xcap");
    add(
      "capability on B's agent",
      "agent_capabilities",
      {
        workspace_id: world.a.id,
        agent_id: bAgent,
        capability: cap1,
        tier: 1,
        granted_by: world.a.ownerMemberId,
      },
      "capability",
      cap1,
    );
    const cap2 = uniq("xcap");
    add(
      "capability granted_by B's owner",
      "agent_capabilities",
      {
        workspace_id: world.a.id,
        agent_id: aAgent,
        capability: cap2,
        tier: 1,
        granted_by: world.b.ownerMemberId,
      },
      "capability",
      cap2,
    );
    add(
      "run on B's task",
      "runs",
      { workspace_id: world.a.id, task_id: bTask, agent_id: aAgent },
      "task_id",
      bTask,
    );
    add(
      "run with B's agent",
      "runs",
      { workspace_id: world.a.id, task_id: aTask, agent_id: bAgent },
      "task_id",
      aTask,
    );
    add(
      "budget for B's agent",
      "budgets_usage",
      {
        workspace_id: world.a.id,
        agent_id: bAgent,
        period_start: "2400-01-01",
        period_end: "2400-02-01",
      },
      "agent_id",
      bAgent,
    );

    for (const attempt of attempts) {
      const count = async () =>
        (
          await svcRows(
            attempt.table,
            `${attempt.column}=eq.${attempt.value}&workspace_id=eq.${world.a.id}&select=id`,
          )
        ).length;
      const before = await count();
      const res = await send(aOwner, `/rest/v1/${attempt.table}`, {
        method: "POST",
        body: attempt.body,
        prefer: "return=minimal",
      });
      const detail = `${attempt.name}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`;
      expect.soft(res.status, detail).toBeGreaterThanOrEqual(400);
      expect.soft(await count(), detail).toBe(before);
    }

    // The same through UPDATE: re-assigning A's task to B's agent.
    const before = JSON.stringify(await svcRow("tasks", aTask));
    const reassign = await send(aOwner, `/rest/v1/tasks?id=eq.${aTask}`, {
      method: "PATCH",
      body: { agent_id: bAgent },
      prefer: "return=representation",
    });
    expect
      .soft(reassign.status, `reassign: ${JSON.stringify(reassign.body)}`)
      .toBeGreaterThanOrEqual(400);
    expect.soft(JSON.stringify(await svcRow("tasks", aTask))).toBe(before);
  });

  test("AC2 (negative): attribution columns are pinned to the caller (granted_by, created_by)", async () => {
    const world = await getWorld();
    const memberAId = must(await memberIdOf(world.a, world.memberA));
    const agent = (await seedAgent(world.a.id)).id as string;

    for (const [label, grantedBy] of [
      ["granted_by = another member", memberAId],
      ["granted_by omitted", undefined],
    ] as const) {
      const capability = uniq("cap");
      const res = await send({ user: world.ownerA }, "/rest/v1/agent_capabilities", {
        method: "POST",
        body: {
          workspace_id: world.a.id,
          agent_id: agent,
          capability,
          tier: 1,
          granted_by: grantedBy,
        },
      });
      const rows = await svcRows("agent_capabilities", `capability=eq.${capability}&select=id`);
      expect
        .soft(rows.length, `${label}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`)
        .toBe(0);
    }

    const forged = uniq("forged");
    const forgedRes = await send({ user: world.memberA }, "/rest/v1/tasks", {
      method: "POST",
      body: { workspace_id: world.a.id, title: forged, created_by: world.a.ownerMemberId },
    });
    const forgedRows = await svcRows("tasks", `title=eq.${forged}&select=id`);
    expect
      .soft(forgedRows.length, `created_by = the owner: HTTP ${String(forgedRes.status)}`)
      .toBe(0);

    for (const [label, createdBy] of [
      ["created_by = caller", memberAId],
      ["created_by omitted", undefined],
    ] as const) {
      const title = uniq("honest");
      const res = await send({ user: world.memberA }, "/rest/v1/tasks", {
        method: "POST",
        body: { workspace_id: world.a.id, title, created_by: createdBy },
      });
      const rows = await svcRows("tasks", `title=eq.${title}&select=id`);
      expect
        .soft(
          rows.length,
          `${label} (positive control): HTTP ${String(res.status)} ${JSON.stringify(res.body)}`,
        )
        .toBe(1);
    }
  });

  test("AC2 (negative): runtime-owned and security-relevant columns are not writable by a signed-in human", async () => {
    const world = await getWorld();
    const user = { user: world.ownerA }; // the most privileged human, so only the column grant can stop it
    const agent = (await seedAgent(world.a.id)).id as string;
    const skill = (await seedSkill(world.a.id)).id as string;
    const budget = (await seedRow("budgets_usage", world.a)).id as string;
    const run = await seedRow("runs", world.a);

    const attempts: {
      name: string;
      method: "POST" | "PATCH";
      table: string;
      body: Row;
      id?: string;
    }[] = [
      {
        name: "create an agent in a loosened mode",
        method: "POST",
        table: "agents",
        body: { workspace_id: world.a.id, name: uniq("loose"), mode: "autonomous" },
      },
      {
        name: "create an agent and set its status",
        method: "POST",
        table: "agents",
        body: { workspace_id: world.a.id, name: uniq("busy"), status: "running" },
      },
      {
        name: "loosen an agent's mode",
        method: "PATCH",
        table: "agents",
        body: { mode: "autonomous" },
        id: agent,
      },
      {
        name: "change an agent's status",
        method: "PATCH",
        table: "agents",
        body: { status: "running" },
        id: agent,
      },
      {
        name: "bump a skill's version",
        method: "PATCH",
        table: "skills",
        body: { version: 99 },
        id: skill,
      },
      {
        name: "rewrite the usage counters",
        method: "PATCH",
        table: "budgets_usage",
        body: { tokens_used: 0, cost_used_cents: 0 },
        id: budget,
      },
      {
        name: "queue a run that is already succeeded",
        method: "POST",
        table: "runs",
        body: {
          workspace_id: world.a.id,
          task_id: run.task_id,
          agent_id: run.agent_id,
          status: "succeeded",
        },
      },
      {
        name: "set a run's status",
        method: "PATCH",
        table: "runs",
        body: { status: "succeeded" },
        id: run.id as string,
      },
    ];

    for (const attempt of attempts) {
      const before = attempt.id
        ? JSON.stringify(await svcRow(attempt.table, attempt.id))
        : undefined;
      const count = async () => (await svcRows(attempt.table, "select=id")).length;
      const rowsBefore = await count();
      const path = `/rest/v1/${attempt.table}${attempt.id ? `?id=eq.${attempt.id}` : ""}`;
      const res = await send(user, path, {
        method: attempt.method,
        body: attempt.body,
        prefer: "return=representation",
      });
      const detail = `${attempt.name}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`;
      expect.soft(res.status, detail).toBe(403);
      if (attempt.id)
        expect.soft(JSON.stringify(await svcRow(attempt.table, attempt.id)), detail).toBe(before);
      else expect.soft(await count(), detail).toBe(rowsBefore);
    }
  });

  test("AC2 (negative): PostgREST upsert cannot reach a row an INSERT or UPDATE could not", async () => {
    const world = await getWorld();
    const bAgent = must(await svcRow("agents", world.b.seeded.agents));
    const aAgent = must(await svcRow("agents", world.a.seeded.agents));
    const upsert = { method: "POST", prefer: "resolution=merge-duplicates,return=representation" };

    // A's owner aims at B's agent by id, naming B's workspace and A's.
    for (const workspace of [world.a.id, world.b.id]) {
      await send({ user: world.ownerA }, "/rest/v1/agents?on_conflict=id", {
        ...upsert,
        body: { id: bAgent.id, workspace_id: workspace, name: "hijacked" },
      });
    }
    expect
      .soft(JSON.stringify(await svcRow("agents", bAgent.id as string)), "B's agent untouched")
      .toBe(JSON.stringify(bAgent));

    // A viewer upserting onto an existing agent of their own workspace changes nothing.
    await send({ user: world.viewerA }, "/rest/v1/agents?on_conflict=workspace_id,name", {
      ...upsert,
      body: { workspace_id: world.a.id, name: aAgent.name, description: "viewer was here" },
    });
    expect
      .soft(
        JSON.stringify(await svcRow("agents", aAgent.id as string)),
        "A's agent untouched by a viewer",
      )
      .toBe(JSON.stringify(aAgent));

    // agent_skills has INSERT but no UPDATE: a merge-duplicates upsert must not rewrite a link.
    const link = must(await svcRow("agent_skills", world.a.seeded.agent_skills));
    await send({ user: world.ownerA }, "/rest/v1/agent_skills?on_conflict=agent_id,skill_id", {
      ...upsert,
      body: { workspace_id: world.a.id, agent_id: link.agent_id, skill_id: link.skill_id },
    });
    expect
      .soft(JSON.stringify(await svcRow("agent_skills", link.id as string)), "link untouched")
      .toBe(JSON.stringify(link));
  });

  // ---- AC2: human in the loop - approvals ------------------------------------------------------

  test.describe("approvals", () => {
    const decide = (user: World["ownerA"], id: string, body: Row) =>
      send({ user }, `/rest/v1/approvals?id=eq.${id}`, {
        method: "PATCH",
        body,
        prefer: "return=representation",
      });

    test("AC2: a member decides a pending approval once, as themselves, and the payload hash stays bound", async () => {
      const world = await getWorld();
      const approval = await seedApproval(world.a.id);
      const id = approval.id as string;
      const memberId = must(await memberIdOf(world.a, world.memberA));

      const res = await decide(world.memberA, id, {
        status: "approved",
        decided_by: memberId,
        decided_at: now(),
      });
      expect.soft(res.status, JSON.stringify(res.body)).toBe(200);
      const decided = must(await svcRow("approvals", id));
      expect.soft(decided.status).toBe("approved");
      expect.soft(decided.decided_by).toBe(memberId);
      expect.soft(decided.payload_hash, "hash is untouched").toBe(approval.payload_hash);

      // The decision is final: neither the decider nor an owner can flip or repeat it.
      for (const [user, status] of [
        [world.memberA, "denied"],
        [world.ownerA, "denied"],
        [world.ownerA, "approved"],
      ] as const) {
        await decide(user, id, { status, decided_by: world.a.ownerMemberId, decided_at: now() });
      }
      const after = must(await svcRow("approvals", id));
      expect.soft(after.status, "an approved approval stays approved").toBe("approved");
      expect.soft(after.decided_by).toBe(memberId);
    });

    test("AC2 (negative): approving cannot be combined with changing the payload hash, expiry, action or links", async () => {
      const world = await getWorld();
      const tampering: Row[] = [
        { payload_hash: hex64() },
        { expires_at: "2999-01-01T00:00:00Z" },
        { consumed_at: now() },
        { consumed_at: null },
        { action: "rm -rf" },
        { agent_id: world.a.seeded.agents },
        { run_id: world.a.seeded.runs },
        { workspace_id: world.b.id },
        { id: randomUUID() },
      ];
      for (const extra of tampering) {
        const approval = await seedApproval(world.a.id);
        const id = approval.id as string;
        const before = JSON.stringify(await svcRow("approvals", id));
        const res = await decide(world.ownerA, id, {
          status: "approved",
          decided_by: world.a.ownerMemberId,
          decided_at: now(),
          ...extra,
        });
        const label = JSON.stringify(Object.keys(extra));
        expect.soft(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(403);
        expect
          .soft(JSON.stringify(await svcRow("approvals", id)), `${label} left the row unchanged`)
          .toBe(before);
      }
    });

    test("AC2 (negative): timeout means deny - an expired, consumed or already-decided approval cannot be approved", async () => {
      const world = await getWorld();
      const scenarios: [string, Row][] = [
        ["expired", { expires_at: anHourAgo() }],
        ["consumed", { consumed_at: now() }],
        ["denied already", { status: "denied" }],
        ["approved already", { status: "approved" }],
      ];
      for (const [label, overrides] of scenarios) {
        const approval = await seedApproval(world.a.id, overrides);
        const id = approval.id as string;
        const before = must(await svcRow("approvals", id));
        const res = await decide(world.ownerA, id, {
          status: "approved",
          decided_by: world.a.ownerMemberId,
          decided_at: now(),
        });
        expect
          .soft(await svcRow("approvals", id), `${label}: HTTP ${String(res.status)}`)
          .toEqual(before);
      }
    });

    test("AC2 (negative): only a real decision, by a real member, as themselves, is accepted", async () => {
      const world = await getWorld();
      const memberId = must(await memberIdOf(world.a, world.memberA));
      const bad: [string, Row][] = [
        [
          "decided_by another member",
          { status: "approved", decided_by: world.a.ownerMemberId, decided_at: now() },
        ],
        ["decided_by omitted", { status: "approved", decided_at: now() }],
        ["decided_by null", { status: "approved", decided_by: null, decided_at: now() }],
        ["decided_at null", { status: "approved", decided_by: memberId, decided_at: null }],
        [
          "decided_by a member of B",
          { status: "approved", decided_by: world.b.ownerMemberId, decided_at: now() },
        ],
        ["status 'consumed'", { status: "consumed", decided_by: memberId, decided_at: now() }],
        ["status 'expired'", { status: "expired", decided_by: memberId, decided_at: now() }],
        ["status 'APPROVED'", { status: "APPROVED", decided_by: memberId, decided_at: now() }],
        ["status back to pending", { status: "pending", decided_by: memberId, decided_at: now() }],
      ];
      for (const [label, body] of bad) {
        const approval = await seedApproval(world.a.id);
        const id = approval.id as string;
        const before = must(await svcRow("approvals", id));
        const res = await decide(world.memberA, id, body);
        expect
          .soft(
            await svcRow("approvals", id),
            `${label}: HTTP ${String(res.status)} ${JSON.stringify(res.body)}`,
          )
          .toEqual(before);
      }
    });

    test("AC2 (negative): a viewer, a removed member and another workspace's owner cannot decide", async () => {
      const world = await getWorld();
      for (const [label, user, tenant] of [
        ["viewer of A", world.viewerA, world.a],
        ["removed member of A", world.removedA, world.a],
        ["owner of B", world.ownerB, world.b],
      ] as const) {
        const approval = await seedApproval(world.a.id);
        const id = approval.id as string;
        const own = await memberIdOf(tenant, user);
        const res = await decide(user, id, {
          status: "approved",
          decided_by: own ?? world.a.ownerMemberId,
          decided_at: now(),
        });
        expect
          .soft((await svcRow("approvals", id))?.status, `${label}: HTTP ${String(res.status)}`)
          .toBe("pending");
      }
    });

    test("AC2 (negative): a human cannot create an approval, nor delete one", async () => {
      const world = await getWorld();
      const run = await seedRow("runs", world.a);
      const action = uniq("self-issued");
      const create = await send({ user: world.ownerA }, "/rest/v1/approvals", {
        method: "POST",
        body: {
          workspace_id: world.a.id,
          run_id: run.id,
          agent_id: run.agent_id,
          action,
          payload_hash: hex64(),
          expires_at: inAnHour(),
          status: "approved",
        },
      });
      expect.soft(create.status).toBe(403);
      expect.soft((await svcRows("approvals", `action=eq.${action}&select=id`)).length).toBe(0);

      const approval = await seedApproval(world.a.id);
      const id = approval.id as string;
      await send({ user: world.ownerA }, `/rest/v1/approvals?id=eq.${id}`, { method: "DELETE" });
      expect.soft(await svcRow("approvals", id)).toBeDefined();
    });
  });

  // ---- AC2: append-only audit log ----------------------------------------------------------

  test("AC2 (negative): run_events stays append-only through the API for every role, service_role included", async () => {
    const world = await getWorld();
    const event = await seedRow("run_events", world.a);
    const id = event.id as string;
    const before = JSON.stringify(await svcRow("run_events", id));

    for (const actor of actors(world)) {
      await send(actor, `/rest/v1/run_events?id=eq.${id}`, {
        method: "PATCH",
        body: { type: "forged" },
      });
      await send(actor, `/rest/v1/run_events?id=eq.${id}`, { method: "DELETE" });
      await send(actor, `/rest/v1/run_events?run_id=eq.${String(event.run_id)}`, {
        method: "DELETE",
      });
    }
    // The runtime role is the one that can write; it still may not rewrite history.
    const patch = await asServiceRole(`/rest/v1/run_events?id=eq.${id}`, {
      method: "PATCH",
      body: { type: "rewritten" },
    });
    const remove = await asServiceRole(`/rest/v1/run_events?id=eq.${id}`, { method: "DELETE" });
    expect.soft(patch.status, "service_role update is refused").toBeGreaterThanOrEqual(400);
    expect.soft(remove.status, "service_role delete is refused").toBeGreaterThanOrEqual(400);
    expect
      .soft(JSON.stringify(await svcRow("run_events", id)), "event is byte-for-byte unchanged")
      .toBe(before);
  });

  // ---- AC2: nobody changes their own role or reinstates themselves -------------------------

  test("AC2 (negative): nobody can change a role, leave a membership or reinstate themselves through the API", async () => {
    const world = await getWorld();
    const cases = [
      ["viewer promotes self", world.viewerA, { role: "owner" }],
      ["member promotes self", world.memberA, { role: "owner" }],
      ["owner demotes self", world.ownerA, { role: "viewer" }],
      ["removed member reinstates self", world.removedA, { removed_at: null }],
      ["member un-removes self and promotes", world.memberA, { removed_at: null, role: "owner" }],
    ] as const;
    for (const [label, user, body] of cases) {
      const id = must(await memberIdOf(world.a, user));
      const before = JSON.stringify(await svcRow("members", id));
      const res = await send({ user }, `/rest/v1/members?id=eq.${id}`, {
        method: "PATCH",
        body,
        prefer: "return=representation",
      });
      expect
        .soft(JSON.stringify(await svcRow("members", id)), `${label}: HTTP ${String(res.status)}`)
        .toBe(before);
    }
    for (const [label, user] of [
      ["viewer", world.viewerA],
      ["member", world.memberA],
    ] as const) {
      const id = must(await memberIdOf(world.a, user));
      await send({ user }, `/rest/v1/members?id=eq.${id}`, { method: "DELETE" });
      expect
        .soft(await svcRow("members", id), `${label} cannot delete their own membership`)
        .toBeDefined();
    }
    // A signed-in stranger cannot join A.
    const join = await send({ user: world.stranger }, "/rest/v1/members", {
      method: "POST",
      body: { workspace_id: world.a.id, user_id: world.stranger.id, role: "owner" },
    });
    expect.soft(join.status).toBe(403);
    expect
      .soft((await svcRows("members", `user_id=eq.${world.stranger.id}&select=id`)).length)
      .toBe(0);
  });

  // ---- AC1/AC2: the surface outside the tables -------------------------------------------

  test("AC1 (negative): private helpers and other schemas are not reachable through the Data API", async () => {
    const world = await getWorld();
    for (const fn of ["is_member", "current_member_id"]) {
      for (const [label, user] of [
        ["authenticated", world.ownerA],
        ["anon", null],
      ] as const) {
        const res = await send<{ code?: string }>({ user }, `/rest/v1/rpc/${fn}`, {
          method: "POST",
          body: { p_workspace_id: world.a.id, workspace_id: world.a.id, p_min_role: "viewer" },
        });
        expect.soft(res.status, `${label} rpc/${fn}`).toBeGreaterThanOrEqual(400);
        expect.soft(res.body.code, `${label} rpc/${fn}`).toBeDefined();
      }
    }
    // Accept-Profile picks the schema for reads, Content-Profile for writes.
    for (const [header, method] of [
      ["Accept-Profile", "GET"],
      ["Content-Profile", "POST"],
    ] as const) {
      for (const schema of ["private", "auth", "storage", "extensions"]) {
        const res = await send<{ code?: string }>(
          { user: world.ownerA },
          "/rest/v1/members?select=*",
          {
            method,
            body: method === "POST" ? {} : undefined,
            headers: { [header]: schema },
          },
        );
        expect.soft(res.status, `${header}: ${schema}`).toBe(406);
        expect.soft(res.body.code, `${header}: ${schema}`).toBe("PGRST106");
      }
    }
  });

  test("AC1: onboarding again returns the caller's own workspace and creates no second one", async () => {
    const world = await getWorld();
    const again = await asUser<string>(world.ownerA, "/rest/v1/rpc/onboard_current_user", {
      method: "POST",
      body: { p_workspace_name: "A second workspace" },
    });
    expect.soft(again.status).toBe(200);
    expect.soft(again.body).toBe(world.a.id);
    expect
      .soft((await svcRows("workspaces", "name=eq.A second workspace&select=id")).length)
      .toBe(0);
  });
});
