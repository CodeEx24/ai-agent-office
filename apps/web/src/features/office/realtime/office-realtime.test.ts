import { describe, expect, it } from "vitest";
import { compareFeedOrder, type OfficeState } from "@ago/shared";

import { loadOfficeEvents } from "./load-office-events";
import type {
  FetchEventsArgs,
  FetchRunEventsArgs,
  OfficeEventSource,
  OfficeRealtimeStatus,
  SubscribeHandlers,
} from "./office-event-source";
import { createOfficeRealtime } from "./office-realtime";

// ---------------------------------------------------------------- fixtures

const BASE_MS = Date.parse("2026-11-17T08:00:00.000Z");

function mkId(ns: number, n: number): string {
  return `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
const WS = mkId(1, 1);
const OTHER_WS = mkId(1, 2);
const AGENT = mkId(3, 1);
const runId = (n: number): string => mkId(4, n);

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

/** `run.created` for seq 1, then `run.started` (payload-free) for the rest: all valid, all advance seq. */
function mk(run: number, seq: number, at: number, ws: string = WS): Row {
  return {
    id: mkId(2, run * 10_000 + seq),
    workspace_id: ws,
    run_id: runId(run),
    agent_id: AGENT,
    seq,
    type: seq === 1 ? "run.created" : "run.started",
    payload: seq === 1 ? { version: 1, agent_id: AGENT, task_id: null } : { version: 1 },
    created_at: new Date(BASE_MS + at * 1000).toISOString(),
  };
}

class FakeSource implements OfficeEventSource {
  rows: Row[] = [];
  fetchCalls: FetchEventsArgs[] = [];
  runCalls: FetchRunEventsArgs[] = [];
  subscriptions = 0;
  handlers: SubscribeHandlers | null = null;
  closed = 0;
  failFetches = 0;

  fetchEvents(args: FetchEventsArgs): Promise<readonly unknown[]> {
    this.fetchCalls.push(args);
    if (this.failFetches > 0) {
      this.failFetches -= 1;
      return Promise.reject(new Error("network down"));
    }
    // A leaky server on purpose: it does not filter by workspace. The loader must.
    const sinceMs = args.since === null ? -Infinity : Date.parse(args.since);
    const out = this.rows
      .filter((r) => Date.parse(r.created_at) >= sinceMs)
      .filter((r) => args.after === null || compareFeedOrder(r, args.after) > 0)
      .sort(compareFeedOrder)
      .slice(0, args.limit);
    return Promise.resolve(out);
  }

  fetchRunEvents(args: FetchRunEventsArgs): Promise<readonly unknown[]> {
    this.runCalls.push(args);
    return Promise.resolve(
      this.rows
        .filter((r) => r.run_id === args.runId && r.seq > args.afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, args.limit),
    );
  }

  subscribe(_ws: string, handlers: SubscribeHandlers): () => void {
    this.subscriptions += 1;
    this.handlers = handlers;
    return () => {
      this.closed += 1;
      if (this.handlers === handlers) this.handlers = null;
    };
  }

  insert(row: Row, push = true): void {
    this.rows.push(row);
    if (push) this.handlers?.onRow(row);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

interface Harness {
  source: FakeSource;
  states: OfficeState[];
  statuses: OfficeRealtimeStatus[];
  errors: unknown[];
  timers: { fn: () => void; ms: number; cleared: boolean }[];
  controller: ReturnType<typeof createOfficeRealtime>;
}

function harness(overrides: { initialState?: OfficeState; pageSize?: number } = {}): Harness {
  const source = new FakeSource();
  const states: OfficeState[] = [];
  const statuses: OfficeRealtimeStatus[] = [];
  const errors: unknown[] = [];
  const timers: Harness["timers"] = [];
  const controller = createOfficeRealtime({
    source,
    workspaceId: WS,
    initialState: overrides.initialState,
    pageSize: overrides.pageSize,
    onState: (s) => states.push(s),
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
    random: () => 1,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { source, states, statuses, errors, timers, controller };
}

const lastSeq = (c: Harness["controller"], run: number): number | undefined =>
  c.getState().runs[runId(run)]?.last_seq;

// ---------------------------------------------------------------- tests

describe("loadOfficeEvents", () => {
  it("returns feed-ordered rows, one per id, from cursor minus overlap", async () => {
    const source = new FakeSource();
    source.rows = [mk(1, 1, 10), mk(1, 2, 20), mk(1, 3, 30), mk(1, 3, 30)];
    const loaded = await loadOfficeEvents({
      source,
      workspaceId: WS,
      cursor: { created_at: mk(1, 3, 30).created_at, id: mk(1, 3, 30).id },
      overlapMs: 15_000,
    });
    expect(source.fetchCalls[0]?.since).toBe(new Date(BASE_MS + 15_000).toISOString());
    expect(loaded.rows.map((r) => r.seq)).toEqual([2, 3]);
  });

  it("drops and counts rows of another workspace and invalid rows", async () => {
    const source = new FakeSource();
    source.rows = [mk(1, 1, 10), mk(2, 1, 11, OTHER_WS), mk(1, 2, 12)];
    const bad = { ...mk(1, 3, 13), seq: -1 };
    source.rows.push(bad);
    const loaded = await loadOfficeEvents({ source, workspaceId: WS, cursor: null });
    expect(loaded.rows.every((r) => r.workspace_id === WS)).toBe(true);
    expect(loaded.rows).toHaveLength(2);
    expect(loaded.foreign).toBe(1);
    expect(loaded.invalid).toBe(1);
  });

  it("pages by keyset until a short page", async () => {
    const source = new FakeSource();
    source.rows = [1, 2, 3, 4, 5].map((n) => mk(1, n, n));
    const loaded = await loadOfficeEvents({ source, workspaceId: WS, cursor: null, pageSize: 2 });
    expect(loaded.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(source.fetchCalls).toHaveLength(3);
    expect(loaded.truncated).toBe(false);
  });

  it("reports truncation at maxPages", async () => {
    const source = new FakeSource();
    source.rows = [1, 2, 3, 4, 5].map((n) => mk(1, n, n));
    const loaded = await loadOfficeEvents({
      source,
      workspaceId: WS,
      cursor: null,
      pageSize: 2,
      maxPages: 1,
    });
    expect(loaded.truncated).toBe(true);
    expect(loaded.rows).toHaveLength(2);
  });
});

describe("createOfficeRealtime", () => {
  it("subscribes first, catches up on subscribed, then goes live", async () => {
    const h = harness();
    h.source.rows = [mk(1, 1, 10), mk(1, 2, 20)];
    h.controller.start();
    expect(h.source.subscriptions).toBe(1);
    expect(h.statuses).toEqual(["connecting"]);
    h.source.handlers?.onStatus("subscribed");
    await flush();
    expect(h.statuses).toEqual(["connecting", "catching_up", "live"]);
    expect(lastSeq(h.controller, 1)).toBe(2);
  });

  it("applies live rows, ignoring duplicates", async () => {
    const h = harness();
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    await flush();
    h.source.insert(mk(1, 1, 10));
    h.source.insert(mk(1, 2, 20));
    h.source.insert(mk(1, 2, 20));
    await flush();
    expect(lastSeq(h.controller, 1)).toBe(2);
    expect(h.states).toHaveLength(2); // the duplicate changed nothing
  });

  it("applies live rows that arrive during catch-up after it, once each", async () => {
    const h = harness();
    h.source.rows = [mk(1, 1, 10)];
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    h.source.insert(mk(1, 2, 20)); // pushed while the catch-up is still running
    await flush();
    expect(lastSeq(h.controller, 1)).toBe(2);
    expect(h.controller.getState().anomalies).toEqual({ unsupported: 0, invalid: 0, foreign: 0 });
  });

  it("AC1: after a drop, missed events are fetched and applied in order, each once", async () => {
    const h = harness();
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    h.source.insert(mk(1, 1, 10));
    h.source.insert(mk(1, 2, 20));
    await flush();

    h.source.handlers?.onStatus("closed"); // connection drops
    expect(h.controller.getStatus()).toBe("reconnecting");
    expect(h.source.closed).toBe(1);
    // Events inserted while down; one of them is also an old, late-committed row inside the overlap.
    h.source.insert(mk(1, 3, 30), false);
    h.source.insert(mk(1, 4, 40), false);
    h.source.insert(mk(2, 1, 25), false);

    expect(h.timers).toHaveLength(1);
    h.timers[0]?.fn(); // backoff elapsed
    expect(h.source.subscriptions).toBe(2);
    const before = h.states.length;
    h.source.handlers?.onStatus("subscribed");
    await flush();

    expect(h.controller.getStatus()).toBe("live");
    expect(lastSeq(h.controller, 1)).toBe(4);
    expect(lastSeq(h.controller, 2)).toBe(1);
    expect(h.controller.getState().anomalies).toEqual({ unsupported: 0, invalid: 0, foreign: 0 });
    // Only new rows changed state: seq 3, seq 4 and run 2 (the overlap re-read of seq 1-2 did nothing).
    expect(h.states.length - before).toBe(1); // one catch-up batch, one state emit
    const fetch = h.source.fetchCalls.at(-1);
    expect(fetch?.since).not.toBeNull();
  });

  it("fills a gap by seq when a live row skips ahead", async () => {
    const h = harness();
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    h.source.insert(mk(1, 1, 10));
    await flush();
    h.source.insert(mk(1, 2, 20), false); // missed by the stream
    h.source.insert(mk(1, 3, 30)); // arrives ahead of seq 2
    await flush();
    expect(h.source.runCalls).toHaveLength(1);
    expect(h.source.runCalls[0]).toMatchObject({ runId: runId(1), afterSeq: 1 });
    expect(lastSeq(h.controller, 1)).toBe(3);
    expect(h.controller.getState().gaps).toEqual({});
  });

  it("never applies a row of another workspace", async () => {
    const h = harness();
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    h.source.insert(mk(9, 1, 10, OTHER_WS));
    await flush();
    expect(h.controller.getState().runs).toEqual({});
    expect(h.controller.getState().anomalies.foreign).toBe(1);
  });

  it("retries with exponential backoff and resets after a good catch-up", async () => {
    const h = harness();
    h.source.failFetches = 2;
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    await flush();
    expect(h.errors).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(1000); // base, random() = 1 gives the full delay
    h.timers[0]?.fn();
    h.source.handlers?.onStatus("subscribed");
    await flush();
    expect(h.timers[1]?.ms).toBe(2000);
    h.timers[1]?.fn();
    h.source.handlers?.onStatus("subscribed");
    await flush();
    expect(h.controller.getStatus()).toBe("live");
    h.source.handlers?.onStatus("error");
    expect(h.timers[2]?.ms).toBe(1000); // back to base
  });

  it("stop() closes the stream and ignores later events", async () => {
    const h = harness();
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    await flush();
    const handlers = h.source.handlers;
    h.controller.stop();
    expect(h.source.closed).toBe(1);
    expect(h.controller.getStatus()).toBe("stopped");
    const emitted = h.states.length;
    handlers?.onRow(mk(1, 1, 10));
    handlers?.onStatus("closed");
    await flush();
    expect(h.states).toHaveLength(emitted);
    expect(h.timers).toHaveLength(0);
  });

  it("reconnectNow() reconnects immediately and cancels a pending retry", () => {
    const h = harness();
    h.controller.start();
    h.source.handlers?.onStatus("error");
    expect(h.timers).toHaveLength(1);
    h.controller.reconnectNow();
    expect(h.timers[0]?.cleared).toBe(true);
    expect(h.source.subscriptions).toBe(2);
  });

  it("continues from a snapshot: only rows after its cursor change state", async () => {
    const seed = harness();
    seed.source.rows = [mk(1, 1, 10), mk(1, 2, 20)];
    seed.controller.start();
    seed.source.handlers?.onStatus("subscribed");
    await flush();
    const snapshot = seed.controller.getState();

    const h = harness({ initialState: snapshot });
    h.source.rows = [mk(1, 1, 10), mk(1, 2, 20), mk(1, 3, 30)];
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    await flush();
    expect(lastSeq(h.controller, 1)).toBe(3);
    expect(h.states).toHaveLength(1);
  });
});

describe("truncated catch-up continues from the keyset position", () => {
  async function settle(h: Harness): Promise<void> {
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    for (let i = 0; i < 60; i += 1) await flush();
  }

  it("catches up a backlog of exactly maxPages x pageSize, then proves the drain with one short page", async () => {
    const h = harness({ pageSize: 2 });
    for (let q = 1; q <= 80; q += 1) h.source.insert(mk(1, q, q), false); // 40 pages x 2, one overlap window
    await settle(h);
    expect(lastSeq(h.controller, 1)).toBe(80);
    expect(h.controller.getStatus()).toBe("live");
    expect(h.errors).toEqual([]);
    const last = h.source.fetchCalls.at(-1);
    expect(last?.after).not.toBeNull(); // the final fetch resumed from the keyset, not from the overlap start
    expect(h.source.fetchCalls.filter((c) => c.after === null)).toHaveLength(1);
  });

  it("never goes live while a backlog is left: it fails into a reconnect and resumes", async () => {
    const h = harness({ pageSize: 1 });
    for (let q = 1; q <= 25 * 40 + 5; q += 1) h.source.insert(mk(1, q, q), false); // more than 20 loads x 40 pages
    await settle(h);
    expect(h.controller.getStatus()).not.toBe("live");
    expect(h.errors).toHaveLength(1);
    expect(h.statuses).not.toContain("live");
  });

  it("applies rows inserted while the catch-up is paging, in order, once each", async () => {
    const h = harness({ pageSize: 2 });
    for (let q = 1; q <= 100; q += 1) h.source.insert(mk(1, q, q), false);
    const original = h.source.fetchEvents.bind(h.source);
    let calls = 0;
    h.source.fetchEvents = (args): Promise<readonly unknown[]> => {
      calls += 1;
      if (calls === 30) {
        h.source.insert(mk(1, 101, 101), true); // also pushed live; the catch-up must not double-apply it
        h.source.insert(mk(1, 102, 102), false);
      }
      return original(args);
    };
    await settle(h);
    expect(lastSeq(h.controller, 1)).toBe(102);
    const seen = h.states.map((s) => s.runs[runId(1)]?.last_seq ?? 0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    expect(h.controller.getState().gaps).toEqual({});
  });
});

describe("the resume position survives reconnects", () => {
  it("never moves backwards across reconnects and applies each row once", async () => {
    const h = harness({ pageSize: 1 });
    const total = 25 * 40 + 5; // above one connection's cap (20 loads x 40 pages x 1 row), one overlap window
    for (let q = 1; q <= total; q += 1) h.source.insert(mk(1, q, q), false);
    h.controller.start();
    for (let attempt = 0; attempt < 6 && h.controller.getStatus() !== "live"; attempt += 1) {
      h.source.handlers?.onStatus("subscribed");
      for (let i = 0; i < 60; i += 1) await flush();
      const timer = h.timers.filter((t) => !t.cleared).pop();
      if (h.controller.getStatus() !== "live" && timer) {
        timer.cleared = true;
        timer.fn();
      }
    }
    expect(h.controller.getStatus()).toBe("live");
    expect(lastSeq(h.controller, 1)).toBe(total);
    expect(h.errors.length).toBeGreaterThan(0); // the cap was hit at least once
    const seen = h.states.map((s) => s.runs[runId(1)]?.last_seq ?? 0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    const positions = h.source.fetchCalls.filter((c) => c.after !== null).map((c) => c.after);
    for (let i = 1; i < positions.length; i += 1) {
      const prev = positions[i - 1];
      const cur = positions[i];
      if (prev && cur) expect(compareFeedOrder(cur, prev)).toBeGreaterThanOrEqual(0);
    }
  });
});
