import { describe, expect, it } from "vitest";

import { WORKSPACE_ROLES, hasMinRole, workspaceRoleSchema } from "./roles.js";

describe("workspace roles", () => {
  it("lists roles from least to most privileged", () => {
    expect(WORKSPACE_ROLES).toEqual(["viewer", "member", "owner"]);
  });

  it.each([
    ["viewer", "viewer", true],
    ["viewer", "member", false],
    ["viewer", "owner", false],
    ["member", "viewer", true],
    ["member", "member", true],
    ["member", "owner", false],
    ["owner", "viewer", true],
    ["owner", "member", true],
    ["owner", "owner", true],
  ] as const)("hasMinRole(%s, %s) is %s", (role, minRole, expected) => {
    expect(hasMinRole(role, minRole)).toBe(expected);
  });

  it.each(["admin", "OWNER", "", null, undefined, 3])("rejects the unknown role %s", (value) => {
    expect(workspaceRoleSchema.safeParse(value).success).toBe(false);
  });
});
