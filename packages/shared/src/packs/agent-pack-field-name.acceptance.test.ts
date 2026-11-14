import { describe, expect, it } from "vitest";

import { buildAgentPack, PackExportError, type PackSource } from "./agent-pack-export.js";
import { previewAgentPackText, type PreviewContext } from "./agent-pack-import-preview.js";
import { parseAgentPack } from "./agent-pack-migrate.js";

// AGO-193 round 2: a secret-shaped value used as a field NAME is reported by location only, in every shape of
// the validation result (path and message) and in the export error. Fake secrets are built at runtime.

type Loose = Record<string, unknown>;
const piece = (...parts: string[]) => parts.join("");

const KEYS = {
  github: piece("gh", "p_", "K".repeat(36)),
  aws: piece("AK", "IA", "Q".repeat(16)),
  anthropic: piece("sk", "-ant-", "w".repeat(32)),
  agentToken: piece("ago", "_agt_", "Z9y8X7w6".repeat(4)),
};
const PLAIN_KEY = "mysteryField";

const context: PreviewContext = {
  existingAgents: [],
  existingSkills: [],
  catalog: [{ key: "vault.read", tier: 0, scope: "workspace" }],
};

function validPack(): Loose {
  return {
    packVersion: 1,
    metadata: { name: "Team", exportedAt: "2026-11-13T00:00:00Z", appVersion: "0.1.0" },
    agents: [
      {
        name: "Scout",
        role: "Researcher",
        model: "claude-sonnet-5-5",
        thinkingEffort: "medium",
        prompt: "Find sources.",
        skills: ["S"],
        capabilities: [
          { name: "vault.read", scope: "workspace" },
          { name: "vault.write_own", scope: "agent" },
        ],
        dailyBudgetCents: 500,
        autonomyMode: "strict",
      },
    ],
    skills: [{ name: "S", version: 1, body: "# S" }],
    notes: [{ title: "N", body: "b" }],
  };
}

const SPOTS: [string, string, (pack: Loose) => Loose][] = [
  ["the pack root", "", (p) => p],
  ["metadata", "metadata", (p) => p.metadata as Loose],
  ["agents[0]", "agents.0", (p) => (p.agents as Loose[])[0]!],
  [
    "agents[0].capabilities[1]",
    "agents.0.capabilities.1",
    (p) => ((p.agents as Loose[])[0]!.capabilities as Loose[])[1]!,
  ],
  ["skills[0]", "skills.0", (p) => (p.skills as Loose[])[0]!],
  ["notes[0]", "notes.0", (p) => (p.notes as Loose[])[0]!],
];

const VALUES: [string, unknown][] = [
  ["a string", "x"],
  ["an object", { nested: "x", deeper: { more: 1 } }],
  ["an array", [1, { a: 2 }]],
  ["null", null],
];

const shapes = (text: string) => {
  const parsedResult = parseAgentPack(JSON.parse(text));
  const previewResult = previewAgentPackText(text, context);
  return [JSON.stringify(parsedResult), JSON.stringify(previewResult)];
};

describe("F1: a secret-shaped field name is reported by location only", () => {
  for (const [spotLabel, path, pick] of SPOTS) {
    for (const [valueLabel, value] of VALUES) {
      it(`omits a secret-shaped name from messages and paths at ${spotLabel} when its value is ${valueLabel}`, () => {
        const pack = validPack();
        const holder = pick(pack);
        for (const key of Object.values(KEYS)) holder[key] = value;
        const text = JSON.stringify(pack);
        for (const output of shapes(text)) {
          for (const key of Object.values(KEYS)) expect(output).not.toContain(key);
        }
        const result = parseAgentPack(JSON.parse(text));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // The location of the object that holds the key is still reported.
          expect(result.issues.map((i) => i.path)).toContain(path);
          expect(result.issues.some((i) => i.message === "4 unrecognized fields.")).toBe(true);
        }
      });
    }
  }

  it("reports a plain unknown name as a count too, never by name", () => {
    const pack = validPack();
    (pack.agents as Loose[])[0]![PLAIN_KEY] = 1;
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ path: "agents.0", message: "1 unrecognized field." }]);
    }
  });

  it("uses the plural when two names are unrecognized", () => {
    const pack = validPack();
    Object.assign((pack.agents as Loose[])[0]!, { one: 1, two: 2 });
    const result = parseAgentPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toBe("2 unrecognized fields.");
  });

  it("omits the name from the path when a secret-shaped value sits under a secret-shaped name", () => {
    const pack = validPack();
    (pack.agents as Loose[])[0]![KEYS.github] = { inner: KEYS.aws };
    const text = JSON.stringify(pack);
    for (const output of shapes(text)) {
      expect(output).not.toContain(KEYS.github);
      expect(output).not.toContain(KEYS.aws);
    }
  });

  it("omits a secret-shaped name nested several levels deep under a secret-shaped parent", () => {
    const pack = validPack();
    (pack.agents as Loose[])[0]![PLAIN_KEY] = { [KEYS.anthropic]: [{ [KEYS.agentToken]: 1 }] };
    for (const output of shapes(JSON.stringify(pack))) {
      expect(output).not.toContain(KEYS.anthropic);
      expect(output).not.toContain(KEYS.agentToken);
    }
  });

  it("does not echo a secret-shaped name that sits in a key position of a wrong-typed value", () => {
    const pack = validPack();
    (pack.agents as Loose[])[0]!.skills = { [KEYS.github]: "S" };
    for (const output of shapes(JSON.stringify(pack))) {
      expect(output).not.toContain(KEYS.github);
    }
  });
});

describe("F1: export never echoes a secret-shaped value in its error issues", () => {
  const options = { name: "Team", now: new Date("2026-11-14T00:00:00.000Z"), appVersion: "0.1.0" };
  function source(overrides: Loose = {}): PackSource {
    return {
      agents: [
        {
          name: "Scout",
          role: "Researcher",
          model: "claude-sonnet-5-5",
          thinkingEffort: "medium",
          prompt: "Find sources.",
          mode: "strict",
          dailyBudgetCents: 500,
          skills: [],
          capabilities: [{ key: "vault.read", scope: "workspace" }],
          ...overrides,
        },
      ],
      skills: [],
    };
  }

  it.each([
    ["a role", { role: KEYS.github }],
    ["a prompt", { prompt: `use ${KEYS.aws}` }],
    ["a mode", { mode: KEYS.anthropic }],
    ["a capability scope", { capabilities: [{ key: "vault.read", scope: KEYS.agentToken }] }],
    ["a capability key", { capabilities: [{ key: KEYS.github, scope: "workspace" }] }],
  ])("lists paths only and no secret when the source carries one as %s", (_label, overrides) => {
    let thrown: unknown;
    try {
      buildAgentPack(source(overrides), options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PackExportError);
    const error = thrown as PackExportError;
    expect(error.code).toBe("invalid_pack");
    const everything = `${error.message}${JSON.stringify(error.issues)}`;
    for (const key of Object.values(KEYS)) expect(everything).not.toContain(key);
  });

  it("drops an extra secret-shaped property on a source agent instead of exporting or echoing it", () => {
    const built = buildAgentPack(source({ [KEYS.github]: "x" }), options);
    expect(built.json).not.toContain(KEYS.github);
  });
});
