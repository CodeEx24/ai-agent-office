import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { GATED_CAPABILITY_PREREQUISITES, PREREQUISITE_NAMES } from "@ago/shared";

import { createPgAttestationStore, startPrerequisiteAttestation } from "./attestation.js";

import type { PrerequisiteResult } from "@ago/shared";
import type pg from "pg";

const PASS: PrerequisiteResult[] = PREREQUISITE_NAMES.map((name) => ({ name, status: "pass" }));

describe("createPgAttestationStore", () => {
  it("writes one row per check as JSON in a single parameterised statement", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const store = createPgAttestationStore({ query } as unknown as pg.Pool);
    await store.record([
      { name: "sandbox_hardened", status: "pass" },
      { name: "egress_default_deny", status: "fail", reason: "allowlist_unreadable" },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, string[]];
    expect(sql).toContain("capability_prerequisite_status");
    expect(sql).toContain("on conflict (workspace_id, check_name)");
    expect(JSON.parse(params[0] ?? "[]")).toEqual([
      { name: "sandbox_hardened", status: "pass", reason: null },
      { name: "egress_default_deny", status: "fail", reason: "allowlist_unreadable" },
    ]);
  });

  it("refuses an unknown check, an unknown status or a free-text reason before any query", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const store = createPgAttestationStore({ query } as unknown as pg.Pool);
    for (const bad of [
      { name: "free_money", status: "pass" },
      { name: "sandbox_hardened", status: "ok" },
      { name: "sandbox_hardened", status: "fail", reason: "Error at /srv/app" },
    ]) {
      await expect(store.record([bad as unknown as PrerequisiteResult])).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("writes nothing for an empty report", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    await createPgAttestationStore({ query } as unknown as pg.Pool).record([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("startPrerequisiteAttestation", () => {
  it("records once on start, with exactly what the probes said", async () => {
    const record = vi.fn(() => Promise.resolve());
    const attestation = startPrerequisiteAttestation({
      store: { record },
      runChecks: () => Promise.resolve(PASS),
      logger: { warn: vi.fn() },
      intervalMs: 3_600_000,
    });
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledTimes(1);
    });
    attestation.stop();
    expect(record).toHaveBeenCalledWith(PASS);
  });

  it("never throws, and logs a failure once until it recovers", async () => {
    const warn = vi.fn();
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("connection refused"));
    const attestation = startPrerequisiteAttestation({
      store: { record },
      runChecks: () => Promise.resolve(PASS),
      logger: { warn },
      intervalMs: 3_600_000,
    });
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledTimes(1);
    });
    await attestation.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    await attestation.tick();
    await attestation.tick();
    attestation.stop();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls as unknown[][]) {
      expect(JSON.stringify(call)).not.toContain("connection refused");
    }
  });

  it("treats a probe runner that throws as a failed round (nothing is recorded)", async () => {
    const record = vi.fn(() => Promise.resolve());
    const warn = vi.fn();
    const attestation = startPrerequisiteAttestation({
      store: { record },
      runChecks: () => Promise.reject(new Error("boom")),
      logger: { warn },
      intervalMs: 3_600_000,
    });
    await attestation.tick();
    attestation.stop();
    expect(record).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not overlap rounds", async () => {
    let release: () => void = () => undefined;
    const record = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const attestation = startPrerequisiteAttestation({
      store: { record },
      runChecks: () => Promise.resolve(PASS),
      logger: { warn: vi.fn() },
      intervalMs: 3_600_000,
    });
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledTimes(1);
    });
    await attestation.tick();
    expect(record).toHaveBeenCalledTimes(1);
    release();
    attestation.stop();
  });
});

describe("the database map of required checks (drift guard)", () => {
  const sql = readFileSync(
    new URL(
      "../../../../supabase/migrations/20261121010001_ago_85_enable_capability.sql",
      import.meta.url,
    ),
    "utf8",
  );

  function sqlMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const match of sql.matchAll(/when '([a-z_.]+)' then array\[([^\]]*)\]/g)) {
      map[match[1] ?? ""] = [...(match[2] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
    }
    return map;
  }

  it("lists exactly the capabilities and checks the shared registry gates", () => {
    const shared = Object.fromEntries(
      Object.entries(GATED_CAPABILITY_PREREQUISITES).map(([key, names]) => [
        key,
        [...names].sort(),
      ]),
    );
    const database = Object.fromEntries(
      Object.entries(sqlMap()).map(([key, names]) => [key, [...names].sort()]),
    );
    expect(database).toEqual(shared);
  });

  it("only names checks the worker records", () => {
    for (const names of Object.values(sqlMap())) {
      for (const name of names) expect(PREREQUISITE_NAMES as readonly string[]).toContain(name);
    }
    expect(sql).toContain(
      "check_name in ('sandbox_hardened', 'egress_default_deny', 'credential_broker', 'approval_payload_hash')",
    );
  });
});
