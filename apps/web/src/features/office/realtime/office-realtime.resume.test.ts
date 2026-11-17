// AGO-126 round 3: the catch-up resume position (overlap start + last keyset position) across failures,
// stop/start and a finished drain. Own fixtures and fake source; independent of the other test files.
import { describe, expect, it } from "vitest";
import { compareFeedOrder } from "@ago/shared";

import type { FetchEventsArgs, OfficeEventSource, SubscribeHandlers } from "./office-event-source";
import { createOfficeRealtime } from "./office-realtime";

const BASE_MS = Date.parse("2026-11-17T08:00:00.000Z");
const id = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = id(1, 1);
const OTHER_WS = id(1, 2);
const AGENT = id(3, 1);
const OTHER_AGENT = id(3, 2);
const RUN = id(4, 1);
const OTHER_RUN = id(4, 2);

interface Row {
  id: string;
  workspace_id: string;
  run_id: string;
  agent_id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

function row(seq: number, offsetMs: number = seq): Row {
  return {
    id: id(2, seq),
    workspace_id: WS,
    run_id: RUN,
    agent_id: AGENT,
    seq,
    type: seq === 1 ? "run.created" : "run.started",
    payload: seq === 1 ? { version: 1, agent_id: AGENT, task_id: null } : { version: 1 },
    created_at: new Date(BASE_MS + offsetMs).toISOString(),
  };
}

function foreignRow(seq: number, offsetMs: number): Row {
  return {
    id: id(9, seq),
    workspace_id: OTHER_WS,
    run_id: OTHER_RUN,
    agent_id: OTHER_AGENT,
    seq,
    type: seq === 1 ? "run.created" : "run.started",
    payload: seq === 1 ? { version: 1, agent_id: OTHER_AGENT, task_id: null } : { version: 1 },
    created_at: new Date(BASE_MS + offsetMs).toISOString(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6000; i += 1) await Promise.resolve();
}

function harness(pageSize = 1) {
  const rows: Row[] = [];
  const fetchCalls: FetchEventsArgs[] = [];
  let handlers: SubscribeHandlers | null = null;
  let failOnCall: number | null = null; // 1-based index into fetchCalls
  const source: OfficeEventSource = {
    fetchEvents: (a) => {
      fetchCalls.push(a);
      if (failOnCall === fetchCalls.length) return Promise.reject(new Error("network down"));
      const sinceMs = a.since === null ? -Infinity : Date.parse(a.since);
      return Promise.resolve(
        rows
          .filter((r) => Date.parse(r.created_at) >= sinceMs)
          .filter((r) => a.after === null || compareFeedOrder(r, a.after) > 0)
          .sort(compareFeedOrder)
          .slice(0, a.limit),
      );
    },
    fetchRunEvents: (a) =>
      Promise.resolve(
        rows
          .filter((r) => r.run_id === a.runId && r.seq > a.afterSeq)
          .sort((x, y) => x.seq - y.seq)
          .slice(0, a.limit),
      ),
    subscribe: (_ws, h) => {
      handlers = h;
      return () => {
        if (handlers === h) handlers = null;
      };
    },
  };
  const timers: (() => void)[] = [];
  const lastSeqs: number[] = [];
  const controller = createOfficeRealtime({
    source,
    workspaceId: WS,
    pageSize,
    onState: (s) => lastSeqs.push(s.runs[RUN]?.last_seq ?? 0),
    random: () => 1,
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => undefined,
  });
  const subscribed = async (): Promise<void> => {
    handlers?.onStatus("subscribed");
    await flush();
  };
  const fireRetry = async (): Promise<void> => {
    timers.pop()?.();
    await subscribed();
  };
  return {
    rows,
    fetchCalls,
    controller,
    lastSeqs,
    subscribed,
    fireRetry,
    failOnCall: (n: number | null) => {
      failOnCall = n;
    },
    push: (r: Row) => handlers?.onRow(r),
  };
}

const lastSeq = (c: { getState(): { runs: Record<string, { last_seq: number } | undefined> } }) =>
  c.getState().runs[RUN]?.last_seq;

describe("catch-up resume: a failed fetch mid-backlog", () => {
  it("continues from the last keyset position, not from the overlap start, after the retry", async () => {
    const h = harness(1);
    for (let q = 1; q <= 100; q += 1) h.rows.push(row(q)); // all inside one overlap window; 40 rows per load
    h.failOnCall(50); // load 1 reads 40 rows (calls 1-40), load 2 fails at its 10th page
    h.controller.start();
    await h.subscribed();
    expect(h.controller.getStatus()).toBe("reconnecting");
    const appliedBeforeRetry = lastSeq(h.controller);
    expect(appliedBeforeRetry).toBe(40);

    h.failOnCall(null);
    const callsBefore = h.fetchCalls.length;
    await h.fireRetry();

    const first = h.fetchCalls[callsBefore];
    expect(first?.after).toEqual({ created_at: row(40).created_at, id: row(40).id });
    expect(h.controller.getStatus()).toBe("live");
    expect(lastSeq(h.controller)).toBe(100);
    expect(h.lastSeqs).toEqual([...h.lastSeqs].sort((a, b) => a - b));
    expect(new Set(h.lastSeqs).size).toBe(h.lastSeqs.length);
  });
});

describe("catch-up resume: stop() then start() mid-backlog", () => {
  it("keeps the state and finishes the backlog from the stored position, each row once", async () => {
    const h = harness(1);
    for (let q = 1; q <= 100; q += 1) h.rows.push(row(q));
    h.failOnCall(50);
    h.controller.start();
    await h.subscribed();
    expect(lastSeq(h.controller)).toBe(40);

    h.controller.stop();
    h.failOnCall(null);
    const callsBefore = h.fetchCalls.length;
    h.controller.start();
    await h.subscribed();

    expect(h.fetchCalls[callsBefore]?.after).not.toBeNull();
    expect(lastSeq(h.controller)).toBe(100);
    expect(h.controller.getStatus()).toBe("live");
    expect(new Set(h.lastSeqs).size).toBe(h.lastSeqs.length);
  });
});

describe("catch-up resume: after the backlog is drained", () => {
  it("starts the next reconnect from the new cursor, not from a stale resume position", async () => {
    const h = harness(1);
    for (let q = 1; q <= 60; q += 1) h.rows.push(row(q)); // one truncated load (40), then a short page
    h.controller.start();
    await h.subscribed();
    expect(h.controller.getStatus()).toBe("live");
    expect(lastSeq(h.controller)).toBe(60);

    // A drop; a row committed far later (outside the old window) while disconnected.
    h.rows.push(row(61, 60 * 60 * 1000));
    h.controller.reconnectNow();
    const callsBefore = h.fetchCalls.length;
    await h.subscribed();

    const first = h.fetchCalls[callsBefore];
    expect(first?.after).toBeNull();
    expect(first?.since).toBe(
      new Date(Date.parse(row(60).created_at) - 5 * 60 * 1000).toISOString(),
    );
    expect(lastSeq(h.controller)).toBe(61);
  });
});

describe("AC2: other workspaces never arrive while a resumed backlog drains", () => {
  it("applies none of the interleaved foreign rows across a failure and resume", async () => {
    const h = harness(1);
    for (let q = 1; q <= 90; q += 1) {
      h.rows.push(row(q, q * 2));
      h.rows.push(foreignRow(q, q * 2 + 1));
    }
    h.failOnCall(50);
    h.controller.start();
    await h.subscribed();
    h.failOnCall(null);
    await h.fireRetry();

    expect(h.controller.getStatus()).toBe("live");
    expect(lastSeq(h.controller)).toBe(90);
    expect(h.controller.getState().runs[OTHER_RUN]).toBeUndefined();
    expect(Object.keys(h.controller.getState().runs)).toEqual([RUN]);
  });
});

describe("AC1: a live row arriving while a resumed catch-up is paging", () => {
  it("is applied once and in order after the backlog", async () => {
    const h = harness(1);
    for (let q = 1; q <= 100; q += 1) h.rows.push(row(q));
    h.failOnCall(50);
    h.controller.start();
    await h.subscribed();
    h.failOnCall(null);

    h.controller.reconnectNow(); // new connection; the retry timer is superseded
    const late = row(101);
    h.rows.push(late);
    await h.subscribed();
    h.push(late); // the stream also delivers it (duplicate of what the catch-up read)
    await flush();

    expect(lastSeq(h.controller)).toBe(101);
    expect(h.lastSeqs).toEqual([...h.lastSeqs].sort((a, b) => a - b));
    expect(new Set(h.lastSeqs).size).toBe(h.lastSeqs.length);
    expect(h.controller.getState().gaps).toEqual({});
  });
});
