import { describe, expect, it } from "vitest";

import { isKillSwitchRoute, killSwitchBodySchema, killSwitchResultSchema } from "./kill-switch.js";

const WS = "84000000-0000-4000-8000-000000000001";
const AGENT = "84000000-0000-4000-8000-0000000000a1";

describe("killSwitchBodySchema", () => {
  it("accepts a workspace scope without an agent", () => {
    expect(killSwitchBodySchema.safeParse({ workspace_id: WS, scope: "workspace" }).success).toBe(
      true,
    );
  });

  it("accepts an agent scope with an agent", () => {
    expect(
      killSwitchBodySchema.safeParse({ workspace_id: WS, scope: "agent", agent_id: AGENT }).success,
    ).toBe(true);
  });

  it("refuses an agent scope without an agent", () => {
    expect(killSwitchBodySchema.safeParse({ workspace_id: WS, scope: "agent" }).success).toBe(
      false,
    );
  });

  it("refuses a workspace scope that names an agent", () => {
    expect(
      killSwitchBodySchema.safeParse({ workspace_id: WS, scope: "workspace", agent_id: AGENT })
        .success,
    ).toBe(false);
  });

  it("refuses unknown fields, a bad scope and a bad id", () => {
    expect(
      killSwitchBodySchema.safeParse({ workspace_id: WS, scope: "workspace", extra: 1 }).success,
    ).toBe(false);
    expect(killSwitchBodySchema.safeParse({ workspace_id: WS, scope: "everything" }).success).toBe(
      false,
    );
    expect(
      killSwitchBodySchema.safeParse({ workspace_id: "nope", scope: "workspace" }).success,
    ).toBe(false);
  });
});

describe("killSwitchResultSchema", () => {
  it("accepts counts and nothing else", () => {
    expect(
      killSwitchResultSchema.safeParse({ runs_stopped: 2, credentials_revoked: 3 }).success,
    ).toBe(true);
    expect(
      killSwitchResultSchema.safeParse({ runs_stopped: -1, credentials_revoked: 0 }).success,
    ).toBe(false);
    expect(killSwitchResultSchema.safeParse({ runs_stopped: 1 }).success).toBe(false);
  });
});

describe("isKillSwitchRoute", () => {
  it("matches the kill and release routes only", () => {
    expect(isKillSwitchRoute("/api/control/kill")).toBe(true);
    expect(isKillSwitchRoute("/api/control/kill/release")).toBe(true);
    expect(isKillSwitchRoute("/api/control/kill/other")).toBe(false);
    expect(isKillSwitchRoute("/api/control/killer")).toBe(false);
    expect(isKillSwitchRoute("/api/approvals")).toBe(false);
  });
});
