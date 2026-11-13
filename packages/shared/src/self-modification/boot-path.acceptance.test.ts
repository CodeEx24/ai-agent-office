import { describe, expect, it } from "vitest";

import { agentConfigChangeSchema, classifyBootPath } from "./self-modification-schemas.js";

/** AGO-154 tester-functional r1: boot-file path classifier edge cases. */
describe("classifyBootPath edge cases", () => {
  describe("case insensitivity", () => {
    it.each([
      "AGENTS.MD",
      "Claude.Md",
      "bOoT.md",
      "_BOOT/x.md",
      ".CLAUDE/settings.json",
      "docs/CLAUDE.MD",
      "Notes/_Boot/Welcome.md",
    ])("%s is a boot path", (path) => {
      expect(classifyBootPath(path)).toBe(true);
    });
  });

  describe("traversal", () => {
    it.each([
      "../x.md",
      "..",
      "a/../b.md",
      "a/b/../../c.md",
      "notes/..",
      "..\\x.md",
      "a\\..\\b.md",
      "./../x.md",
      "notes/ ../x.md",
    ])("%s is treated as a boot path (conservative)", (path) => {
      expect(classifyBootPath(path)).toBe(true);
    });
  });

  describe("backslashes and slash noise", () => {
    it.each([
      "notes\\_boot\\a.md",
      "\\_boot\\a.md",
      "/_boot/a.md",
      "//_boot//a.md",
      "a/./_boot/./b.md",
      "a\\.\\_boot\\b.md",
      "C:\\vault\\_boot\\a.md",
      "vault\\AGENTS.md",
    ])("%s is a boot path", (path) => {
      expect(classifyBootPath(path)).toBe(true);
    });
  });

  describe("nested _boot and .claude", () => {
    it.each([
      "_boot/a/b/c/d.md",
      "x/y/_boot/z.md",
      "x/_boot",
      "x/_boot/",
      "a/.claude/hooks/guard.mjs",
      "_boot/_boot/_boot.md",
      " _boot /a.md",
    ])("%s is a boot path", (path) => {
      expect(classifyBootPath(path)).toBe(true);
    });
  });

  describe("ordinary notes are not boot files", () => {
    it.each([
      "",
      "   ",
      "/",
      ".",
      "./",
      "notes/ideas.md",
      "my_boot/x.md",
      "_booth/x.md",
      "boot/x.md",
      "claude/x.md",
      "claude.md.txt",
      "notes/agents.md.bak",
      "notes/agents.txt",
      "daily/2026-11-13.md",
      "claude-notes.md",
      "dot.claude/x.md",
    ])("%j is not a boot path", (path) => {
      expect(classifyBootPath(path)).toBe(false);
    });
  });

  describe("known limits (documented, not protection)", () => {
    it("does not URL-decode: callers must pass decoded paths", () => {
      expect(classifyBootPath("%2e%2e/x.md")).toBe(false);
      expect(classifyBootPath("%5Fboot/x.md")).toBe(false);
    });
  });

  describe("boot_file changes through the schema", () => {
    const base = {
      workspaceId: "00000000-0000-4000-8000-0000000000a1",
      agentId: "00000000-0000-4000-8000-0000000000b1",
      kind: "boot_file",
      proposedContent: "x",
    };
    it("accepts exactly the paths the classifier accepts", () => {
      for (const path of ["_boot/a.md", "A\\_BOOT\\b.md", "../escape.md", "AGENTS.md"]) {
        expect(agentConfigChangeSchema.safeParse({ ...base, targetRef: path }).success, path).toBe(
          true,
        );
      }
      for (const path of ["notes/a.md", "my_boot/a.md", "claude.md.txt"]) {
        expect(agentConfigChangeSchema.safeParse({ ...base, targetRef: path }).success, path).toBe(
          false,
        );
      }
    });
  });
});
