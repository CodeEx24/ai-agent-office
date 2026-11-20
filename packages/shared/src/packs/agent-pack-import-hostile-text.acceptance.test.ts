// AGO-194 functional acceptance tests (tester-functional, round 2): the pure side of the hostile-text fixes.
// Text the database cannot store (NUL, a lone or reversed surrogate) is refused at the boundary with a 422-shaped
// `invalid_pack` naming the field path and never repeating the text, in every text field and field name; a valid
// surrogate pair (an emoji) is still accepted; a rename never produces a lone surrogate.
// No database: runs with the normal `pnpm test`.
import { describe, expect, it } from "vitest";

import {
  renamedCopyName,
  validatePackText,
  type PackRejectionIssue,
} from "./agent-pack-import-preview.js";

type Loose = Record<string, unknown>;

const MARK = "MARKER-HOSTILE-TEXT"; // printable text next to the bad character: it must never come back in an answer

const DIRTY: [string, string][] = [
  ["a NUL character", `${MARK}\u0000tail`],
  ["a lone high surrogate", `${MARK}\ud800tail`],
  ["a lone low surrogate", `${MARK}\udc00tail`],
  ["a reversed surrogate pair", `${MARK}\udc00\ud800tail`],
  ["a high surrogate at the very end", `${MARK}\ud83d`],
];

const baseAgent = (): Loose => ({
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5",
  thinkingEffort: "medium",
  prompt: "Find sources.",
  skills: ["Cite"],
  capabilities: [{ name: "vault.read", scope: "workspace" }],
  dailyBudgetCents: 500,
  autonomyMode: "strict",
  department: "Research",
  secretRefs: ["secret:crm_api_key"],
});

const basePack = (): Loose => ({
  packVersion: 1,
  metadata: { name: "Pack", exportedAt: "2026-11-17T00:00:00Z", appVersion: "0.1.0" },
  agents: [baseAgent()],
  skills: [{ name: "Cite", version: 1, body: "Cite sources." }],
  notes: [{ title: "Note", body: "A note." }],
});

/** The pack with `dirty` placed at `path` (dot path through objects and arrays). */
function withValueAt(path: string, dirty: string): string {
  const pack = basePack();
  const parts = path.split(".");
  let node: unknown = pack;
  for (const part of parts.slice(0, -1)) {
    node = (node as Record<string, unknown>)[part];
  }
  (node as Record<string, unknown>)[parts[parts.length - 1]!] = dirty;
  return JSON.stringify(pack);
}

const FIELDS = [
  "metadata.name",
  "metadata.appVersion",
  "metadata.exportedAt",
  "agents.0.name",
  "agents.0.role",
  "agents.0.model",
  "agents.0.thinkingEffort",
  "agents.0.prompt",
  "agents.0.department",
  "agents.0.autonomyMode",
  "agents.0.skills.0",
  "agents.0.secretRefs.0",
  "agents.0.capabilities.0.name",
  "agents.0.capabilities.0.scope",
  "skills.0.name",
  "skills.0.body",
  "notes.0.title",
  "notes.0.body",
] as const;

function refusal(text: string): { code: string; issues: PackRejectionIssue[]; echoed: string } {
  const result = validatePackText(text);
  if (result.ok) throw new Error("expected the pack to be refused");
  return {
    code: result.error.code,
    issues: result.error.issues ?? [],
    echoed: JSON.stringify(result.error),
  };
}

describe("hostile text: NUL and invalid UTF-16 are refused in every text field, naming the path", () => {
  for (const field of FIELDS) {
    for (const [label, dirty] of DIRTY) {
      it(`refuses ${label} in ${field} with invalid_pack naming that field and not repeating the text`, () => {
        const { code, issues, echoed } = refusal(withValueAt(field, dirty));
        expect(code).toBe("invalid_pack");
        expect(issues.map((issue) => issue.path)).toEqual([field]);
        expect(issues[0]!.message).toMatch(/NUL character or an invalid Unicode/);
        expect(echoed).not.toContain(MARK);
        expect(echoed).not.toContain("tail");
        expect(echoed).not.toContain("\u0000");
      });
    }
  }

  it("refuses a field in a later agent and reports the index of that agent", () => {
    const pack = basePack();
    pack.agents = [
      baseAgent(),
      { ...baseAgent(), name: "Second" },
      { ...baseAgent(), name: "Third", prompt: "a\u0000b" },
    ];
    const { issues } = refusal(JSON.stringify(pack));
    expect(issues.map((issue) => issue.path)).toEqual(["agents.2.prompt"]);
  });

  it("refuses bad text in an ignored field the import would only report, because the whole file is checked first", () => {
    // notes and departments are never stored, but the file is one unit: refused, not half-read.
    for (const field of ["notes.0.body", "agents.0.department", "agents.0.secretRefs.0"]) {
      expect(refusal(withValueAt(field, "x\u0000y")).code).toBe("invalid_pack");
    }
  });

  it("names every offending field up to a bounded number and never more", () => {
    const pack = basePack();
    pack.agents = Array.from({ length: 60 }, (_, index) => ({
      ...baseAgent(),
      name: `Agent ${String(index)}`,
      prompt: "a\u0000b",
    }));
    const { issues } = refusal(JSON.stringify(pack));
    expect(issues.length).toBeGreaterThan(1);
    expect(issues.length).toBeLessThanOrEqual(50);
  });

  const FIELD_NAME_PLACES = ["", "metadata", "agents.0", "skills.0", "notes.0"] as const;
  for (const place of FIELD_NAME_PLACES) {
    for (const [label, bad] of [
      ["a NUL", "bad\u0000key"],
      ["a lone surrogate", "bad\ud800key"],
    ] as const) {
      it(`refuses ${label} in a field name at ${place === "" ? "the top level" : place} with a clean 4xx shape`, () => {
        const pack = basePack();
        let node: Loose = pack;
        for (const part of place === "" ? [] : place.split(".")) {
          node = node[part] as Loose;
        }
        node[bad] = 1;
        const { code, issues, echoed } = refusal(JSON.stringify(pack));
        expect(code).toBe("invalid_pack");
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path.startsWith(place)).toBe(true);
        expect(issues[0]!.path.length).toBeLessThanOrEqual(203);
        expect(echoed).not.toContain("\u0000");
      });
    }
  }

  it("refuses a bad field name nested in an unknown object and does not walk past the depth guard", () => {
    const pack = basePack();
    (pack.agents as Loose[])[0]!.extra = { nested: { "k\u0000": 1 } };
    const { code, issues } = refusal(JSON.stringify(pack));
    expect(code).toBe("invalid_pack");
    expect(issues[0]!.path.startsWith("agents.0.extra.nested.")).toBe(true);
  });

  it("still accepts a valid surrogate pair (an emoji) in text, written raw or as an escape", () => {
    const raw = withValueAt("agents.0.prompt", "Find 😀 sources");
    expect(validatePackText(raw).ok).toBe(true);
    const escaped = withValueAt("agents.0.prompt", "x").replace('"x"', '"a\\ud83d\\ude00b"');
    expect(validatePackText(escaped).ok).toBe(true);
  });

  it("still accepts other control characters, which are stored as data and cleaned only where they are displayed", () => {
    for (const ok of ["tab\there", "line\nbreak", "esc\u001b[31m", "rlo\u202etext", "zw\u200bsp"]) {
      expect(validatePackText(withValueAt("agents.0.prompt", ok)).ok).toBe(true);
    }
  });
});

