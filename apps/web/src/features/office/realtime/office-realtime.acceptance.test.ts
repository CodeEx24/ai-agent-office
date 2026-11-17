// AGO-126 acceptance tests (functional tester). Independent of office-realtime.test.ts: own fixtures, own fake source.
// AC1: a dropped connection catches up, missed events fetched and applied in order.
// AC2: events of other workspaces never arrive (neither by catch-up, gap fill nor the stream).
import { describe, expect, it } from "vitest";
import type { OfficeState } from "@ago/shared";

import { loadOfficeEvents } from "./load-office-events";
import type {
  FetchEventsArgs,
  FetchRunEventsArgs,
  OfficeEventSource,
  SubscribeHandlers,
} from "./office-event-source";
import { createOfficeRealtime } from "./office-realtime";

const T0 = Date.parse("2026-11-17T08:00:00.000Z");
const uuid = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = uuid(0xa1, 1);
const FOREIGN_WS = uuid(0xa1, 2);
const AGENT = uuid(0xa2, 1);
const FOREIGN_AGENT = uuid(0xa2, 2);
const runId = (n: number): string => uuid(0xa3, n);

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

/** A row; `idn` gives it a distinct id so ties on created_at are possible. */
function row(run: number, seq: number, atSec: number, extra: Partial<Row> = {}): Row {
  return {
    id: uuid(0xa4, run * 100_000 + seq),
    workspace_id: WS,
    run_id: runId(run),
    agent_id: AGENT,
    seq,
    type: seq === 1 ? "run.created" : "run.started",
    payload: seq === 1 ? { version: 1, agent_id: AGENT, task_id: null } : { version: 1 },
    created_at: new Date(T0 + atSec * 1000).toISOString(),
    ...extra,
  };
}
const foreign = (run: number, seq: number, atSec: number): Row =>
  row(run + 500, seq, atSec, {
    workspace_id: FOREIGN_WS,
    agent_id: FOREIGN_AGENT,
    payload: seq === 1 ? { version: 1, agent_id: FOREIGN_AGENT, task_id: null } : { version: 1 },
  });

const feedCmp = (a: Row, b: Row): number =>
  Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Independent fake. `leaky` ignores workspace on purpose (simulates a broken RLS / filter). */
class Source implements OfficeEventSource {
  rows: Row[] = [];
  handlers: SubscribeHandlers | null = null;
  subscribeCount = 0;
  closeCount = 0;
  fetchCalls: FetchEventsArgs[] = [];
  runCalls: FetchRunEventsArgs[] = [];
  failFetchEvents = 0;
  failFetchRuns = 0;
  throwOnSubscribe = 0;
  leaky = true;
  /** When set, fetchEvents waits for it (to hold a catch-up in flight). */
  gate: Promise<void> | null = null;

  async fetchEvents(a: FetchEventsArgs): Promise<readonly unknown[]> {
    this.fetchCalls.push(a);
    if (this.gate) await this.gate;
    if (this.failFetchEvents > 0) {
      this.failFetchEvents -= 1;
      throw new Error("offline");
    }
    const since = a.since === null ? -Infinity : Date.parse(a.since);
    return this.rows
      .filter((r) => this.leaky || r.workspace_id === a.workspaceId)
      .filter((r) => Date.parse(r.created_at) >= since)
      .filter((r) => a.after === null || feedCmp(r, { ...r, ...a.after }) > 0)
      .sort(feedCmp)
      .slice(0, a.limit);
  }

  fetchRunEvents(a: FetchRunEventsArgs): Promise<readonly unknown[]> {
    this.runCalls.push(a);
    if (this.failFetchRuns > 0) {
      this.failFetchRuns -= 1;
      return Promise.reject(new Error("offline"));
    }
    return Promise.resolve(
      this.rows
        .filter((r) => this.leaky || r.workspace_id === a.workspaceId)
        .filter((r) => r.run_id === a.runId && r.seq > a.afterSeq)
        .sort((x, y) => x.seq - y.seq)
        .slice(0, a.limit),
    );
  }

  subscribe(_ws: string, h: SubscribeHandlers): () => void {
    this.subscribeCount += 1;
    if (this.throwOnSubscribe > 0) {
      this.throwOnSubscribe -= 1;
      throw new Error("socket refused");
    }
    this.handlers = h;
    return () => {
      this.closeCount += 1;
      if (this.handlers === h) this.handlers = null;
    };
  }

