import { describe, expect, it } from "vitest";

import { getCrowdSlots } from "./crowd-layout";

describe("getCrowdSlots", () => {
  it("returns the requested number of slots with unique ids", () => {
    const slots = getCrowdSlots(8);
    expect(slots).toHaveLength(8);
    expect(new Set(slots.map((slot) => slot.id)).size).toBe(8);
  });

  it("mixes the two characters evenly", () => {
    const slots = getCrowdSlots(8);
    expect(slots.filter((slot) => slot.character === "pixel")).toHaveLength(4);
    expect(slots.filter((slot) => slot.character === "mannequin")).toHaveLength(4);
  });

  it("never puts two characters at the same position", () => {
    const keys = getCrowdSlots(8).map((slot) => slot.position.join(","));
    expect(new Set(keys).size).toBe(8);
  });

  it("centres the grid on the origin", () => {
    const slots = getCrowdSlots(8);
    const meanX = slots.reduce((sum, slot) => sum + slot.position[0], 0) / slots.length;
    const meanZ = slots.reduce((sum, slot) => sum + slot.position[2], 0) / slots.length;
    expect(meanX).toBeCloseTo(0, 6);
    expect(meanZ).toBeCloseTo(0, 6);
  });

  it("spreads start phases inside the clip", () => {
    for (const slot of getCrowdSlots(8)) {
      expect(slot.phase).toBeGreaterThanOrEqual(0);
      expect(slot.phase).toBeLessThan(1);
    }
  });
});
