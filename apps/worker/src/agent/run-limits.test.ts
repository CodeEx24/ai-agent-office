import { describe, expect, it, vi } from "vitest";

import { createRunLimitsResolver, mergeRunLimits } from "./run-limits.js";

const SCOPE = { workspaceId: "ws", agentId: "agent" };
const DEFAULTS = { maxSteps: 25, maxTokens: 200_000, maxWallMs: 600_000 };

describe("mergeRunLimits", () => {
  it("overrides only the fields given", () => {
    expect(mergeRunLimits(DEFAULTS, { maxSteps: 10 })).toEqual({ ...DEFAULTS, maxSteps: 10 });
  });

  it("caps values above the maximum and raises values below the minimum", () => {
    expect(
      mergeRunLimits(DEFAULTS, { maxSteps: 9_999, maxTokens: 1, maxWallMs: 99_999_999 }),
    ).toEqual({ maxSteps: 200, maxTokens: 1_000, maxWallMs: 840_000 });
  });

  it.each([null, undefined, "x", 5, [1, 2]])("ignores a non-object override (%j)", (value) => {
    expect(mergeRunLimits(DEFAULTS, value)).toEqual(DEFAULTS);
  });

  it.each([Infinity, NaN, 1.5, "10", null, {}])(
    "keeps the default for a value that is not an integer limit (%j)",
    (value) => {
      expect(mergeRunLimits(DEFAULTS, { maxSteps: value })).toEqual(DEFAULTS);
    },
  );

  it("never returns 'unlimited' for a hostile value", () => {
    expect(mergeRunLimits(DEFAULTS, { maxSteps: Number.MAX_SAFE_INTEGER }).maxSteps).toBe(200);
  });
});

describe("createRunLimitsResolver", () => {
  it("returns the defaults when there is no source", async () => {
    await expect(createRunLimitsResolver({ defaults: DEFAULTS }).resolve(SCOPE)).resolves.toEqual(
      DEFAULTS,
    );
  });

  it("asks the source for this workspace and agent", async () => {
    const get = vi.fn(() => Promise.resolve({ maxSteps: 5 }));
    const resolver = createRunLimitsResolver({ defaults: DEFAULTS, source: { get } });

    await expect(resolver.resolve(SCOPE)).resolves.toEqual({ ...DEFAULTS, maxSteps: 5 });
    expect(get).toHaveBeenCalledWith(SCOPE);
  });

  it("returns the defaults, and reports the error, when the source throws", async () => {
    const onSourceError = vi.fn();
    const resolver = createRunLimitsResolver({
      defaults: DEFAULTS,
      source: { get: () => Promise.reject(new Error("boom")) },
      onSourceError,
    });

    await expect(resolver.resolve(SCOPE)).resolves.toEqual(DEFAULTS);
    expect(onSourceError).toHaveBeenCalledOnce();
  });

  it("bounds the defaults themselves", async () => {
    const resolver = createRunLimitsResolver({
      defaults: { maxSteps: 10_000, maxTokens: 200_000, maxWallMs: 600_000 },
    });
    await expect(resolver.resolve(SCOPE)).resolves.toMatchObject({ maxSteps: 200 });
  });
});
