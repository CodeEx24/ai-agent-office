import { describe, expect, it } from "vitest";

import {
  APPROVAL_VERDICT_SOURCES,
  approvalIdParamSchema,
  decideApprovalBodySchema,
  satisfiesApprovalGate,
} from "./approval-decision.js";

const WORKSPACE_ID = "12500000-0000-4000-8000-0000000000a1";

describe("decideApprovalBodySchema", () => {
  it.each(["approved", "denied"])("accepts %s", (decision) => {
    expect(
      decideApprovalBodySchema.safeParse({ workspace_id: WORKSPACE_ID, decision }).success,
    ).toBe(true);
  });

  it.each([
    ["rejected", { decision: "rejected" }],
    ["expired", { decision: "expired" }],
    ["pending", { decision: "pending" }],
    ["a payload hash", { decision: "approved", payload_hash: "a".repeat(64) }],
    ["a status", { decision: "approved", status: "approved" }],
    ["a decided_by", { decision: "approved", decided_by: WORKSPACE_ID }],
  ])("rejects %s", (_name, extra) => {
    expect(
      decideApprovalBodySchema.safeParse({ workspace_id: WORKSPACE_ID, ...extra }).success,
    ).toBe(false);
  });

  it("needs a uuid workspace and a uuid approval id", () => {
    expect(
      decideApprovalBodySchema.safeParse({ workspace_id: "x", decision: "approved" }).success,
    ).toBe(false);
    expect(approvalIdParamSchema.safeParse("x").success).toBe(false);
    expect(approvalIdParamSchema.safeParse(WORKSPACE_ID).success).toBe(true);
  });
});

describe("satisfiesApprovalGate", () => {
  it("is true for exactly one combination: a human approval", () => {
    const grants = APPROVAL_VERDICT_SOURCES.flatMap((source) =>
      ["pending", "approved", "denied", "rejected"].map((status) => ({ source, status })),
    ).filter((answer) => satisfiesApprovalGate(answer));
    expect(grants).toEqual([{ source: "human", status: "approved" }]);
  });
});
