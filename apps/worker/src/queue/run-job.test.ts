import { describe, expect, it } from "vitest";

import { idempotencyKeySchema, runJobKey, runJobSchema } from "./run-job.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "44444444-4444-4444-8444-444444444444";
const RUN = "22222222-2222-4222-8222-222222222222";

describe("run job payload", () => {
  it("accepts a run reference and nothing else", () => {
    expect(runJobSchema.safeParse({ workspace_id: WORKSPACE, run_id: RUN }).success).toBe(true);
    expect(
      runJobSchema.safeParse({ workspace_id: WORKSPACE, run_id: RUN, prompt: "x" }).success,
    ).toBe(false);
    expect(runJobSchema.safeParse({ workspace_id: WORKSPACE, run_id: "nope" }).success).toBe(false);
  });
});

describe("idempotency key", () => {
  it("defaults to the run id, so the same run is the same job", () => {
    const payload = { workspace_id: WORKSPACE, run_id: RUN };
    expect(runJobKey(payload, undefined)).toBe(runJobKey(payload, undefined));
  });

  it("is scoped to the workspace so tenants never collide", () => {
    const a = runJobKey({ workspace_id: WORKSPACE, run_id: RUN }, "same-key");
    const b = runJobKey({ workspace_id: OTHER_WORKSPACE, run_id: RUN }, "same-key");
    expect(a).not.toBe(b);
  });

  it("keeps a caller key apart from a run-id key", () => {
    const payload = { workspace_id: WORKSPACE, run_id: RUN };
    expect(runJobKey(payload, "x")).not.toBe(runJobKey(payload, undefined));
  });

  it("validates caller keys", () => {
    expect(idempotencyKeySchema.safeParse("schedule:daily/2026-11-07").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("has space").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(201)).success).toBe(false);
  });
});
