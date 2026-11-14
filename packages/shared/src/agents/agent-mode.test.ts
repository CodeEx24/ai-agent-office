import { describe, expect, it } from "vitest";

import { parsePolicyAgentMode } from "../policy/policy-engine.js";
import {
  AGENT_MODE_DESCRIPTIONS,
  AGENT_MODE_LABELS,
  AGENT_MODE_MESSAGES,
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  agentModeSchema,
  setAgentModeSchema,
} from "./agent-mode.js";

const IDS = {
  workspaceId: "99000000-0000-4000-8000-0000000000a1",
  agentId: "99000000-0000-4000-8000-0000000000b1",
};

describe("AGO-99 the default mode", () => {
  it("is Strict, and Strict is the safe fallback for anything unknown", () => {
    expect(DEFAULT_AGENT_MODE).toBe("strict");
    expect(AGENT_MODES).toContain(DEFAULT_AGENT_MODE);
    expect(parsePolicyAgentMode("")).toBe(DEFAULT_AGENT_MODE);
    expect(parsePolicyAgentMode("permissive")).toBe(DEFAULT_AGENT_MODE);
  });

  it("has a label and a description for every mode", () => {
    for (const mode of AGENT_MODES) {
      expect(AGENT_MODE_LABELS[mode].length).toBeGreaterThan(0);
      expect(AGENT_MODE_DESCRIPTIONS[mode].length).toBeGreaterThan(0);
    }
  });
});

describe("AGO-99 agentModeSchema", () => {
  it.each(AGENT_MODES)("accepts %s", (mode) => {
    expect(agentModeSchema.parse(mode)).toBe(mode);
  });

  it("refuses an unknown mode and an empty one with different messages", () => {
    const unknown = agentModeSchema.safeParse("permissive");
    const empty = agentModeSchema.safeParse("");
    expect(unknown.success).toBe(false);
    expect(empty.success).toBe(false);
    expect(unknown.error?.issues[0]?.message).toBe(AGENT_MODE_MESSAGES.modeUnknown);
    expect(empty.error?.issues[0]?.message).toBe(AGENT_MODE_MESSAGES.modeRequired);
  });
});

describe("AGO-99 setAgentModeSchema", () => {
  it("accepts a ticked confirm box with an allowed mode", () => {
    expect(setAgentModeSchema.parse({ ...IDS, mode: "standard", confirm: "on" })).toEqual({
      ...IDS,
      mode: "standard",
      confirm: "on",
    });
  });

  it("refuses a missing or unticked confirm", () => {
    for (const confirm of [undefined, "", "off", "true"]) {
      const input =
        confirm === undefined
          ? { ...IDS, mode: "standard" }
          : { ...IDS, mode: "standard", confirm };
      const result = setAgentModeSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path[0]).toBe("confirm");
    }
  });

  it("refuses fields the caller must not choose (who, when, from, status)", () => {
    for (const extra of [
      { changedBy: "99000000-0000-4000-8000-0000000000c1" },
      { fromMode: "standard" },
      { createdAt: "2026-11-14T00:00:00Z" },
      { status: "idle" },
    ]) {
      expect(
        setAgentModeSchema.safeParse({ ...IDS, mode: "relaxed", confirm: "on", ...extra }).success,
      ).toBe(false);
    }
  });

  it("refuses ids that are not UUIDs", () => {
    expect(
      setAgentModeSchema.safeParse({
        ...IDS,
        agentId: "not-a-uuid",
        mode: "relaxed",
        confirm: "on",
      }).success,
    ).toBe(false);
  });
});
