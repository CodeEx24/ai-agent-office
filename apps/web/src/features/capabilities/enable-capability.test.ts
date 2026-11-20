import { describe, expect, it, vi } from "vitest";

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import {
  ENABLE_FAILED_ERROR,
  ENABLE_NOT_FOUND_ERROR,
  ENABLE_OWNER_ONLY_ERROR,
  enableCapabilityInputSchema,
  enableCapabilityWith,
  type CapabilityEnabler,
  type CapabilityToEnable,
} from "./enable-capability";

vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError };
});

const INPUT = {
  workspaceId: "12500000-0000-4000-8000-0000000000a1",
  capabilityId: "12500000-0000-4000-8000-0000000000c1",
};

const NAMES = [
  "sandbox_hardened",
  "egress_default_deny",
  "credential_broker",
  "approval_payload_hash",
] as const;
const allPass = NAMES.map((name) => ({ name, status: "pass" as const }));

function fakeEnabler(capability: CapabilityToEnable | null) {
  const enable = vi.fn(() => Promise.resolve());
  const enabler: CapabilityEnabler = { find: () => Promise.resolve(capability), enable };
  return { enabler, enable };
}

describe("enableCapabilityWith", () => {
  it("enables a gated capability when every prerequisite passes", async () => {
    const { enabler, enable } = fakeEnabler({ key: "code.run", isEnabled: false });
    const result = await enableCapabilityWith(
      { enabler, report: () => Promise.resolve(allPass) },
      INPUT,
    );
    expect(result).toEqual({ done: true });
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("refuses and names the failing check, without enabling", async () => {
    const { enabler, enable } = fakeEnabler({ key: "web.browse", isEnabled: false });
    const report = allPass.map((r) =>
      r.name === "egress_default_deny"
        ? { ...r, status: "fail" as const, reason: "wildcard_host" }
        : r,
    );
    const result = await enableCapabilityWith(
      { enabler, report: () => Promise.resolve(report) },
      INPUT,
    );
    expect(result.done).toBeUndefined();
    expect(result.failedChecks).toHaveLength(1);
    expect(result.error).toMatch(/^Blocked until these checks pass: /);
    expect(enable).not.toHaveBeenCalled();
  });

  it.each([
    ["endpoint down (no report)", () => Promise.resolve([])],
    ["report throws", () => Promise.reject(new Error("ECONNREFUSED 10.0.0.1:8080"))],
  ])("fails closed on %s", async (_label, report) => {
    const { enabler, enable } = fakeEnabler({ key: "code.run", isEnabled: false });
    const result = await enableCapabilityWith({ enabler, report }, INPUT);
    expect(result.done).toBeUndefined();
    expect(result.failedChecks?.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(enable).not.toHaveBeenCalled();
  });

  it("does not require the checks for a capability that is not gated", async () => {
    const { enabler, enable } = fakeEnabler({ key: "time.now", isEnabled: false });
    const report = vi.fn(() => Promise.resolve([]));
    expect(await enableCapabilityWith({ enabler, report }, INPUT)).toEqual({ done: true });
    expect(report).not.toHaveBeenCalled();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("leaves an already enabled capability alone", async () => {
    const { enabler, enable } = fakeEnabler({ key: "code.run", isEnabled: true });
    expect(
      await enableCapabilityWith({ enabler, report: () => Promise.resolve([]) }, INPUT),
    ).toEqual({ done: true });
    expect(enable).not.toHaveBeenCalled();
  });

  it("refuses a capability that is not in the workspace", async () => {
    const { enabler, enable } = fakeEnabler(null);
    const result = await enableCapabilityWith(
      { enabler, report: () => Promise.resolve(allPass) },
      INPUT,
    );
    expect(result).toEqual({ error: ENABLE_NOT_FOUND_ERROR });
    expect(enable).not.toHaveBeenCalled();
  });

  it("refuses a non-owner and a signed-out caller with fixed text", async () => {
    for (const [code, text] of [
      ["forbidden", ENABLE_OWNER_ONLY_ERROR],
      ["unauthenticated", "Your session has expired. Please sign in again."],
    ] as const) {
      const enable = vi.fn(() => Promise.resolve());
      const enabler: CapabilityEnabler = {
        find: () => Promise.reject(new WorkspaceAccessError(code)),
        enable,
      };
      const result = await enableCapabilityWith(
        { enabler, report: () => Promise.resolve(allPass) },
        INPUT,
      );
      expect(result).toEqual({ error: text });
      expect(enable).not.toHaveBeenCalled();
    }
  });

  it("returns a generic error, never the database text, when the write fails", async () => {
    const enabler: CapabilityEnabler = {
      find: () => Promise.resolve({ key: "code.run", isEnabled: false }),
      enable: () => Promise.reject(new Error("permission denied for table capabilities")),
    };
    const result = await enableCapabilityWith(
      { enabler, report: () => Promise.resolve(allPass) },
      INPUT,
    );
    expect(result).toEqual({ error: ENABLE_FAILED_ERROR });
  });
});

describe("enableCapabilityInputSchema", () => {
  it("takes two ids and nothing else, so a client cannot send its own pass flag", () => {
    expect(enableCapabilityInputSchema.safeParse(INPUT).success).toBe(true);
    expect(
      enableCapabilityInputSchema.safeParse({ ...INPUT, prerequisitesPassed: true }).success,
    ).toBe(false);
    expect(
      enableCapabilityInputSchema.safeParse({ ...INPUT, capabilityId: "code.run" }).success,
    ).toBe(false);
  });
});
