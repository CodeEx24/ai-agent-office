// AGO-142: the office store is driven only by events, and a reload rebuilds the same state.
import { describe, expect, it, vi } from "vitest";
import { applyOfficeEvents, createOfficeState } from "@ago/shared";

import type {
  FetchEventsArgs,
  FetchRunEventsArgs,
  OfficeEventSource,
  SubscribeHandlers,
} from "../realtime/office-event-source";
import {
  createOfficeStore,
  selectOfficeAgentState,
  selectOfficeAgentStates,
  type OfficeStore,
} from "./office-store";

vi.setConfig({ testTimeout: 15_000 });

const T0 = Date.parse("2026-11-18T08:00:00.000Z");
const uuid = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = uuid(0xb1, 1);
const OTHER_WS = uuid(0xb1, 2);
const AGENT = uuid(0xb2, 1);
const AGENT_2 = uuid(0xb2, 2);
const runId = (n: number): string => uuid(0xb3, n);

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

function row(run: number, seq: number, atSec: number, extra: Partial<Row> = {}): Row {
  const agent = extra.agent_id ?? AGENT;
  return {
    id: uuid(0xb4, run * 100_000 + seq),
    workspace_id: WS,
    run_id: runId(run),
    agent_id: agent,
    seq,
    type: seq === 1 ? "run.created" : "run.started",
    payload: seq === 1 ? { version: 1, agent_id: agent, task_id: null } : { version: 1 },
    created_at: new Date(T0 + atSec * 1000).toISOString(),
    ...extra,
  };
}

const feedCmp = (a: Row, b: Row): number =>
  Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** In-memory event log and stream (no database). */
class FakeSource implements OfficeEventSource {
  rows: Row[] = [];
  handlers: SubscribeHandlers | null = null;
  subscribeCount = 0;
  closeCount = 0;

  fetchEvents(a: FetchEventsArgs): Promise<readonly unknown[]> {
    const since = a.since === null ? -Infinity : Date.parse(a.since);
    return Promise.resolve(
      this.rows
        .filter((r) => r.workspace_id === a.workspaceId)
        .filter((r) => Date.parse(r.created_at) >= since)
        .filter((r) => a.after === null || feedCmp(r, { ...r, ...a.after }) > 0)
        .sort(feedCmp)
        .slice(0, a.limit),
    );
  }

  fetchRunEvents(a: FetchRunEventsArgs): Promise<readonly unknown[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.workspace_id === a.workspaceId)
        .filter((r) => r.run_id === a.runId && r.seq > a.afterSeq)
        .sort((x, y) => x.seq - y.seq)
        .slice(0, a.limit),
    );
  }

  subscribe(_workspaceId: string, h: SubscribeHandlers): () => void {
    this.subscribeCount += 1;
    this.handlers = h;
    return () => {
      this.closeCount += 1;
      if (this.handlers === h) this.handlers = null;
    };
  }

  /** Store a row and, unless the connection is "down", push it to the stream. */
  insert(r: Row, push = true): void {
    this.rows.push(r);
    if (push) this.handlers?.onRow(r);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
};

const noTimer = { setTimer: () => 0, clearTimer: () => undefined };

async function open(source: FakeSource, workspaceId = WS): Promise<OfficeStore> {
  const store = createOfficeStore();
  store.getState().connect({ source, workspaceId, ...noTimer });
  source.handlers?.onStatus("subscribed");
  await settle();
  return store;
}

/** Reference: the shared reducer folding the stored log in feed order, nothing else. */
function reference(rows: readonly Row[], workspaceId = WS) {
  return applyOfficeEvents(createOfficeState(workspaceId), [...rows].sort(feedCmp));
}

describe("office store: driven only by events", () => {
  it("exposes no way to write state, only connect and disconnect", () => {
    const store = createOfficeStore();
    expect("setState" in store).toBe(false);
    expect("destroy" in store).toBe(false);
    const actions = Object.entries(store.getState())
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .sort();
    expect(actions).toEqual(["connect", "disconnect"]);
    expect(Object.keys(store.getState()).sort()).toEqual([
      "connect",
      "disconnect",
      "office",
      "status",
      "workspaceId",
    ]);
  });

  it("starts empty and unscoped", () => {
    const state = createOfficeStore().getState();
    expect(state.office).toBeNull();
    expect(state.workspaceId).toBeNull();
    expect(state.status).toBe("idle");
    expect(selectOfficeAgentStates(state)).toEqual({});
  });

  it("changes only when an event arrives, and the result equals the shared reducer's fold", async () => {
    const source = new FakeSource();
    const store = await open(source);
    const seen: unknown[] = [];
    store.subscribe((s) => seen.push(s.office));
    expect(store.getState().office).toEqual(createOfficeState(WS));
    expect(store.getState().status).toBe("live");

    const events = [row(1, 1, 1), row(1, 2, 2), row(2, 1, 3, { agent_id: AGENT_2 })];
    for (const e of events) source.insert(e);
    await settle();

    expect(store.getState().office).toEqual(reference(events));
    expect(seen.length).toBeGreaterThan(0);
    // Nothing else moved the state: a quiet period changes nothing.
    const before = store.getState().office;
    await settle();
    expect(store.getState().office).toBe(before);
  });

  it("derives agent states from the office, memoized per state object", async () => {
    const source = new FakeSource();
    const store = await open(source);
    source.insert(row(1, 1, 1));
    source.insert(row(1, 2, 2));
    await settle();
    const first = selectOfficeAgentStates(store.getState());
    expect(selectOfficeAgentStates(store.getState())).toBe(first);
    expect(selectOfficeAgentState(store.getState(), AGENT)?.run_id).toBe(runId(1));
    expect(selectOfficeAgentState(store.getState(), AGENT_2)).toBeNull();
  });
});

