import { describe, expect, it } from "vitest";

import { approvalIdFor } from "./approval-id.js";

const RUN = "00000000-0000-4000-8000-0000000000b1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("approvalIdFor", () => {
  it("is a valid uuid and the same for the same call, so a retry finds its own approval", () => {
    const a = approvalIdFor({ runId: RUN, step: 1, callId: "toolu_0" });
    expect(a).toMatch(UUID);
    expect(approvalIdFor({ runId: RUN, step: 1, callId: "toolu_0" })).toBe(a);
  });

  it("differs by run, step and call id", () => {
    const base = approvalIdFor({ runId: RUN, step: 1, callId: "toolu_0" });
    const ids = new Set([
      base,
      approvalIdFor({ runId: "00000000-0000-4000-8000-0000000000b2", step: 1, callId: "toolu_0" }),
      approvalIdFor({ runId: RUN, step: 2, callId: "toolu_0" }),
      approvalIdFor({ runId: RUN, step: 1, callId: "toolu_1" }),
    ]);
    expect(ids.size).toBe(4);
  });

  it("cannot be made to collide by moving text between fields", () => {
    expect(approvalIdFor({ runId: RUN, step: 1, callId: "2x" })).not.toBe(
      approvalIdFor({ runId: RUN, step: 12, callId: "x" }),
    );
  });
});
