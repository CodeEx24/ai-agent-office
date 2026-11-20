import { beforeEach, describe, expect, it, vi } from "vitest";

// AGO-85: an agent credential can never turn a capability on, and a non-owner is refused. The real
// requireHumanRequest and the real enable logic run; only the request headers, the database enabler and the
// worker report are replaced.
const requestHeaders = vi.hoisted(() => ({ authorization: null as string | null }));
const enabler = vi.hoisted(() => ({ find: vi.fn(), enable: vi.fn() }));
const report = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? requestHeaders.authorization : null,
    }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError, requireWorkspaceRole: vi.fn() };
});
vi.mock("./capability-enabler", () => ({ capabilityEnabler: enabler }));
vi.mock("./prerequisite-report", () => ({ fetchPrerequisiteReport: report }));

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { enableCapabilityAction } from "./actions";
import { ENABLE_AGENT_CREDENTIAL_ERROR, ENABLE_OWNER_ONLY_ERROR } from "./enable-capability";

const IDS = {
  workspaceId: "12500000-0000-4000-8000-0000000000a1",
  capabilityId: "12500000-0000-4000-8000-0000000000c1",
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const PASSING = [
  "sandbox_hardened",
  "egress_default_deny",
  "credential_broker",
  "approval_payload_hash",
].map((name) => ({ name, status: "pass" }));

describe("enableCapabilityAction", () => {
  beforeEach(() => {
    requestHeaders.authorization = null;
    enabler.find.mockReset();
    enabler.enable.mockReset();
    report.mockReset();
  });

  it("refuses a request carrying an agent credential before reading or writing anything", async () => {
    requestHeaders.authorization = "Bearer ago_agt_0123456789abcdef0123456789abcdef";
    expect(await enableCapabilityAction({}, form(IDS))).toEqual({
      error: ENABLE_AGENT_CREDENTIAL_ERROR,
    });
    expect(enabler.find).not.toHaveBeenCalled();
    expect(enabler.enable).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("refuses a non-owner", async () => {
    enabler.find.mockRejectedValue(new WorkspaceAccessError("forbidden"));
    expect(await enableCapabilityAction({}, form(IDS))).toEqual({ error: ENABLE_OWNER_ONLY_ERROR });
    expect(enabler.enable).not.toHaveBeenCalled();
  });

  it("ignores a client-sent pass flag: extra fields make the input invalid", async () => {
    const result = await enableCapabilityAction({}, form({ ...IDS, prerequisitesPassed: "true" }));
    expect(result.error).toBeDefined();
    expect(enabler.find).not.toHaveBeenCalled();
  });

  it("blocks a risky capability when the worker report is empty, and enables it when all pass", async () => {
    enabler.find.mockResolvedValue({ key: "code.run", isEnabled: false });
    report.mockResolvedValue([]);
    const blocked = await enableCapabilityAction({}, form(IDS));
    expect(blocked.failedChecks?.length).toBeGreaterThan(0);
    expect(enabler.enable).not.toHaveBeenCalled();

    report.mockResolvedValue(PASSING);
    enabler.enable.mockResolvedValue(undefined);
    expect(await enableCapabilityAction({}, form(IDS))).toEqual({ done: true });
    expect(enabler.enable).toHaveBeenCalledTimes(1);
  });
});