describe("office store: after reload the state matches", () => {
  it("a fresh store rebuilt from the stored log equals the state before reload", async () => {
    const source = new FakeSource();
    const before = await open(source);
    const log = [
      row(1, 1, 1),
      row(1, 2, 2),
      row(1, 3, 3),
      row(2, 1, 4, { agent_id: AGENT_2 }),
      row(2, 2, 5, { agent_id: AGENT_2 }),
    ];
    for (const e of log) source.insert(e);
    await settle();

    const after = await open(source); // the reload: a new store, same log
    expect(after.getState().office).toEqual(before.getState().office);
    expect(after.getState().office).toEqual(reference(log));
  });

  it("includes events that arrived while the page was gone", async () => {
    const source = new FakeSource();
    const before = await open(source);
    source.insert(row(1, 1, 1));
    source.insert(row(1, 2, 2));
    await settle();
    before.getState().disconnect(); // tab closed

    const missed = [row(1, 3, 3), row(2, 1, 4, { agent_id: AGENT_2 })];
    for (const e of missed) source.insert(e, false);

    const after = await open(source);
    expect(after.getState().office).toEqual(reference(source.rows));
  });

  it("is not changed by duplicates, out-of-order delivery or an overlap window", async () => {
    const source = new FakeSource();
    const log = [row(1, 1, 1), row(1, 2, 2), row(1, 3, 3), row(1, 4, 4)];
    for (const e of log) source.insert(e, false);
    const store = await open(source);
    const settled = store.getState().office;
    expect(settled).toEqual(reference(log));

    source.handlers?.onRow(log[3]); // duplicate of the last row
    source.handlers?.onRow(log[0]); // duplicate of the first row
    await settle();
    expect(store.getState().office).toEqual(settled);

    // A row arrives ahead of an older one (seq 6 before seq 5): the gap is filled by seq.
    const five = row(1, 5, 5);
    const six = row(1, 6, 6);
    source.rows.push(five, six);
    source.handlers?.onRow(six);
    await settle();
    source.handlers?.onRow(five);
    await settle();
    expect(store.getState().office).toEqual(reference([...log, five, six]));
    expect(store.getState().office?.gaps).toEqual({});

    // A second reload of the same log gives the same state (the overlap re-reads applied rows).
    const again = await open(source);
    expect(again.getState().office).toEqual(store.getState().office);
  });
});

describe("office store: one workspace at a time", () => {
  it("switching workspace resets the office and never mixes events", async () => {
    const source = new FakeSource();
    const store = await open(source);
    source.insert(row(1, 1, 1));
    await settle();
    expect(Object.keys(store.getState().office?.runs ?? {})).toHaveLength(1);

    store.getState().connect({ source, workspaceId: OTHER_WS, ...noTimer });
    expect(source.closeCount).toBe(1);
    expect(store.getState().workspaceId).toBe(OTHER_WS);
    expect(store.getState().office).toEqual(createOfficeState(OTHER_WS));

    source.handlers?.onStatus("subscribed");
    source.insert(row(9, 1, 2, { workspace_id: OTHER_WS }));
    source.handlers?.onRow(row(1, 2, 3)); // a row of the first workspace, wrongly pushed
    await settle();
    const office = store.getState().office;
    expect(Object.keys(office?.runs ?? {})).toEqual([runId(9)]);
    expect(office?.anomalies.foreign).toBe(1);
  });

  it("connecting to the same workspace again keeps the stream; disconnect stops it", async () => {
    const source = new FakeSource();
    const store = await open(source);
    store.getState().connect({ source, workspaceId: WS, ...noTimer });
    expect(source.subscribeCount).toBe(1);

    store.getState().disconnect();
    expect(source.closeCount).toBe(1);
    expect(store.getState().status).toBe("stopped");
    const frozen = store.getState().office;
    source.handlers?.onRow(row(1, 1, 1));
    await settle();
    expect(store.getState().office).toBe(frozen);
  });
});
