// AGO-194 hardening: the trifecta lint on an update judges what the agent will hold (existing plus imported), a
// rename never splits a surrogate pair, and unstorable text is refused at the boundary. Pure plan tests: no database.
import { describe, expect, it } from "vitest";

import { buildImportPlan } from "./agent-pack-import-plan.js";
import {
  renamedCopyName,
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
