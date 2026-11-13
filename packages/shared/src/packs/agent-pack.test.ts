import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  AGENT_PACK_JSON_SCHEMA_PATH,
  PACK_VERSION,
  agentPackSchema,
  buildAgentPackJsonSchema,
  findSecretShape,
  migrateAgentPack,
  parseAgentPack,
  renderAgentPackJsonSchema,
  type PackMigration,
} from "./index.js";

// Pack-level ratio tests parse many notes several times, so give every test here room on a slow runner.
vi.setConfig({ testTimeout: 30_000 });

type Loose = Record<string, unknown>;

function validPack(): Loose {
  return {
    packVersion: 1,
    metadata: { name: "Research team", exportedAt: "2026-11-13T00:00:00Z", appVersion: "0.1.0" },
    agents: [
      {
        name: "Scout",
        role: "Researcher",
        model: "claude-sonnet-5-5",
        thinkingEffort: "medium",
        prompt: "Find sources and summarise them.",
        skills: ["Citing sources"],
        capabilities: [{ name: "vault.read", scope: "workspace" }],
        dailyBudgetCents: 500,
        autonomyMode: "strict",
        department: "Research",
        secretRefs: ["secret:crm_api_key"],
      },
    ],
    skills: [{ name: "Citing sources", version: 3, body: "# Citing\n\nAlways link the source." }],
    notes: [{ title: "Hand-off", body: "Review weekly." }],
  };
}

function agentOf(pack: Loose): Loose {
  return (pack.agents as Loose[])[0]!;
}

