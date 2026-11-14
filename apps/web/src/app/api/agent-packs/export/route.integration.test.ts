// @vitest-environment node
// AGO-192 acceptance tests, LIVE: the real POST /api/agent-packs/export handler, the real workspace-access gate,
// the real exportAgentPack loader and the real record_pack_export function, against the local Supabase stack
// (row-level security on, signed in as real throw-away users). Only the Next.js request-scope module
// (`next/headers`) is replaced, by an in-memory cookie jar that holds the session a real browser would send.
//
// Gate: runs only with E2E_SUPABASE=1 (the same flag the Playwright live specs use), so a plain `pnpm test`
// stays green and database-free. Run it inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-192 && pnpm exec supabase db reset
//   E2E_SUPABASE=1 pnpm --filter @ago/web exec vitest run src/app/api/agent-packs/export/route.integration.test.ts
//   node scripts/db-lock.mjs release AGO-192
//
// Every secret-looking value is assembled at runtime from pieces; nothing realistic is committed.
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { agentPackSchema, type AgentPack, type Database } from "@ago/shared";
import { verifyPackChecksum } from "@ago/shared/pack-export";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  addMember,
  asAnon,
  asServiceRole,
  asUser,
  createUser,
  onboard,
  type TestUser,
} from "../../../../../e2e/support/stack-api";
import { svcInsert, svcRows, type Row } from "../../../../../e2e/support/rls-world";
import {
  ExportAgentPackError,
  exportAgentPack,
} from "../../../../features/packs/export-agent-pack";
import { runPackExport } from "../../../../features/packs/cli/run-pack-export";

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
const REPO_ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:44321";
const ROUTE_URL = "http://localhost/api/agent-packs/export";
/** What a null daily budget exports as (AGENT_DAILY_BUDGET_DEFAULT_CENTS), written out so the test is independent. */
const DEFAULT_BUDGET_CENTS = 500;

// Fake credential-looking values, built here so no realistic secret is in the source.
const FAKE = {
  anthropic: ["sk", "ant", "x".repeat(8) + "Q".repeat(16)].join("-"),
  github: ["gh", "p_"].join("") + "a1".repeat(18),
  jwtLike: ["eyJ" + "a".repeat(12), "eyJ" + "b".repeat(8), "c".repeat(12)].join("."),
  urlPassword: ["postgres", "://user:", "pw".repeat(4), "@db.example.test"].join(""),
};
const FAKE_VALUES = Object.values(FAKE);
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

// ---- independent oracles (written here, not imported from the code under test) -----------------

function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function checksumOf(pack: AgentPack): string {
  const { checksum: _omitted, ...content } = pack;
  return sha256Hex(canon(content));
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") <= value);
}

function everyObjectHasSortedKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(everyObjectHasSortedKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return isSorted(Object.keys(record)) && Object.values(record).every(everyObjectHasSortedKeys);
  }
  return true;
}

// ---- sessions and calls -----------------------------------------------------------------------

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

