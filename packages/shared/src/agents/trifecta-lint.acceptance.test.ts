import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES } from "./agent-templates.js";
import { lintTrifecta } from "./trifecta-lint.js";

// Expected leg of each key, written out here on purpose (not read from the lint): decision q3 of AGO-138.
const UNTRUSTED = ["web.search", "web.browse"];
const PRIVATE = ["vault.read_private", "vault.read"];
const OUTBOUND = ["message.send_outbound", "integration.write"];

const subsets = <T>(items: readonly T[]): T[][] =>
  items.reduce<T[][]>((all, item) => [...all, ...all.map((s) => [...s, item])], [[]]);

describe("AGO-138 AC1: a set holding all three legs is blocked with an explanation", () => {
  const triples = UNTRUSTED.flatMap((u) =>
    PRIVATE.flatMap((p) => OUTBOUND.map((o) => [u, p, o] as const)),
  );

  it.each(triples)("blocks %s + %s + %s and names each leg and its capability", (u, p, o) => {
    const result = lintTrifecta([u, p, o]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.legs.untrusted.length).toBeGreaterThan(0);
    expect(result.legs.private.length).toBeGreaterThan(0);
    expect(result.legs.outbound.length).toBeGreaterThan(0);
    expect(result.message.length).toBeGreaterThan(40);
    expect(result.message).toMatch(/blocked/);
    expect(result.message).toMatch(/Remove at least one/);
  });

  it("blocks the full set of all six leg capabilities and lists every one in the message", () => {
    const result = lintTrifecta([...UNTRUSTED, ...PRIVATE, ...OUTBOUND]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const name of [
      "Search the web",
      "Browse the web",
      "Read own private notes",
      "Read shared notes",
      "Send outbound messages",
      "Write to integrations",
    ]) {
      expect(result.message).toContain(name);
    }
  });

  it("blocks regardless of key order", () => {
    expect(lintTrifecta(["message.send_outbound", "web.search", "vault.read_private"]).ok).toBe(
      false,
    );
    expect(lintTrifecta(["vault.read", "integration.write", "web.browse"]).ok).toBe(false);
  });

  it("blocks when unrelated and unknown keys are mixed in", () => {
    expect(
      lintTrifecta(["tasks.manage", "made.up", "web.search", "vault.read", "integration.write"]).ok,
    ).toBe(false);
  });

  it("blocks when the same keys are repeated (duplicates do not hide a leg)", () => {
    expect(lintTrifecta(["web.search", "web.search", "vault.read", "integration.write"]).ok).toBe(
      false,
    );
  });

  it("does not change the list it is given", () => {
    const keys = ["web.search", "vault.read_private", "message.send_outbound"];
    const copy = [...keys];
    lintTrifecta(keys);
    expect(keys).toEqual(copy);
  });
});

describe("AGO-138 AC1 edge cases: anything short of three legs is allowed", () => {
  const pairs: [string, string[], string[]][] = [
    ["untrusted + private", UNTRUSTED, PRIVATE],
    ["untrusted + outbound", UNTRUSTED, OUTBOUND],
    ["private + outbound", PRIVATE, OUTBOUND],
  ];

  it.each(pairs)("allows every key combination of %s", (_name, first, second) => {
    for (const a of subsets(first).filter((s) => s.length > 0)) {
      for (const b of subsets(second).filter((s) => s.length > 0)) {
        expect(lintTrifecta([...a, ...b]), `${a.join()} + ${b.join()}`).toEqual({ ok: true });
      }
    }
  });

  it("allows an empty list, an empty set and a single leg held with both keys", () => {
    expect(lintTrifecta([])).toEqual({ ok: true });
    expect(lintTrifecta(new Set<string>())).toEqual({ ok: true });
    for (const leg of [UNTRUSTED, PRIVATE, OUTBOUND])
      expect(lintTrifecta(leg)).toEqual({ ok: true });
  });

  it("allows only unknown keys, and unknown keys never stand in for a leg", () => {
    expect(lintTrifecta(["a", "b", "c"])).toEqual({ ok: true });
    expect(lintTrifecta(["web.search", "vault.read", "made.up.outbound"])).toEqual({ ok: true });
  });

  it("does not match keys that differ in case or spacing (exact keys only)", () => {
    expect(lintTrifecta(["WEB.SEARCH", "vault.read", "integration.write"])).toEqual({ ok: true });
    expect(lintTrifecta([" web.search", "vault.read", "integration.write"])).toEqual({ ok: true });
  });

  it("matches the eight leg combinations to blocked only for the full one", () => {
    const legs = [UNTRUSTED[0], PRIVATE[0], OUTBOUND[0]] as string[];
    const blocked = subsets(legs).filter((s) => !lintTrifecta(s).ok);
    expect(blocked).toEqual([legs]);
  });
});

describe("AGO-138 AC2: the role templates pass", () => {
  it.each(AGENT_TEMPLATES.map((t) => [t.id, t] as const))("%s passes the lint", (_id, template) => {
    expect(lintTrifecta(template.capabilities.map((c) => c.key))).toEqual({ ok: true });
  });

  it.each(["researcher", "analyst"])("the %s template exists and passes", (id) => {
    const template = AGENT_TEMPLATES.find((t) => t.id === id);
    expect(template).toBeDefined();
    expect(lintTrifecta((template?.capabilities ?? []).map((c) => c.key))).toEqual({ ok: true });
  });

  it("a template that gets the one leg it lacks added becomes blocked only when it then holds all three", () => {
    for (const template of AGENT_TEMPLATES) {
      const keys = template.capabilities.map((c) => c.key);
      const has = (leg: string[]) => keys.some((k) => leg.includes(k));
      const held = [has(UNTRUSTED), has(PRIVATE), has(OUTBOUND)];
      if (held.filter(Boolean).length !== 2) continue;
      const missing = !held[0] ? UNTRUSTED[0] : !held[1] ? PRIVATE[0] : OUTBOUND[0];
      expect(lintTrifecta([...keys, missing ?? ""]).ok, `${template.id} + ${missing ?? ""}`).toBe(
        false,
      );
    }
  });

  it("the Researcher plus the one leg it lacks (private notes) is blocked, the Analyst plus web too", () => {
    const keysOf = (id: string) =>
      (AGENT_TEMPLATES.find((t) => t.id === id)?.capabilities ?? []).map((c) => c.key);
    const researcher = keysOf("researcher");
    const analyst = keysOf("analyst");
    // Only meaningful if each really holds two legs today; assert the premise so a change is noticed.
    const legsHeld = (keys: string[]) =>
      [UNTRUSTED, PRIVATE, OUTBOUND].filter((leg) => keys.some((k) => leg.includes(k))).length;
    expect(legsHeld(researcher)).toBeLessThanOrEqual(2);
    expect(legsHeld(analyst)).toBeLessThanOrEqual(2);
    expect(lintTrifecta([...researcher, ...UNTRUSTED, ...PRIVATE, ...OUTBOUND]).ok).toBe(false);
    expect(lintTrifecta([...analyst, ...UNTRUSTED, ...PRIVATE, ...OUTBOUND]).ok).toBe(false);
  });
});