  /** Store a row; push it to the stream unless the connection is "down". */
  insert(r: Row, push = true): void {
    this.rows.push(r);
    if (push) this.handlers?.onRow(r);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
};

function setup(opts: { initialState?: OfficeState; pageSize?: number; workspaceId?: string } = {}) {
  const source = new Source();
  const states: OfficeState[] = [];
  const errors: unknown[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const controller = createOfficeRealtime({
    source,
    workspaceId: opts.workspaceId ?? WS,
    initialState: opts.initialState,
    pageSize: opts.pageSize,
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
    random: () => 1,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: () => undefined,
  });
  /** (run, seq) pairs in the order the states advanced, from the emitted states. */
  const applied = (): string[] => {
    const out: string[] = [];
    let prev: OfficeState | null = null;
    for (const s of states) {
      for (const [id, run] of Object.entries(s.runs)) {
        const before = prev?.runs[id]?.last_seq ?? 0;
        for (let q = before + 1; q <= run.last_seq; q += 1) out.push(`${id}#${String(q)}`);
      }
      prev = s;
    }
    return out;
  };
  const connect = async (): Promise<void> => {
    controller.start();
    source.handlers?.onStatus("subscribed");
    await settle();
  };
  const reconnect = async (): Promise<void> => {
    const t = timers.at(-1);
    t?.fn();
    source.handlers?.onStatus("subscribed");
    await settle();
  };
  return { source, states, errors, timers, controller, applied, connect, reconnect };
}

const seqOf = (c: { getState(): OfficeState }, run: number): number | undefined =>
  c.getState().runs[runId(run)]?.last_seq;

describe("AC1: a dropped connection catches up, missed events applied in order", () => {
  it("applies the missed events of one run in seq order, each once, after the connection returns", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2));
    await settle();

    h.source.handlers?.onStatus("closed");
    // Inserted while down, stored out of seq order in the table on purpose.
    h.source.insert(row(1, 4, 4), false);
    h.source.insert(row(1, 3, 3), false);
    await h.reconnect();

    expect(seqOf(h.controller, 1)).toBe(4);
    expect(h.applied()).toEqual([1, 2, 3, 4].map((q) => `${runId(1)}#${String(q)}`));
    expect(h.controller.getStatus()).toBe("live");
  });

