import { describe, expect, it } from "vitest";

import {
  VAULT_PATH_MAX_LENGTH,
  formatVaultAuthorName,
  isVaultHumanOnlyPath,
  parseVaultAuthorName,
  validateVaultPath,
  vaultPrincipalSchema,
} from "./vault-schemas.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("validateVaultPath", () => {
  it.each([
    "_meta/AGENTS.md",
    "inbox/note.md",
    "projects/a b/c;d.md",
    "tasks/-flag.md",
    "logs/日本語.md",
  ])("accepts %s", (input) => {
    expect(validateVaultPath(input)).toMatchObject({ ok: true, path: input });
  });

  it.each([
    ["", "empty"],
    ["a".repeat(VAULT_PATH_MAX_LENGTH + 1), "too_long"],
    ["inbox/a\u0000b.md", "nul_or_control"],
    ["inbox/a\nb.md", "nul_or_control"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows/win.ini", "drive_or_unc"],
    ["c:evil.md", "drive_or_unc"],
    ["//server/share/x.md", "drive_or_unc"],
    ["\\\\server\\share\\x.md", "backslash"],
    ["inbox\\note.md", "backslash"],
    ["../outside.md", "traversal"],
    ["inbox/../../outside.md", "traversal"],
    ["inbox/./note.md", "traversal"],
    ["inbox/.../note.md", "traversal"],
    ["inbox//note.md", "empty_segment"],
    ["inbox/", "empty_segment"],
    [".git/config", "git_internal"],
    ["inbox/.GIT/hooks/pre-commit", "git_internal"],
    ["inbox/.git./config", "git_internal"],
    ["inbox/.git~1/config", "git_internal"],
    ["inbox/note.md:stream", "drive_or_unc"],
    ["_meta/AGENTS~1.MD", "ambiguous_name"],
    ["inbox/NUL", "ambiguous_name"],
    ["inbox/com1.txt", "ambiguous_name"],
  ])("rejects %j as %s", (input, reason) => {
    expect(validateVaultPath(input)).toEqual({ ok: false, reason });
  });
});

describe("isVaultHumanOnlyPath", () => {
  it.each([
    "_meta/AGENTS.md",
    "_meta/agents.md",
    "_META/Agents.MD",
    "_meta/AGENTS.md.",
    "_meta/AGENTS.md ",
    "projects/x/AGENTS.md",
    "CLAUDE.md",
    "_boot/start.md",
  ])("treats %j as human-only", (input) => {
    expect(isVaultHumanOnlyPath(input)).toBe(true);
  });

  it.each(["inbox/note.md", "_meta/README.md", "agents/helper.md"])(
    "lets agents write %s",
    (input) => {
      expect(isVaultHumanOnlyPath(input)).toBe(false);
    },
  );
});

describe("principals", () => {
  it("accepts human and agent principals and rejects anything else", () => {
    expect(vaultPrincipalSchema.safeParse({ kind: "human", userId: USER_ID }).success).toBe(true);
    expect(vaultPrincipalSchema.safeParse({ kind: "agent", agentId: AGENT_ID }).success).toBe(true);
    expect(vaultPrincipalSchema.safeParse({ kind: "agent", agentId: "nope" }).success).toBe(false);
    expect(vaultPrincipalSchema.safeParse({ kind: "system" }).success).toBe(false);
    expect(
      vaultPrincipalSchema.safeParse({ kind: "human", userId: USER_ID, isAdmin: true }).success,
    ).toBe(false);
  });

  it("round-trips the git author name", () => {
    const human = formatVaultAuthorName({ kind: "human", userId: USER_ID });
    const agent = formatVaultAuthorName({ kind: "agent", agentId: AGENT_ID });
    expect(parseVaultAuthorName(human)).toEqual({ kind: "human", id: USER_ID });
    expect(parseVaultAuthorName(agent)).toEqual({ kind: "agent", id: AGENT_ID });
    expect(parseVaultAuthorName("vault-service")).toBeNull();
    expect(parseVaultAuthorName(`human:${USER_ID}x`)).toBeNull();
  });
});
