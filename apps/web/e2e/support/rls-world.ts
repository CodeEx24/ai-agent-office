import { randomUUID } from "node:crypto";
import {
  addMember,
  asAnon,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  softRemove,
  type ApiResult,
  type TestUser,
} from "./stack-api";

// Fixtures for the AGO-107 row-level-security probes. Local stack only. Everything is created
// through the same paths a real deployment has: users sign up, onboard through the RPC, and the
// runtime-owned rows are written as service_role. Ground truth is always read back with
// service_role, never inferred from the status code of the attempt under test.

export type Row = Record<string, unknown>;

export const TABLES = [
  "workspaces",
  "members",
  "agents",
  "skills",
  "agent_skills",
  "agent_capabilities",
  "tasks",
  "runs",
  "run_events",
  "approvals",
  "claims",
  "budgets_usage",
  "notes_index",
] as const;
export type TableName = (typeof TABLES)[number];

/** Lowest role allowed to run each command (from the AGO-107 role matrix); null = nobody. */
export type MinRole = "viewer" | "member" | "owner" | null;
export const RANK = { viewer: 1, member: 2, owner: 3 } as const;

export const ROLE_MATRIX: Record<
  TableName,
  { select: MinRole; insert: MinRole; update: MinRole; delete: MinRole }
> = {
  workspaces: { select: "viewer", insert: null, update: "owner", delete: null },
  members: { select: "viewer", insert: null, update: null, delete: null },
  agents: { select: "viewer", insert: "owner", update: "member", delete: "owner" },
  skills: { select: "viewer", insert: "owner", update: "owner", delete: null },
  agent_skills: { select: "viewer", insert: "owner", update: null, delete: "owner" },
  agent_capabilities: { select: "viewer", insert: "owner", update: null, delete: "owner" },
  tasks: { select: "viewer", insert: "member", update: "member", delete: "member" },
  runs: { select: "viewer", insert: "member", update: null, delete: null },
  run_events: { select: "viewer", insert: null, update: null, delete: null },
  approvals: { select: "viewer", insert: null, update: "member", delete: null },
  claims: { select: "viewer", insert: null, update: null, delete: null },
  budgets_usage: { select: "viewer", insert: "owner", update: "owner", delete: null },
  notes_index: { select: "viewer", insert: "member", update: "member", delete: "member" },
};

/** Narrows `T | undefined`, failing the test setup loudly instead of with a later type error. */
export function must<T>(value: T | undefined, what = "the row or id under test"): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
export const hex64 = () => (randomUUID() + randomUUID()).replaceAll("-", "").slice(0, 64);
export const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
export const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

function randomDate(): string {
  const year = 2100 + Math.floor(Math.random() * 800);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
}

// ---- service_role ground truth ------------------------------------------------------------

export async function svcRows(table: string, query: string): Promise<Row[]> {
  const result = await asServiceRole<Row[]>(`/rest/v1/${table}?${query}`);
  if (result.status !== 200) {
    throw new Error(`svcRows ${table}?${query} -> ${String(result.status)}`);
  }
  return result.body;
}

export async function svcInsert(table: string, body: Row): Promise<Row> {
  const result = await asServiceRole<Row[]>(`/rest/v1/${table}`, {
    method: "POST",
    body,
    prefer: "return=representation",
  });
  const row = result.body[0];
  if (result.status !== 201 || !row) {
    throw new Error(
      `svcInsert ${table} -> ${String(result.status)} ${JSON.stringify(result.body)}`,
    );
  }
  return row;
}

export async function svcRow(table: string, id: string): Promise<Row | undefined> {
  return (await svcRows(table, `id=eq.${id}`))[0];
}

// ---- seeding -----------------------------------------------------------------------------

