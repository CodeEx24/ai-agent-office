import { describe, expect, it } from "vitest";

import {
  EGRESS_BLOCK_REASONS,
  egressAllowlistFileSchema,
  egressDecisionSchema,
  egressHostPatternSchema,
} from "./egress-schemas.js";

describe("egressHostPatternSchema", () => {
  it.each(["api.example.com", "*.example.com", "EXAMPLE.com", "a-b.example.co.uk"])(
    "accepts %s",
    (host) => {
      expect(egressHostPatternSchema.safeParse(host).success).toBe(true);
    },
  );

  // Syntax only: TLD wildcards and IP literals are rejected by the worker's normaliser (see egress-config.test.ts).
  it.each(["", "*", "https://a.com", "a.com/path", "a.com:443", "a b.com", "*.*.a.com"])(
    "rejects %j",
    (host) => {
      expect(egressHostPatternSchema.safeParse(host).success).toBe(false);
    },
  );
});

describe("egressAllowlistFileSchema", () => {
  it("accepts a valid file and rejects unknown keys at every level", () => {
    const ok = { version: 1, workspaces: { w: { hosts: ["a.example.com"], ports: [443] } } };
    expect(egressAllowlistFileSchema.safeParse(ok).success).toBe(true);
    expect(egressAllowlistFileSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      egressAllowlistFileSchema.safeParse({
        version: 1,
        workspaces: { w: { hosts: [], allowPrivate: true } },
      }).success,
    ).toBe(false);
  });

  it("caps the hosts and ports per workspace", () => {
    const hosts = Array.from({ length: 201 }, (_, i) => `h${String(i)}.example.com`);
    expect(
      egressAllowlistFileSchema.safeParse({ version: 1, workspaces: { w: { hosts } } }).success,
    ).toBe(false);
    const ports = Array.from({ length: 11 }, (_, i) => 1000 + i);
    expect(
      egressAllowlistFileSchema.safeParse({
        version: 1,
        workspaces: { w: { hosts: ["a.example.com"], ports } },
      }).success,
    ).toBe(false);
  });
});

describe("egressDecisionSchema", () => {
  it("accepts a blocked line with a known reason and rejects an unknown one", () => {
    const line = {
      event: "egress.blocked",
      run_id: "r",
      workspace_id: "w",
      host: "x.com",
      port: 443,
      method: "CONNECT",
    };
    for (const reason of EGRESS_BLOCK_REASONS) {
      expect(egressDecisionSchema.safeParse({ ...line, reason }).success).toBe(true);
    }
    expect(egressDecisionSchema.safeParse({ ...line, reason: "because" }).success).toBe(false);
  });
});
