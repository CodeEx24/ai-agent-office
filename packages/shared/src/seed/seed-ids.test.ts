import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isAgentModelId } from "../agents/agent-limits.js";
import {
  SEED_AGENTS,
  SEED_COUNTS,
  SEED_OWNER_EMAIL,
  SEED_OWNER_MEMBER_ID,
  SEED_OWNER_USER_ID,
  SEED_SKILLS,
  SEED_TASKS,
  SEED_WORKSPACE_ID,
} from "./seed-ids.js";

const seedSql = readFileSync(
  fileURLToPath(new URL("../../../../supabase/seed.sql", import.meta.url)),
  "utf8",
);

describe("seed fixtures match supabase/seed.sql", () => {
  const ids = [
    SEED_WORKSPACE_ID,
    SEED_OWNER_USER_ID,
    SEED_OWNER_MEMBER_ID,
    ...SEED_AGENTS.map((a) => a.id),
    ...SEED_SKILLS.map((s) => s.id),
    ...SEED_TASKS.map((t) => t.id),
  ];

  it("every fixture id appears in the seed", () => {
    for (const id of ids) expect(seedSql).toContain(`'${id}'`);
  });

  it("every fixture name, title and the owner email appear in the seed", () => {
    for (const text of [
      SEED_OWNER_EMAIL,
      ...SEED_AGENTS.map((a) => a.name),
      ...SEED_SKILLS.map((s) => s.name),
      ...SEED_TASKS.map((t) => t.title),
    ]) {
      expect(seedSql).toContain(`'${text}'`);
    }
  });

  it("ids are unique and the counts match the AC (3 agents, 5 tasks, starter skills)", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(SEED_COUNTS).toMatchObject({ workspaces: 1, agents: 3, tasks: 5 });
    expect(SEED_COUNTS.skills).toBeGreaterThan(0);
  });

  it("is idempotent by construction: every insert has on conflict do nothing", () => {
    const inserts = seedSql.match(/^insert into /gm) ?? [];
    const guards = seedSql.match(/^on conflict do nothing;/gm) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(guards.length).toBe(inserts.length);
  });

  it("every seed agent has a model from the shared allowlist (AGO-94), or its runs fail", () => {
    const block =
      /insert into public\.agents \(([^)]*)\) values([\s\S]*?)on conflict do nothing;/.exec(
        seedSql,
      );
    expect(block?.[1]).toContain("model");
    const models = [...(block?.[2] ?? "").matchAll(/'(claude-[a-z0-9-]+)'/g)].map(
      (m) => m[1] ?? "",
    );
    expect(models).toHaveLength(SEED_AGENTS.length);
    for (const model of models) expect(isAgentModelId(model)).toBe(true);
  });

  it("never fakes history or approvals", () => {
    expect(seedSql).not.toMatch(/insert into public\.(run_events|runs|approvals|claims)\b/);
  });
});
