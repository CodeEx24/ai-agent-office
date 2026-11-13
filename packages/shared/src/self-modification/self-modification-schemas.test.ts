import { describe, expect, it } from "vitest";

import {
  agentConfigChangeSchema,
  classifyBootPath,
  configProposalSchema,
  PROTECTED_TARGET_KINDS,
} from "./self-modification-schemas.js";

const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const AGENT = "00000000-0000-4000-8000-0000000000b1";

describe("classifyBootPath", () => {
  it.each([
    "_boot/start.md",
    "notes/_BOOT/start.md",
    ".claude/settings.json",
    "AGENTS.md",
    "docs/claude.md",
    "vault\\_boot\\welcome.md",
    "./BOOT.md",
    "../outside.md",
    "notes/../../x.md",
    "_boot",
  ])("treats %s as a boot file", (path) => {
    expect(classifyBootPath(path)).toBe(true);
  });

  it.each(["", "   ", "notes/ideas.md", "daily/2026-11-13.md", "bootstrap/readme.md", "boot.txt"])(
    "does not treat %j as a boot file",
    (path) => {
      expect(classifyBootPath(path)).toBe(false);
    },
  );
});

describe("agentConfigChangeSchema", () => {
  const base = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    kind: "agent_prompt",
    targetRef: AGENT,
    proposedContent: "new prompt",
  };

  it("covers the four protected kinds", () => {
    expect(PROTECTED_TARGET_KINDS).toEqual(["agent_prompt", "skill", "policy", "boot_file"]);
  });

  it("accepts a prompt change", () => {
    expect(agentConfigChangeSchema.safeParse(base).success).toBe(true);
  });

  it("rejects unknown fields (no smuggled actor)", () => {
    expect(agentConfigChangeSchema.safeParse({ ...base, actor: "human" }).success).toBe(false);
  });

  it("rejects a boot_file change whose path is not a boot path", () => {
    const change = { ...base, kind: "boot_file", targetRef: "notes/ideas.md" };
    expect(agentConfigChangeSchema.safeParse(change).success).toBe(false);
    expect(agentConfigChangeSchema.safeParse({ ...change, targetRef: "_boot/a.md" }).success).toBe(
      true,
    );
  });

  it("rejects a bad workspace id and oversized content", () => {
    expect(agentConfigChangeSchema.safeParse({ ...base, workspaceId: "nope" }).success).toBe(false);
    expect(
      agentConfigChangeSchema.safeParse({ ...base, proposedContent: "x".repeat(100_001) }).success,
    ).toBe(false);
  });
});

describe("configProposalSchema", () => {
  it("only allows a pending proposal", () => {
    const proposal = {
      id: "00000000-0000-4000-8000-0000000000c1",
      workspaceId: WORKSPACE,
      agentId: AGENT,
      kind: "skill",
      targetRef: "00000000-0000-4000-8000-0000000000d1",
      proposedContent: "text",
      status: "pending",
      createdAt: "2026-11-13T10:00:00+08:00",
    };
    expect(configProposalSchema.safeParse(proposal).success).toBe(true);
    expect(configProposalSchema.safeParse({ ...proposal, status: "approved" }).success).toBe(false);
  });
});
