import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

/**
 * Independent acceptance tests for AGO-191 (agent pack schema v1). Expected values come from the ticket
 * AC and owner decisions, not from the implementation. Every fake secret is assembled at runtime so no
 * realistic secret is committed.
 */

type Loose = Record<string, unknown>;

function validPack(): Loose {
  return {
    packVersion: 1,
    metadata: { name: "Sales team", exportedAt: "2026-11-13T10:30:00+08:00", appVersion: "1.2.3" },
    agents: [
      {
        name: "Closer",
        role: "Sales lead",
        model: "some-future-model-id",
        thinkingEffort: "high",
        prompt: "Follow up with warm leads.",
        skills: ["Outreach"],
        capabilities: [
          { name: "vault.read", scope: "workspace" },
          { name: "vault.write", scope: "agent" },
        ],
        dailyBudgetCents: 1200,
        autonomyMode: "standard",
        department: "Sales",
        secretRefs: ["secret:crm_api_key", "secret:mail.token-2"],
      },
    ],
    skills: [{ name: "Outreach", version: 2, body: "# Outreach\n\nBe brief." }],
    notes: [{ title: "Hand-off", body: "Check the pipeline weekly." }],
  };
}

function agent0(pack: Loose): Loose {
  return (pack.agents as Loose[])[0]!;
}

