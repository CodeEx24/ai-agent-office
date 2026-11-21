import { describe, expect, it } from "vitest";

import { STARTER_CAPABILITIES } from "../starter-capabilities.js";
import {
  GATED_CAPABILITY_PREREQUISITES,
  PREREQUISITE_NAMES,
  describePrerequisiteFailures,
  evaluatePrerequisites,
  isGatedCapability,
  prerequisitesFor,
  type PrerequisiteName,
} from "./prerequisites.js";

const allPass = PREREQUISITE_NAMES.map((name) => ({ name, status: "pass" as const }));

describe("gated capabilities", () => {
  it("gates code, browse and outbound message, and nothing below tier 3", () => {
    expect(isGatedCapability("code.run")).toBe(true);
    expect(isGatedCapability("web.browse")).toBe(true);
    expect(isGatedCapability("message.send_outbound")).toBe(true);
    expect(isGatedCapability("vault.read")).toBe(false);
    expect(isGatedCapability("toString")).toBe(false);
    expect(isGatedCapability("__proto__")).toBe(false);
  });

  it("only names capabilities that exist in the starter catalog", () => {
    const keys = new Set<string>(STARTER_CAPABILITIES.map((c) => c.key));
    for (const key of Object.keys(GATED_CAPABILITY_PREREQUISITES)) expect(keys.has(key)).toBe(true);
  });

  it("always requires approvals bound to the payload hash", () => {
    for (const key of Object.keys(GATED_CAPABILITY_PREREQUISITES)) {
      expect(prerequisitesFor(key)).toContain("approval_payload_hash");
    }
  });
});

describe("evaluatePrerequisites (fail closed)", () => {
  it("is satisfied when every needed check passes, and for a capability with no prerequisites", () => {
    expect(evaluatePrerequisites("web.browse", allPass).isSatisfied).toBe(true);
    expect(evaluatePrerequisites("vault.read", []).isSatisfied).toBe(true);
  });

  it.each(["fail", "error", "timeout", "not_run"] as const)(
    "a %s result blocks, and names the failing check",
    (status) => {
      const results = allPass.map((r) =>
        r.name === "egress_default_deny" ? { ...r, status, reason: "network_open" } : r,
      );
      const verdict = evaluatePrerequisites("message.send_outbound", results);
      expect(verdict.isSatisfied).toBe(false);
      expect(verdict.failures.map((f) => f.name)).toEqual(["egress_default_deny"]);
      expect(describePrerequisiteFailures(verdict.failures)).toContain(
        "Egress proxy wired with default deny",
      );
    },
  );

  it("a check nobody reported is a failure", () => {
    const missing: PrerequisiteName = "credential_broker";
    const verdict = evaluatePrerequisites(
      "code.run",
      allPass.filter((r) => r.name !== missing),
    );
    expect(verdict.isSatisfied).toBe(false);
    expect(verdict.failures[0]).toMatchObject({ name: missing, status: "not_run" });
  });

  it("ignores malformed results and a lone pass beside a failure does not win", () => {
    const verdict = evaluatePrerequisites("code.run", [
      ...allPass,
      { name: "sandbox_hardened", status: "fail" },
      { name: "sandbox_hardened", status: "pass", extra: true },
      "pass",
      null,
    ]);
    expect(verdict.isSatisfied).toBe(false);
    expect(verdict.failures.map((f) => f.name)).toEqual(["sandbox_hardened"]);
  });

  it("never carries free text from a result", () => {
    const verdict = evaluatePrerequisites("code.run", [
      { name: "sandbox_hardened", status: "fail", reason: "Error: secret=abc at /etc/passwd" },
    ]);
    expect(JSON.stringify(verdict)).not.toContain("/etc/passwd");
  });
});
