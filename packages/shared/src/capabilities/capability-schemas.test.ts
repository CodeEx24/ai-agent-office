import { describe, expect, it } from "vitest";

import {
  capabilityDefinitionSchema,
  capabilityKeySchema,
  capabilitySchema,
  isAllowedDefaultMode,
  listCapabilitiesQuerySchema,
  listCapabilitiesResponseSchema,
} from "./capability-schemas.js";

const ID = "12500000-0000-4000-8000-0000000000a1";
const row = {
  id: ID,
  workspaceId: ID,
  key: "vault.read",
  name: "Read shared notes",
  description: "",
  tier: 0,
  scope: "workspace",
  defaultMode: "automatic",
  enabled: true,
  createdAt: "2026-11-06T00:00:00Z",
  updatedAt: "2026-11-06T00:00:00Z",
};

describe("isAllowedDefaultMode", () => {
  it.each([0, 1, 2] as const)("allows automatic at tier %i", (tier) => {
    expect(isAllowedDefaultMode(tier, "automatic")).toBe(true);
  });
  it.each([3, 4] as const)("rejects automatic at tier %i", (tier) => {
    expect(isAllowedDefaultMode(tier, "automatic")).toBe(false);
    expect(isAllowedDefaultMode(tier, "approval")).toBe(true);
  });
});

describe("capability schemas", () => {
  it("accepts a catalog row", () => {
    expect(capabilitySchema.safeParse(row).success).toBe(true);
  });

  it.each([3, 4])("rejects an automatic tier %i row", (tier) => {
    expect(capabilitySchema.safeParse({ ...row, tier }).success).toBe(false);
    const definition = {
      key: "x.y",
      name: "X",
      description: "",
      tier,
      scope: "external",
      defaultMode: "automatic",
    };
    expect(capabilityDefinitionSchema.safeParse(definition).success).toBe(false);
  });

  it("rejects tier 5, an unknown scope and unknown keys", () => {
    expect(capabilitySchema.safeParse({ ...row, tier: 5 }).success).toBe(false);
    expect(capabilitySchema.safeParse({ ...row, scope: "galaxy" }).success).toBe(false);
    expect(capabilitySchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
  });

  it("validates keys", () => {
    expect(capabilityKeySchema.safeParse("web.search").success).toBe(true);
    for (const bad of [
      "web",
      "Web.search",
      "web.",
      ".search",
      "web search",
      "web.search".repeat(20),
    ]) {
      expect(capabilityKeySchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("requires a uuid workspace_id and nothing else in the query", () => {
    expect(listCapabilitiesQuerySchema.safeParse({ workspace_id: ID }).success).toBe(true);
    expect(listCapabilitiesQuerySchema.safeParse({ workspace_id: "nope" }).success).toBe(false);
    expect(listCapabilitiesQuerySchema.safeParse({}).success).toBe(false);
    expect(listCapabilitiesQuerySchema.safeParse({ workspace_id: ID, x: "1" }).success).toBe(false);
  });

  it("parses a response body", () => {
    expect(listCapabilitiesResponseSchema.safeParse({ capabilities: [row] }).success).toBe(true);
  });
});