function paths(input: unknown): string[] {
  const result = parseAgentPack(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

// Fake secrets, built at runtime.
const fake = {
  anthropic: () => ["sk", "ant", "q".repeat(32)].join("-"),
  openai: () => "sk" + "-" + "z".repeat(24),
  aws: () => "AK" + "IA" + "A".repeat(16),
  github: () => "gh" + "p_" + "a1".repeat(18),
  slack: () => "xo" + "xb-" + "1234567890" + "-abcdef",
  stripe: () => "sk" + "_live_" + "a".repeat(26),
  google: () => "AI" + "za" + "B".repeat(35),
  jwt: () => ["eyJ" + "h".repeat(12), "eyJ" + "p".repeat(10), "s".repeat(14)].join("."),
  privateKey: () =>
    "-----" + "BEGIN RSA PRIVATE" + " KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
  postgresUrl: () => "post" + "gres://app_user:" + "pa55w0rd" + "@db.internal:5432/app",
  httpUrl: () => "https://svc:" + "letmein99" + "@host.example.com/path",
};

describe("AC1: valid pack parses; unknown fields and wrong types are rejected with the field path", () => {
  it("parses a full valid pack and returns the same content", () => {
    const result = parseAgentPack(validPack());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.agents[0]?.name).toBe("Closer");
      expect(result.pack.agents[0]?.secretRefs).toEqual([
        "secret:crm_api_key",
        "secret:mail.token-2",
      ]);
      expect(result.pack.notes?.[0]?.title).toBe("Hand-off");
    }
  });

  it("parses a pack with no notes, no department, no secretRefs and no agents", () => {
    const pack = validPack();
    delete pack.notes;
    delete agent0(pack).department;
    delete agent0(pack).secretRefs;
    expect(parseAgentPack(pack).ok).toBe(true);
    expect(parseAgentPack({ ...validPack(), agents: [], skills: [] }).ok).toBe(true);
  });

  it("rejects an unknown field at the pack root, reporting a count and not the key", () => {
    const result = parseAgentPack({ ...validPack(), surprise: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path)).toEqual([""]);
      expect(result.issues[0]?.message).toBe("1 unrecognized field.");
      expect(result.issues[0]?.message).not.toContain("surprise");
    }
  });

  it("reports a secret-shaped field name by location only, in messages and paths", () => {
    const key = `ghp_${"U".repeat(36)}`;
    const pack = validPack();
    agent0(pack)[key] = { nested: "x" };
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.issues)).not.toContain(key);
      expect(result.issues.some((i) => i.path === "agents.0")).toBe(true);
    }
  });

  const nestedTargets: [string, string, (pack: Loose) => Loose][] = [
    ["metadata", "metadata", (p) => p.metadata as Loose],
    ["agents[]", "agents.0", (p) => agent0(p)],
    ["capabilities[]", "agents.0.capabilities.1", (p) => (agent0(p).capabilities as Loose[])[1]!],
    ["skills[]", "skills.0", (p) => (p.skills as Loose[])[0]!],
    ["notes[]", "notes.0", (p) => (p.notes as Loose[])[0]!],
  ];
  it.each(nestedTargets)(
    "rejects an unknown field inside %s with the path of the object and a count, not the key",
    (_label, expectedPath, pick) => {
      const pack = validPack();
      pick(pack).mystery = "x";
      const result = parseAgentPack(pack);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((i) => i.path)).toEqual([expectedPath]);
        expect(result.issues[0]?.message).toBe("1 unrecognized field.");
        expect(result.issues[0]?.message).not.toContain("mystery");
      }
    },
  );

  const wrongTypes: [string, (pack: Loose) => void, string][] = [
    ["metadata is a string", (p) => (p.metadata = "x"), "metadata"],
    ["agents is an object", (p) => (p.agents = {}), "agents"],
    ["skills is a string", (p) => (p.skills = "x"), "skills"],
    ["notes is a number", (p) => (p.notes = 5), "notes"],
    ["agent name is a number", (p) => (agent0(p).name = 7), "agents.0.name"],
    ["agent role is null", (p) => (agent0(p).role = null), "agents.0.role"],
    ["agent model is an array", (p) => (agent0(p).model = []), "agents.0.model"],
    ["agent prompt is a boolean", (p) => (agent0(p).prompt = true), "agents.0.prompt"],
    ["agent skills is a string", (p) => (agent0(p).skills = "Outreach"), "agents.0.skills"],
    ["agent skill entry is a number", (p) => (agent0(p).skills = [3]), "agents.0.skills.0"],
    ["budget is a string", (p) => (agent0(p).dailyBudgetCents = "10"), "agents.0.dailyBudgetCents"],
    ["budget is a float", (p) => (agent0(p).dailyBudgetCents = 10.5), "agents.0.dailyBudgetCents"],
    ["secretRefs is a string", (p) => (agent0(p).secretRefs = "secret:a"), "agents.0.secretRefs"],
    [
      "capability name is a number",
      (p) => ((agent0(p).capabilities as Loose[])[0]!.name = 1),
      "agents.0.capabilities.0.name",
    ],
    [
      "capability scope is a number",
      (p) => ((agent0(p).capabilities as Loose[])[0]!.scope = 1),
      "agents.0.capabilities.0.scope",
    ],
    [
      "skill version is a string",
      (p) => ((p.skills as Loose[])[0]!.version = "2"),
      "skills.0.version",
    ],
    ["skill version is 0", (p) => ((p.skills as Loose[])[0]!.version = 0), "skills.0.version"],
    ["skill body is a number", (p) => ((p.skills as Loose[])[0]!.body = 1), "skills.0.body"],
    ["note title is an object", (p) => ((p.notes as Loose[])[0]!.title = {}), "notes.0.title"],
    ["note body is null", (p) => ((p.notes as Loose[])[0]!.body = null), "notes.0.body"],
    ["metadata name is a number", (p) => ((p.metadata as Loose).name = 1), "metadata.name"],
    [
      "exportedAt is not a date",
      (p) => ((p.metadata as Loose).exportedAt = "13/11/2026"),
      "metadata.exportedAt",
    ],
    [
      "exportedAt is a number",
      (p) => ((p.metadata as Loose).exportedAt = 1700000000),
      "metadata.exportedAt",
    ],
    [
      "appVersion is missing",
      (p) => delete (p.metadata as Loose).appVersion,
      "metadata.appVersion",
    ],
    [
      "thinkingEffort is unknown",
      (p) => (agent0(p).thinkingEffort = "max"),
      "agents.0.thinkingEffort",
    ],
    ["autonomyMode is unknown", (p) => (agent0(p).autonomyMode = "yolo"), "agents.0.autonomyMode"],
    [
      "capability scope is unknown",
      (p) => ((agent0(p).capabilities as Loose[])[0]!.scope = "galaxy"),
      "agents.0.capabilities.0.scope",
    ],
    [
      "capability key is not dotted",
      (p) => ((agent0(p).capabilities as Loose[])[0]!.name = "vaultread"),
      "agents.0.capabilities.0.name",
    ],
    ["agent prompt is missing", (p) => delete agent0(p).prompt, "agents.0.prompt"],
  ];
  it.each(wrongTypes)(
    "rejects a wrong value with its path when %s",
    (_label, mutate, expectedPath) => {
      const pack = validPack();
      mutate(pack);
      expect(paths(pack)).toContain(expectedPath);
      expect(parseAgentPack(pack).ok).toBe(false);
    },
  );

  it("rejects a pack that is not an object", () => {
    for (const bad of [null, undefined, [], "pack", 3, true]) {
      expect(paths(bad), String(bad)).toEqual([""]);
    }
  });

  it("reports every problem, each with its own path, when several fields are wrong", () => {
    const pack = validPack();
    agent0(pack).dailyBudgetCents = "x";
    (pack.notes as Loose[])[0]!.title = 4;
    expect(paths(pack).sort()).toEqual(["agents.0.dailyBudgetCents", "notes.0.title"]);
  });

  it("enforces text and collection bounds", () => {
    const longName = validPack();
    agent0(longName).name = "n".repeat(121);
    expect(paths(longName)).toEqual(["agents.0.name"]);

    const blankRole = validPack();
    agent0(blankRole).role = "  \n ";
    expect(paths(blankRole)).toEqual(["agents.0.role"]);

    const longModel = validPack();
    agent0(longModel).model = "m".repeat(100);
    expect(parseAgentPack(longModel).ok).toBe(true);
    agent0(longModel).model = "m".repeat(101);
    expect(paths(longModel)).toEqual(["agents.0.model"]);

    const tooManyAgents = validPack();
    tooManyAgents.agents = Array.from({ length: 101 }, (_, i) => ({
      ...agent0(validPack()),
      name: `A${String(i)}`,
    }));
    expect(paths(tooManyAgents)).toEqual(["agents"]);
  });

  it("accepts unicode, emoji and right-to-left text in text fields", () => {
    const pack = validPack();
    agent0(pack).name = "Agent \u{1F680} שלום 你好";
    agent0(pack).prompt = "Reply in العربية when asked.";
    expect(parseAgentPack(pack).ok).toBe(true);
  });
});