export async function seedAgent(workspaceId: string): Promise<Row> {
  return svcInsert("agents", { workspace_id: workspaceId, name: uniq("agent") });
}
export async function seedSkill(workspaceId: string): Promise<Row> {
  return svcInsert("skills", { workspace_id: workspaceId, name: uniq("skill"), body: "# qa" });
}
export async function seedTask(workspaceId: string, agentId?: string): Promise<Row> {
  return svcInsert("tasks", {
    workspace_id: workspaceId,
    title: uniq("task"),
    ...(agentId ? { agent_id: agentId } : {}),
  });
}
export async function seedRun(workspaceId: string): Promise<Row> {
  const agent = await seedAgent(workspaceId);
  const task = await seedTask(workspaceId, agent.id as string);
  return svcInsert("runs", { workspace_id: workspaceId, task_id: task.id, agent_id: agent.id });
}
export async function seedApproval(workspaceId: string, overrides: Row = {}): Promise<Row> {
  const run = await seedRun(workspaceId);
  return svcInsert("approvals", {
    workspace_id: workspaceId,
    run_id: run.id,
    agent_id: run.agent_id,
    action: uniq("deploy"),
    payload_hash: hex64(),
    expires_at: inAnHour(),
    ...overrides,
  });
}

export interface Tenant {
  id: string;
  ownerMemberId: string;
  /** A members row the matrix tests may poke at (in A: the removed member's row). */
  targetMemberId: string;
  /** One row id per table, seeded once, for read checks. */
  seeded: Record<TableName, string>;
}

/** A fresh row of `table` in tenant `t`, written as service_role. */
export async function seedRow(
  table: TableName,
  t: Pick<Tenant, "id" | "ownerMemberId" | "targetMemberId">,
): Promise<Row> {
  const ws = t.id;
  switch (table) {
    case "workspaces":
      return must((await svcRows("workspaces", `id=eq.${ws}`))[0], "workspace row");
    case "members":
      return must((await svcRows("members", `id=eq.${t.targetMemberId}`))[0], "target member row");
    case "agents":
      return seedAgent(ws);
    case "skills":
      return seedSkill(ws);
    case "agent_skills": {
      const agent = await seedAgent(ws);
      const skill = await seedSkill(ws);
      return svcInsert("agent_skills", {
        workspace_id: ws,
        agent_id: agent.id,
        skill_id: skill.id,
      });
    }
    case "agent_capabilities": {
      const agent = await seedAgent(ws);
      return svcInsert("agent_capabilities", {
        workspace_id: ws,
        agent_id: agent.id,
        capability: uniq("cap"),
        tier: 1,
        granted_by: t.ownerMemberId,
      });
    }
    case "tasks":
      return seedTask(ws);
    case "runs":
      return seedRun(ws);
    case "run_events": {
      const run = await seedRun(ws);
      return svcInsert("run_events", { workspace_id: ws, run_id: run.id, type: uniq("evt") });
    }
    case "approvals":
      return seedApproval(ws);
    case "claims": {
      const agent = await seedAgent(ws);
      const task = await seedTask(ws);
      return svcInsert("claims", { workspace_id: ws, task_id: task.id, agent_id: agent.id });
    }
    case "budgets_usage":
      return svcInsert("budgets_usage", {
        workspace_id: ws,
        period_start: randomDate(),
        period_end: "2999-12-31",
        token_budget: 10,
      });
    case "notes_index":
      return svcInsert("notes_index", { workspace_id: ws, path: `${uniq("note")}.md` });
  }
}

// ---- the world ---------------------------------------------------------------------------

export interface World {
  ownerA: TestUser;
  memberA: TestUser;
  viewerA: TestUser;
  removedA: TestUser;
  ownerB: TestUser;
  /** Signed in, but never onboarded: belongs to no workspace at all. */
  stranger: TestUser;
  a: Tenant;
  b: Tenant;
}

async function memberRowId(workspaceId: string, userId: string): Promise<string | undefined> {
  const rows = await svcRows(
    "members",
    `workspace_id=eq.${workspaceId}&user_id=eq.${userId}&select=id`,
  );
  return rows[0]?.id as string | undefined;
}

/** The member id of `user` in `tenant`, if any (a removed member keeps their row). */
export function memberIdOf(tenant: Tenant, user: TestUser) {
  return memberRowId(tenant.id, user.id);
}

