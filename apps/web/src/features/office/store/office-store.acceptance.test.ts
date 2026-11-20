// AGO-142 acceptance tests (functional tester, round 1). Independent of office-store.test.ts: own fixtures,
// own fake source, expected agent states derived by hand from the AGO-124 contract (not from the code under test).
// AC1: after reload, the store matches the state before reload.
// AC2: store updates are driven only by events.
import { describe, expect, it, vi } from "vitest";

import type {
  FetchEventsArgs,
  FetchRunEventsArgs,
  OfficeEventSource,
  SubscribeHandlers,
} from "../realtime/office-event-source";
import { createOfficeStore, selectOfficeAgentState, selectOfficeAgentStates } from "./office-store";
import type { OfficeStore } from "./office-store";

vi.setConfig({ testTimeout: 20_000 });

const T0 = Date.parse("2026-11-19T09:00:00.000Z");
const uuid = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = uuid(0xc1, 1);
const WS_B = uuid(0xc1, 2);
const AGENT_A = uuid(0xc2, 1);
const AGENT_B = uuid(0xc2, 2);
const AGENT_C = uuid(0xc2, 3);
const runId = (n: number): string => uuid(0xc3, n);
const HASH = "a".repeat(64);
const EXPIRES = "2026-11-19T10:00:00.000Z";

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

let rowCounter = 0;
function ev(
  run: number,
  seq: number,
  type: string,
  fields: Record<string, unknown>,
  atSec: number,
  extra: Partial<Row> = {},
): Row {
  rowCounter += 1;
  return {
    id: uuid(0xc4, rowCounter),
    workspace_id: WS,
    run_id: runId(run),
    agent_id: AGENT_A,
    seq,
    type,
    payload: { version: 1, ...fields },
    created_at: new Date(T0 + atSec * 1000).toISOString(),
    ...extra,
  };
}

const feedCmp = (a: Row, b: Row): number =>
  Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A believable office, 11 rows: run 1 (agent A) ends waiting on a human approval, run 2 (agent B) has a tool
 * call in flight, run 3 (agent C) completed.
 */
function officeLog(): Row[] {
  const rows: Row[] = [];
  let t = 0;
  const add = (
    run: number,
    seq: number,
    type: string,
    fields: Record<string, unknown>,
    agent: string,
  ): void => {
    t += 1;
    rows.push(ev(run, seq, type, fields, t, { agent_id: agent }));
  };
  add(1, 1, "run.created", { agent_id: AGENT_A, task_id: null }, AGENT_A);
  add(1, 2, "run.started", {}, AGENT_A);
  add(1, 3, "step.started", { step: 1 }, AGENT_A);
  add(
    1,
    4,
    "tool_call.requested",
    { call_id: "c1", tool_name: "send_email", tier: 3, input_hash: HASH },
    AGENT_A,
  );
  add(
    1,
    5,
    "approval.requested",
    { approval_id: "ap1", call_id: "c1", payload_hash: HASH, tier: 3, expires_at: EXPIRES },
    AGENT_A,
  );
  add(2, 1, "run.created", { agent_id: AGENT_B, task_id: null }, AGENT_B);
  add(2, 2, "run.started", {}, AGENT_B);
  add(
    2,
    3,
    "tool_call.requested",
    { call_id: "c2", tool_name: "read_file", tier: 0, input_hash: HASH },
    AGENT_B,
  );
  add(3, 1, "run.created", { agent_id: AGENT_C, task_id: null }, AGENT_C);
  add(3, 2, "run.started", {}, AGENT_C);
  add(3, 3, "run.completed", { steps: 1 }, AGENT_C);
  return rows;
}

/** Fake source. The stored log is `rows`; `push` sends a row down the stream. */
class FakeSource implements OfficeEventSource {
  rows: Row[] = [];
  handlers: SubscribeHandlers | null = null;
  subscribeCount = 0;
  closeCount = 0;
  /** When set, fetchEvents waits for it (keeps a catch-up in flight). */
  gate: Promise<void> | null = null;

