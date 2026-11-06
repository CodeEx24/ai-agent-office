import { describe, expect, it } from "vitest";

import { createLogger } from "../logger.js";

import {
  RunEventValidationError,
  RunEventWriteError,
  createRunEventEmitter,
  type RunEventRow,
  type RunEventStore,
} from "./run-event-emitter.js";

const WS = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const RUN_2 = "44444444-4444-4444-8444-444444444444";
const HASH = "b".repeat(64);

/** In-memory store that assigns seq the way the database does (max + 1 per run). */
function memoryStore() {
  const rows: (RunEventRow & { seq: number })[] = [];
  const store: RunEventStore = {
    insert(row) {
      const seq = rows.filter((r) => r.run_id === row.run_id).length + 1;
      rows.push({ ...row, seq });
      return Promise.resolve({
        id: `id-${String(rows.length)}`,
        seq,
        created_at: "2026-11-06T10:00:00.000Z",
      });
    },
  };
  return { rows, store };
}

interface Loose {
  emit(event: unknown): Promise<unknown>;
}

describe("createRunEventEmitter", () => {
  it("stamps the version into the payload, binds workspace and run, and never sends a seq", async () => {
    const { rows, store } = memoryStore();
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    const stored = await emitter.emit({ type: "step.started", payload: { step: 1 } });
    expect(stored.seq).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: WS,
      run_id: RUN,
      type: "step.started",
      payload: { version: 1, step: 1 },
    });
  });

  it("rejects an invalid payload and writes nothing", async () => {
    const { rows, store } = memoryStore();
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    await expect(
      emitter.emit({ type: "step.started", payload: { step: 0 } }),
    ).rejects.toBeInstanceOf(RunEventValidationError);
    expect(rows).toHaveLength(0);
  });

  it("rejects an unknown event type and extra keys at runtime (untyped callers)", async () => {
    const { rows, store } = memoryStore();
    const loose = createRunEventEmitter({ workspaceId: WS, runId: RUN, store }) as unknown as Loose;
    await expect(loose.emit({ type: "run.exploded", payload: {} })).rejects.toBeInstanceOf(
      RunEventValidationError,
    );
    await expect(
      loose.emit({ type: "run.started", payload: { token: "x" } }),
    ).rejects.toBeInstanceOf(RunEventValidationError);
    expect(rows).toHaveLength(0);
  });

  it("validation errors and logs never contain the offending values", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      destination: { write: (chunk) => void lines.push(chunk) },
    });
    const { store } = memoryStore();
    const loose = createRunEventEmitter({
      workspaceId: WS,
      runId: RUN,
      store,
      logger,
    }) as unknown as Loose;
    const error = (await loose
      .emit({ type: "run.started", payload: { note: "hunter2-SECRET" } })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("hunter2");
    expect(lines.join("")).not.toContain("hunter2");
    expect(lines.join("")).toContain("run event rejected");
  });

  it("gets increasing seq per run, independently for two runs, with concurrent emits", async () => {
    const { rows, store } = memoryStore();
    const a = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    const b = createRunEventEmitter({ workspaceId: WS, runId: RUN_2, store });
    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        a.emit({ type: "budget.usage", payload: { input_tokens: 1, output_tokens: 1 } }),
      ),
      ...Array.from({ length: 3 }, () => b.emit({ type: "run.started", payload: {} })),
    ]);
    const seqs = (run: string) => rows.filter((r) => r.run_id === run).map((r) => r.seq);
    expect(seqs(RUN)).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(RUN_2)).toEqual([1, 2, 3]);
  });

  it("wraps store failures without leaking the payload", async () => {
    const store: RunEventStore = { insert: () => Promise.reject(new Error("connection refused")) };
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    const error = (await emitter
      .emit({
        type: "tool_call.requested",
        payload: { call_id: "c", tool_name: "t", tier: 1, input_hash: HASH },
      })
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(RunEventWriteError);
    expect(error.message).not.toContain(HASH);
  });

  it("enforces approval rules: an expiry is decided by timeout, a timeout cannot approve", async () => {
    const { rows, store } = memoryStore();
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    await expect(
      emitter.emit({
        type: "approval.decided",
        payload: {
          approval_id: "a",
          outcome: "approved",
          decided_by: "timeout",
          payload_hash: HASH,
        },
      }),
    ).rejects.toBeInstanceOf(RunEventValidationError);
    await emitter.emit({
      type: "approval.decided",
      payload: { approval_id: "a", outcome: "expired", decided_by: "timeout", payload_hash: HASH },
    });
    expect(rows).toHaveLength(1);
  });
});