async function seedTenant(
  workspaceId: string,
  ownerId: string,
  targetUserId: string,
): Promise<Tenant> {
  const ownerMemberId = must(await memberRowId(workspaceId, ownerId), "owner membership");
  const targetMemberId = must(await memberRowId(workspaceId, targetUserId), "target membership");
  const base = { id: workspaceId, ownerMemberId, targetMemberId };
  const seeded = {} as Record<TableName, string>;
  for (const table of TABLES) seeded[table] = (await seedRow(table, base)).id as string;
  // Read checks need a row that is visible: a soft-removed member's row is hidden from everyone.
  seeded.members = ownerMemberId;
  return { ...base, seeded };
}

let worldPromise: Promise<World> | undefined;

/** One world per worker: tenant A with every role plus a removed member, tenant B with its owner. */
export function getWorld(): Promise<World> {
  worldPromise ??= (async () => {
    const [ownerA, memberA, viewerA, removedA, ownerB, stranger] = await Promise.all([
      createUser("qa-owner-a"),
      createUser("qa-member-a"),
      createUser("qa-viewer-a"),
      createUser("qa-removed-a"),
      createUser("qa-owner-b"),
      createUser("qa-stranger"),
    ]);
    const workspaceA = await onboard(ownerA, "QA Tenant A");
    const workspaceB = await onboard(ownerB, "QA Tenant B");
    await addMember(workspaceA, memberA, "member");
    await addMember(workspaceA, viewerA, "viewer");
    await addMember(workspaceA, removedA, "member");
    await softRemove(workspaceA, removedA);
    const a = await seedTenant(workspaceA, ownerA.id, removedA.id);
    const b = await seedTenant(workspaceB, ownerB.id, ownerB.id);
    return { ownerA, memberA, viewerA, removedA, ownerB, stranger, a, b };
  })();
  return worldPromise;
}

// ---- actors ------------------------------------------------------------------------------

export interface Actor {
  label: string;
  user: TestUser | null;
  /** Tenant the actor's target rows live in. */
  target: "a" | "b";
  /** The actor's effective role rank in the target tenant (0 = none, removed or anon). */
  rank: number;
}

export function actors(world: World): Actor[] {
  return [
    { label: "owner of A on A", user: world.ownerA, target: "a", rank: RANK.owner },
    { label: "member of A on A", user: world.memberA, target: "a", rank: RANK.member },
    { label: "viewer of A on A", user: world.viewerA, target: "a", rank: RANK.viewer },
    { label: "removed member of A on A", user: world.removedA, target: "a", rank: 0 },
    { label: "owner of B on A (outsider)", user: world.ownerB, target: "a", rank: 0 },
    { label: "owner of A on B (outsider)", user: world.ownerA, target: "b", rank: 0 },
    { label: "anon on A", user: null, target: "a", rank: 0 },
    // Positive control: proves the request bodies are valid, so a denial is policy, not a typo.
    { label: "owner of B on B (control)", user: world.ownerB, target: "b", rank: RANK.owner },
  ];
}

export function send<T = unknown>(
  actor: { user: TestUser | null },
  path: string,
  init?: Parameters<typeof asUser>[2],
): Promise<ApiResult<T>> {
  return actor.user ? asUser<T>(actor.user, path, init) : asAnon<T>(path, init);
}

export function tenantOf(world: World, actor: Actor): Tenant {
  return actor.target === "a" ? world.a : world.b;
}

// ---- command plans -----------------------------------------------------------------------

export interface InsertPlan {
  body: Row;
  /** How many rows now exist for this attempt's marker (read as service_role). */
  count: () => Promise<number>;
}
export interface UpdatePlan {
  path: string;
  body: Row;
  /** True when the seeded row differs from its snapshot (read as service_role). */
  changed: () => Promise<boolean>;
}
export interface DeletePlan {
  path: string;
  exists: () => Promise<boolean>;
}