async function callExport(
  jar: Jar,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  request.jar = jar;
  const response = await POST(
    new NextRequest(ROUTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function parsePack(text: string): AgentPack {
  return agentPackSchema.parse(JSON.parse(text));
}

async function events(workspaceId: string): Promise<Row[]> {
  return svcRows("pack_events", `workspace_id=eq.${workspaceId}&order=created_at`);
}

async function memberIdOf(workspaceId: string, user: TestUser): Promise<string> {
  const rows = await svcRows("members", `workspace_id=eq.${workspaceId}&user_id=eq.${user.id}`);
  return String(rows[0]?.id);
}

function userClient(user: TestUser) {
  return createClient<Database>(API_URL, readAnonKey(), {
    global: { headers: { Authorization: `Bearer ${user.accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

interface Password {
  user: TestUser;
  password: string;
}

/** A user with a known password (the CLI signs in with one); createUser keeps its password private. */
async function createUserWithPassword(label: string): Promise<Password> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${API_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: readAnonKey(), "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    user: { id: string };
  };
  if (response.status !== 200) throw new Error("sign-up failed");
  return {
    password,
    user: {
      id: body.user.id,
      email,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
    },
  };
}

// ---- the world --------------------------------------------------------------------------------

interface World {
  owner: TestUser;
  member: TestUser;
  viewer: TestUser;
  stranger: TestUser;
  ownerB: TestUser;
  wsA: string;
  wsB: string;
  writer: string;
  planner: string;
  bystander: string;
  archived: string;
  leakyPrompt: string;
  leakySkill: string;
  agentB: string;
  catalog: { key: string; scope: string }[];
  writerCaps: { key: string; scope: string }[];
}

let world: World;
const savedEnv: Record<string, string | undefined> = {};

/**
 * Hires an agent as the workspace owner, through the Data API, the way the product does. (A service-role insert
 * into agents is refused by the database: run_limits_valid is executable by `authenticated` only.) Columns the
 * owner may not set at insert time (thinking_effort, archived_at) are set in a second, owner-allowed update.
 */
async function agentRow(owner: TestUser, ws: string, values: Row): Promise<string> {
  const { thinking_effort, archived_at, ...insertable } = values;
  const created = await asUser<Row[]>(owner, "/rest/v1/agents", {
    method: "POST",
    prefer: "return=representation",
    body: {
      workspace_id: ws,
      role: "Role text",
      model: "claude-sonnet-4-5",
      prompt: "Do the work carefully.",
      ...insertable,
    },
  });
  const id = String(created.body[0]?.id);
  if (created.status !== 201) throw new Error(`hiring an agent failed: ${String(created.status)}`);
  if (thinking_effort !== undefined || archived_at !== undefined) {
    const patched = await asUser(owner, `/rest/v1/agents?id=eq.${id}`, {
      method: "PATCH",
      body: {
        ...(thinking_effort === undefined ? {} : { thinking_effort }),
        ...(archived_at === undefined ? {} : { archived_at }),
      },
    });
    if (patched.status >= 300)
      throw new Error(`updating an agent failed: ${String(patched.status)}`);
  }
  return id;
}

async function skillRow(ws: string, values: Row): Promise<string> {
  const row = await svcInsert("skills", { workspace_id: ws, ...values });
  return String(row.id);
}

async function link(ws: string, agent: string, skill: string): Promise<void> {
  await svcInsert("agent_skills", { workspace_id: ws, agent_id: agent, skill_id: skill });
}

beforeAll(async () => {
  if (!isLive) return;
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    savedEnv[name] = process.env[name];
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = readAnonKey();

  const [owner, member, viewer, stranger, ownerB] = await Promise.all([
    createUser("pk-owner"),
    createUser("pk-member"),
    createUser("pk-viewer"),
    createUser("pk-stranger"),
    createUser("pk-owner-b"),
  ]);
  const wsA = await onboard(owner, "Pack tests A");
  const wsB = await onboard(ownerB, "Pack tests B");
  await addMember(wsA, member, "member");
  await addMember(wsA, viewer, "viewer");

  const ownerMember = await memberIdOf(wsA, owner);
  const catalogRows = await svcRows("capabilities", `workspace_id=eq.${wsA}&order=key`);
  const catalog = catalogRows.map((row) => ({ key: String(row.key), scope: String(row.scope) }));
  if (catalog.length < 3) throw new Error("the capability catalog should be seeded on onboarding");
  const writerCaps = catalog.slice(0, 3);

  // Plant credential-looking text in columns the exporter must never read.
  const firstCapability = catalogRows[0];
  await fetchService("PATCH", `capabilities?id=eq.${String(firstCapability?.id)}`, {
    name: `Cap ${FAKE.github}`,
    description: FAKE.anthropic,
  });

  // Agents are inserted in reverse alphabetical order, links and grants too, so a pack that is sorted
  // is sorted by the exporter and not by the order the database happened to return rows in.
  const planner = await agentRow(owner, wsA, { name: "zed-planner", thinking_effort: "low" });
  const writer = await agentRow(owner, wsA, {
    name: "ada-writer",
    thinking_effort: "high",
    daily_budget_cents: 1200,
    description: FAKE.jwtLike,
  });
  const bystander = await agentRow(owner, wsA, { name: "mia-bystander" });
  const archived = await agentRow(owner, wsA, {
    name: "old-archived",
    archived_at: new Date().toISOString(),
  });
  const leakyPrompt = await agentRow(owner, wsA, {
    name: "leaky-prompt",
    prompt: `Use this key: ${FAKE.anthropic}`,
    archived_at: new Date().toISOString(),
  });
  const leakySkill = await agentRow(owner, wsA, {
    name: "leaky-skill",
    archived_at: new Date().toISOString(),
  });

  const research = await skillRow(wsA, {
    name: "s-research",
    body: "# Research\nRead sources.",
    version: 3,
    description: FAKE.urlPassword,
  });
  const edit = await skillRow(wsA, { name: "s-edit", body: "# Edit\nTighten prose." });
  const plan = await skillRow(wsA, { name: "s-plan", body: "# Plan\nBreak work down." });
  const bystanderOnly = await skillRow(wsA, { name: "s-bystander-only", body: "# Bystander" });
  await skillRow(wsA, { name: "s-unused", body: "# Nobody uses this" });
  const leakyBody = await skillRow(wsA, {
    name: "s-leaky",
    body: `Token: ${FAKE.github}`,
  });

  await link(wsA, writer, research);
  await link(wsA, writer, edit);
  await link(wsA, planner, plan);
  await link(wsA, planner, edit);
  await link(wsA, bystander, bystanderOnly);
  await link(wsA, archived, plan);
  await link(wsA, leakySkill, leakyBody);

  for (const cap of [...writerCaps].reverse()) {
    await svcInsert("agent_capabilities", {
      workspace_id: wsA,
      agent_id: writer,
      capability: cap.key,
      tier: 2,
      granted_by: ownerMember,
    });
  }

  const agentB = await agentRow(ownerB, wsB, { name: "other-tenant-agent" });

  world = {
    owner,
    member,
    viewer,
    stranger,
    ownerB,
    wsA,
    wsB,
    writer,
    planner,
    bystander,
    archived,
    leakyPrompt,
    leakySkill,
    agentB,
    catalog,
    writerCaps,
  };
}, 60_000);

/** A service-role write for test setup only (it bypasses RLS). */
async function fetchService(method: string, path: string, body: Row): Promise<void> {
  const result = await asServiceRole(`/rest/v1/${path}`, { method, body });
  if (result.status >= 300) throw new Error(`service ${method} ${path} failed`);
}

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

describe.skipIf(!isLive)("agent pack export (live: real route, real RLS, real database)", () => {
  describe("AC1: the pack includes the selected agents and only the skills they use", () => {
    it("exports only the selected agent and only the skills that agent uses", async () => {
      const before = (await events(world.wsA)).length;
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer],
      });
      expect(response.status).toBe(200);
      const pack = parsePack(response.text);
      expect(pack.agents.map((agent) => agent.name)).toEqual(["ada-writer"]);
      expect(pack.skills.map((skill) => skill.name)).toEqual(["s-edit", "s-research"]);
      expect(pack.agents[0]?.skills).toEqual(["s-edit", "s-research"]);
      expect((await events(world.wsA)).length).toBe(before + 1);
    });

    it("exports the skills of several selected agents once each and leaves out unused skills", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.planner, world.writer],
      });
      const pack = parsePack(response.text);
      expect(pack.agents.map((agent) => agent.name)).toEqual(["ada-writer", "zed-planner"]);
      expect(pack.skills.map((skill) => skill.name)).toEqual(["s-edit", "s-plan", "s-research"]);
      expect(pack.skills.map((skill) => skill.name)).not.toContain("s-unused");
      expect(pack.skills.map((skill) => skill.name)).not.toContain("s-bystander-only");
    });

    it("exports every active agent and skips archived ones when no agent is named", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
      });
      expect(response.status).toBe(200);
      const pack = parsePack(response.text);
      expect(pack.agents.map((agent) => agent.name)).toEqual([
        "ada-writer",
        "mia-bystander",
        "zed-planner",
      ]);
      expect(pack.skills.map((skill) => skill.name)).toEqual([
        "s-bystander-only",
        "s-edit",
        "s-plan",
        "s-research",
      ]);
    });

    it("exports an archived agent when it is named", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.archived],
      });
      expect(response.status).toBe(200);
      expect(parsePack(response.text).agents.map((agent) => agent.name)).toEqual(["old-archived"]);
    });

    it("counts a repeated agent id once", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer, world.writer],
      });
      expect(response.status).toBe(200);
      expect(parsePack(response.text).agents).toHaveLength(1);
    });

    it("maps the agent fields, with a null budget exported as the platform default", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer, world.planner],
        name: "Team pack",
      });
      const pack = parsePack(response.text);
      expect(pack.metadata.name).toBe("Team pack");
      const writer = pack.agents.find((agent) => agent.name === "ada-writer");
      const planner = pack.agents.find((agent) => agent.name === "zed-planner");
      expect(writer).toMatchObject({
        thinkingEffort: "high",
        dailyBudgetCents: 1200,
        autonomyMode: "strict",
        role: "Role text",
      });
      expect(planner).toMatchObject({
        thinkingEffort: "low",
        dailyBudgetCents: DEFAULT_BUDGET_CENTS,
      });
      expect(pack.skills.find((skill) => skill.name === "s-research")).toMatchObject({
        version: 3,
        body: "# Research\nRead sources.",
      });
    });

    it("answers 404 and writes no event when a named agent does not exist", async () => {
      const before = (await events(world.wsA)).length;
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer, randomUUID()],
      });
      expect(response.status).toBe(404);
      expect(response.text).not.toContain("ada-writer");
      expect((await events(world.wsA)).length).toBe(before);
    });

    it("answers 400 and writes no event for an empty agent list", async () => {
      const before = (await events(world.wsA)).length;
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [],
      });
      expect(response.status).toBe(400);
      expect((await events(world.wsA)).length).toBe(before);
    });
  });

  describe("AC2: deterministic output with a SHA-256 checksum of the content", () => {
    const FIXED = new Date(Date.now());

    async function exportAtFixedTime(jar: Jar, body: unknown) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED);
      try {
        return await callExport(jar, body);
      } finally {
        vi.useRealTimers();
      }
    }

    it("returns byte-identical files for the same agents at the same time", async () => {
      const jar = await sessionJar(world.owner);
      const body = { workspace_id: world.wsA, agent_ids: [world.planner, world.writer] };
      const first = await exportAtFixedTime(jar, body);
      const second = await exportAtFixedTime(jar, body);
      expect(first.status).toBe(200);
      expect(second.text).toBe(first.text);
      expect(parsePack(first.text).metadata.exportedAt).toBe(FIXED.toISOString());
    });

    it("returns the same file whichever order the agent ids are given in", async () => {
      const jar = await sessionJar(world.owner);
      const ascending = await exportAtFixedTime(jar, {
        workspace_id: world.wsA,
        agent_ids: [world.writer, world.planner],
      });
      const descending = await exportAtFixedTime(jar, {
        workspace_id: world.wsA,
        agent_ids: [world.planner, world.writer],
      });
      expect(descending.text).toBe(ascending.text);
    });

    it("returns identical files for two exports running at the same moment", async () => {
      const jar = await sessionJar(world.owner);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED);
      try {
        const [one, two] = await Promise.all([
          callExport(jar, { workspace_id: world.wsA }),
          callExport(jar, { workspace_id: world.wsA }),
        ]);
        expect(one.status).toBe(200);
        expect(two.text).toBe(one.text);
      } finally {
        vi.useRealTimers();
      }
    });

    it("writes sorted keys, sorted agents, skills and capabilities, and one trailing newline", async () => {
      // The grants and links were inserted in reverse order on purpose (see the setup).
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer, world.planner],
      });
      const parsed: unknown = JSON.parse(response.text);
      expect(everyObjectHasSortedKeys(parsed)).toBe(true);
      expect(response.text).toBe(`${canon(parsed)}\n`);
      const pack = parsePack(response.text);
      expect(isSorted(pack.agents.map((agent) => agent.name))).toBe(true);
      expect(isSorted(pack.skills.map((skill) => skill.name))).toBe(true);
      for (const agent of pack.agents) {
        expect(isSorted(agent.skills)).toBe(true);
        expect(isSorted(agent.capabilities.map((capability) => capability.name))).toBe(true);
      }
      const writer = pack.agents.find((agent) => agent.name === "ada-writer");
      expect(writer?.capabilities.map((capability) => capability.name)).toEqual(
        world.writerCaps.map((cap) => cap.key).sort(),
      );
    });

    it("carries a checksum equal to an independent SHA-256 of the canonical content", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
      });
      const pack = parsePack(response.text);
      expect(pack.checksum?.algorithm).toBe("sha256");
      expect(pack.checksum?.value).toMatch(/^[0-9a-f]{64}$/);
      expect(pack.checksum?.value).toBe(checksumOf(pack));
      expect(response.headers.get("x-pack-checksum")).toBe(pack.checksum?.value);
      expect(verifyPackChecksum(pack)).toBe("valid");
    });

    it("gives a different checksum when the content changes by one character", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer],
      });
      const pack = parsePack(response.text);
      const first = pack.agents[0];
      if (!first) throw new Error("the pack should hold the writer agent");
      const tampered: AgentPack = {
        ...pack,
        agents: [{ ...first, prompt: `${first.prompt}!` }],
      };
      expect(checksumOf(tampered)).not.toBe(pack.checksum?.value);
      expect(verifyPackChecksum(tampered)).toBe("mismatch");
    });

    it("gives a different checksum for a different agent selection", async () => {
      const jar = await sessionJar(world.owner);
      const one = parsePack(
        (await callExport(jar, { workspace_id: world.wsA, agent_ids: [world.writer] })).text,
      );
      const two = parsePack(
        (await callExport(jar, { workspace_id: world.wsA, agent_ids: [world.planner] })).text,
      );
      expect(two.checksum?.value).not.toBe(one.checksum?.value);
    });

    it("sends the pack as a private, uncached download with a name that holds no workspace or agent name", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer],
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment; filename="agent-pack-[0-9a-f]{12}\.json"$/,
      );
    });
  });

  describe("AC3: capabilities are names and scopes only; no credential appears anywhere", () => {
    it("exports each capability as exactly a name and the catalog scope", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer],
      });
      const writer = parsePack(response.text).agents[0];
      expect(writer?.capabilities).toHaveLength(world.writerCaps.length);
      for (const capability of writer?.capabilities ?? []) {
        expect(Object.keys(capability).sort()).toEqual(["name", "scope"]);
        const catalogRow = world.catalog.find((row) => row.key === capability.name);
        expect(capability.scope).toBe(catalogRow?.scope);
      }
    });

    it("holds no id, tier, grant, run history or credential field anywhere in the file", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
      });
      expect(response.text).not.toMatch(UUID_PATTERN);
      for (const forbidden of [
        '"tier"',
        '"granted_by"',
        '"workspace_id"',
        '"agent_id"',
        '"run_limits"',
        '"token_hash"',
        '"credential',
        '"identity',
        '"policies"',
        '"runs"',
        '"approvals"',
      ]) {
        expect(response.text).not.toContain(forbidden);
      }
      const capabilityKeys = new Set(
        parsePack(response.text).agents.flatMap((agent) =>
          agent.capabilities.flatMap((capability) => Object.keys(capability)),
        ),
      );
      expect([...capabilityKeys].sort()).toEqual(["name", "scope"]);
    });

    it("leaves out credential-looking text planted in columns the exporter does not read", async () => {
      // Planted in: agents.description, skills.description, the catalog name and description.
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer],
      });
      expect(response.status).toBe(200);
      for (const fake of FAKE_VALUES) expect(response.text).not.toContain(fake);
      expect(response.text).not.toContain("Cap ");
    });

    it("holds neither the caller's session tokens nor the anon key", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
      });
      for (const secret of [
        world.owner.accessToken,
        world.owner.refreshToken,
        readAnonKey(),
        world.owner.email,
      ]) {
        expect(response.text).not.toContain(secret);
      }
    });

    it("refuses with 422, echoes nothing and logs no event when a prompt holds a credential", async () => {
      const before = (await events(world.wsA)).length;
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.leakyPrompt],
      });
      expect(response.status).toBe(422);
      expect(JSON.parse(response.text)).toEqual({ error: "invalid_pack" });
      for (const fake of FAKE_VALUES) expect(response.text).not.toContain(fake);
      expect((await events(world.wsA)).length).toBe(before);
    });

    it("refuses with 422, echoes nothing and logs no event when a skill body holds a credential", async () => {
      const before = (await events(world.wsA)).length;
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.leakySkill],
      });
      expect(response.status).toBe(422);
      for (const fake of FAKE_VALUES) expect(response.text).not.toContain(fake);
      expect((await events(world.wsA)).length).toBe(before);
    });

    it("refuses the whole export, with no partial pack, when one selected agent is unsafe", async () => {
      const response = await callExport(await sessionJar(world.owner), {
        workspace_id: world.wsA,
        agent_ids: [world.writer, world.leakyPrompt],
      });
      expect(response.status).toBe(422);
      expect(response.text).not.toContain("ada-writer");
    });
  });

  describe("AC4: available through the API and logged with the exporter and agent list", () => {
    it("writes exactly one event holding the exporter, agents and checksum for one export", async () => {
      const before = await events(world.wsA);
      const response = await callExport(await sessionJar(world.member), {
        workspace_id: world.wsA,
        agent_ids: [world.planner, world.writer],
      });
      expect(response.status).toBe(200);
      const after = await events(world.wsA);
      expect(after).toHaveLength(before.length + 1);
      const event = after[after.length - 1];
      const pack = parsePack(response.text);

      expect(event?.kind).toBe("export");
      expect(event?.exported_by).toBe(await memberIdOf(world.wsA, world.member));
      expect(event?.agent_names).toEqual(["ada-writer", "zed-planner"]);
      expect([...(event?.agent_ids as string[])].sort()).toEqual(
        [world.planner, world.writer].sort(),
      );
      expect(event?.skill_count).toBe(pack.skills.length);
      expect(event?.checksum).toBe(pack.checksum?.value);
      expect(event?.workspace_id).toBe(world.wsA);
    });

    it("keeps pack content and secrets out of the event row", async () => {
      await callExport(await sessionJar(world.owner), { workspace_id: world.wsA });
      const rows = await events(world.wsA);
      const event = rows[rows.length - 1];
      expect(Object.keys(event ?? {}).sort()).toEqual([
        "agent_ids",
        "agent_names",
        "checksum",
        "created_at",
        "exported_by",
        "id",
        "kind",
        "skill_count",
        "workspace_id",
      ]);
      const serialized = JSON.stringify(rows);
      for (const text of ["Do the work carefully.", "Read sources.", "Role text", "# Edit"]) {
        expect(serialized).not.toContain(text);
      }
      for (const fake of FAKE_VALUES) expect(serialized).not.toContain(fake);
    });

    it("writes two events for two exports", async () => {
      const jar = await sessionJar(world.owner);
      const before = (await events(world.wsA)).length;
      await callExport(jar, { workspace_id: world.wsA, agent_ids: [world.writer] });
      await callExport(jar, { workspace_id: world.wsA, agent_ids: [world.writer] });
      expect((await events(world.wsA)).length).toBe(before + 2);
    });

    it("lets a workspace member read the events of their own workspace through RLS", async () => {
      const result = await asUser<Row[]>(
        world.member,
        "/rest/v1/pack_events?select=id,agent_names",
      );
      expect(result.status).toBe(200);
      expect(result.body.length).toBe((await events(world.wsA)).length);
    });

    it("hides the events of one workspace from the owner of another", async () => {
      const result = await asUser<Row[]>(
        world.ownerB,
        `/rest/v1/pack_events?workspace_id=eq.${world.wsA}&select=id`,
      );
      expect(result.status).toBe(200);
      expect(result.body).toEqual([]);
    });

    it("refuses to change or delete an event, or to write one, through the API", async () => {
      const [event] = await events(world.wsA);
      if (!event) throw new Error("an earlier test should have logged an event");
      const id = String(event.id);
      const patch = await asUser(world.owner, `/rest/v1/pack_events?id=eq.${id}`, {
        method: "PATCH",
        body: { skill_count: 999, agent_names: ["forged"] },
      });
      const remove = await asUser(world.owner, `/rest/v1/pack_events?id=eq.${id}`, {
        method: "DELETE",
      });
      const insert = await asUser(world.owner, "/rest/v1/pack_events", {
        method: "POST",
        body: {
          workspace_id: world.wsA,
          kind: "export",
          exported_by: event.exported_by,
          agent_ids: [world.writer],
          agent_names: ["forged"],
          skill_count: 0,
          checksum: "0".repeat(64),
        },
      });
      expect([patch.status, remove.status, insert.status]).toEqual([403, 403, 403]);
      expect((await svcRows("pack_events", `id=eq.${id}`))[0]).toEqual(event);
    });

    it("refuses the logging function to a signed-out caller", async () => {
      const result = await asAnon("/rest/v1/rpc/record_pack_export", {
        method: "POST",
        body: {
          p_workspace_id: world.wsA,
          p_agent_ids: [world.writer],
          p_skill_count: 0,
          p_checksum: "0".repeat(64),
        },
      });
      expect([401, 403]).toContain(result.status);
    });
  });

  describe("access: who may export, and from where", () => {
    async function refused(
      jar: Jar,
      body: unknown,
      status: number,
      headers: Record<string, string> = {},
    ) {
      const before = (await events(world.wsA)).length + (await events(world.wsB)).length;
      const response = await callExport(jar, body, headers);
      expect(response.status).toBe(status);
      expect(response.text).not.toContain("ada-writer");
      expect((await events(world.wsA)).length + (await events(world.wsB)).length).toBe(before);
      return response;
    }

    it("refuses an agent credential with 403 and no event, even beside a valid human session", async () => {
      const token = `ago_agt_${"A1b2C3d4".repeat(5)}`;
      const response = await refused(
        await sessionJar(world.owner),
        { workspace_id: world.wsA, agent_ids: [world.writer] },
        403,
        { authorization: `Bearer ${token}` },
      );
      expect(JSON.parse(response.text)).toEqual({ error: "agent_credential_not_allowed" });
      expect(response.text).not.toContain(token);
    });

    it("answers 401 and no event when nobody is signed in", async () => {
      await refused(new Map(), { workspace_id: world.wsA }, 401);
    });

    it("answers 403 and no event for a viewer of the workspace", async () => {
      await refused(await sessionJar(world.viewer), { workspace_id: world.wsA }, 403);
    });

    it("answers 403 and no event for a signed-in user with no workspace", async () => {
      await refused(await sessionJar(world.stranger), { workspace_id: world.wsA }, 403);
    });

    it("answers 403 and no event when a member of one workspace names another workspace", async () => {
      await refused(await sessionJar(world.owner), { workspace_id: world.wsB }, 403);
    });

    it("answers 404 and no event when the owner of one workspace names an agent of another", async () => {
      await refused(
        await sessionJar(world.owner),
        { workspace_id: world.wsA, agent_ids: [world.agentB] },
        404,
      );
    });

    it("answers 415 for a body that is not JSON", async () => {
      request.jar = await sessionJar(world.owner);
      const response = await POST(
        new NextRequest(ROUTE_URL, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "workspace_id",
        }),
      );
      expect(response.status).toBe(415);
    });

    it("lets the database refuse a viewer even when the loader is called directly", async () => {
      const before = (await events(world.wsA)).length;
      await expect(
        exportAgentPack(userClient(world.viewer), {
          workspaceId: world.wsA,
          agentIds: [world.writer],
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await events(world.wsA)).length).toBe(before);
    });

    it("lets row-level security hide another workspace's agent from the loader", async () => {
      const before = (await events(world.wsB)).length;
      const client = userClient(world.owner);
      await expect(
        exportAgentPack(client, { workspaceId: world.wsB, agentIds: [world.agentB] }),
      ).rejects.toBeInstanceOf(ExportAgentPackError);
      await expect(
        exportAgentPack(client, { workspaceId: world.wsB, agentIds: [world.agentB] }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(exportAgentPack(client, { workspaceId: world.wsB })).rejects.toMatchObject({
        code: "no_agents",
      });
      expect((await events(world.wsB)).length).toBe(before);
    });
  });

  describe("CLI: pnpm pack:export front end against the real stack", () => {
    interface CliRun {
      code: number;
      output: string;
      written: { path: string; data: string }[];
      secrets: string[];
    }

    async function runCli(args: string[], email: string, password: string): Promise<CliRun> {
      const out: string[] = [];
      const written: { path: string; data: string }[] = [];
      const secrets: string[] = [];
      const code = await runPackExport(args, {
        env: {
          NEXT_PUBLIC_SUPABASE_URL: API_URL,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: readAnonKey(),
          AGO_CLI_EMAIL: email,
          AGO_CLI_PASSWORD: password,
        },
        createClient: (url, key) => {
          const client = createClient<Database>(url, key, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          });
          client.auth.onAuthStateChange((_event, session) => {
            if (session) secrets.push(session.access_token, session.refresh_token);
          });
          return client;
        },
        writeFile: (path, data) => {
          written.push({ path, data });
          return Promise.resolve();
        },
        stdout: (line) => out.push(line),
        stderr: (line) => out.push(line),
      });
      return { code, output: out.join("\n"), written, secrets };
    }

    async function cliWorld() {
      const owner = await createUserWithPassword("pk-cli-owner");
      const ws = await onboard(owner.user, "Pack CLI tests");
      const agent = await agentRow(owner.user, ws, { name: "cli-agent" });
      const used = await skillRow(ws, { name: "cli-used", body: "# Used" });
      await skillRow(ws, { name: "cli-unused", body: "# Unused" });
      await link(ws, agent, used);
      return { owner, ws, agent };
    }

    it("writes the pack, logs one event and never prints the password or the session token", async () => {
      const { owner, ws, agent } = await cliWorld();
      const run = await runCli(
        ["--workspace", ws, "--agent", agent, "--out", "pack.json"],
        owner.user.email,
        owner.password,
      );
      expect(run.code).toBe(0);
      expect(run.written).toHaveLength(1);
      const pack = parsePack(run.written[0]?.data ?? "");
      expect(pack.agents.map((a) => a.name)).toEqual(["cli-agent"]);
      expect(pack.skills.map((s) => s.name)).toEqual(["cli-used"]);
      expect(run.output).toContain(`sha256:${pack.checksum?.value ?? "missing"}`);
      expect(run.secrets.length).toBeGreaterThan(0);
      for (const secret of [owner.password, ...run.secrets]) {
        expect(run.output).not.toContain(secret);
        expect(run.written[0]?.data).not.toContain(secret);
      }
      const rows = await events(ws);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.checksum).toBe(pack.checksum?.value);
      expect(rows[0]?.exported_by).toBe(await memberIdOf(ws, owner.user));
    });

    it("prints a fixed message, writes nothing and logs nothing for a wrong password", async () => {
      const { owner, ws, agent } = await cliWorld();
      const wrong = `Wrong-${randomUUID()}`;
      const run = await runCli(["--workspace", ws, "--agent", agent], owner.user.email, wrong);
      expect(run.code).toBe(1);
      expect(run.output).toBe("Sign-in failed. Check AGO_CLI_EMAIL and AGO_CLI_PASSWORD.");
      expect(run.output).not.toContain(wrong);
      expect(run.written).toEqual([]);
      expect(await events(ws)).toEqual([]);
    });

    it("refuses a viewer with the forbidden message, writes nothing and logs nothing", async () => {
      const { owner, ws } = await cliWorld();
      const viewer = await createUserWithPassword("pk-cli-viewer");
      await addMember(ws, viewer.user, "viewer");
      const run = await runCli(["--workspace", ws], viewer.user.email, viewer.password);
      expect(run.code).toBe(1);
      expect(run.output).toContain("may not export");
      expect(run.written).toEqual([]);
      expect(run.output).not.toContain(viewer.password);
      expect(run.output).not.toContain(owner.password);
      expect(await events(ws)).toEqual([]);
    });
  });
});
