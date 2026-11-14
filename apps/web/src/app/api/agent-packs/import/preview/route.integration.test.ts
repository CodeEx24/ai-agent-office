// @vitest-environment node
// AGO-193 acceptance tests, LIVE: the real POST /api/agent-packs/import/preview handler, the real
// workspace-access gate and the real previewAgentPackImport loader, against the local Supabase stack
// (row-level security on, signed in as real throw-away users). Only the Next.js request-scope module
// (`next/headers`) is replaced, by an in-memory cookie jar that holds the session a real browser would send.
//
// Gate: runs only with E2E_SUPABASE=1, so a plain `pnpm test` stays green and database-free. Run it inside
// the db lock:
//   node scripts/db-lock.mjs acquire AGO-193 && pnpm exec supabase db reset
//   E2E_SUPABASE=1 pnpm --filter @ago/web exec vitest run src/app/api/agent-packs/import/preview/route.integration.test.ts
//   node scripts/db-lock.mjs release AGO-193
//
// Every secret-looking value is assembled at runtime from pieces; nothing realistic is committed.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MAX_PACK_BYTES } from "@ago/shared/pack-import-preview";
import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  addMember,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  type TestUser,
} from "../../../../../../e2e/support/stack-api";
import { svcInsert, svcRows, type Row } from "../../../../../../e2e/support/rls-world";

vi.mock("server-only", () => ({}));

// The in-memory cookie jar behind `cookies()`; each test sets it to the caller it wants to act as.
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

import { POST } from "./route";

const isLive = process.env.E2E_SUPABASE === "1";
const REPO_ROOT = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:44321";
const ROUTE_URL = "http://localhost/api/agent-packs/import/preview";

/** Every table a preview could conceivably touch. Their row counts must be identical before and after. */
const WATCHED_TABLES = [
  "agents",
  "skills",
  "agent_skills",
  "agent_capabilities",
  "capabilities",
  "pack_events",
  "tasks",
  "runs",
  "run_events",
  "approvals",
  "members",
  "workspaces",
] as const;

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

type Jar = Map<string, string>;