  it("does not re-apply rows delivered both by the overlap re-read and by the stream", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2));
    await settle();
    h.source.handlers?.onStatus("error");
    h.source.insert(row(1, 3, 3), false);
    await h.reconnect();
    // The same row also arrives live after the reconnect, plus a replay of an old one.
    h.source.handlers?.onRow(row(1, 3, 3));
    h.source.handlers?.onRow(row(1, 1, 1));
    await settle();

    expect(h.applied()).toEqual([1, 2, 3].map((q) => `${runId(1)}#${String(q)}`));
    expect(h.controller.getState().anomalies).toEqual({ unsupported: 0, invalid: 0, foreign: 0 });
  });

  it("catches up from the cursor minus the overlap, not from the start of the feed", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    await settle();
    h.source.handlers?.onStatus("closed");
    await h.reconnect();
    const last = h.source.fetchCalls.at(-1);
    expect(last?.since).toBe(new Date(T0 + 1000 - 5 * 60 * 1000).toISOString());
  });

  it("applies a row that committed late (older created_at than the cursor, within the overlap) after a reconnect", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(2, 1, 100)); // run 2 commits first, cursor moves to t=100
    await settle();
    h.source.handlers?.onStatus("closed");
    // Run 1's transaction started at t=50 but committed only now: created_at < cursor.
    h.source.insert(row(1, 1, 50), false);
    await h.reconnect();
    expect(seqOf(h.controller, 1)).toBe(1);
    expect(seqOf(h.controller, 2)).toBe(1);
  });

  it("applies live rows that commit out of created_at order across runs without losing either run", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(2, 1, 100));
    h.source.insert(row(1, 1, 50)); // pushed later although created_at is earlier
    h.source.insert(row(1, 2, 51));
    h.source.insert(row(2, 2, 101));
    await settle();
    expect(seqOf(h.controller, 1)).toBe(2);
    expect(seqOf(h.controller, 2)).toBe(2);
    expect(h.controller.getState().gaps).toEqual({});
  });

  it("recovers a late row older than the overlap through the gap fill when the run's next event arrives", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(2, 1, 2000)); // cursor far ahead (> 5 min)
    await settle();
    h.source.handlers?.onStatus("closed");
    h.source.insert(row(1, 1, 10), false); // committed late, 33 min behind the cursor
    await h.reconnect();
    expect(seqOf(h.controller, 1)).toBeUndefined(); // cursor catch-up cannot see it (documented overlap bound)
    h.source.insert(row(1, 2, 2001)); // the next live event of run 1 reveals the gap
    await settle();
    expect(h.applied().filter((a) => a.startsWith(runId(1)))).toEqual([
      `${runId(1)}#1`,
      `${runId(1)}#2`,
    ]);
    expect(h.controller.getState().gaps).toEqual({});
  });

  it("fills a gap by seq in order when a live row skips ahead of a missed one", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2), false); // lost by the stream
    h.source.insert(row(1, 3, 3), false); // lost by the stream
    h.source.insert(row(1, 4, 4)); // arrives ahead
    await settle();
    expect(h.source.runCalls[0]).toMatchObject({ runId: runId(1), afterSeq: 1 });
    expect(h.applied()).toEqual([1, 2, 3, 4].map((q) => `${runId(1)}#${String(q)}`));
    expect(h.controller.getState().gaps).toEqual({});
  });

  it("fills the gaps of two runs independently", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(2, 1, 2));
    h.source.insert(row(1, 2, 3), false);
    h.source.insert(row(2, 2, 4), false);
    h.source.insert(row(1, 3, 5));
    h.source.insert(row(2, 3, 6));
    await settle();
    expect(seqOf(h.controller, 1)).toBe(3);
    expect(seqOf(h.controller, 2)).toBe(3);
    expect(h.controller.getState().gaps).toEqual({});
  });

  it("keeps the gap recorded and does not loop forever when the missing row is not there yet", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 3, 3)); // seq 2 does not exist anywhere
    await settle();
    expect(seqOf(h.controller, 1)).toBe(1);
    expect(h.controller.getState().gaps[runId(1)]).toMatchObject({ after_seq: 1, seen_seq: 3 });
    expect(h.source.runCalls.length).toBeLessThanOrEqual(3);
    h.source.insert(row(1, 2, 2), false); // it commits now
    h.source.insert(row(1, 4, 4)); // next live event triggers another fill
    await settle();
    expect(seqOf(h.controller, 1)).toBe(4);
  });

  it("pages a large backlog by keyset and applies all of it in order", async () => {
    const h = setup({ pageSize: 3 });
    for (let q = 1; q <= 10; q += 1) h.source.insert(row(1, q, q), false);
    await h.connect();
    expect(seqOf(h.controller, 1)).toBe(10);
    expect(h.applied()).toEqual(
      Array.from({ length: 10 }, (_, i) => `${runId(1)}#${String(i + 1)}`),
    );
  });

  it("breaks ties on created_at by id so no row at the page boundary is skipped", async () => {
    const h = setup({ pageSize: 2 });
    for (let q = 1; q <= 5; q += 1) h.source.insert(row(1, q, 7), false); // all the same instant
    await h.connect();
    expect(seqOf(h.controller, 1)).toBe(5);
  });

  it("catches up a backlog bigger than one load (maxPages x pageSize) completely", async () => {
    const h = setup({ pageSize: 2 });
    const total = 85; // > 40 pages x 2 rows, all inside one overlap window
    for (let q = 1; q <= total; q += 1) h.source.insert(row(1, q, q), false);
    await h.connect();
    expect(seqOf(h.controller, 1)).toBe(total);
  });

  it("catches up a backlog bigger than one load when the rows are spread over time", async () => {
    const h = setup({ pageSize: 2 });
    const total = 85;
    for (let q = 1; q <= total; q += 1) h.source.insert(row(1, q, q * 600), false); // 10 min apart
    await h.connect();
    expect(seqOf(h.controller, 1)).toBe(total);
  });

  it("continues from a stored snapshot and applies only newer rows", async () => {
    const first = setup();
    first.source.insert(row(1, 1, 1), false);
    first.source.insert(row(1, 2, 2), false);
    await first.connect();
    const snapshot = first.controller.getState();

    const h = setup({ initialState: snapshot });
    h.source.rows = [row(1, 1, 1), row(1, 2, 2), row(1, 3, 3)];
    await h.connect();
    expect(h.states).toHaveLength(1); // only seq 3 changed state
    expect(seqOf(h.controller, 1)).toBe(3);
  });
});