/** Best of seven runs in ms, after one warm-up run. Timing tests compare two input sizes, never an absolute time. */
function bestOfSevenMs(run: () => unknown): number {
  run();
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** A linear scan grows about 4x for 4x the input, a quadratic one about 16x. */
const MAX_GROWTH_FOR_4X_INPUT = 11;
const TIMER_FLOOR_MS = 2;

function issuePaths(input: unknown): string[] {
  const result = parseAgentPack(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe("agent pack schema", () => {
  it("accepts a valid pack and a minimal one", () => {
    expect(parseAgentPack(validPack()).ok).toBe(true);
    const minimal = {
      packVersion: 1,
      metadata: { name: "Empty", exportedAt: "2026-11-13T00:00:00+08:00", appVersion: "0.1.0" },
      agents: [],
      skills: [],
    };
    expect(parseAgentPack(minimal).ok).toBe(true);
  });

  it("accepts a $schema pointer so editors can find the JSON Schema", () => {
    expect(parseAgentPack({ ...validPack(), $schema: "./agent-pack.v1.schema.json" }).ok).toBe(
      true,
    );
  });

  it("rejects unknown fields with their path, at every level", () => {
    const pack = validPack();
    agentOf(pack).extra = true;
    expect(issuePaths(pack)).toEqual(["agents.0"]);
    expect(issuePaths({ ...validPack(), runs: [] })).toEqual([""]);
    const nested = validPack();
    (nested.metadata as Loose).owner = "x";
    expect(issuePaths(nested)).toEqual(["metadata"]);
  });

  it("rejects wrong types with the field path", () => {
    const pack = validPack();
    agentOf(pack).dailyBudgetCents = "500";
    (pack.skills as Loose[])[0]!.version = 1.5;
    expect(issuePaths(pack).sort()).toEqual(["agents.0.dailyBudgetCents", "skills.0.version"]);
  });

  it("never carries database ids, run history or approval history", () => {
    for (const key of ["id", "workspaceId", "runs", "runEvents", "approvals", "createdAt"]) {
      const pack = validPack();
      agentOf(pack)[key] = key === "runs" ? [] : "x";
      expect(parseAgentPack(pack).ok, key).toBe(false);
      expect(parseAgentPack({ ...validPack(), [key]: "x" }).ok, `root ${key}`).toBe(false);
    }
  });

  it("rejects policies, identities and credentials as fields", () => {
    for (const key of ["policies", "identity", "credentials", "apiKey", "tier"]) {
      const pack = validPack();
      agentOf(pack)[key] = "x";
      expect(parseAgentPack(pack).ok, key).toBe(false);
    }
  });

  it("allows broker secrets only as named references", () => {
    const pack = validPack();
    expect(parseAgentPack(pack).ok).toBe(true);
    for (const bad of ["crm_api_key", "secret:", "secret:Has Space", "secret:UPPER"]) {
      agentOf(pack).secretRefs = [bad];
      expect(issuePaths(pack), bad).toEqual(["agents.0.secretRefs.0"]);
    }
  });

  it("rejects a secret-shaped value anywhere, with its path", () => {
    // Built at runtime so no realistic secret is committed.
    const fakeKey = ["sk", "ant", "x".repeat(30)].join("-");
    const fakeJwt = ["eyJ" + "a".repeat(12), "eyJ" + "b".repeat(8), "c".repeat(12)].join(".");
    const fakeUrl = "postgres://admin:" + "hunter2" + "@db.example.com/app";

    const inPrompt = validPack();
    agentOf(inPrompt).prompt = `Use ${fakeKey} to call the API`;
    expect(issuePaths(inPrompt)).toEqual(["agents.0.prompt"]);

    const inSkill = validPack();
    (inSkill.skills as Loose[])[0]!.body = `token ${fakeJwt}`;
    expect(issuePaths(inSkill)).toEqual(["skills.0.body"]);

    const inNote = validPack();
    (inNote.notes as Loose[])[0]!.body = fakeUrl;
    expect(issuePaths(inNote)).toEqual(["notes.0.body"]);

    const inMeta = validPack();
    (inMeta.metadata as Loose).name = fakeKey;
    expect(issuePaths(inMeta)).toEqual(["metadata.name"]);
  });

  it("does not reject ordinary prose about secrets and tokens", () => {
    expect(findSecretShape("Never paste a token or password into a note.")).toBeNull();
    expect(findSecretShape("Use secret:crm_api_key through the broker.")).toBeNull();
  });

  it("still finds a password in a URL after the scheme was bounded", () => {
    expect(findSecretShape("postgres://" + "u:p" + "@h")).toBe("password in a URL");
    expect(findSecretShape("see https://example.com/docs")).toBeNull();
  });

  it("finds a password in a URL that has an empty user name", () => {
    expect(findSecretShape("redis://" + ":pw" + "@host:6379")).toBe("password in a URL");
  });

  it("parses one oversized note of JWT-like text in linear time, with a length issue", () => {
    const packOf = (repeats: number) => {
      const pack = validPack();
      pack.notes = [{ title: "n", body: "eyJ-".repeat(repeats) }];
      return pack;
    };
    const small = packOf(12_500);
    const large = packOf(50_000);
    const smallMs = bestOfSevenMs(() => parseAgentPack(small));
    const largeMs = bestOfSevenMs(() => parseAgentPack(large));
    expect(largeMs / Math.max(smallMs, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
    expect(parseAgentPack(large).ok).toBe(false);
    expect(issuePaths(large)).toEqual(["notes.0.body"]);
  });

  it("scans hostile text in linear time (no regex backtracking)", () => {
    const hostile = (length: number) => "a.".repeat(length / 2);
    expect(findSecretShape(hostile(20_000))).toBeNull();

    // The unbounded scheme took minutes here (174 s for 500 notes) and grew about 16x for a 4x
    // longer note. A linear scan grows about 4x.
    const packOf = (length: number) => {
      const pack = validPack();
      pack.notes = Array.from({ length: 100 }, () => ({ title: "n", body: hostile(length) }));
      return pack;
    };
    const small = packOf(5000);
    const large = packOf(20_000);
    expect(parseAgentPack(small).ok).toBe(true);
    expect(parseAgentPack(large).ok).toBe(true);
    const smallMs = bestOfSevenMs(() => parseAgentPack(small));
    const largeMs = bestOfSevenMs(() => parseAgentPack(large));
    expect(largeMs / Math.max(smallMs, TIMER_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_4X_INPUT);
  });

  it("never echoes a secret-shaped name in an issue message", () => {
    const fakeKey = ["sk", "ant", "x".repeat(30)].join("-");

    const missing = validPack();
    agentOf(missing).skills = [fakeKey];
    const missingResult = parseAgentPack(missing);
    expect(missingResult.ok).toBe(false);
    expect(JSON.stringify(missingResult)).not.toContain(fakeKey);
    expect(issuePaths(missing)).toContain("agents.0.skills.0");

    const duplicate = validPack();
    (duplicate.agents as unknown[]).push({ ...agentOf(duplicate), name: fakeKey });
    (duplicate.agents as unknown[]).push({ ...agentOf(duplicate), name: fakeKey });
    const duplicateResult = parseAgentPack(duplicate);
    expect(duplicateResult.ok).toBe(false);
    expect(JSON.stringify(duplicateResult)).not.toContain(fakeKey);

    // An ordinary name is still quoted so the message stays useful.
    const ordinary = validPack();
    agentOf(ordinary).skills = ["Nope"];
    expect(JSON.stringify(parseAgentPack(ordinary))).toContain("Nope");
  });

  it("checks that skills exist and names are unique", () => {
    const missing = validPack();
    agentOf(missing).skills = ["Nope"];
    expect(issuePaths(missing)).toEqual(["agents.0.skills.0"]);

    const duplicateSkill = validPack();
    (duplicateSkill.skills as unknown[]).push({ name: "Citing sources", version: 1, body: "" });
    expect(issuePaths(duplicateSkill)).toEqual(["skills.1.name"]);

    const duplicateAgent = validPack();
    (duplicateAgent.agents as unknown[]).push(agentOf(duplicateAgent));
    expect(issuePaths(duplicateAgent)).toEqual(["agents.1.name"]);

    const repeatedSkill = validPack();
    agentOf(repeatedSkill).skills = ["Citing sources", "Citing sources"];
    expect(issuePaths(repeatedSkill)).toEqual(["agents.0.skills.1"]);
  });

  it("rejects a repeated capability and bad capability fields", () => {
    const repeated = validPack();
    agentOf(repeated).capabilities = [
      { name: "vault.read", scope: "workspace" },
      { name: "vault.read", scope: "agent" },
    ];
    expect(issuePaths(repeated)).toEqual(["agents.0.capabilities.1.name"]);

    const badScope = validPack();
    agentOf(badScope).capabilities = [{ name: "vault.read", scope: "galaxy" }];
    expect(issuePaths(badScope)).toEqual(["agents.0.capabilities.0.scope"]);

    const withTier = validPack();
    agentOf(withTier).capabilities = [{ name: "vault.read", scope: "workspace", tier: 0 }];
    expect(issuePaths(withTier)).toEqual(["agents.0.capabilities.0"]);
  });

  it("validates thinking effort, autonomy mode, budget, model and dates", () => {
    const cases: [string, unknown, string][] = [
      ["thinkingEffort", "extreme", "agents.0.thinkingEffort"],
      ["autonomyMode", "yolo", "agents.0.autonomyMode"],
      ["dailyBudgetCents", 0, "agents.0.dailyBudgetCents"],
      ["dailyBudgetCents", -5, "agents.0.dailyBudgetCents"],
      ["model", "", "agents.0.model"],
      ["model", "m".repeat(101), "agents.0.model"],
      ["name", "   ", "agents.0.name"],
    ];
    for (const [field, value, path] of cases) {
      const pack = validPack();
      agentOf(pack)[field] = value;
      expect(issuePaths(pack), `${field}=${String(value)}`).toEqual([path]);
    }
    const badDate = validPack();
    (badDate.metadata as Loose).exportedAt = "yesterday";
    expect(issuePaths(badDate)).toEqual(["metadata.exportedAt"]);
  });

  it("accepts an unknown model id: the importer checks the allowlist", () => {
    const pack = validPack();
    agentOf(pack).model = "claude-future-9";
    expect(parseAgentPack(pack).ok).toBe(true);
  });

  it("accepts standard autonomy as data (import still forces Strict)", () => {
    const pack = validPack();
    agentOf(pack).autonomyMode = "standard";
    expect(parseAgentPack(pack).ok).toBe(true);
  });

  it("keeps the exported schema usable directly", () => {
    expect(agentPackSchema.safeParse(validPack()).success).toBe(true);
  });
});

describe("packVersion and migration", () => {
  it("requires packVersion", () => {
    const { packVersion: _omit, ...rest } = validPack();
    expect(parseAgentPack(rest)).toEqual({
      ok: false,
      issues: [{ path: "packVersion", message: "packVersion is required." }],
    });
  });

  it("rejects a non-integer, zero, string or non-object pack", () => {
    for (const bad of [0, -1, 1.5, "1", null, true]) {
      expect(issuePaths({ ...validPack(), packVersion: bad }), String(bad)).toEqual([
        "packVersion",
      ]);
    }
    expect(issuePaths(null)).toEqual([""]);
    expect(issuePaths([])).toEqual([""]);
    expect(issuePaths("pack")).toEqual([""]);
  });

  it("refuses a pack newer than the app, with a clear message", () => {
    const result = parseAgentPack({ ...validPack(), packVersion: PACK_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/newer than this app/);
  });

  it("reports the version a pack was read from", () => {
    const result = parseAgentPack(validPack());
    expect(result.ok && result.fromVersion).toBe(1);
  });

  it("runs the migration chain from an older version, step by step", () => {
    const steps: Record<number, PackMigration> = {
      1: (pack) => ({ ...pack, packVersion: 2, renamed: pack.old }),
      2: (pack) => ({ ...pack, packVersion: 3 }),
    };
    expect(migrateAgentPack({ packVersion: 1, old: "x" }, steps, 3)).toEqual({
      ok: true,
      fromVersion: 1,
      pack: { packVersion: 3, old: "x", renamed: "x" },
    });
  });

  it("fails on a gap in the chain or a step that forgets to bump the version", () => {
    expect(migrateAgentPack({ packVersion: 1 }, {}, 3).ok).toBe(false);
    expect(migrateAgentPack({ packVersion: 1 }, { 1: (pack) => pack }, 2).ok).toBe(false);
  });

  it("does not mutate the input", () => {
    const input = validPack();
    const copy = structuredClone(input);
    parseAgentPack(input);
    expect(input).toEqual(copy);
  });
});

describe("generated JSON Schema", () => {
  const committed: unknown = JSON.parse(
    readFileSync(
      resolve(fileURLToPath(new URL("../..", import.meta.url)), AGENT_PACK_JSON_SCHEMA_PATH),
      "utf8",
    ),
  );

  // Compared as data, not text: the commit hook runs prettier over the file.
  it("is committed and up to date (run `pnpm --filter @ago/shared pack:schema` when this fails)", () => {
    expect(committed).toEqual(JSON.parse(renderAgentPackJsonSchema()));
  });

  it("closes every object so editors flag unknown fields", () => {
    const schema = buildAgentPackJsonSchema();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("packVersion");
    const properties = schema.properties as Record<
      string,
      { items?: { additionalProperties?: boolean } }
    >;
    expect(properties.agents?.items?.additionalProperties).toBe(false);
    expect(properties.skills?.items?.additionalProperties).toBe(false);
  });

  it("names no id, run history, approval or credential field", () => {
    const text = JSON.stringify(buildAgentPackJsonSchema()).toLowerCase();
    for (const word of ["workspaceid", '"id"', "runs", "approval", "apikey", "password"]) {
      expect(text, word).not.toContain(word);
    }
  });
});