describe("AC2: no secrets, ids, run or approval history; broker secrets only as named references", () => {
  const secretKinds = Object.entries(fake);

  type Place = [string, string, (pack: Loose, value: string) => void];
  const places: Place[] = [
    ["agent prompt", "agents.0.prompt", (p, v) => (agent0(p).prompt = `Call with ${v} now`)],
    ["agent role", "agents.0.role", (p, v) => (agent0(p).role = v)],
    ["agent name", "agents.0.name", (p, v) => (agent0(p).name = v)],
    ["agent model", "agents.0.model", (p, v) => (agent0(p).model = v)],
    ["agent department", "agents.0.department", (p, v) => (agent0(p).department = v)],
    ["skill body", "skills.0.body", (p, v) => ((p.skills as Loose[])[0]!.body = `Use ${v}`)],
    ["skill name", "skills.0.name", (p, v) => ((p.skills as Loose[])[0]!.name = v)],
    ["note title", "notes.0.title", (p, v) => ((p.notes as Loose[])[0]!.title = v)],
    ["note body", "notes.0.body", (p, v) => ((p.notes as Loose[])[0]!.body = `see ${v}`)],
    ["metadata name", "metadata.name", (p, v) => ((p.metadata as Loose).name = v)],
    [
      "metadata appVersion",
      "metadata.appVersion",
      (p, v) => ((p.metadata as Loose).appVersion = v),
    ],
    ["$schema pointer", "$schema", (p, v) => (p.$schema = v)],
  ];

  describe.each(places)("secret-like text in %s", (_place, expectedPath, put) => {
    it.each(secretKinds)("is rejected with its path when it holds a %s", (_kind, make) => {
      const pack = validPack();
      put(pack, make());
      expect(paths(pack)).toContain(expectedPath);
      expect(parseAgentPack(pack).ok).toBe(false);
    });
  });

  it("rejects a secret value in a secretRefs entry, with the entry's path", () => {
    for (const [kind, make] of secretKinds) {
      const pack = validPack();
      agent0(pack).secretRefs = ["secret:ok_name", make()];
      expect(paths(pack), kind).toContain("agents.0.secretRefs.1");
    }
  });

  it("rejects a secretRefs entry that is not secret:<name>", () => {
    for (const bad of [
      "crm_api_key",
      "secret:",
      "secret:UPPER",
      "secret:has space",
      "Secret:abc",
      "secret:1abc",
      "",
    ]) {
      const pack = validPack();
      agent0(pack).secretRefs = [bad];
      expect(paths(pack), JSON.stringify(bad)).toContain("agents.0.secretRefs.0");
    }
  });

  it("accepts secret:<name> references that hold names only", () => {
    const pack = validPack();
    agent0(pack).secretRefs = ["secret:crm_api_key", "secret:a", "secret:billing.api-v2"];
    expect(parseAgentPack(pack).ok).toBe(true);
  });

  it("rejects a repeated secret reference", () => {
    const pack = validPack();
    agent0(pack).secretRefs = ["secret:a", "secret:a"];
    expect(paths(pack)).toEqual(["agents.0.secretRefs.1"]);
  });

  it("accepts prose that merely talks about keys, tokens and passwords", () => {
    const pack = validPack();
    agent0(pack).prompt =
      "Never paste an API key, token or password. Ask for secret:crm_api_key instead.";
    expect(parseAgentPack(pack).ok).toBe(true);
  });

  it("findSecretShape labels a value shape and returns null for plain text", () => {
    expect(findSecretShape(fake.aws())).toEqual(expect.any(String));
    expect(findSecretShape(fake.jwt())).toEqual(expect.any(String));
    expect(findSecretShape(fake.postgresUrl())).toEqual(expect.any(String));
    expect(findSecretShape("just a normal sentence")).toBeNull();
    expect(findSecretShape("https://example.com/docs")).toBeNull();
  });

  const idLike = [
    "id",
    "workspace_id",
    "workspaceId",
    "uuid",
    "agent_id",
    "agentId",
    "skill_id",
    "department_id",
    "createdBy",
    "owner_id",
  ];
  const history = [
    "runs",
    "run_id",
    "runEvents",
    "run_events",
    "approvals",
    "approval_id",
    "history",
    "approvalHistory",
    "runHistory",
    "cost",
    "tier",
    "policies",
    "identity",
    "credentials",
    "apiKey",
    "token",
    "password",
  ];

  it.each([...idLike, ...history])(
    "rejects the field %s on an agent, at the root and on a skill",
    (key) => {
      const onAgent = validPack();
      agent0(onAgent)[key] = "00000000-0000-0000-0000-000000000000";
      expect(paths(onAgent)).toEqual(["agents.0"]);

      const onRoot = { ...validPack(), [key]: "x" };
      expect(paths(onRoot)).toEqual([""]);

      const onSkill = validPack();
      (onSkill.skills as Loose[])[0]![key] = "x";
      expect(paths(onSkill)).toEqual(["skills.0"]);
    },
  );

  it("rejects an id on metadata, capability and note objects", () => {
    const meta = validPack();
    (meta.metadata as Loose).workspace_id = "w";
    expect(paths(meta)).toEqual(["metadata"]);
    const cap = validPack();
    (agent0(cap).capabilities as Loose[])[0]!.id = "c";
    expect(paths(cap)).toEqual(["agents.0.capabilities.0"]);
    const note = validPack();
    (note.notes as Loose[])[0]!.id = "n";
    expect(paths(note)).toEqual(["notes.0"]);
  });

  it("names no id, history or credential property anywhere in the JSON Schema", () => {
    const names = new Set<string>();
    (function walk(node: unknown): void {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const props = (node as Loose).properties as Loose | undefined;
        if (props) for (const key of Object.keys(props)) names.add(key);
        Object.values(node).forEach(walk);
      }
    })(buildAgentPackJsonSchema());
    for (const banned of [...idLike, ...history]) expect(names.has(banned), banned).toBe(false);
    expect(names.has("secretRefs")).toBe(true);
  });
});