describe("AC1: failures during catch-up retry on their own", () => {
  it("reports the error, backs off and succeeds on the retry when the first catch-up fails", async () => {
    const h = setup();
    h.source.insert(row(1, 1, 1), false);
    h.source.failFetchEvents = 1;
    await h.connect();
    expect(h.errors).toHaveLength(1);
    expect(h.controller.getStatus()).toBe("reconnecting");
    expect(seqOf(h.controller, 1)).toBeUndefined();
    await h.reconnect();
    expect(seqOf(h.controller, 1)).toBe(1);
    expect(h.controller.getStatus()).toBe("live");
  });

  it("does not leak row data into the error callback", async () => {
    const h = setup();
    h.source.insert(row(1, 1, 1), false);
    h.source.failFetchEvents = 1;
    await h.connect();
    expect(JSON.stringify(h.errors.map(String))).not.toContain(runId(1));
  });

  it("retries when the gap fill fails and still applies the rows in order afterwards", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    await settle();
    h.source.insert(row(1, 2, 2), false);
    h.source.failFetchRuns = 1;
    h.source.insert(row(1, 3, 3));
    await settle();
    expect(h.errors).toHaveLength(1);
    await h.reconnect();
    expect(h.applied()).toEqual([1, 2, 3].map((q) => `${runId(1)}#${String(q)}`));
    expect(h.controller.getStatus()).toBe("live");
  });

  it("retries when subscribing itself throws", async () => {
    const h = setup();
    h.source.throwOnSubscribe = 1;
    h.controller.start();
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.fn();
    h.source.handlers?.onStatus("subscribed");
    await settle();
    expect(h.controller.getStatus()).toBe("live");
  });

  it("grows the backoff on repeated drops and caps it", () => {
    const h = setup();
    h.controller.start();
    for (let i = 0; i < 8; i += 1) {
      h.source.handlers?.onStatus("error");
      h.timers.at(-1)?.fn();
    }
    const delays = h.timers.map((t) => t.ms);
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    expect(delays.at(-1)).toBe(30_000);
  });

  it("start() twice opens a single connection", () => {
    const h = setup();
    h.controller.start();
    h.controller.start();
    expect(h.source.subscribeCount).toBe(1);
  });

  it("can be started again after stop() and catches up again", async () => {
    const h = setup();
    h.source.insert(row(1, 1, 1), false);
    await h.connect();
    h.controller.stop();
    h.source.insert(row(1, 2, 2), false);
    await h.connect();
    expect(seqOf(h.controller, 1)).toBe(2);
    expect(h.controller.getStatus()).toBe("live");
  });
});

describe("AC1: stop() then late events", () => {
  it("emits nothing when the catch-up finishes after stop()", async () => {
    const h = setup();
    h.source.insert(row(1, 1, 1), false);
    let release: () => void = () => undefined;
    h.source.gate = new Promise<void>((r) => {
      release = r;
    });
    h.controller.start();
    h.source.handlers?.onStatus("subscribed");
    await settle();
    h.controller.stop();
    release();
    await settle();
    expect(h.states).toHaveLength(0);
    expect(h.controller.getStatus()).toBe("stopped");
  });

  it("ignores rows, statuses and a pending retry after stop()", async () => {
    const h = setup();
    await h.connect();
    const stale = h.source.handlers;
    h.source.handlers?.onStatus("error"); // schedules a retry
    h.controller.stop();
    const emitted = h.states.length;
    h.timers[0]?.fn(); // the retry fires after stop
    stale?.onRow(row(1, 1, 1));
    stale?.onStatus("subscribed");
    await settle();
    expect(h.states).toHaveLength(emitted);
    expect(h.source.subscribeCount).toBe(1);
  });

  it("ignores rows of the dead connection after a reconnect replaced it", async () => {
    const h = setup();
    await h.connect();
    const dead = h.source.handlers;
    h.source.handlers?.onStatus("closed");
    await h.reconnect();
    const before = h.states.length;
    dead?.onRow(row(1, 1, 1));
    await settle();
    expect(h.states).toHaveLength(before);
  });
});

