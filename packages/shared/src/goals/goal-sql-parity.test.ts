import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GOAL_TEXT_MAX_LENGTH, isGoalTextBlank, normalizeGoalText } from "./goal-limits.js";

// AGO-113: the goal text rules live in three places (the client and Zod in goal-limits.ts, and the database in the
// migration). This test keeps them in step: the same limit and the same invisible characters in every layer.
const MIGRATION = readFileSync(
  new URL("../../../../supabase/migrations/20261120010001_ago_113_goals.sql", import.meta.url),
  "utf8",
);

// Zero-width and invisible characters the app strips: ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen, Mongolian
// vowel separator.
const INVISIBLE_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e];

function sqlBlock(startMarker: string): string {
  const start = MIGRATION.indexOf(startMarker);
  expect(start, `migration contains ${startMarker}`).toBeGreaterThanOrEqual(0);
  return MIGRATION.slice(start, start + 400);
}

// The character class the SQL uses after `marker`, as a JavaScript regexp that matches one such character. The SQL
// lists some characters as ranges (U+200B-U+200D), so a plain substring check would miss U+200C.
function sqlClass(marker: string, pattern: RegExp): RegExp {
  const found = pattern.exec(sqlBlock(marker));
  expect(found, `a character class follows ${marker}`).not.toBeNull();
  return new RegExp(`[${found?.[1] ?? ""}]`, "u");
}

describe("goal text rules: app and database stay in step", () => {
  it("uses the same maximum length in the CHECK constraint and in submit_goal", () => {
    expect(MIGRATION).toContain(`char_length(text) between 1 and ${String(GOAL_TEXT_MAX_LENGTH)}`);
    expect(MIGRATION).toContain(`char_length(v_text) > ${String(GOAL_TEXT_MAX_LENGTH)}`);
  });

  it.each(INVISIBLE_CODE_POINTS)(
    "treats code point %i the same in the app and in SQL",
    (codePoint) => {
      const char = String.fromCodePoint(codePoint);
      // App: stripped by normalising, and text made only of it is blank.
      expect(normalizeGoalText(`a${char}b`)).toBe("ab");
      expect(isGoalTextBlank(char)).toBe(true);
      // SQL: listed in the CHECK constraint and in the function's strip step.
      expect(sqlClass("goals_text_not_blank", /text !~ '\^\[([^\]]*)\]\*\$'/).test(char)).toBe(
        true,
      );
      expect(sqlClass("v_text := btrim(", /'\[([^'\]]*)\]', '', 'g'/).test(char)).toBe(true);
    },
  );

  it("lists the no-break space as blank in both layers", () => {
    const nbsp = String.fromCodePoint(0x00a0);
    expect(isGoalTextBlank(nbsp)).toBe(true);
    expect(sqlClass("goals_text_not_blank", /text !~ '\^\[([^\]]*)\]\*\$'/).test(nbsp)).toBe(true);
    expect(sqlClass("if v_text !~", /!~ '\[\^([^\]]*)\]'/).test(nbsp)).toBe(true);
  });

  it("does not let ordinary letters slip through the SQL blank check", () => {
    expect(sqlClass("goals_text_not_blank", /text !~ '\^\[([^\]]*)\]\*\$'/).test("a")).toBe(false);
  });
});