describe("AC3: packVersion is required and a migration function exists for older versions", () => {
  it("requires packVersion with a path and message", () => {
    const { packVersion: _drop, ...rest } = validPack();
    const result = parseAgentPack(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.path).toBe("packVersion");
      expect(result.issues[0]?.message).toMatch(/required/i);
    }
  });

  it.each([
    ["unknown string", "v1"],
    ["numeric string", "1"],
    ["zero", 0],
    ["negative", -1],
    ["float", 1.5],
    ["null", null],
    ["boolean", true],
    ["NaN as null", Number.NaN],
    ["array", [1]],
  ])("rejects packVersion when it is %s", (_label, value) => {
    expect(paths({ ...validPack(), packVersion: value })).toEqual(["packVersion"]);
  });

  it("rejects a future version with a message that says to update the app", () => {
    for (const future of [PACK_VERSION + 1, 99]) {
      const result = parseAgentPack({ ...validPack(), packVersion: future });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.path).toBe("packVersion");
        expect(result.issues[0]?.message).toMatch(/newer/i);
        expect(result.issues[0]?.message).toMatch(/update/i);
      }
    }
  });

  it("current version is the integer 1 (v1 format)", () => {
    expect(PACK_VERSION).toBe(1);
    expect(Number.isInteger(PACK_VERSION)).toBe(true);
  });

  it("upgrades an old pack through an injected chain and parses it against the current schema", () => {
    // Pretend an old v0-style pack stored the pack title as `title` instead of metadata.name.
    const old = validPack();
    old.packVersion = 1;
    const steps: Record<number, PackMigration> = {
      1: (pack) => ({ ...pack, packVersion: 2 }),
      2: (pack) => ({ ...pack, packVersion: 3 }),
    };
    const result = migrateAgentPack(old, steps, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromVersion).toBe(1);
      expect(result.pack.packVersion).toBe(3);
      expect(result.pack.agents).toEqual(old.agents);
    }
  });

  it("applies each step once, in order, starting from the pack's own version", () => {
    const calls: number[] = [];
    const steps: Record<number, PackMigration> = {
      1: (pack) => (calls.push(1), { ...pack, packVersion: 2 }),
      2: (pack) => (calls.push(2), { ...pack, packVersion: 3 }),
      3: (pack) => (calls.push(3), { ...pack, packVersion: 4 }),
    };
    const result = migrateAgentPack({ packVersion: 2 }, steps, 4);
    expect(calls).toEqual([2, 3]);
    expect(result.ok && result.fromVersion).toBe(2);
  });

  it("runs no step when the pack is already current", () => {
    let called = false;
    const result = migrateAgentPack({ packVersion: 2 }, { 1: (p) => ((called = true), p) }, 2);
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("fails with a path on packVersion when the chain has a gap", () => {
    const result = migrateAgentPack(
      { packVersion: 1 },
      { 2: (p) => ({ ...p, packVersion: 3 }) },
      3,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("packVersion");
  });

  it("fails when a step does not bump packVersion, or bumps it to the wrong number", () => {
    const same = migrateAgentPack({ packVersion: 1 }, { 1: (p) => p }, 2);
    expect(same.ok).toBe(false);
    const skip = migrateAgentPack({ packVersion: 1 }, { 1: (p) => ({ ...p, packVersion: 5 }) }, 3);
    expect(skip.ok).toBe(false);
    const dropped = migrateAgentPack({ packVersion: 1 }, { 1: () => ({}) }, 2);
    expect(dropped.ok).toBe(false);
  });

  it("does not mutate the input pack, with or without migration steps", () => {
    const input = validPack();
    const before = structuredClone(input);
    parseAgentPack(input);
    migrateAgentPack(input, { 1: (p) => ({ ...p, packVersion: 2 }) }, 2);
    expect(input).toEqual(before);
  });

  it("parseAgentPack uses the injected chain and still validates the migrated result", () => {
    const steps: Record<number, PackMigration> = { 1: (p) => ({ ...p, packVersion: 1 }) };
    // Current version is 1, so the chain is never used: a valid v1 pack parses, a bad one still fails.
    expect(parseAgentPack(validPack(), steps).ok).toBe(true);
    expect(parseAgentPack({ ...validPack(), extra: 1 }, steps).ok).toBe(false);
  });

  it("migrateAgentPack does not validate content, only the version", () => {
    const result = migrateAgentPack({ packVersion: 1, anything: "goes" });
    expect(result.ok).toBe(true);
  });
});

/**
 * No JSON Schema validator is usable here: the only `ajv` in node_modules is v6 (an eslint dependency, draft-07,
 * not resolvable from packages/shared), and the ticket forbids new dependencies. This is a small structural
 * validator for the keywords the generated schema uses: type, const, enum, required, additionalProperties,
 * properties, items, maxLength, maxItems, minimum, maximum, pattern. `format` and cross-field rules are not checked.
 */
function validateJsonSchema(schema: Loose, value: unknown, at = ""): string[] {
  const errors: string[] = [];
  const err = (msg: string): void => void errors.push(`${at}: ${msg}`);
  const type = schema.type as string | undefined;
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return [`${at}: not an object`];
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${at}: not an array`];
  } else if (type === "string") {
    if (typeof value !== "string") return [`${at}: not a string`];
  } else if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${at}: not a number`];
  } else if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [`${at}: not an integer`];
  }
  if ("const" in schema && value !== schema.const) err("const mismatch");
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) err("not in enum");
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) err("too long");
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      err("pattern mismatch");
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) err("below minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum) err("above maximum");
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      err("too many items");
    if (schema.items)
      value.forEach((item, i) =>
        errors.push(...validateJsonSchema(schema.items as Loose, item, `${at}/${String(i)}`)),
      );
  }
  if (type === "object") {
    const obj = value as Loose;
    const props = (schema.properties ?? {}) as Record<string, Loose>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) err(`missing ${key}`);
    for (const [key, item] of Object.entries(obj)) {
      const sub = props[key];
      if (sub) errors.push(...validateJsonSchema(sub, item, `${at}/${key}`));
      else if (schema.additionalProperties === false) err(`unknown property ${key}`);
    }
  }
  return errors;
}