describe("AC2: events of other workspaces never arrive", () => {
  it("never applies another workspace's rows returned by catch-up, even from a leaky source", async () => {
    const h = setup();
    h.source.insert(row(1, 1, 1), false);
    h.source.insert(foreign(1, 1, 2), false);
    h.source.insert(foreign(1, 2, 3), false);
    await h.connect();
    const state = h.controller.getState();
    expect(Object.keys(state.runs)).toEqual([runId(1)]);
    expect(Object.values(state.runs).every((r) => r.agent_id === AGENT)).toBe(true);
  });

  it("never lets a foreign row move the cursor", async () => {
    const h = setup();
    h.source.insert(row(1, 1, 1), false);
    h.source.insert(foreign(1, 1, 900), false); // far in the future
    await h.connect();
    expect(h.controller.getState().cursor?.created_at).toBe(new Date(T0 + 1000).toISOString());
  });

  it("never applies a foreign row pushed by the stream", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(foreign(1, 1, 1));
    h.source.insert(foreign(1, 2, 2));
    await settle();
    expect(h.controller.getState().runs).toEqual({});
    expect(h.controller.getState().cursor).toBeNull();
    expect(h.states.every((s) => Object.keys(s.runs).length === 0)).toBe(true);
  });

  it("never applies a foreign row that reuses one of our run ids", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2, { workspace_id: FOREIGN_WS }));
    await settle();
    expect(seqOf(h.controller, 1)).toBe(1);
  });

  it("never applies foreign rows returned by the per-run gap fill", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2, { workspace_id: FOREIGN_WS }), false); // same run id, other workspace
    h.source.insert(row(1, 3, 3)); // gap: fill asks for seq > 1
    await settle();
    expect(seqOf(h.controller, 1)).toBe(1);
    expect(h.controller.getState().gaps[runId(1)]).toBeDefined();
  });

  it("loadOfficeEvents drops foreign rows and counts them", async () => {
    const source = new Source();
    source.rows = [row(1, 1, 1), foreign(1, 1, 2)];
    const loaded = await loadOfficeEvents({ source, workspaceId: WS, cursor: null });
    expect(loaded.rows.map((r) => r.workspace_id)).toEqual([WS]);
    expect(loaded.foreign).toBe(1);
  });

  it("ignores an initial snapshot that belongs to another workspace", async () => {
    const first = setup({ workspaceId: FOREIGN_WS });
    first.source.rows = [foreign(1, 1, 1)];
    await first.connect();
    const foreignSnapshot = first.controller.getState();
    expect(Object.keys(foreignSnapshot.runs)).toHaveLength(1);

    const h = setup({ initialState: foreignSnapshot });
    expect(h.controller.getState().workspace_id).toBe(WS);
    expect(h.controller.getState().runs).toEqual({});
  });
});

describe("AC1/AC2: invalid and unknown rows", () => {
  it("survives garbage rows from the stream and keeps applying valid ones", async () => {
    const h = setup();
    await h.connect();
    h.source.handlers?.onRow(null);
    h.source.handlers?.onRow("nope");
    h.source.handlers?.onRow({ id: "x" });
    h.source.handlers?.onRow({ ...row(1, 1, 1), seq: -3 });
    h.source.insert(row(1, 1, 1));
    await settle();
    expect(seqOf(h.controller, 1)).toBe(1);
    expect(h.controller.getState().anomalies.invalid).toBe(4);
    expect(h.errors).toHaveLength(0);
  });

  it("skips garbage rows in catch-up without failing it", async () => {
    const h = setup();
    h.source.insert(row(1, 1, 1), false);
    h.source.rows.push({ ...row(1, 2, 2), created_at: "not a date" });
    h.source.insert(row(1, 3, 3), false);
    await h.connect();
    expect(h.errors).toHaveLength(0);
    expect(h.controller.getStatus()).toBe("live");
    expect(seqOf(h.controller, 1)).toBe(1); // seq 2 was invalid so seq 3 is a gap, not applied out of order
  });

  it("counts an unknown event type, advances the run past it and keeps order", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2, { type: "run.from_the_future" }));
    h.source.insert(row(1, 3, 3));
    await settle();
    expect(seqOf(h.controller, 1)).toBe(3);
    expect(h.controller.getState().anomalies.unsupported).toBe(1);
  });

  it("counts a newer payload version as unsupported without crashing", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2, { payload: { version: 99 } }));
    await settle();
    expect(seqOf(h.controller, 1)).toBe(2);
    expect(h.controller.getState().anomalies.unsupported).toBe(1);
  });

  it("rejects a row whose agent differs from the run's agent", async () => {
    const h = setup();
    await h.connect();
    h.source.insert(row(1, 1, 1));
    h.source.insert(row(1, 2, 2, { agent_id: uuid(0xa2, 77) }));
    await settle();
    expect(seqOf(h.controller, 1)).toBe(1);
    expect(h.controller.getState().anomalies.invalid).toBe(1);
  });
});
