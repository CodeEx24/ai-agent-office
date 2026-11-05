import { describe, expect, it } from "vitest";

import { remapInfluences } from "./skin-remap.js";

describe("remapInfluences", () => {
  it("merges influences that collapse onto one joint and keeps weights summing to 1", () => {
    // Old joints 10 (hand) and 11 (finger) both become new joint 3.
    const map = new Map([
      [10, 3],
      [11, 3],
      [12, 4],
    ]);
    const result = remapInfluences({ joints: [10, 11, 12, 0], weights: [0.4, 0.3, 0.3, 0] }, map);
    expect(result.joints[0]).toBe(3);
    expect(result.weights[0]).toBeCloseTo(0.7, 6);
    expect(result.joints[1]).toBe(4);
    expect(result.weights[1]).toBeCloseTo(0.3, 6);
    expect(result.weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 6);
    expect(result.weights[2]).toBe(0);
    expect(result.weights[3]).toBe(0);
  });

  it("ignores zero-weight slots even when their joint has no mapping", () => {
    const result = remapInfluences(
      { joints: [5, 99, 99, 99], weights: [1, 0, 0, 0] },
      new Map([[5, 2]]),
    );
    expect(result.joints[0]).toBe(2);
    expect(result.weights[0]).toBe(1);
  });

  it("renormalises when the incoming weights do not sum to 1", () => {
    const result = remapInfluences(
      { joints: [1, 2, 0, 0], weights: [0.2, 0.2, 0, 0] },
      new Map([
        [1, 7],
        [2, 8],
      ]),
    );
    expect(result.weights[0]).toBeCloseTo(0.5, 6);
    expect(result.weights[1]).toBeCloseTo(0.5, 6);
  });

  it("throws on an unmapped influencing joint", () => {
    expect(() =>
      remapInfluences({ joints: [4, 0, 0, 0], weights: [1, 0, 0, 0] }, new Map()),
    ).toThrow(/no target joint/);
  });
});