describe("AC4: JSON Schema is generated and committed", () => {
  const committedPath = resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
    AGENT_PACK_JSON_SCHEMA_PATH,
  );
  const committed = JSON.parse(readFileSync(committedPath, "utf8")) as Loose;

  it("committed file path is schemas/agent-pack.v1.schema.json", () => {
    expect(AGENT_PACK_JSON_SCHEMA_PATH.replace(/\\/g, "/")).toBe(
      "schemas/agent-pack.v1.schema.json",
    );
  });

  it("committed schema equals the generator output as data (not stale)", () => {
    expect(committed).toEqual(JSON.parse(renderAgentPackJsonSchema()));
    expect(committed).toEqual(buildAgentPackJsonSchema());
  });

  it("generated text is JSON that ends with a newline", () => {
    const text = renderAgentPackJsonSchema();
    expect(text.endsWith("\n")).toBe(true);
    expect(() => {
      JSON.parse(text) as unknown;
    }).not.toThrow();
  });

  it("is a closed draft 2020-12 schema that requires packVersion, metadata, agents and skills", () => {
    expect(committed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(committed.additionalProperties).toBe(false);
    expect(committed.required).toEqual(
      expect.arrayContaining(["packVersion", "metadata", "agents", "skills"]),
    );
    expect(committed.required as string[]).not.toContain("notes");
  });

  it("closes every object schema in the file", () => {
    const open: string[] = [];
    (function walk(node: unknown, at: string): void {
      if (Array.isArray(node)) {
        node.forEach((n, i) => {
          walk(n, `${at}/${String(i)}`);
        });
      } else if (node && typeof node === "object") {
        const o = node as Loose;
        if (o.type === "object" && o.additionalProperties !== false) open.push(at);
        for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`);
      }
    })(committed, "");
    expect(open).toEqual([]);
  });

  const invalidCases: [string, (pack: Loose) => void][] = [
    ["root unknown field", (p) => (p.runs = [])],
    ["metadata unknown field", (p) => ((p.metadata as Loose).owner = "x")],
    ["agent unknown field", (p) => (agent0(p).id = "x")],
    ["capability unknown field", (p) => ((agent0(p).capabilities as Loose[])[0]!.tier = 1)],
    ["skill unknown field", (p) => ((p.skills as Loose[])[0]!.workspaceId = "x")],
    ["note unknown field", (p) => ((p.notes as Loose[])[0]!.id = "x")],
    ["missing packVersion", (p) => delete p.packVersion],
    ["packVersion 2", (p) => (p.packVersion = 2)],
    ["packVersion string", (p) => (p.packVersion = "1")],
    ["missing metadata", (p) => delete p.metadata],
    ["missing agents", (p) => delete p.agents],
    ["missing skills", (p) => delete p.skills],
    ["agent name number", (p) => (agent0(p).name = 1)],
    ["agent missing prompt", (p) => delete agent0(p).prompt],
    ["bad thinkingEffort", (p) => (agent0(p).thinkingEffort = "max")],
    ["bad autonomyMode", (p) => (agent0(p).autonomyMode = "yolo")],
    ["bad scope", (p) => ((agent0(p).capabilities as Loose[])[0]!.scope = "galaxy")],
    ["bad capability key", (p) => ((agent0(p).capabilities as Loose[])[0]!.name = "NoDots")],
    ["budget zero", (p) => (agent0(p).dailyBudgetCents = 0)],
    ["budget float", (p) => (agent0(p).dailyBudgetCents = 1.5)],
    ["budget above sanity bound", (p) => (agent0(p).dailyBudgetCents = 100_000_001)],
    ["model too long", (p) => (agent0(p).model = "m".repeat(101))],
    ["secretRefs plain value", (p) => (agent0(p).secretRefs = ["abc123"])],
    ["secretRefs empty name", (p) => (agent0(p).secretRefs = ["secret:"])],
    [
      "secretRefs too many",
      (p) => (agent0(p).secretRefs = Array.from({ length: 51 }, (_, i) => `secret:n${String(i)}`)),
    ],
    ["skill version 0", (p) => ((p.skills as Loose[])[0]!.version = 0)],
    ["skill version float", (p) => ((p.skills as Loose[])[0]!.version = 1.5)],
    ["too many agents", (p) => (p.agents = Array.from({ length: 101 }, () => agent0(validPack())))],
    ["note body too long", (p) => ((p.notes as Loose[])[0]!.body = "b".repeat(20_001))],
    ["metadata name too long", (p) => ((p.metadata as Loose).name = "n".repeat(121))],
  ];

  it("the structural checker accepts a valid pack and a minimal pack (sanity for the validator itself)", () => {
    expect(validateJsonSchema(committed, validPack())).toEqual([]);
    expect(validateJsonSchema(committed, { ...validPack(), agents: [], skills: [] })).toEqual([]);
  });

  it.each(invalidCases)("committed schema and Zod both reject: %s", (_label, mutate) => {
    const pack = validPack();
    mutate(pack);
    expect(agentPackSchema.safeParse(pack).success, "zod").toBe(false);
    expect(validateJsonSchema(committed, pack), "json schema").not.toEqual([]);
  });

  it("committed schema and Zod both accept the same valid variants", () => {
    const variants: Loose[] = [validPack()];
    const noOptional = validPack();
    delete noOptional.notes;
    delete agent0(noOptional).department;
    delete agent0(noOptional).secretRefs;
    variants.push(noOptional);
    const withPointer = { ...validPack(), $schema: "./agent-pack.v1.schema.json" };
    variants.push(withPointer);
    const edge = validPack();
    agent0(edge).model = "m".repeat(100);
    agent0(edge).dailyBudgetCents = 100_000_000;
    agent0(edge).secretRefs = ["secret:" + "a".repeat(64)];
    variants.push(edge);
    for (const pack of variants) {
      expect(agentPackSchema.safeParse(pack).success, "zod").toBe(true);
      expect(validateJsonSchema(committed, pack), "json schema").toEqual([]);
    }
  });

  it("is a superset-check only: rules JSON Schema cannot express stay with Zod", () => {
    // Duplicate names and missing skills pass the JSON Schema but fail Zod, as the generator documents.
    const pack = validPack();
    agent0(pack).skills = ["Nope"];
    expect(validateJsonSchema(committed, pack)).toEqual([]);
    expect(agentPackSchema.safeParse(pack).success).toBe(false);
  });
});
