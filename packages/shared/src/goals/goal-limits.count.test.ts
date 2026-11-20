import { describe, expect, it } from "vitest";

import { GOAL_TEXT_MAX_LENGTH, checkGoalText, countGoalCharacters } from "./goal-limits.js";

// Invisible code points are built at runtime; none is written literally in this file.
const INVISIBLE_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e];
// Neighbours of the invisible set that are NOT in it: they are visible to the counter and count as one.
const NEIGHBOURS = [0x200a, 0x200e, 0x2061, 0xfefe, 0x00ac, 0x00ae, 0x180d, 0x180f, 0x2029];

describe("AGO-113 AC2: countGoalCharacters (round 2)", () => {
  it.each(INVISIBLE_CODE_POINTS)("counts U+%i alone as 0", (codePoint) => {
    expect(countGoalCharacters(String.fromCodePoint(codePoint))).toBe(0);
  });

  it("counts every invisible code point together as 0", () => {
    expect(countGoalCharacters(String.fromCodePoint(...INVISIBLE_CODE_POINTS))).toBe(0);
  });

  it("counts 0 for an empty string", () => {
    expect(countGoalCharacters("")).toBe(0);
  });

  it("ignores invisible characters mixed into visible text", () => {
    const z = String.fromCodePoint(...INVISIBLE_CODE_POINTS);
    expect(countGoalCharacters(`a${z}b${z}${z}c`)).toBe(3);
    expect(countGoalCharacters(`${z}hello${z}`)).toBe(5);
  });

  it("counts ordinary spaces and newlines as characters while typing", () => {
    expect(countGoalCharacters("a b\nc")).toBe(5);
  });

  it.each(NEIGHBOURS)("counts the nearby visible U+%i as one", (codePoint) => {
    expect(countGoalCharacters(String.fromCodePoint(codePoint))).toBe(1);
  });

  it("counts an astral character as two UTF-16 units, the same unit the 5000 limit uses", () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(countGoalCharacters(emoji)).toBe(2);
    expect(countGoalCharacters(`${emoji}${String.fromCodePoint(0x200b)}${emoji}`)).toBe(4);
  });

  it("agrees with the limit check: the counter passes 5000 exactly when the check says too long", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const atLimit = emoji.repeat(GOAL_TEXT_MAX_LENGTH / 2);
    const overLimit = `${atLimit}x`;
    expect(countGoalCharacters(atLimit)).toBe(GOAL_TEXT_MAX_LENGTH);
    expect(checkGoalText(atLimit).ok).toBe(true);
    expect(countGoalCharacters(overLimit)).toBe(GOAL_TEXT_MAX_LENGTH + 1);
    expect(checkGoalText(overLimit).ok).toBe(false);
  });

  it("does not count invisible padding toward the limit", () => {
    const z = String.fromCodePoint(0x200b);
    const padded = `${z.repeat(3000)}${"a".repeat(GOAL_TEXT_MAX_LENGTH)}${z.repeat(3000)}`;
    expect(countGoalCharacters(padded)).toBe(GOAL_TEXT_MAX_LENGTH);
    expect(checkGoalText(padded).ok).toBe(true);
  });

  it("counts right-to-left and combining characters one unit each", () => {
    expect(countGoalCharacters("שלום")).toBe(4);
    expect(countGoalCharacters("e\u0301")).toBe(2);
  });
});
