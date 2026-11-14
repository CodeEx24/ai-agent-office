// @vitest-environment node
// AGO-37 acceptance tests, LIVE: the real decide route (AGO-58), the real workspace-access gate and the real inbox
// loader against the local Supabase stack (row-level security on, signed in as real throw-away users). Only the
// Next.js request-scope module (`next/headers`) is replaced, by an in-memory cookie jar holding the session a
// browser would send.
//
// Covers: the pending list (age, agent, reason, steps, cost from stored events), "decisions update the run within
// 2 seconds" (decision to the next inbox read and the stored state, measured), and that a viewer sees the inbox but
// cannot decide.
//
// Gate: runs only with E2E_SUPABASE=1, so a plain `pnpm test` stays database-free. Run it inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-37 && pnpm exec supabase db reset
//   E2E_SUPABASE=1 pnpm --filter @ago/web exec vitest run src/features/approvals/inbox.integration.test.ts
//   node scripts/db-lock.mjs release AGO-37
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  addMember,
  asUser,
  createUser,
  onboard,
  type TestUser,
} from "../../../e2e/support/stack-api";
import {
  hex64,
  inAnHour,
  seedTask,
  svcInsert,
  svcRow,
  uniq,
  type Row,
} from "../../../e2e/support/rls-world";

vi.mock("server-only", () => ({}));

const request = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      getAll: () => [...request.jar].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => {
        if (value === "") request.jar.delete(name);
        else request.jar.set(name, value);
      },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

import { POST } from "../../app/api/approvals/[id]/decision/route";
import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { listPendingApprovals } from "./inbox-data";

const isLive = process.env.E2E_SUPABASE === "1";
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:44321";
/** The acceptance budget: a decision shows in the inbox and the run's state within this many milliseconds. */
const BUDGET_MS = 2_000;

function readAnonKey(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (fromEnv) return fromEnv;
  const raw = execSync("pnpm exec supabase status -o json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (JSON.parse(raw.slice(raw.indexOf("{"))) as { ANON_KEY: string }).ANON_KEY;
}

/** The cookies a signed-in browser would send for `user`, written by a real @supabase/ssr client. */
async function sessionJar(user: TestUser): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const client = createServerClient(API_URL, readAnonKey(), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const cookie of list) jar.set(cookie.name, cookie.value);
      },
    },
  });
  const { error } = await client.auth.setSession({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
  });
  if (error) throw new Error("could not build the test session");
  return jar;
}

function event(runId: string, workspaceId: string, type: string, payload: Row): Promise<Row> {
  return svcInsert("run_events", {
    workspace_id: workspaceId,
    run_id: runId,
    type,
    payload: { version: 1, ...payload },
  });
}