const isWellFormed = (text: string): boolean => {
  try {
    encodeURIComponent(text); // throws on an unpaired surrogate
    return true;
  } catch {
    return false;
  }
};

describe("rename: the copy name is cut on whole code points and stays within 120 units", () => {
  const SUFFIX = " (imported)";
  const MAX = 120;

  it("never splits a surrogate pair when the cut falls inside an emoji", () => {
    // 108 ASCII + a 2-unit emoji: the budget is 120 - 11 = 109 units, so a unit-level cut lands inside the emoji.
    for (const emoji of ["😀", "🧑", "𝔘", "🇦"]) {
      const name = `${"a".repeat(108)}${emoji}${"b".repeat(10)}`.slice(0, MAX);
      const out = renamedCopyName(name, new Set([name]));
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(MAX);
      expect(out.endsWith(SUFFIX)).toBe(true);
    }
  });

  it("stays well formed for every possible cut position of a name made of emoji", () => {
    for (let ascii = 0; ascii < 6; ascii += 1) {
      const name = `${"x".repeat(ascii)}${"😀".repeat(60)}`.slice(0, MAX);
      const safeName = isWellFormed(name) ? name : name.slice(0, -1);
      const out = renamedCopyName(safeName, new Set([safeName]));
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(MAX);
    }
  });

  it("keeps a ZWJ sequence or a combining mark from producing malformed text, and the repeated suffix still fits", () => {
    const family = "👨\u200d👩\u200d👧\u200d👦"; // 11 UTF-16 units
    const names = [
      `${"a".repeat(100)}${family}`,
      `${"a".repeat(108)}é`,
      `${"a".repeat(104)}${family}`.slice(0, MAX),
    ];
    for (const name of names) {
      const taken = new Set([name]);
      let candidate = renamedCopyName(name, taken);
      for (let n = 0; n < 12; n += 1) {
        expect(isWellFormed(candidate)).toBe(true);
        expect(candidate.length).toBeLessThanOrEqual(MAX);
        expect(taken.has(candidate)).toBe(false);
        taken.add(candidate);
        candidate = renamedCopyName(name, taken);
      }
    }
  });

  const family = "👨\u200d👩\u200d👧\u200d👦"; // one grapheme, 11 units
  const clusterCases: [string, string][] = [
    ["a ZWJ family emoji", `${"a".repeat(100)}${family}`],
    ["a letter with a combining accent", `${"a".repeat(108)}e\u0301`],
    ["a flag made of two regional indicators", `${"a".repeat(108)}🇦🇺b`],
    ["a skin-tone modifier sequence", `${"a".repeat(108)}👍🏽b`],
  ];
  for (const [label, name] of clusterCases) {
    it(`cuts the name on a grapheme boundary when the budget ends inside ${label}`, () => {
      const out = renamedCopyName(name, new Set([name]));
      const kept = out.slice(0, out.length - SUFFIX.length);
      const boundaries = new Set<number>();
      for (const part of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(name)) {
        boundaries.add(part.index + part.segment.length);
      }
      boundaries.add(0);
      // The kept text is a prefix of the name that ends where a whole user-perceived character ends (a trailing
      // space the trim removed is the only allowed difference).
      expect(name.startsWith(kept)).toBe(true);
      expect(boundaries.has(kept.length)).toBe(true);
    });
  }

  it("returns a name that is not taken, counting up", () => {
    const taken = new Set(["Scout", "Scout (imported)", "Scout (imported 2)"]);
    expect(renamedCopyName("Scout", taken)).toBe("Scout (imported 3)");
  });
});