  async fetchEvents(a: FetchEventsArgs): Promise<readonly unknown[]> {
    if (this.gate) await this.gate;
    const since = a.since === null ? -Infinity : Date.parse(a.since);
    return this.rows
      .filter((r) => r.workspace_id === a.workspaceId)
      .filter((r) => Date.parse(r.created_at) >= since)
      .filter((r) => a.after === null || feedCmp(r, { ...r, ...a.after }) > 0)
      .sort(feedCmp)
      .slice(0, a.limit);
  }

  fetchRunEvents(a: FetchRunEventsArgs): Promise<readonly unknown[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) => r.workspace_id === a.workspaceId && r.run_id === a.runId && r.seq > a.afterSeq,
        )
        .sort((x, y) => x.seq - y.seq)
        .slice(0, a.limit),
    );
  }

  subscribe(_ws: string, h: SubscribeHandlers): () => void {
    this.subscribeCount += 1;
    this.handlers = h;
    return () => {
      this.closeCount += 1;
      if (this.handlers === h) this.handlers = null;
    };
  }

  push(row: unknown): void {
    this.handlers?.onRow(row);
  }
}

const withRows = (rows: readonly Row[]): FakeSource =>
  Object.assign(new FakeSource(), { rows: [...rows] });

const settle = async (): Promise<void> => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
};

interface Timers {
  pending: (() => void)[];
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}
function makeTimers(): Timers {
  const pending: (() => void)[] = [];
  return {
    pending,
    setTimer: (fn) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimer: () => undefined,
  };
}

async function open(
  source: FakeSource,
  opts: { workspaceId?: string; pageSize?: number; overlapMs?: number; timers?: Timers } = {},
): Promise<OfficeStore> {
  const timers = opts.timers ?? makeTimers();
  const store = createOfficeStore();
  store.getState().connect({
    source,
    workspaceId: opts.workspaceId ?? WS,
    pageSize: opts.pageSize,
    overlapMs: opts.overlapMs,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0,
  });
  source.handlers?.onStatus("subscribed");
  await settle();
  return store;
}

