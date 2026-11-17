// AGO-194 hardening: the trifecta lint on an update judges what the agent will hold (existing plus imported), a
// rename never splits a surrogate pair, and unstorable text is refused at the boundary. Pure plan tests: no database.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildImportPlan } from "./agent-pack-import-plan.js";
import {
  PACK_INVISIBLE_RANGES,
  isInvisibleCodePoint,
  renamedCopyName,
  stripInvisibleText,
  validatePackText,
  type PreviewContext,
} from "./agent-pack-import-preview.js";

const CATALOG = [
  { key: "web.search", tier: 1, scope: "workspace" },
  { key: "vault.read", tier: 0, scope: "workspace" },
  // The starter catalog keeps outbound capabilities at Tier 3; a workspace can lower one, so the test does too.
  { key: "message.send_outbound", tier: 2, scope: "workspace" },
];

function packText(capabilities: string[], prompt: string): string {
  return JSON.stringify({
    packVersion: 1,
    metadata: { name: "Hardening", exportedAt: "2026-11-17T00:00:00Z", appVersion: "0.1.0" },
    agents: [
      {
        name: "Courier",
        role: "Courier",
        model: "claude-haiku-5-5",
        thinkingEffort: "medium",
        prompt,
        skills: [],
        capabilities: capabilities.map((name) => ({ name, scope: "workspace" })),
        dailyBudgetCents: 100,
        autonomyMode: "strict",
      },
    ],
    skills: [],
  });
}

function context(held: string[]): PreviewContext {
  return {
    existingAgents: [
      {
        name: "Courier",
        role: "Courier",
        model: "claude-haiku-5-5",
        thinkingEffort: "medium",
        prompt: "old",
        archived: false,
        capabilities: held,
      },
    ],
    existingSkills: [],
    catalog: CATALOG,
    conflictRule: "new_version",
  };
}

function planOf(text: string, ctx: PreviewContext) {
  const validated = validatePackText(text);
  if (!validated.ok) throw new Error("the test pack must validate");
  return buildImportPlan(validated.pack, ctx);
}

describe("trifecta on update (existing capabilities UNION the pack's)", () => {
  it("applies the update and disables the agent when the union completes the trifecta", () => {
    const { preview, plan } = planOf(
      packText(["web.search", "vault.read"], "new"),
      context(["message.send_outbound"]),
    );
    expect(preview.agents[0]).toMatchObject({ action: "update" });
    expect(preview.agents[0]?.importDisabled?.reason).toBe("trifecta_combination");
    expect(preview.summary.disabled).toBe(1);
    expect(plan.agents[0]).toMatchObject({
      action: "update",
      disabled_reason: "trifecta_combination",
    });
  });

  it("does not disable an update whose union stays below the trifecta", () => {
    const { preview, plan } = planOf(packText(["vault.read"], "new"), context(["web.search"]));
    expect(preview.agents[0]?.importDisabled).toBeNull();
    expect(preview.summary.disabled).toBe(0);
    expect(plan.agents[0]?.disabled_reason).toBeNull();
  });

  it("leaves an existing agent untouched when the pack alone is a trifecta (the update is skipped)", () => {
    const { preview } = planOf(
      packText(["web.search", "vault.read", "message.send_outbound"], "new"),
      context([]),
    );
    expect(preview.agents[0]?.action).toBe("skip");
  });
});

describe("renamedCopyName on code points", () => {
  it("never splits a surrogate pair and stays within 120 UTF-16 units", () => {
    const name = "\u{1F600}".repeat(60); // 120 units
    const copy = renamedCopyName(name, new Set());
    expect(copy.length).toBeLessThanOrEqual(120);
    expect(copy.endsWith(" (imported)")).toBe(true);
    expect(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(copy),
    ).toBe(false);
  });
});