export async function insertPlan(table: TableName, t: Tenant, world: World): Promise<InsertPlan> {
  const ws = t.id;
  const marker = uniq("m");
  const countBy =
    (column: string, value: string, extra = "") =>
    async () =>
      (await svcRows(table, `${column}=eq.${encodeURIComponent(value)}${extra}&select=id`)).length;
  switch (table) {
    case "workspaces":
      return { body: { name: marker }, count: countBy("name", marker) };
    case "members": {
      const joiner = t.id === world.a.id ? world.ownerB : world.ownerA;
      return {
        body: { workspace_id: ws, user_id: joiner.id, role: "owner" },
        count: countBy("user_id", joiner.id, `&workspace_id=eq.${ws}`),
      };
    }
    case "agents":
    case "skills":
      return { body: { workspace_id: ws, name: marker }, count: countBy("name", marker) };
    case "agent_skills": {
      const agent = await seedAgent(ws);
      const skill = await seedSkill(ws);
      return {
        body: { workspace_id: ws, agent_id: agent.id, skill_id: skill.id },
        count: countBy("agent_id", agent.id as string),
      };
    }
    case "agent_capabilities": {
      const agent = await seedAgent(ws);
      return {
        body: {
          workspace_id: ws,
          agent_id: agent.id,
          capability: marker,
          tier: 1,
          granted_by: t.ownerMemberId,
        },
        count: countBy("capability", marker),
      };
    }
    case "tasks":
      return { body: { workspace_id: ws, title: marker }, count: countBy("title", marker) };
    case "runs": {
      const agent = await seedAgent(ws);
      const task = await seedTask(ws, agent.id as string);
      return {
        body: { workspace_id: ws, task_id: task.id, agent_id: agent.id },
        count: countBy("task_id", task.id as string),
      };
    }
    case "run_events": {
      const run = await seedRun(ws);
      return {
        body: { workspace_id: ws, run_id: run.id, type: marker },
        count: countBy("type", marker),
      };
    }
    case "approvals": {
      const run = await seedRun(ws);
      return {
        body: {
          workspace_id: ws,
          run_id: run.id,
          agent_id: run.agent_id,
          action: marker,
          payload_hash: hex64(),
          expires_at: inAnHour(),
        },
        count: countBy("action", marker),
      };
    }
    case "claims": {
      const run = await seedRun(ws);
      const task = await seedTask(ws);
      return {
        body: { workspace_id: ws, task_id: task.id, agent_id: run.agent_id },
        count: countBy("task_id", task.id as string),
      };
    }
    case "budgets_usage": {
      const start = randomDate();
      return {
        body: { workspace_id: ws, period_start: start, period_end: "2999-12-31", token_budget: 5 },
        count: countBy("period_start", start, `&workspace_id=eq.${ws}`),
      };
    }
    case "notes_index": {
      const path = `${marker}.md`;
      return { body: { workspace_id: ws, path }, count: countBy("path", path) };
    }
  }
}

/** A column each table's UPDATE grant allows (or, for no-update tables, the most tempting one). */
function updateBody(table: TableName, callerMemberId: string): Row {
  switch (table) {
    case "workspaces":
      return { name: uniq("renamed") };
    case "members":
      return { role: "owner" };
    case "agents":
    case "skills":
      return { description: uniq("d") };
    case "agent_skills":
      return { created_at: "2001-01-01T00:00:00Z" };
    case "agent_capabilities":
      return { tier: 4 };
    case "tasks":
      return { title: uniq("t") };
    case "runs":
      return { status: "succeeded" };
    case "run_events":
      return { payload: { forged: true } };
    case "approvals":
      return {
        status: "approved",
        decided_by: callerMemberId,
        decided_at: new Date().toISOString(),
      };
    case "claims":
      return { released_at: new Date().toISOString() };
    case "budgets_usage":
      return { token_budget: 123456 };
    case "notes_index":
      return { title: uniq("n") };
  }
}

export async function updatePlan(
  table: TableName,
  t: Tenant,
  callerMemberId: string,
): Promise<UpdatePlan> {
  const row = await seedRow(table, t);
  const id = row.id as string;
  const before = JSON.stringify(await svcRow(table, id));
  return {
    path: `/rest/v1/${table}?id=eq.${id}`,
    body: updateBody(table, callerMemberId),
    changed: async () => JSON.stringify(await svcRow(table, id)) !== before,
  };
}

export async function deletePlan(table: TableName, t: Tenant): Promise<DeletePlan> {
  const row = await seedRow(table, t);
  const id = row.id as string;
  return {
    path: `/rest/v1/${table}?id=eq.${id}`,
    exists: async () => (await svcRow(table, id)) !== undefined,
  };
}
