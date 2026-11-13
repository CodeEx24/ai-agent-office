import { describe, expect, it } from "vitest";

import { STARTER_CAPABILITIES } from "../capabilities/starter-capabilities.js";
import { AGENT_TEMPLATES } from "./agent-templates.js";
import { lintTrifecta, trifectaMappedKeys } from "./trifecta-lint.js";

const U = "web.search";
const P = "vault.read_private";
const O = "message.send_outbound";

/** Starter capabilities that deliberately carry no leg. Add a new capability here or map it in the lint. */
const NEUTRAL = new Set([
  "tasks.manage",
  "vault.write_own",
  "vault.write_shared",
  "code.run",
  "payments.execute",
  "data.delete_irreversible",
]);

describe("lintTrifecta", () => {
  it("AC1: blocks a set with untrusted content, private data and outbound, with an explanation", () => {
    const result = lintTrifecta([U, P, O]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/^Capabilities:/);
    expect(result.message).toContain("untrusted content");
    expect(result.message).toContain("private data");
    expect(result.message).toContain("out of the workspace");
    expect(result.message).toContain("Search the web");
    expect(result.message).toContain("Read own private notes");
    expect(result.message).toContain("Send outbound messages");
    expect(result.message).toMatch(/Remove at least one/);
  });

  it.each([[[]], [[U]], [[P]], [[O]], [[U, P]], [[U, O]], [[P, O]]])(
    "passes %j (fewer than three legs)",
    (keys) => {
      expect(lintTrifecta(keys)).toEqual({ ok: true });
    },
  );

  it.each([
    ["web.browse", "vault.read", "integration.write"],
    ["web.search", "vault.read", "message.send_outbound"],
    ["web.browse", "vault.read_private", "integration.write"],
  ])("blocks the broader mapping %s + %s + %s", (u, p, o) => {
    expect(lintTrifecta([u, p, o]).ok).toBe(false);
  });

  it("ignores capabilities with no leg and unknown keys", () => {
    expect(lintTrifecta([U, P, "tasks.manage", "code.run", "made.up"])).toEqual({ ok: true });
    expect(lintTrifecta([U, P, O, "made.up"]).ok).toBe(false);
  });

  it("accepts any iterable and ignores repeats", () => {
    expect(lintTrifecta(new Set([U, P, O])).ok).toBe(false);
    expect(lintTrifecta([U, U, P, P]).ok).toBe(true);
  });

  it("maps every starter capability or lists it as neutral", () => {
    const mapped = new Set(trifectaMappedKeys());
    for (const { key } of STARTER_CAPABILITIES) {
      expect(mapped.has(key) || NEUTRAL.has(key), `${key} needs a decision`).toBe(true);
    }
    for (const key of mapped) {
      expect(
        STARTER_CAPABILITIES.some((capability) => capability.key === key),
        key,
      ).toBe(true);
    }
  });

  it("AC2: the Researcher and the Analyst pass, and so does every template", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(lintTrifecta(template.capabilities.map((c) => c.key)), template.id).toEqual({
        ok: true,
      });
    }
    for (const id of ["researcher", "analyst"]) {
      const template = AGENT_TEMPLATES.find((t) => t.id === id);
      expect(template).toBeDefined();
    }
  });
});