/** A deterministic shuffle (LCG), so a failing order can be replayed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const j = s % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/** An element that must exist (the fixtures are fixed, so a miss is a test bug). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`fixture index ${String(index)} is missing`);
  return value;
}

describe("AGO-142 AC1: after reload, the store matches the state before reload", () => {
  it("a full live session and a fresh store from the same stored log are deep-equal, with the expected agent states", async () => {
    const source = new FakeSource();
    const before = await open(source);
    for (const row of officeLog()) {
      source.rows.push(row);
      source.push(row);
    }
    await settle();

    const after = await open(source); // reload
    expect(after.getState().office).toEqual(before.getState().office);

    // Expected states, derived by hand from the contract (not from the selector's code).
    const states = selectOfficeAgentStates(after.getState());
    expect(states[AGENT_A]).toMatchObject({
      state: "waiting_on_you",
      run_id: runId(1),
      approval_id: "ap1",
    });
    expect(states[AGENT_B]).toMatchObject({ state: "working", run_id: runId(2) });
    expect(states[AGENT_C]).toMatchObject({ state: "idle", run_id: runId(3) });
    expect(selectOfficeAgentStates(before.getState())).toEqual(states);
  });

  it("includes events that arrived while the page was gone (stream down during the reload gap)", async () => {
    const log = officeLog();
    const source = new FakeSource();
    const before = await open(source);
    for (const row of log.slice(0, 6)) {
      source.rows.push(row);
      source.push(row);
    }
    await settle();
    before.getState().disconnect();
    source.rows.push(...log.slice(6)); // arrived while nobody listened

    const after = await open(source);
    const full = await open(withRows(log));
    expect(after.getState().office).toEqual(full.getState().office);
    expect(selectOfficeAgentState(after.getState(), AGENT_C)?.state).toBe("idle");
    expect(selectOfficeAgentState(after.getState(), AGENT_B)?.state).toBe("working");
  });

  it("a live row that arrives while the reload's catch-up is still in flight is applied after it, once", async () => {
    const log = officeLog();
    const source = withRows(log.slice(0, 8));
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createOfficeStore();
    store.getState().connect({ source, workspaceId: WS, ...makeTimers() });
    source.handlers?.onStatus("subscribed");
    await settle();
    expect(store.getState().status).toBe("catching_up");

    const late = at(log, 8);
    source.rows.push(late);
    source.push(late); // live, during catch-up
    source.push(late); // and a duplicate of it
    source.gate = null;
    release();
    await settle();

    source.rows.push(at(log, 9), at(log, 10));
    source.push(at(log, 9));
    source.push(at(log, 10));
    await settle();

    const reference = await open(withRows(log));
    expect(store.getState().status).toBe("live");
    expect(store.getState().office).toEqual(reference.getState().office);
  });

  it("rebuilds the same state when the backlog is paged (page size 2 over 11 rows)", async () => {
    const log = officeLog();
    const big = await open(withRows(log));
    const small = await open(withRows(log), { pageSize: 2 });
    expect(small.getState().office).toEqual(big.getState().office);
    expect(Object.keys(small.getState().office?.runs ?? {})).toHaveLength(3);
  });

  it("copes with duplicates and a very wide overlap window: reload twice gives the same state", async () => {
    const source = withRows(officeLog());
    const first = await open(source, { overlapMs: 365 * 24 * 3600 * 1000 });
    for (const row of source.rows) source.push(row); // every row delivered again live
    await settle();
    const second = await open(source, { overlapMs: 0 });
    expect(first.getState().office).toEqual(second.getState().office);
    expect(first.getState().office?.gaps).toEqual({});
  });

  it("an out-of-order stream (rows delivered in shuffled order) still ends in the stored log's state", async () => {
    const log = officeLog();
    for (const seed of [1, 2, 3, 4, 5]) {
      const source = new FakeSource();
      const live = await open(source);
      source.rows = [...log];
      for (const row of shuffled(log, seed)) source.push(row);
      await settle();
      const reloaded = await open(source);
      expect(live.getState().office?.gaps, `seed ${String(seed)} left a gap`).toEqual({});
      expect(live.getState().office, `seed ${String(seed)}`).toEqual(reloaded.getState().office);
    }
  });

  it("a dropped stream reconnects and catches up the missed events", async () => {
    const log = officeLog();
    const source = new FakeSource();
    const timers = makeTimers();
    const store = await open(source, { timers });
    for (const row of log.slice(0, 5)) {
      source.rows.push(row);
      source.push(row);
    }
    await settle();

    source.handlers?.onStatus("closed");
    expect(store.getState().status).toBe("reconnecting");
    source.rows.push(...log.slice(5)); // missed while down
    expect(timers.pending.length).toBeGreaterThan(0);
    timers.pending.shift()?.();
    source.handlers?.onStatus("subscribed");
    await settle();

    const reference = await open(withRows(log));
    expect(store.getState().status).toBe("live");
    expect(store.getState().office).toEqual(reference.getState().office);
  });

  it("an empty workspace reloads to an empty office, not to a stale or null one", async () => {
    const source = new FakeSource();
    const before = await open(source);
    const after = await open(source);
    expect(after.getState().office).toEqual(before.getState().office);
    expect(after.getState().office?.runs).toEqual({});
    expect(after.getState().office?.cursor).toBeNull();
    expect(selectOfficeAgentStates(after.getState())).toEqual({});
  });

  it("switching workspace and back rebuilds the first workspace's state, with nothing from the second", async () => {
    const foreignRow = ev(9, 1, "run.created", { agent_id: AGENT_B, task_id: null }, 1, {
      workspace_id: WS_B,
      agent_id: AGENT_B,
    });
    const source = withRows([...officeLog(), foreignRow]);
    const store = await open(source);
    const original = store.getState().office;
    expect(original?.workspace_id).toBe(WS);
    expect(Object.keys(original?.runs ?? {})).not.toContain(runId(9));

    const timers = makeTimers();
    store.getState().connect({ source, workspaceId: WS_B, ...timers });
    expect(store.getState().office?.workspace_id).toBe(WS_B);
    expect(store.getState().office?.runs).toEqual({}); // reset at once, before any event
    source.handlers?.onStatus("subscribed");
    await settle();
    expect(Object.keys(store.getState().office?.runs ?? {})).toEqual([runId(9)]);

    store.getState().connect({ source, workspaceId: WS, ...timers });
    source.handlers?.onStatus("subscribed");
    await settle();
    expect(store.getState().office).toEqual(original);
  });
});

describe("AGO-142 AC2: store updates are driven only by events", () => {
  it("the public handle can only read and subscribe; the only actions are connect and disconnect", () => {
    const store = createOfficeStore();
    expect(Object.keys(store).sort()).toEqual(["getInitialState", "getState", "subscribe"]);
    const actions = Object.entries(store.getState())
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .sort();
    expect(actions).toEqual(["connect", "disconnect"]);
  });

  it("nothing changes the state without an event: a quiet period, selector reads and a repeated connect leave the office as it was", async () => {
    const source = withRows(officeLog());
    const store = await open(source);
    const office = store.getState().office;
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    selectOfficeAgentStates(store.getState());
    store.getState().connect({ source, workspaceId: WS }); // same workspace: no-op
    await settle();
    expect(store.getState().office).toBe(office);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("every change of the office is caused by a delivered row; a duplicate is not a change", async () => {
    const source = new FakeSource();
    const store = await open(source);
    const seen: unknown[] = [];
    store.subscribe((s, prev) => {
      if (s.office !== prev.office) seen.push(s.office);
    });
    const log = officeLog();
    for (const row of log.slice(0, 4)) {
      source.rows.push(row);
      source.push(row);
      await settle();
    }
    expect(seen).toHaveLength(4);
    source.push(log[0]);
    await settle();
    expect(seen).toHaveLength(4);
  });

  it("replay is deterministic: the same log by catch-up, one by one live, and in shuffled order gives one state", async () => {
    const log = officeLog();

    const viaCatchUp = await open(withRows(log));

    const liveSource = new FakeSource();
    const viaLive = await open(liveSource);
    for (const row of log) {
      liveSource.rows.push(row);
      liveSource.push(row);
    }
    await settle();

    const shuffledSource = new FakeSource();
    const viaShuffle = await open(shuffledSource);
    shuffledSource.rows = [...log];
    for (const row of shuffled(log, 42)) shuffledSource.push(row);
    await settle();

    const a = viaCatchUp.getState().office;
    expect(viaLive.getState().office).toEqual(a);
    expect(viaShuffle.getState().office).toEqual(a);
    expect(JSON.stringify(viaLive.getState().office)).toBe(JSON.stringify(a));
  });

  it("rows of another workspace, invalid rows and malformed input never change the runs", async () => {
    const source = new FakeSource();
    const store = await open(source);
    const log = officeLog().slice(0, 3);
    for (const row of log) source.push(row);
    await settle();
    const runsBefore = structuredClone(store.getState().office?.runs);

    source.push(
      ev(7, 1, "run.created", { agent_id: AGENT_B, task_id: null }, 50, {
        workspace_id: WS_B,
        agent_id: AGENT_B,
      }),
    );
    source.push({ not: "a row" });
    source.push(null);
    source.push({ ...log[0], id: "not-a-uuid" });
    await settle();
    expect(store.getState().office?.runs).toEqual(runsBefore);
    expect(Object.keys(store.getState().office?.runs ?? {})).toEqual([runId(1)]);
  });

  it("after disconnect the stream is closed and late rows do nothing; connecting again starts from the stored events", async () => {
    const log = officeLog();
    const source = withRows(log.slice(0, 5));
    const store = await open(source);
    const handlersBefore = source.handlers;
    store.getState().disconnect();
    expect(source.closeCount).toBe(1);
    expect(store.getState().status).toBe("stopped");
    const frozen = store.getState().office;
    handlersBefore?.onRow(log[5]); // a late row through the old handler
    await settle();
    expect(store.getState().office).toBe(frozen);

    source.rows = [...log];
    store.getState().connect({ source, workspaceId: WS });
    source.handlers?.onStatus("subscribed");
    await settle();
    const reference = await open(withRows(log));
    expect(store.getState().office).toEqual(reference.getState().office);
  });
});
