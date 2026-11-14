// AGO-47: why a call was refused. Every answer is a denial; the code is only there for the model and the audit trail.
import { describe, expect, it } from "vitest";

import { APPROVAL_REFUSAL, describeApprovalRefusal } from "./approval-refusal.js";

import type { StoredApproval } from "./approval-store.js";

const NOW = Date.parse("2026-11-13T00:00:00Z");
const HASH = "a".repeat(64);

const row = (over: Partial<StoredApproval> = {}): StoredApproval => ({
  approvalId: "id",
  workspaceId: "ws",
  runId: "run",
  status: "approved",
  payloadHash: HASH,
  expiresAt: new Date(NOW + 60_000),
  consumedAt: null,
  ...over,
});

const code = (approval: StoredApproval | null, hash = HASH, now = NOW): string =>
  describeApprovalRefusal(approval, hash, now).errorCode;

describe("describeApprovalRefusal", () => {
  it("names a changed payload on an approved row", () => {
    expect(code(row(), "b".repeat(64))).toBe("approval_payload_mismatch");
  });

  it("names a used approval", () => {
    expect(code(row({ consumedAt: new Date(NOW - 1) }))).toBe("approval_already_used");
  });

  it("names an expired approval, and treats now == expires_at as expired", () => {
    expect(code(row({ expiresAt: new Date(NOW) }))).toBe("approval_expired");
    expect(code(row({ expiresAt: new Date(NOW - 1) }))).toBe("approval_expired");
  });

  it("reports a changed payload before used or expired", () => {
    const spent = row({ consumedAt: new Date(NOW - 1), expiresAt: new Date(NOW - 1) });

    expect(code(spent, "b".repeat(64))).toBe("approval_payload_mismatch");
    expect(code(spent)).toBe("approval_already_used");
  });

  it("names denied, rejected (expired) and past-due pending rows", () => {
    expect(code(row({ status: "denied" }))).toBe("approval_denied");
    expect(code(row({ status: "rejected" }))).toBe("approval_expired");
    expect(code(row({ status: "pending", expiresAt: new Date(NOW - 1) }))).toBe("approval_expired");
  });

  it.each([null, row({ status: "pending" }), row({ status: "consumed" }), row({ status: "" })])(
    "falls back to not granted for anything else (%#)",
    (approval) => {
      expect(describeApprovalRefusal(approval, HASH, NOW)).toBe(APPROVAL_REFUSAL.notGranted);
    },
  );

  it("never answers with an empty code, whatever the row", () => {
    for (const status of ["pending", "approved", "denied", "rejected", "x"]) {
      for (const consumedAt of [null, new Date(NOW)]) {
        expect(code(row({ status, consumedAt }), "z".repeat(64))).toMatch(/^approval_[a-z_]+$/);
      }
    }
  });
});
