import { describe, expect, it } from "vitest";

import {
  emptyRunCheckpointState,
  parseRunCheckpointState,
  runCheckpointStateSchema,
  type RunCheckpointState,
} from "./checkpoint.js";

const HASH = "a".repeat(64);

const withStep = (): RunCheckpointState => ({
  ...emptyRunCheckpointState(),
  steps: 2,
  tokens: 150,
  lastFingerprint: "f",
  repeatCount: 1,
  history: [{ source: "tool:get_current_time#c1", content: "status: ok\n12:00" }],
  step: {
    step: 2,
    hadError: false,
    calls: [
      {
        call_id: "c1",
        name: "get_current_time",
        input: {},
        status: "done",
        result: {
          record: { source: "tool:get_current_time#c1", content: "status: ok\n12:00" },
          isError: false,
          fingerprint: "f",
          toolName: "get_current_time",
        },
      },
      {
        call_id: "c2",
        name: "send_email",
        input: { to: "x" },
        status: "awaiting_approval",
        payload_hash: HASH,
      },
    ],
  },
});

describe("run checkpoint state", () => {
  it("accepts the empty state and a state with an open step", () => {
    expect(parseRunCheckpointState(emptyRunCheckpointState()).ok).toBe(true);
    expect(parseRunCheckpointState(JSON.parse(JSON.stringify(withStep()))).ok).toBe(true);
  });

  it("rejects an unknown key (nothing rides along)", () => {
    expect(
      runCheckpointStateSchema.safeParse({ ...emptyRunCheckpointState(), api_key: "x" }).success,
    ).toBe(false);
  });

  it("reports a wrong version apart from other damage, and never echoes the content", () => {
    expect(parseRunCheckpointState({ ...emptyRunCheckpointState(), version: 2 })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
    expect(parseRunCheckpointState({ nope: true })).toEqual({ ok: false, reason: "invalid" });
    expect(parseRunCheckpointState(null)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects negative counters, a bad status and a malformed payload hash", () => {
    const bad = (over: Record<string, unknown>) =>
      runCheckpointStateSchema.safeParse({ ...emptyRunCheckpointState(), ...over }).success;
    expect(bad({ steps: -1 })).toBe(false);
    expect(bad({ tokens: 1.5 })).toBe(false);
    const calls = withStep().step?.calls ?? [];
    expect(
      bad({ step: { step: 1, hadError: false, calls: [{ ...calls[0], status: "running" }] } }),
    ).toBe(false);
    expect(
      bad({ step: { step: 1, hadError: false, calls: [{ ...calls[1], payload_hash: "short" }] } }),
    ).toBe(false);
  });
});
