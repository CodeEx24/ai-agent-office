// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// AGO-118 AC2 (traces are uploaded when a test fails) is configuration, so it is locked in
// by reading the config and the workflow rather than by breaking a build in CI.
const webRoot = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(webRoot, path), "utf8");

// Comments are dropped so a mention of `next dev` in prose cannot fail (or satisfy) a check.
const config = read("playwright.config.ts").replace(/^\s*\/\/.*$/gm, "");
const workflow = readFileSync(resolve(webRoot, "../../.github/workflows/ci.yml"), "utf8");
const e2eJob = workflow.slice(workflow.indexOf("  test-e2e:"));

describe("AGO-118 AC2: failure evidence", () => {
  it("AC2: Playwright keeps trace, screenshot and video only for failing tests", () => {
    expect(config).toMatch(/trace:\s*"retain-on-failure"/);
    expect(config).toMatch(/screenshot:\s*"only-on-failure"/);
    expect(config).toMatch(/video:\s*"retain-on-failure"/);
    expect(config).toMatch(/outputDir:\s*"\.\/test-results"/);
  });

  it("AC2: the E2E job uploads the output dir only on failure, SHA-pinned, with short retention", () => {
    const step = e2eJob.slice(e2eJob.indexOf("Upload Playwright traces"));
    expect(step).toMatch(/if:\s*failure\(\)/);
    expect(step).toMatch(/uses:\s*actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(step).toContain("apps/web/test-results/");
    const retention = Number(/retention-days:\s*(\d+)/.exec(step)?.[1]);
    expect(retention).toBeGreaterThan(0);
    expect(retention).toBeLessThanOrEqual(7);
  });
});

describe("AGO-118 AC1: E2E runs against a production build in CI", () => {
  it("AC1: the web server is `next start`, never `next dev`, and never reuses a running server", () => {
    expect(config).toMatch(/command:\s*`pnpm exec next start /);
    expect(config).not.toMatch(/next dev/);
    expect(config).toMatch(/reuseExistingServer:\s*false/);
  });

  it("AC1: the test-e2e job is hardened (pinned actions, timeout, read-only, no event interpolation)", () => {
    const uses = [...e2eJob.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
    expect(e2eJob).toMatch(/timeout-minutes:\s*\d+/);
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    expect(e2eJob).not.toContain("${{ github.event");
    expect(e2eJob).toMatch(/key:\s*playwright-.*steps\.playwright\.outputs\.version/);
  });
});