async function decide(
  jar: Map<string, string>,
  approvalId: string,
  workspaceId: string,
  decision: string,
): Promise<Response> {
  request.jar = jar;
  return POST(
    new NextRequest(`http://localhost/api/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, decision }),
    }),
    { params: Promise.resolve({ id: approvalId }) },
  );
}

interface World {
  workspaceId: string;
  owner: TestUser;
  memberJar: Map<string, string>;
  viewerJar: Map<string, string>;
}

/**
 * Hires an agent as the workspace owner through the Data API, the way the product does. (A service-role insert
 * into agents is refused by the database: run_limits_valid is executable by `authenticated` only.)
 */
async function hireAgent(owner: TestUser, workspaceId: string): Promise<Row> {
  const created = await asUser<Row[]>(owner, "/rest/v1/agents", {
    method: "POST",
    prefer: "return=representation",
    body: {
      workspace_id: workspaceId,
      name: uniq("agent"),
      role: "Role text",
      model: "claude-sonnet-4-5",
      prompt: "Do the work carefully.",
    },
  });
  const row = created.body[0];
  if (created.status !== 201 || !row) {
    throw new Error(`hiring an agent failed: ${String(created.status)}`);
  }
  return row;
}

async function seedPendingApproval(world: World): Promise<string> {
  const agent = await hireAgent(world.owner, world.workspaceId);
  const task = await seedTask(world.workspaceId, agent.id as string);
  const run = await svcInsert("runs", {
    workspace_id: world.workspaceId,
    task_id: task.id,
    agent_id: agent.id,
  });
  const hash = hex64();
  const approval = await svcInsert("approvals", {
    workspace_id: world.workspaceId,
    run_id: run.id,
    agent_id: agent.id,
    action: "email.send",
    payload_hash: hash,
    expires_at: inAnHour(),
  });
  const runId = run.id as string;
  const callId = uniq("call");
  await event(runId, world.workspaceId, "step.started", { step: 1 });
  await event(runId, world.workspaceId, "policy.decision", {
    call_id: callId,
    decision: "needs_approval",
    tier: 3,
    reason_code: "tier_3_needs_human",
  });
  await event(runId, world.workspaceId, "approval.requested", {
    approval_id: approval.id,
    call_id: callId,
    payload_hash: hash,
    tier: 3,
    expires_at: inAnHour(),
  });
  await event(runId, world.workspaceId, "budget.usage", {
    input_tokens: 1000,
    output_tokens: 200,
    cost_micros: 12_345,
  });
  return approval.id as string;
}

let world: World;
const ENV_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

beforeAll(async () => {
  if (!isLive) return;
  // The code under test reads the Supabase URL and anon key from the environment, as the running app does.
  // Assigned directly, not with vi.stubEnv: this config unstubs the environment after every test.
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = readAnonKey();
  const member = await createUser("inbox-member");
  const viewer = await createUser("inbox-viewer");
  const workspaceId = await onboard(member, uniq("inbox"));
  await addMember(workspaceId, viewer, "viewer");
  world = {
    workspaceId,
    owner: member,
    memberJar: await sessionJar(member),
    viewerJar: await sessionJar(viewer),
  };
}, 90_000);

describe.skipIf(!isLive)("approvals inbox, live (AGO-37)", () => {
  it("lists a pending approval with its agent, age, reason, steps and cost from stored events", async () => {
    const approvalId = await seedPendingApproval(world);
    request.jar = world.memberJar;
    const inbox = await listPendingApprovals(world.workspaceId);

    expect(inbox.canDecide).toBe(true);
    const card = inbox.cards.find((c) => c.id === approvalId);
    expect(card).toBeDefined();
    expect(card?.agentName).toMatch(/^agent-/);
    expect(card?.action).toBe("email.send");
    expect(card?.reason).toBe("tier_3_needs_human");
    expect(card?.tier).toBe(3);
    expect(card?.cost).toEqual({ inputTokens: 1000, outputTokens: 200, costMicros: 12_345 });
    expect(card?.recentSteps.map((s) => s.label)).toContain("Approval requested");
    expect(Date.parse(card?.createdAt ?? "")).toBeLessThanOrEqual(Date.now());
  });

  it("shows an approval decided through the route in the next read and in the stored state, within 2 seconds", async () => {
    const approvalId = await seedPendingApproval(world);

    const startedAt = performance.now();
    const response = await decide(world.memberJar, approvalId, world.workspaceId, "approved");
    request.jar = world.memberJar;
    const inbox = await listPendingApprovals(world.workspaceId);
    const row = await svcRow("approvals", approvalId);
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(inbox.cards.some((c) => c.id === approvalId)).toBe(false);
    expect(row?.status).toBe("approved");
    expect(typeof row?.decided_by).toBe("string");
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it("records a rejection as `denied`", async () => {
    const approvalId = await seedPendingApproval(world);
    const response = await decide(world.memberJar, approvalId, world.workspaceId, "denied");
    expect(response.status).toBe(200);
    expect((await svcRow("approvals", approvalId))?.status).toBe("denied");
  });

  it("lets a viewer read the inbox but not decide", async () => {
    const approvalId = await seedPendingApproval(world);
    request.jar = world.viewerJar;
    const inbox = await listPendingApprovals(world.workspaceId);
    expect(inbox.canDecide).toBe(false);
    expect(inbox.cards.some((c) => c.id === approvalId)).toBe(true);

    const response = await decide(world.viewerJar, approvalId, world.workspaceId, "approved");
    expect(response.status).toBe(403);
    expect((await svcRow("approvals", approvalId))?.status).toBe("pending");
  });

  it("does not show another workspace's approvals", async () => {
    const stranger = await createUser("inbox-stranger");
    const otherWorkspace = await onboard(stranger, uniq("other"));
    request.jar = await sessionJar(stranger);
    await expect(listPendingApprovals(world.workspaceId)).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
    const own = await listPendingApprovals(otherWorkspace);
    expect(own.cards).toEqual([]);
  });
});
