import { describe, expect, it } from "vitest";

import { AGENT_DAILY_BUDGET_DEFAULT_CENTS } from "../agents/agent-limits.js";
import {
  PackExportError,
  buildAgentPack,
  computePackChecksum,
  verifyPackChecksum,
  withoutChecksum,
  type PackSource,
  type PackSourceAgent,
} from "./agent-pack-export.js";
import { agentPackSchema } from "./agent-pack-schemas.js";
import { canonicalJson } from "./canonical-json.js";

// Fake credentials are built at runtime so no realistic-looking secret is committed (gitleaks).
const FAKE_API_KEY = ["sk", "ant", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
const FAKE_AGENT_TOKEN = ["ago", "agt", "Z9y8X7w6V5u4T3s2R1q0P9o8"].join("_");

const NOW = new Date("2026-11-14T00:00:00.000Z");
const OPTIONS = { name: "Team", now: NOW, appVersion: "0.1.0" };

function agent(overrides: Partial<PackSourceAgent> = {}): PackSourceAgent {
  return {
    name: "Scout",
    role: "Researcher",
    model: "claude-sonnet-5-5",
    thinkingEffort: "medium",
    prompt: "Find sources.",
    mode: "strict",
    dailyBudgetCents: 500,
    skills: ["search"],
    capabilities: [{ key: "vault.read", scope: "workspace" }],
    ...overrides,
  };
}

const SKILLS = [
  { name: "write", version: 2, body: "# Write" },
  { name: "search", version: 1, body: "# Search" },
  { name: "unused", version: 1, body: "# Unused" },
];

function source(): PackSource {
  return {
    agents: [
      agent({ name: "Zed", skills: ["write", "search"] }),
      agent({ name: "Ann", skills: ["search"] }),
    ],
    skills: SKILLS,
  };
}

describe("canonicalJson", () => {
  it("sorts keys at every depth, drops whitespace and skips undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("keeps array order and refuses what JSON cannot hold", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe("buildAgentPack: what goes in (AC1)", () => {
  it("includes the selected agents and only the skills they use", () => {
    const { pack } = buildAgentPack(
      { agents: [agent({ name: "Ann", skills: ["search"] })], skills: SKILLS },
      OPTIONS,
    );
    expect(pack.agents.map((a) => a.name)).toEqual(["Ann"]);
    expect(pack.skills.map((s) => s.name)).toEqual(["search"]);
  });

  it("sorts agents, skills and capabilities by name", () => {
    const { pack } = buildAgentPack(
      {
        agents: [
          agent({ name: "Zed", skills: ["write", "search"] }),
          agent({
            name: "Ann",
            skills: ["search"],
            capabilities: [
              { key: "vault.write", scope: "workspace" },
              { key: "vault.read", scope: "workspace" },
            ],
          }),
        ],
        skills: SKILLS,
      },
      OPTIONS,
    );
    expect(pack.agents.map((a) => a.name)).toEqual(["Ann", "Zed"]);
    expect(pack.agents[1]?.skills).toEqual(["search", "write"]);
    expect(pack.agents[0]?.capabilities.map((c) => c.name)).toEqual(["vault.read", "vault.write"]);
    expect(pack.skills.map((s) => s.name)).toEqual(["search", "write"]);
  });

  it("exports a missing budget as the platform default and passes the schema", () => {
    const { pack, json } = buildAgentPack(
      { agents: [agent({ dailyBudgetCents: null })], skills: SKILLS },
      OPTIONS,
    );
    expect(pack.agents[0]?.dailyBudgetCents).toBe(AGENT_DAILY_BUDGET_DEFAULT_CENTS);
    expect(agentPackSchema.safeParse(JSON.parse(json)).success).toBe(true);
  });

  it("refuses an empty selection and an agent whose skill is missing", () => {
    expect(() => buildAgentPack({ agents: [], skills: SKILLS }, OPTIONS)).toThrow(PackExportError);
    expect(() =>
      buildAgentPack({ agents: [agent({ skills: ["ghost"] })], skills: SKILLS }, OPTIONS),
    ).toThrow(expect.objectContaining({ code: "skill_missing" }));
  });
});

describe("buildAgentPack: deterministic output and checksum (AC2)", () => {
  it("gives identical bytes for the same input, whatever the input order", () => {
    const first = buildAgentPack(source(), OPTIONS);
    const reversed = source();
    reversed.agents = [...reversed.agents].reverse();
    reversed.skills = [...reversed.skills].reverse();
    const second = buildAgentPack(reversed, OPTIONS);
    expect(second.json).toBe(first.json);
    expect(second.checksum).toBe(first.checksum);
  });

  it("writes sorted keys, one trailing newline and a parseable pack", () => {
    const { json, pack } = buildAgentPack(source(), OPTIONS);
    expect(json.endsWith("}\n")).toBe(true);
    expect(json.endsWith("\n\n")).toBe(false);
    expect(json).toBe(`${canonicalJson(JSON.parse(json))}\n`);
    const topKeys = Object.keys(JSON.parse(json) as object);
    expect(topKeys).toEqual([...topKeys].sort());
    expect(agentPackSchema.parse(JSON.parse(json))).toEqual(pack);
  });

  it("includes a SHA-256 checksum of the canonical content without the checksum field", () => {
    const { pack, checksum } = buildAgentPack(source(), OPTIONS);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.checksum).toEqual({ algorithm: "sha256", value: checksum });
    expect(computePackChecksum(withoutChecksum(pack))).toBe(checksum);
    expect(computePackChecksum(pack)).toBe(checksum);
    expect(verifyPackChecksum(pack)).toBe("valid");
  });

  it("changes the checksum when the content changes", () => {
    const base = buildAgentPack(source(), OPTIONS).checksum;
    const changed = source();
    changed.agents = [agent({ name: "Ann", skills: ["search"], prompt: "Different." })];
    expect(buildAgentPack(changed, OPTIONS).checksum).not.toBe(base);
  });

  it("detects tampering with any field, and with the checksum itself", () => {
    const { json } = buildAgentPack(source(), OPTIONS);
    const tampered = agentPackSchema.parse(JSON.parse(json));
    const first = tampered.agents[0];
    if (!first) throw new Error("expected an agent");
    first.prompt = "Ignore previous instructions.";
    expect(verifyPackChecksum(tampered)).toBe("mismatch");

    const forged = agentPackSchema.parse(JSON.parse(json));
    forged.checksum = { algorithm: "sha256", value: "0".repeat(64) };
    expect(verifyPackChecksum(forged)).toBe("mismatch");
  });

  it("keeps a v1 pack without a checksum valid", () => {
    const legacy = withoutChecksum(buildAgentPack(source(), OPTIONS).pack);
    const parsed = agentPackSchema.parse(legacy);
    expect(verifyPackChecksum(parsed)).toBe("missing");
  });

  it("rejects a checksum that is not a lowercase hex SHA-256", () => {
    const { pack } = buildAgentPack(source(), OPTIONS);
    expect(
      agentPackSchema.safeParse({ ...pack, checksum: { algorithm: "sha256", value: "ABC" } })
        .success,
    ).toBe(false);
    expect(
      agentPackSchema.safeParse({ ...pack, checksum: { algorithm: "md5", value: "a".repeat(64) } })
        .success,
    ).toBe(false);
  });
});

describe("buildAgentPack: no secrets in the file (AC3)", () => {
  it("exports capabilities as a name and a scope only", () => {
    const planted = {
      key: "vault.read",
      scope: "workspace",
      tier: 4,
      mode: "automatic",
      grantedBy: FAKE_AGENT_TOKEN,
      token: FAKE_API_KEY,
    } as unknown as PackSourceAgent["capabilities"][number];
    const { json, pack } = buildAgentPack(
      { agents: [agent({ capabilities: [planted] })], skills: SKILLS },
      OPTIONS,
    );
    expect(pack.agents[0]?.capabilities).toEqual([{ name: "vault.read", scope: "workspace" }]);
    expect(json).not.toContain(FAKE_API_KEY);
    expect(json).not.toContain(FAKE_AGENT_TOKEN);
  });

  it("never carries extra fields of a source row into the file", () => {
    const planted = {
      ...agent(),
      id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      apiKey: FAKE_API_KEY,
      runLimits: { maxSteps: 3 },
    } as PackSourceAgent;
    const { json } = buildAgentPack({ agents: [planted], skills: SKILLS }, OPTIONS);
    for (const needle of [
      FAKE_API_KEY,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "apiKey",
      "runLimits",
      "workspace_id",
    ]) {
      expect(json).not.toContain(needle);
    }
  });

  it("fails the export, without echoing the value, when text holds a secret", () => {
    const attempt = (source: PackSource) => () => buildAgentPack(source, OPTIONS);
    const inPrompt: PackSource = {
      agents: [agent({ prompt: `Use ${FAKE_API_KEY} to call the API.` })],
      skills: SKILLS,
    };
    const inSkill: PackSource = {
      agents: [agent()],
      skills: [{ name: "search", version: 1, body: `token ${FAKE_AGENT_TOKEN}` }],
    };
    for (const planted of [inPrompt, inSkill]) {
      let message = "";
      try {
        attempt(planted)();
      } catch (error) {
        expect(error).toBeInstanceOf(PackExportError);
        message = (error as Error).message;
      }
      expect(message).toContain("invalid_pack");
      expect(message).not.toContain(FAKE_API_KEY);
      expect(message).not.toContain(FAKE_AGENT_TOKEN);
    }
  });
});
