import { describe, expect, it } from "vitest";

import {
  assignSkillSchema,
  createSkillSchema,
  saveSkillSchema,
  SKILL_BODY_MAX_LENGTH,
  skillSchema,
  skillVersionSchema,
} from "./skill-schemas.js";

const ID = "12800000-0000-4000-8000-0000000000a1";
const OTHER = "12800000-0000-4000-8000-0000000000a2";

describe("createSkillSchema", () => {
  const valid = { workspaceId: ID, name: "  Research  ", description: " d ", body: "# Hi" };

  it("trims the name and description", () => {
    expect(createSkillSchema.parse(valid)).toMatchObject({ name: "Research", description: "d" });
  });

  it("rejects an empty or whitespace name", () => {
    expect(createSkillSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("rejects a name over 120 characters", () => {
    expect(createSkillSchema.safeParse({ ...valid, name: "x".repeat(121) }).success).toBe(false);
  });

  it("accepts text of exactly the maximum size and rejects one more character", () => {
    const atLimit = { ...valid, body: "x".repeat(SKILL_BODY_MAX_LENGTH) };
    expect(createSkillSchema.safeParse(atLimit).success).toBe(true);
    expect(createSkillSchema.safeParse({ ...atLimit, body: atLimit.body + "x" }).success).toBe(
      false,
    );
  });

  it("normalises CRLF line breaks from a browser form to LF", () => {
    expect(createSkillSchema.parse({ ...valid, body: "a\r\nb\rc\nd" }).body).toBe("a\nb\nc\nd");
  });

  it("counts the size limit after normalising line breaks", () => {
    const crlf = "x\r\n".repeat(SKILL_BODY_MAX_LENGTH / 2);
    expect(createSkillSchema.safeParse({ ...valid, body: crlf }).success).toBe(true);
  });
  it("rejects unknown keys, so a caller cannot smuggle a version or workspace override", () => {
    expect(createSkillSchema.safeParse({ ...valid, version: 9 }).success).toBe(false);
  });

  it("rejects a workspace id that is not a uuid", () => {
    expect(createSkillSchema.safeParse({ ...valid, workspaceId: "nope" }).success).toBe(false);
  });
});

describe("saveSkillSchema", () => {
  const valid = {
    workspaceId: ID,
    skillId: OTHER,
    expectedVersion: "3",
    description: "",
    body: "text",
  };

  it("coerces the expected version from a form string", () => {
    expect(saveSkillSchema.parse(valid).expectedVersion).toBe(3);
  });

  it.each(["0", "-1", "1.5", "abc", ""])("rejects expected version %j", (expectedVersion) => {
    expect(saveSkillSchema.safeParse({ ...valid, expectedVersion }).success).toBe(false);
  });

  it("rejects text over the maximum size", () => {
    const body = "x".repeat(SKILL_BODY_MAX_LENGTH + 1);
    expect(saveSkillSchema.safeParse({ ...valid, body }).success).toBe(false);
  });
});

describe("assignSkillSchema", () => {
  it("needs three uuids and nothing else", () => {
    const ok = { workspaceId: ID, skillId: OTHER, agentId: ID };
    expect(assignSkillSchema.safeParse(ok).success).toBe(true);
    expect(assignSkillSchema.safeParse({ ...ok, agentId: "x" }).success).toBe(false);
    expect(assignSkillSchema.safeParse({ ...ok, pinnedVersion: 1 }).success).toBe(false);
  });
});

describe("row schemas", () => {
  it("parses a skill row and a version row", () => {
    expect(
      skillSchema.safeParse({
        id: ID,
        workspaceId: ID,
        name: "n",
        description: "",
        body: "b",
        version: 2,
        createdAt: "2026-11-06T00:00:00Z",
        updatedAt: "2026-11-06T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      skillVersionSchema.safeParse({
        id: ID,
        skillId: OTHER,
        version: 1,
        body: "b",
        createdBy: null,
        createdAt: "2026-11-06T00:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("rejects version 0", () => {
    expect(
      skillVersionSchema.safeParse({
        id: ID,
        skillId: OTHER,
        version: 0,
        body: "",
        createdBy: null,
        createdAt: "x",
      }).success,
    ).toBe(false);
  });
});
