import { describe, expect, it } from "vitest";

import { hardenPgbossFunctionsSettled, isBamSettled } from "./pgboss-hardening.js";

import type pg from "pg";

/** Fake pool: one flag says whether PUBLIC/API roles still hold EXECUTE on some pgboss function. */
function fakePool(options: { revokeWorks?: boolean } = {}) {
  const state = { grants: false, revokes: 0 };
  const client = {
    query: (sql: string) => {
      if (sql.includes("has_grants"))
        return Promise.resolve({ rows: [{ has_grants: state.grants }] });
      if (sql.startsWith("revoke execute")) {
        state.revokes += 1;
        if (options.revokeWorks !== false) state.grants = false;
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  };
  const pool = { connect: () => Promise.resolve(client as unknown as pg.PoolClient) };
  return { state, pool };
}

describe("isBamSettled", () => {
  it("is false while a background migration is pending or running", () => {
    expect(isBamSettled([])).toBe(true);
    expect(isBamSettled([{ status: "completed" }, { status: "failed" }])).toBe(true);
    expect(isBamSettled([{ status: "completed" }, { status: "pending" }])).toBe(false);
    expect(isBamSettled([{ status: "in_progress" }])).toBe(false);
  });
});

describe("hardenPgbossFunctionsSettled", () => {
  it("revokes a function that pg-boss creates late, while its background migration still runs (AGO-213)", async () => {
    const { state, pool } = fakePool();
    const answers = [false, true]; // first look: a migration is still running; second: settled
    let looks = 0;
    await hardenPgbossFunctionsSettled(pool, {
      pollMs: 1,
      isSettled: () => {
        looks += 1;
        state.grants = true; // the background migration (re)creates a function with its default grant
        return Promise.resolve(answers[looks - 1] ?? true);
      },
    });
    expect(looks).toBe(2);
    expect(state.grants).toBe(false);
  });

  it("does not finish on a clean check taken before pg-boss settled", async () => {
    const { pool } = fakePool();
    let looks = 0;
    await hardenPgbossFunctionsSettled(pool, {
      pollMs: 1,
      isSettled: () => {
        looks += 1;
        return Promise.resolve(looks >= 3);
      },
    });
    expect(looks).toBe(3);
  });

  it("fails closed when pg-boss never settles within the maximum wait", async () => {
    const { pool } = fakePool();
    await expect(
      hardenPgbossFunctionsSettled(pool, {
        maxWaitMs: 40,
        pollMs: 5,
        isSettled: () => Promise.resolve(false),
      }),
    ).rejects.toThrow(/refusing to run unhardened/);
  });

  it("fails closed when grants are still present at the end (revoke has no effect)", async () => {
    const { state, pool } = fakePool({ revokeWorks: false });
    state.grants = true;
    await expect(
      hardenPgbossFunctionsSettled(pool, {
        maxWaitMs: 40,
        pollMs: 5,
        isSettled: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(/refusing to run unhardened/);
    expect(state.grants).toBe(true);
  });

  it("keeps the cause when the settle check itself keeps failing", async () => {
    const { pool } = fakePool();
    const error = await hardenPgbossFunctionsSettled(pool, {
      maxWaitMs: 30,
      pollMs: 5,
      isSettled: () => Promise.reject(new Error("bam table missing")),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});

describe("hardenPgbossFunctionsSettled with a stalled database (AGO-213)", () => {
  const MAX_WAIT_MS = 150;
  const MARGIN_MS = 300;

  it("throws within maxWaitMs when connect never resolves", async () => {
    const pool = { connect: () => new Promise<pg.PoolClient>(() => undefined) };
    const started = Date.now();
    await expect(
      hardenPgbossFunctionsSettled(pool, {
        maxWaitMs: MAX_WAIT_MS,
        pollMs: 5,
        isSettled: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(/refusing to run unhardened/);
    expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS + MARGIN_MS);
  });

  it("throws within maxWaitMs when a query never resolves", async () => {
    const client = { query: () => new Promise(() => undefined), release: () => undefined };
    const pool = { connect: () => Promise.resolve(client as unknown as pg.PoolClient) };
    const started = Date.now();
    await expect(
      hardenPgbossFunctionsSettled(pool, {
        maxWaitMs: MAX_WAIT_MS,
        pollMs: 5,
        isSettled: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(/refusing to run unhardened/);
    expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS + MARGIN_MS);
  });

  it("bounds the hardening transaction with a lock and a statement timeout", async () => {
    const sql: string[] = [];
    let grants = true;
    const client = {
      query: (text: string) => {
        sql.push(text);
        if (text.includes("has_grants")) return Promise.resolve({ rows: [{ has_grants: grants }] });
        if (text.startsWith("revoke execute")) grants = false;
        return Promise.resolve({ rows: [] });
      },
      release: () => undefined,
    };
    const pool = { connect: () => Promise.resolve(client as unknown as pg.PoolClient) };
    await hardenPgbossFunctionsSettled(pool, { pollMs: 1, isSettled: () => Promise.resolve(true) });
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '5s'");
  });
});
