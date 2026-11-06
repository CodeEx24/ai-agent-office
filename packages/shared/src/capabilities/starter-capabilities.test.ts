import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { capabilityDefinitionSchema } from "./capability-schemas.js";
import { STARTER_CAPABILITIES } from "./starter-capabilities.js";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20261106140001_ago_125_capability_catalog.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The rows of the VALUES list inside private.seed_workspace_capabilities(). */
function seededRows() {
  const rowPattern =
    /^\s*\('([a-z_.]+)', '((?:[^']|'')*)', '((?:[^']|'')*)', (\d), '(\w+)', '(\w+)'\),?$/gm;
  return [...migration.matchAll(rowPattern)].map((m) => ({
    key: m[1],
    name: m[2]?.replaceAll("''", "'"),
    description: m[3]?.replaceAll("''", "'"),
    tier: Number(m[4]),
    scope: m[5],
    defaultMode: m[6],
  }));
}

describe("STARTER_CAPABILITIES", () => {
  it("holds the 12 starter capabilities AGO-125 promises, all valid", () => {
    expect(STARTER_CAPABILITIES).toHaveLength(12);
    for (const definition of STARTER_CAPABILITIES) {
      expect(capabilityDefinitionSchema.safeParse(definition).success, definition.key).toBe(true);
    }
    expect(new Set(STARTER_CAPABILITIES.map((c) => c.key)).size).toBe(12);
  });

  it("covers every tier from 0 to 4", () => {
    expect(new Set(STARTER_CAPABILITIES.map((c) => c.tier))).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("never makes a tier 3 or 4 capability automatic", () => {
    const risky = STARTER_CAPABILITIES.filter((c) => c.tier >= 3);
    expect(risky.length).toBeGreaterThan(0);
    for (const capability of risky) expect(capability.defaultMode).toBe("approval");
  });

  it("matches the rows seeded by the migration (a drift fails here)", () => {
    expect(seededRows()).toEqual(STARTER_CAPABILITIES.map((c) => ({ ...c })));
  });
});
