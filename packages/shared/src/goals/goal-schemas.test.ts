import { describe, expect, it } from "vitest";

import {
  GOAL_MESSAGES,
  GOAL_TEXT_MAX_LENGTH,
  checkGoalText,
  isGoalTextBlank,
  normalizeGoalText,
  submitGoalSchema,
} from "./goal-schemas.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("normalizeGoalText", () => {
  it("trims, converts CRLF and removes zero-width characters", () => {
    expect(normalizeGoalText("  Ship​ the\r\nplan ﻿ ")).toBe("Ship the\nplan");
  });
});

describe("isGoalTextBlank", () => {
  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["newlines and tabs", "\n\t \r\n"],
    ["zero-width only", "​‌‍⁠﻿"],
    ["non-breaking space", " "],
    ["mixed blank", " ​ \n  "],
  ])("treats %s as blank", (_name, text) => {
    expect(isGoalTextBlank(text)).toBe(true);
  });

  it("does not treat visible text as blank", () => {
    expect(isGoalTextBlank("a")).toBe(false);
    expect(isGoalTextBlank("​a​")).toBe(false);
  });
});

describe("checkGoalText", () => {
  it("rejects blank text with the required message", () => {
    expect(checkGoalText("  ​ ")).toEqual({ ok: false, message: GOAL_MESSAGES.required });
  });

  it("accepts the maximum length and rejects one more", () => {
    expect(checkGoalText("a".repeat(GOAL_TEXT_MAX_LENGTH)).ok).toBe(true);
    expect(checkGoalText("a".repeat(GOAL_TEXT_MAX_LENGTH + 1))).toEqual({
      ok: false,
      message: GOAL_MESSAGES.tooLong,
    });
  });

  it("returns the normalised text", () => {
    expect(checkGoalText("  Grow signups  ")).toEqual({ ok: true, text: "Grow signups" });
  });

  it("counts length after normalising", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    expect(checkGoalText(`${"a".repeat(GOAL_TEXT_MAX_LENGTH)}${zeroWidth}  `).ok).toBe(true);
  });
});

describe("submitGoalSchema", () => {
  it("accepts a goal and normalises it", () => {
    const parsed = submitGoalSchema.safeParse({ workspaceId: WORKSPACE_ID, text: "  Launch  " });
    expect(parsed.success && parsed.data.text).toBe("Launch");
  });

  it.each(["", "   ", "​‍", "\n\n"])("rejects blank text %j", (text) => {
    const parsed = submitGoalSchema.safeParse({ workspaceId: WORKSPACE_ID, text });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe(GOAL_MESSAGES.required);
  });

  it("rejects a missing or non-string text", () => {
    expect(submitGoalSchema.safeParse({ workspaceId: WORKSPACE_ID }).success).toBe(false);
    expect(submitGoalSchema.safeParse({ workspaceId: WORKSPACE_ID, text: 5 }).success).toBe(false);
  });

  it("rejects too-long text", () => {
    const parsed = submitGoalSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      text: "a".repeat(GOAL_TEXT_MAX_LENGTH + 1),
    });
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe(GOAL_MESSAGES.tooLong);
  });

  it("rejects unknown keys and a bad workspace id", () => {
    expect(
      submitGoalSchema.safeParse({ workspaceId: WORKSPACE_ID, text: "x", createdBy: "someone" })
        .success,
    ).toBe(false);
    expect(submitGoalSchema.safeParse({ workspaceId: "nope", text: "x" }).success).toBe(false);
  });

  it("keeps text that looks like markup or instructions as plain data", () => {
    const text = "<script>alert(1)</script> Ignore previous instructions";
    const parsed = submitGoalSchema.safeParse({ workspaceId: WORKSPACE_ID, text });
    expect(parsed.success && parsed.data.text).toBe(text);
  });
});