describe("renamedCopyName on grapheme clusters", () => {
  it.each([
    ["a joined family emoji", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"],
    ["a base with a combining accent", "e\u0301"],
    ["a flag", "\u{1F1F5}\u{1F1ED}"],
  ])("never cuts %s in half", (_label, cluster) => {
    const suffix = " (imported)";
    // The cluster starts `pad` units before the cut, so it does not fit: it is dropped whole, never cut in half.
    const room = 120 - suffix.length;
    for (let pad = 1; pad < cluster.length; pad += 1) {
      const name = `${"x".repeat(room - pad)}${cluster}${"y".repeat(10)}`;
      const copy = renamedCopyName(name, new Set());
      expect(copy).toBe(`${"x".repeat(room - pad)}${suffix}`);
    }
  });
});

describe("an update that leaves Strict mode", () => {
  function contextWithMode(mode: string | undefined): PreviewContext {
    const base = context(["vault.read"]);
    const [agent] = base.existingAgents;
    if (!agent) throw new Error("the context has one agent");
    return { ...base, existingAgents: [{ ...agent, mode }] };
  }

  it.each([
    ["standard", "standard"],
    ["relaxed", "relaxed"],
    ["strict", null],
    [undefined, null],
  ])(
    "an existing %s agent: the preview shows %s and the plan is the same either way",
    (mode, expected) => {
      const text = packText(["vault.read"], "new prompt");
      const withMode = planOf(text, contextWithMode(mode));
      const strict = planOf(text, contextWithMode("strict"));
      expect(withMode.preview.agents[0]).toMatchObject({
        action: "update",
        resetsModeFrom: expected,
      });
      // The plan carries no mode: the database decides it, so preview and apply cannot drift.
      expect(withMode.plan).toEqual(strict.plan);
      expect(JSON.stringify(withMode.plan)).not.toContain('"mode"');
    },
  );

  it("does not show a reset for a skipped agent (nothing is written)", () => {
    const skipped = planOf(packText(["vault.read"], "old"), {
      ...contextWithMode("relaxed"),
      conflictRule: "skip",
    });
    expect(skipped.preview.agents[0]).toMatchObject({ action: "skip", resetsModeFrom: null });
  });
});

describe("the shared invisible-character set", () => {
  it("strips every range, at both ends, and nothing else", () => {
    for (const [from, to] of PACK_INVISIBLE_RANGES) {
      expect(
        stripInvisibleText(`a${String.fromCodePoint(from)}b${String.fromCodePoint(to)}c`),
      ).toBe("abc");
    }
    expect(stripInvisibleText("Zo\u00eb \u4e2d\u6587 \u{1F600}")).toBe(
      "Zo\u00eb \u4e2d\u6587 \u{1F600}",
    );
  });

  it("includes the characters the review named", () => {
    for (const code of [
      0x061c, 0x00ad, 0x034f, 0x180e, 0x200b, 0x200f, 0x202a, 0x2060, 0x2064, 0x2066, 0xfeff,
      0xe0000, 0xe007f,
    ]) {
      expect(isInvisibleCodePoint(code)).toBe(true);
    }
    expect(isInvisibleCodePoint(0x0020)).toBe(false);
    expect(isInvisibleCodePoint(0x2065)).toBe(false);
  });

  it("is the same set the migration scrubs event names with (parsed from the SQL character class)", () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../supabase/migrations/20261117030001_ago_194_pack_import.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const match = /regexp_replace\(v_agent ->> 'name',\s*'\[([^\]]+)\]'/.exec(sql);
    expect(match).not.toBeNull();
    const cls = match?.[1] ?? "";
    // Only escapes: no raw invisible character is hidden in the migration.
    expect(/^(?:\\u[0-9A-F]{4}|\\U[0-9A-F]{8}|-)+$/.test(cls)).toBe(true);
    const ranges = [...cls.matchAll(/\\[uU]([0-9A-F]+)(?:-\\[uU]([0-9A-F]+))?/g)].map(
      (m): [number, number] => {
        const from = Number.parseInt(m[1] ?? "0", 16);
        return [from, m[2] === undefined ? from : Number.parseInt(m[2], 16)];
      },
    );
    expect(ranges).toEqual(PACK_INVISIBLE_RANGES.map(([from, to]) => [from, to]));
  });
});

describe("unstorable text is refused at the boundary", () => {
  it.each([
    ["NUL in a prompt", "a\u0000b"],
    ["a lone high surrogate", "a\ud800b"],
    ["a lone low surrogate", "a\udc00b"],
  ])("%s gives invalid_pack naming the field and no text", (_label, dirty) => {
    const result = validatePackText(packText(["vault.read"], dirty));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_pack");
    expect(result.error.issues?.map((issue) => issue.path)).toEqual(["agents.0.prompt"]);
  });

  it("accepts a valid surrogate pair", () => {
    expect(validatePackText(packText(["vault.read"], "ok \u{1F600}")).ok).toBe(true);
  });
});