/** The cookies a signed-in browser would send for `user`, written by a real @supabase/ssr client. */
async function sessionJar(user: TestUser): Promise<Jar> {
  const jar: Jar = new Map();
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

async function callPreview(
  jar: Jar,
  workspaceId: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; json: () => Record<string, unknown> }> {
  request.jar = jar;
  const response = await POST(
    new NextRequest(`${ROUTE_URL}?workspace_id=${workspaceId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

async function countsOf(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of WATCHED_TABLES) {
    counts[table] = (await svcRows(table, "select=id")).length;
  }
  return counts;
}

async function fetchService(method: string, path: string, body: Row): Promise<void> {
  const result = await asServiceRole(`/rest/v1/${path}`, { method, body });
  if (result.status >= 300) throw new Error(`service ${method} ${path} failed`);
}

/** Hires an agent as the workspace owner through the Data API, the way the product does. */
async function agentRow(owner: TestUser, ws: string, values: Row): Promise<void> {
  const created = await asUser<Row[]>(owner, "/rest/v1/agents", {
    method: "POST",
    prefer: "return=representation",
    body: {
      workspace_id: ws,
      role: "Role text",
      model: "claude-sonnet-4-5",
      prompt: "Do the work carefully.",
      ...values,
    },
  });
  if (created.status !== 201) throw new Error(`hiring an agent failed: ${String(created.status)}`);
}

interface World {
  owner: TestUser;
  member: TestUser;
  viewer: TestUser;
  stranger: TestUser;
  ownerB: TestUser;
  wsA: string;
  wsB: string;
  lowCap: { key: string; scope: string };
  highCap: { key: string; scope: string };
}

let world: World;
const savedEnv: Record<string, string | undefined> = {};

function packText(world_: World, overrides: Record<string, unknown> = {}): string {
  const agent = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    role: "Researcher",
    model: "claude-sonnet-5-5",
    thinkingEffort: "medium",
    prompt: "Find sources.",
    skills: ["Citing"],
    capabilities: [
      { name: world_.lowCap.key, scope: world_.lowCap.scope },
      { name: world_.highCap.key, scope: world_.highCap.scope },
      { name: "totally.unknown", scope: "workspace" },
    ],
    dailyBudgetCents: 500,
    autonomyMode: "strict",
    ...extra,
  });
  return JSON.stringify({
    packVersion: 1,
    metadata: { name: "Preview pack", exportedAt: "2026-11-13T00:00:00Z", appVersion: "0.1.0" },
    agents: [agent("Scout", { prompt: "A different prompt." }), agent("Brand-new")],
    skills: [{ name: "Citing", version: 1, body: "Cite your sources." }],
    ...overrides,
  });
}

beforeAll(async () => {
  if (!isLive) return;
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    savedEnv[name] = process.env[name];
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = readAnonKey();

  const [owner, member, viewer, stranger, ownerB] = await Promise.all([
    createUser("pv-owner"),
    createUser("pv-member"),
    createUser("pv-viewer"),
    createUser("pv-stranger"),
    createUser("pv-owner-b"),
  ]);
  const wsA = await onboard(owner, "Preview tests A");
  const wsB = await onboard(ownerB, "Preview tests B");
  await addMember(wsA, member, "member");
  await addMember(wsA, viewer, "viewer");

  const catalog = await svcRows("capabilities", `workspace_id=eq.${wsA}&order=key`);
  const low = catalog.find((row) => Number(row.tier) <= 1);
  const high = catalog.find((row) => Number(row.tier) >= 3);
  if (!low || !high) throw new Error("the capability catalog should be seeded on onboarding");

  // Workspace A already has "Scout" and "Citing"; workspace B has only look-alikes that must never leak.
  await agentRow(owner, wsA, { name: "Scout" });
  await svcInsert("skills", { workspace_id: wsA, name: "Citing", version: 1, body: "Old body." });
  await agentRow(ownerB, wsB, { name: "Brand-new" });
  await svcInsert("skills", { workspace_id: wsB, name: "Citing", version: 9, body: "B body." });
  await fetchService("PATCH", `capabilities?workspace_id=eq.${wsB}`, { description: "B only" });

  world = {
    owner,
    member,
    viewer,
    stranger,
    ownerB,
    wsA,
    wsB,
    lowCap: { key: String(low.key), scope: String(low.scope) },
    highCap: { key: String(high.key), scope: String(high.scope) },
  };
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

describe.skipIf(!isLive)(
  "agent pack import preview (live: real route, real RLS, real database)",
  () => {
    it("AC1: previews for the owner and writes nothing (row counts identical before and after)", async () => {
      const jar = await sessionJar(world.owner);
      const before = await countsOf();
      const response = await callPreview(jar, world.wsA, packText(world));
      const after = await countsOf();

      expect(response.status).toBe(200);
      expect(after).toEqual(before);
      const preview = response.json() as {
        agents: { name: string; action: string; conflict: boolean }[];
        skills: { name: string; action: string }[];
      };
      const scout = preview.agents.find((agent) => agent.name === "Scout");
      const fresh = preview.agents.find((agent) => agent.name === "Brand-new");
      expect(scout).toMatchObject({ action: "update", conflict: true });
      // Workspace B's "Brand-new" is invisible to workspace A's preview.
      expect(fresh).toMatchObject({ action: "create", conflict: false });
      expect(preview.skills.find((skill) => skill.name === "Citing")?.action).toBe("update");
    });

    it("AC1: running the preview twice gives the same answer and still writes nothing", async () => {
      const jar = await sessionJar(world.owner);
      const before = await countsOf();
      const first = await callPreview(jar, world.wsA, packText(world));
      const second = await callPreview(jar, world.wsA, packText(world));
      expect(second.text).toBe(first.text);
      expect(await countsOf()).toEqual(before);
    });

    it("AC2: shows each capability's tier, flags Tier 3+, and ignores it", async () => {
      const jar = await sessionJar(world.owner);
      const preview = (await callPreview(jar, world.wsA, packText(world))).json() as {
        agents: {
          name: string;
          capabilities: {
            name: string;
            tier: number | null;
            status: string;
            tier3plus?: boolean;
          }[];
        }[];
      };
      const capabilities =
        preview.agents.find((agent) => agent.name === "Brand-new")?.capabilities ?? [];
      expect(capabilities.find((c) => c.name === world.lowCap.key)).toMatchObject({
        status: "applied",
      });
      expect(capabilities.find((c) => c.name === world.highCap.key)).toMatchObject({
        status: "ignored",
        tier3plus: true,
      });
      expect(capabilities.find((c) => c.name === "totally.unknown")).toMatchObject({
        tier: null,
        status: "ignored",
      });
    });

    it("AC3: lists conflicts and what to set up afterwards, never a secret value", async () => {
      const jar = await sessionJar(world.owner);
      // A secret appears in a pack only as a `secret:<name>` reference, never as a value.
      const secretName = "search_api_key";
      const text = packText(world, {
        agents: [
          {
            name: "Needs-setup",
            role: "R",
            model: "claude-sonnet-5-5",
            thinkingEffort: "low",
            prompt: "p",
            skills: [],
            capabilities: [],
            dailyBudgetCents: 500,
            autonomyMode: "strict",
            secretRefs: [`secret:${secretName}`],
          },
        ],
        skills: [],
      });
      const response = await callPreview(jar, world.wsA, text);
      expect(response.status).toBe(200);
      expect(response.text).toContain(secretName);
      expect((response.json() as { references: unknown[] }).references.length).toBeGreaterThan(0);
    });

    it("AC4: rejects invalid JSON, a wrong shape, too many agents and an oversized body with clear messages", async () => {
      const jar = await sessionJar(world.owner);
      const before = await countsOf();

      const badJson = await callPreview(jar, world.wsA, "{ not json");
      expect(badJson.status).toBe(422);
      expect(badJson.json()).toMatchObject({ error: "invalid_json" });

      const wrongShape = await callPreview(jar, world.wsA, JSON.stringify({ packVersion: 1 }));
      expect(wrongShape.status).toBe(422);

      const manyAgents = await callPreview(
        jar,
        world.wsA,
        JSON.stringify({
          packVersion: 1,
          agents: Array.from({ length: 101 }, () => ({})),
          skills: [],
        }),
      );
      expect(manyAgents.status).toBe(422);
      expect(manyAgents.json()).toMatchObject({ error: "too_many_agents" });

      const huge = await callPreview(jar, world.wsA, "x".repeat(MAX_PACK_BYTES + 1));
      expect(huge.status).toBe(413);

      expect(await countsOf()).toEqual(before);
    });

    it("answers 403 to a member, a viewer, a stranger and the owner of another workspace", async () => {
      const before = await countsOf();
      for (const user of [world.member, world.viewer, world.stranger, world.ownerB]) {
        const response = await callPreview(await sessionJar(user), world.wsA, packText(world));
        expect(response.status).toBe(403);
        expect(response.text).not.toContain("Scout");
      }
      expect(await countsOf()).toEqual(before);
    });

    it("answers 401 to a signed-out caller", async () => {
      const response = await callPreview(new Map(), world.wsA, packText(world));
      expect(response.status).toBe(401);
    });

    it("does not leak workspace A's agents or skills into workspace B's preview", async () => {
      const response = await callPreview(
        await sessionJar(world.ownerB),
        world.wsB,
        packText(world),
      );
      expect(response.status).toBe(200);
      const preview = response.json() as {
        agents: { name: string; action: string; conflict: boolean }[];
        skills: { name: string; action: string }[];
      };
      // In B, "Scout" does not exist (create) and "Brand-new" does (conflict): A's rows are not consulted.
      expect(preview.agents.find((agent) => agent.name === "Scout")).toMatchObject({
        action: "create",
        conflict: false,
      });
      expect(preview.agents.find((agent) => agent.name === "Brand-new")?.conflict).toBe(true);
    });
  },
);
