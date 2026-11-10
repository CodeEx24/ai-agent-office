import { describe, expect, it } from "vitest";

import { MIN_NEVER_AUTOMATIC_TIER } from "../capabilities/capability-schemas.js";
import { STARTER_CAPABILITIES } from "../capabilities/starter-capabilities.js";
import { AGENT_MODELS, NEW_AGENT_MODE } from "./agent-limits.js";
import { createAgentSchema, resolveCapabilityGrants } from "./agent-schemas.js";
import {
  agentInputFromTemplate,
  agentTemplateSchema,
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_IDS,
  findAgentTemplate,
} from "./agent-template-schemas.js";

const WORKSPACE = "13600000-0000-4000-8000-0000000000a1";
const catalog = STARTER_CAPABILITIES.map((capability) => ({ ...capability, enabled: true }));
const tierOf = (key: string) => STARTER_CAPABILITIES.find((c) => c.key === key)?.tier;

function template(id: string) {
  const found = findAgentTemplate(id);
  if (!found) throw new Error(`no template ${id}`);
  return found;
}
const keysOf = (id: string) => template(id).capabilities.map((c) => c.key);

describe("role templates (AGO-136)", () => {
  it("has exactly the eight roles, once each", () => {
    expect(AGENT_TEMPLATES.map((t) => t.id)).toEqual([...AGENT_TEMPLATE_IDS]);
    expect(AGENT_TEMPLATES.map((t) => t.name)).toEqual([
      "Manager",
      "Researcher",
      "Analyst",
      "Writer",
      "Reviewer",
      "Developer",
      "Ops assistant",
      "Librarian",
    ]);
  });

  describe.each(AGENT_TEMPLATES.map((t) => [t.id, t] as const))("%s", (_id, t) => {
    it("is valid data", () => {
      expect(agentTemplateSchema.safeParse(t).success).toBe(true);
    });

    it("makes input the wizard's own schema accepts (AC1: a valid agent in one click)", () => {
      const input = agentInputFromTemplate(t, WORKSPACE, t.name);
      expect(input.skillIds).toEqual([]);
      expect(input.dailyBudget).toBe(t.dailyBudgetCents);
      const raw = {
        workspaceId: WORKSPACE,
        name: t.name,
        role: t.role,
        model: t.model,
        prompt: t.prompt,
        dailyBudget: (t.dailyBudgetCents / 100).toFixed(2),
        skillIds: [],
        capabilities: t.capabilities,
      };
      expect(createAgentSchema.safeParse(raw).success).toBe(true);
    });

    it("uses only enabled starter catalog keys and the catalog accepts every grant", () => {
      expect(resolveCapabilityGrants(t.capabilities, catalog).ok).toBe(true);
    });

    it("never sets a Tier 3 or 4 capability to automatic", () => {
      for (const capability of t.capabilities) {
        if ((tierOf(capability.key) ?? 0) >= MIN_NEVER_AUTOMATIC_TIER) {
          expect(capability.mode).toBe("approval");
        }
      }
    });

    it("suggests Opus, Sonnet or Fable from the allowlist, never Haiku (AC3)", () => {
      expect(AGENT_MODELS.map((m) => m.id)).toContain(t.model);
      expect(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]).toContain(t.model);
    });

    it("has no way to ask for another mode, a tier or a status", () => {
      for (const extra of ["mode", "tier", "status"]) {
        expect(agentTemplateSchema.safeParse({ ...t, [extra]: "autonomous" }).success).toBe(false);
      }
      expect(NEW_AGENT_MODE).toBe("strict");
    });

    it("is minimal: no payments, deletes, outbound messages, integrations or browsing", () => {
      const forbidden = [
        "payments.execute",
        "data.delete_irreversible",
        "message.send_outbound",
        "integration.write",
        "web.browse",
      ];
      for (const key of keysOf(t.id)) expect(forbidden).not.toContain(key);
    });

    it("never combines web, private notes and outbound messages (trifecta, AGO-138)", () => {
      const keys = keysOf(t.id);
      const untrusted = keys.some((k) => k === "web.search" || k === "web.browse");
      const privateData = keys.some((k) => k === "vault.read_private" || k === "vault.write_own");
      const outbound = keys.includes("message.send_outbound");
      expect([untrusted, privateData, outbound].filter(Boolean).length).toBeLessThan(3);
      expect(untrusted && privateData).toBe(false);
    });

    it("tells the agent that web, note and message text is data, not instructions", () => {
      expect(t.prompt).toMatch(/untrusted data/);
    });
  });

  it("AC2: the Researcher has web search and no private notes", () => {
    const keys = keysOf("researcher");
    expect(keys).toContain("web.search");
    expect(keys).not.toContain("vault.read_private");
    expect(keys).not.toContain("vault.write_own");
  });

  it("AC2: the Analyst has private notes and no web", () => {
    const keys = keysOf("analyst");
    expect(keys).toContain("vault.read_private");
    expect(keys.some((k) => k.startsWith("web."))).toBe(false);
  });

  it("every budget is within the platform cap", () => {
    for (const t of AGENT_TEMPLATES) expect(t.dailyBudgetCents).toBeLessThanOrEqual(5_000);
  });

  it("finds a template by id and returns nothing for an unknown id", () => {
    expect(findAgentTemplate("manager")?.name).toBe("Manager");
    expect(findAgentTemplate("admin")).toBeUndefined();
    expect(findAgentTemplate("__proto__")).toBeUndefined();
  });
});
