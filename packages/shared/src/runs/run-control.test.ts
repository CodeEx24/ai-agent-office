import { describe, expect, it } from "vitest";

import {
  isRunControlRoute,
  runControlBodySchema,
  runControlResultSchema,
  runIdParamSchema,
} from "./run-control.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

describe("runControlBodySchema", () => {
  it.each(["pause", "resume", "stop"])("accepts %s", (action) => {
    expect(runControlBodySchema.safeParse({ workspace_id: WORKSPACE, action }).success).toBe(true);
  });

  it.each([
    { workspace_id: WORKSPACE, action: "kill" },
    { workspace_id: WORKSPACE },
    { action: "pause" },
    { workspace_id: "not-a-uuid", action: "pause" },
    // Nothing else rides along: no status, no run id, no actor.
    { workspace_id: WORKSPACE, action: "pause", status: "stopped" },
    { workspace_id: WORKSPACE, action: "pause", actor: "agent" },
  ])("rejects %j", (body) => {
    expect(runControlBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("runIdParamSchema and runControlResultSchema", () => {
  it("takes a uuid only", () => {
    expect(runIdParamSchema.safeParse(RUN).success).toBe(true);
    expect(runIdParamSchema.safeParse("../approvals").success).toBe(false);
  });

  it("knows the two answers of the database function", () => {
    expect(runControlResultSchema.safeParse("accepted").success).toBe(true);
    expect(runControlResultSchema.safeParse("not_applicable").success).toBe(true);
    expect(runControlResultSchema.safeParse("done").success).toBe(false);
  });
});

describe("isRunControlRoute", () => {
  it(`matches the control route of a run`, () => {
    expect(isRunControlRoute(`/api/runs/${RUN}/control`)).toBe(true);
  });

  it.each([
    "/api/runs",
    `/api/runs/${RUN}`,
    `/api/runs/${RUN}/control/extra`,
    `/api/runs/${RUN}/controls`,
    "/api/runs/abc/control",
    `/api/approvals/${RUN}/control`,
    `/x/api/runs/${RUN}/control`,
  ])("does not match %s", (path) => {
    expect(isRunControlRoute(path)).toBe(false);
  });
});
