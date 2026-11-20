import { describe, expect, it } from "vitest";

import { createEgressLogLimiter } from "./egress-log-limiter.js";

import type { EgressDecision } from "@ago/shared";

const decision = (event: EgressDecision["event"], run_id = "run-1"): EgressDecision => ({
  event,
  run_id,
  workspace_id: "w",
  host: "blocked.example.com",
  port: 443,
  method: "CONNECT",
  ...(event === "egress.blocked" ? { reason: "not_allowlisted" } : {}),
});

describe("createEgressLogLimiter", () => {
  it("logs the first blocks of a run, counts the rest, and reports one summary on flush", () => {
    const logged: EgressDecision[] = [];
    const summaries: { runId: string; suppressed: number }[] = [];
    const limiter = createEgressLogLimiter(
      (d) => logged.push(d),
      (s) => summaries.push({ ...s }),
      3,
    );
    for (let i = 0; i < 10; i++) limiter.onDecision(decision("egress.blocked"));
    expect(logged).toHaveLength(3);
    expect(limiter.flush("run-1")).toBe(7);
    expect(summaries).toEqual([{ runId: "run-1", suppressed: 7 }]);
    expect(limiter.flush("run-1")).toBe(0);
  });

  it("limits each run on its own and never limits allowed requests", () => {
    const logged: EgressDecision[] = [];
    const limiter = createEgressLogLimiter(
      (d) => logged.push(d),
      () => undefined,
      1,
    );
    limiter.onDecision(decision("egress.blocked", "a"));
    limiter.onDecision(decision("egress.blocked", "a"));
    limiter.onDecision(decision("egress.blocked", "b"));
    for (let i = 0; i < 5; i++) limiter.onDecision(decision("egress.allowed", "a"));
    expect(logged.filter((d) => d.event === "egress.blocked")).toHaveLength(2);
    expect(logged.filter((d) => d.event === "egress.allowed")).toHaveLength(5);
  });

  it("reports nothing when a run stayed under the limit", () => {
    const summaries: unknown[] = [];
    const limiter = createEgressLogLimiter(
      () => undefined,
      (s) => summaries.push(s),
      5,
    );
    limiter.onDecision(decision("egress.blocked"));
    expect(limiter.flush("run-1")).toBe(0);
    expect(summaries).toEqual([]);
  });
});
