import { describe, expect, it } from "vitest";

import { PROJECT_NAME, describeWorkspace } from "./index.js";

describe("describeWorkspace", () => {
  it("appends the project name to the package name", () => {
    expect(describeWorkspace("@ago/shared")).toBe(`@ago/shared (${PROJECT_NAME})`);
  });
});
