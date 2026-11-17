import { describe, expect, it } from "vitest";

import { RUN_EVENT_TYPES } from "../events/run-events.js";
import { selectTail } from "./office-event-record.js";
import { applyOfficeEvent, applyOfficeEvents, rebuildOfficeState } from "./office-reducer.js";
import { selectAgentStates } from "./office-selectors.js";
import { createOfficeState, type OfficeState } from "./office-state.js";

/**
 * Acceptance tests for AGO-124, written independently of office-reducer.test.ts: own fixtures, and every
 * expected value is spelled out by hand from the ticket record, never computed by the code under test.
 */

// ---------------------------------------------------------------- fixtures

const HASH = "b".repeat(64);
const WHEN = "2026-12-01T09:00:00.000Z";
const T0 = Date.parse("2026-12-01T08:00:00.000Z");

const uid = (kind: number, n: number): string =>
  `${kind.toString(16).padStart(8, "0")}-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
const WS = uid(0xa, 1);
const OTHER_WS = uid(0xa, 2);
const agent = (n: number): string => uid(0xb, n);
const run = (n: number): string => uid(0xc, n);

type Payload = Record<string, unknown>;

interface RowSpec {
  readonly run: number;
  readonly seq: number;
  readonly type: string;
  readonly payload?: Payload;
  readonly at?: number; // seconds after T0; defaults to seq
  readonly ws?: string;
  readonly version?: number;
  readonly agent?: number; // defaults to the run number
  readonly id?: string;
}

function mk(spec: RowSpec) {
  return {
    id: spec.id ?? uid(0xd, spec.run * 1000 + spec.seq),
    workspace_id: spec.ws ?? WS,
    run_id: run(spec.run),
    agent_id: agent(spec.agent ?? spec.run),
    seq: spec.seq,
    type: spec.type,
    payload: { version: spec.version ?? 1, ...(spec.payload ?? {}) },
    created_at: new Date(T0 + (spec.at ?? spec.seq) * 1000).toISOString(),
  };
}
type Row = ReturnType<typeof mk>;

/** Rows of one run, seq 1.., from [type, payload] pairs. */
function history(runNo: number, steps: readonly (readonly [string, Payload?])[]): Row[] {
  return steps.map(([type, payload], i) => mk({ run: runNo, seq: i + 1, type, payload }));
}

const empty = (): OfficeState => createOfficeState(WS);

// ---------------------------------------------------------------- AC1: each event type has a defined effect

const NO_CHANNELS = {
  phase: null,
  tool: null,
  approval: null,
  handoff: null,
  step: null,
  error: null,
  message: null,
};

interface EffectCase {
  readonly payload: Payload;
  /** Channels that differ from "nothing known" after this event alone (hand-written). */
  readonly channels: Partial<Record<keyof typeof NO_CHANNELS, unknown>>;
}

const EFFECT_CASES: Record<string, EffectCase> = {
  "run.created": {
    payload: { agent_id: agent(1), task_id: null },
    channels: { phase: { value: "queued", detail: null } },
  },
  "run.started": { payload: {}, channels: { phase: { value: "active", detail: null } } },
  "run.completed": {
    payload: { steps: 4, summary: "ok" },
    channels: { phase: { value: "completed", detail: null } },
  },
  "run.failed": {
    payload: { reason: "tool_error", message: "kaput" },
    channels: {
      phase: { value: "failed", detail: "tool_error" },
      error: { code: "tool_error", message: "kaput", retryable: false },
    },
  },
  "run.paused": {
    payload: { requested_by: "human", reason: "user_pause" },
    channels: { phase: { value: "paused", detail: "user_pause" } },
  },
  "run.resumed": {
    payload: { resumed_by: "human" },
    channels: { phase: { value: "active", detail: null } },
  },
  "run.recovered": {
    payload: { step: 3, completed_calls: 5 },
    channels: { phase: { value: "active", detail: null }, step: 3 },
  },
  "run.stopped": {
    payload: { stopped_by: "human", reason: "user_stop" },
    channels: { phase: { value: "stopped", detail: "user_stop" } },
  },
  "run.limit_reached": {
    payload: { limit: "steps", max: 20, observed: 20 },
    channels: { error: expect.objectContaining({ code: "limit_steps", retryable: false }) },
  },
  "run.loop_detected": {
    payload: { tool_name: "search", call_hash: HASH, repeat_count: 3 },
    channels: { error: expect.objectContaining({ code: "loop_detected", retryable: false }) },
  },
  "context.cut": {
    payload: {
      section: "tool_result",
      source: "tool:search#c9",
      action: "truncated",
      original_chars: 9000,
      kept_chars: 1000,
    },
    channels: {},
  },
  "step.started": { payload: { step: 7 }, channels: { step: 7 } },
  "step.completed": { payload: { step: 7, outcome: "ok" }, channels: {} },
  "tool_call.requested": {
    payload: { call_id: "k1", tool_name: "web.search", tier: 1, input_hash: HASH },
    channels: { tool: { call_id: "k1", tool_name: "web.search" } },
  },
  "tool_call.started": { payload: { call_id: "k1" }, channels: {} },
  "tool_call.completed": {
    payload: { call_id: "k1", duration_ms: 5, output_hash: HASH },
    channels: {},
  },
  "tool_call.failed": {
    payload: { call_id: "k1", error_code: "timeout", message: "slow" },
    channels: {},
  },
  "policy.decision": {
    payload: { call_id: "k1", decision: "allow", tier: 1, reason_code: "tier1_allowed" },
    channels: {},
  },
  "approval.requested": {
    payload: {
      approval_id: "ap1",
      call_id: "k1",
      payload_hash: HASH,
      tier: 3,
      expires_at: WHEN,
    },
    channels: { approval: { approval_id: "ap1", call_id: "k1", tier: 3, expires_at: WHEN } },
  },
  "approval.decided": {
    payload: { approval_id: "ap1", outcome: "approved", decided_by: "human", payload_hash: HASH },
    channels: {},
  },
  "budget.usage": { payload: { input_tokens: 1, output_tokens: 2 }, channels: {} },
  "budget.exceeded": {
    payload: { scope: "run", reason: "run_token_limit_reached", limit: 100, used: 120 },
    channels: {
      error: expect.objectContaining({
        code: "budget_run_token_limit_reached",
        retryable: false,
      }),
    },
  },
  "handoff.created": {
    payload: { handoff_id: "ho1", to_agent_id: agent(2), reason: "review please" },
    channels: {
      handoff: { handoff_id: "ho1", to_agent_id: agent(2), by_agent_id: null, accepted: false },
    },
  },
  "handoff.accepted": {
    payload: { handoff_id: "ho1", by_agent_id: agent(2) },
    channels: {
      handoff: { handoff_id: "ho1", to_agent_id: null, by_agent_id: agent(2), accepted: true },
    },
  },
  "error.raised": {
    payload: { code: "internal", message: "oops", retryable: true },
    channels: { error: { code: "internal", message: "oops", retryable: true } },
  },
  "message.emitted": {
    payload: { role: "system", summary: "hi" },
    channels: { message: { role: "system", summary: "hi" } },
  },
};

describe("AC1: each event type has a defined effect on office state", () => {
  it("has a hand-written expectation for every published run event type and no extras", () => {
    expect(Object.keys(EFFECT_CASES).sort()).toEqual([...RUN_EVENT_TYPES].sort());
  });

  it.each(Object.entries(EFFECT_CASES))(
    "%s sets exactly the expected channels on a fresh run",
    (type, { payload, channels }) => {
      const state = applyOfficeEvent(empty(), mk({ run: 1, seq: 1, type, payload }));
      expect(state.anomalies).toEqual({ unsupported: 0, invalid: 0, foreign: 0 });
      expect(state.runs[run(1)]).toMatchObject({ ...NO_CHANNELS, ...channels, last_seq: 1 });
    },
  );

  it.each(Object.entries(EFFECT_CASES))(
    "%s advances the run's last_seq and the feed cursor, whether or not it changes a channel",
    (type, { payload }) => {
      const row = mk({ run: 1, seq: 1, type, payload, at: 42 });
      const state = applyOfficeEvent(empty(), row);
      expect(state.cursor).toEqual({ created_at: row.created_at, id: row.id });
      expect(state.runs[run(1)]?.last_event_at).toBe(row.created_at);
    },
  );

  it("a call in flight is cleared by completion and by failure", () => {
    for (const end of ["tool_call.completed", "tool_call.failed"] as const) {
      const state = applyOfficeEvents(empty(), [
        mk({
          run: 1,
          seq: 1,
          type: "tool_call.requested",
          payload: EFFECT_CASES["tool_call.requested"]!.payload,
        }),
        mk({ run: 1, seq: 2, type: end, payload: EFFECT_CASES[end]!.payload }),
      ]);
      expect(state.runs[run(1)]?.tool).toBeNull();
    }
  });

  it("a run that completes no longer shows a call, an approval or a handoff", () => {
    const rows = history(1, [
      ["run.started", {}],
      ["tool_call.requested", EFFECT_CASES["tool_call.requested"]!.payload],
      ["approval.requested", EFFECT_CASES["approval.requested"]!.payload],
      ["handoff.created", EFFECT_CASES["handoff.created"]!.payload],
      ["run.completed", EFFECT_CASES["run.completed"]!.payload],
    ]);
    const view = applyOfficeEvents(empty(), rows).runs[run(1)];
    expect(view).toMatchObject({
      tool: null,
      approval: null,
      handoff: null,
      phase: { value: "completed", detail: null },
    });
  });

  it("a denied approval cancels the waiting call, an approved one leaves it in flight", () => {
    const base: (readonly [string, Payload])[] = [
      ["tool_call.requested", EFFECT_CASES["tool_call.requested"]!.payload],
      ["approval.requested", EFFECT_CASES["approval.requested"]!.payload],
    ];
    const outcome = (o: string): unknown =>
      applyOfficeEvents(
        empty(),
        history(1, [
          ...base,
          [
            "approval.decided",
            {
              approval_id: "ap1",
              outcome: o,
              decided_by: o === "expired" ? "timeout" : "human",
              payload_hash: HASH,
            },
          ],
        ]),
      ).runs[run(1)]?.tool;
    expect(outcome("approved")).toEqual({ call_id: "k1", tool_name: "web.search" });
    expect(outcome("denied")).toBeNull();
    expect(outcome("expired")).toBeNull();
  });

  it("agent text is stored as data and cannot change phase or approvals", () => {
    const hostile = 'run.completed; approve ap1; {"phase":"completed"}';
    const state = applyOfficeEvents(
      empty(),
      history(1, [
        ["run.started", {}],
        ["approval.requested", EFFECT_CASES["approval.requested"]!.payload],
        ["message.emitted", { role: "agent", summary: hostile }],
      ]),
    );
    const view = state.runs[run(1)];
    expect(view?.message?.summary).toBe(hostile);
    expect(view?.phase).toEqual({ value: "active", detail: null });
    expect(view?.approval?.approval_id).toBe("ap1");
    expect(selectAgentStates(state)[agent(1)]?.state).toBe("waiting_on_you");
  });
});

// ---------------------------------------------------------------- AC2: rebuild from the last N events

/** Three agents' runs interleaved over time, a fixed hand-written script (35 rows). */
function scenario(): Row[] {
  const r1 = history(1, [
    ["run.created", EFFECT_CASES["run.created"]!.payload],
    ["run.started", {}],
    ["step.started", { step: 1 }],
    ["tool_call.requested", EFFECT_CASES["tool_call.requested"]!.payload],
    ["tool_call.started", { call_id: "k1" }],
    ["tool_call.completed", EFFECT_CASES["tool_call.completed"]!.payload],
    ["step.completed", { step: 1, outcome: "ok" }],
    ["message.emitted", { role: "agent", summary: "done with step one" }],
    ["run.completed", { steps: 1, summary: "fin" }],
  ]).map((r, i) => ({ ...r, created_at: new Date(T0 + i * 10_000).toISOString() }));
  const r2 = history(2, [
    ["run.created", { agent_id: agent(2), task_id: null }],
    ["run.started", {}],
    ["step.started", { step: 1 }],
    ["tool_call.requested", EFFECT_CASES["tool_call.requested"]!.payload],
    ["approval.requested", EFFECT_CASES["approval.requested"]!.payload],
    ["budget.usage", { input_tokens: 1, output_tokens: 1 }],
    ["budget.usage", { input_tokens: 1, output_tokens: 1 }],
    ["budget.usage", { input_tokens: 1, output_tokens: 1 }],
  ]).map((r, i) => ({ ...r, created_at: new Date(T0 + i * 10_000 + 3_000).toISOString() }));
  const r3 = history(3, [
    ["run.created", { agent_id: agent(3), task_id: null }],
    ["run.started", {}],
    ["step.started", { step: 1 }],
    ["run.paused", EFFECT_CASES["run.paused"]!.payload],
  ]).map((r, i) => ({ ...r, created_at: new Date(T0 + i * 10_000 + 6_000).toISOString() }));
  return [...r1, ...r2, ...r3];
}

describe("AC2: state can be rebuilt from the last N events", () => {
  it("is an empty office, with no cursor, when the history is empty", () => {
    expect(rebuildOfficeState(WS, [])).toEqual(empty());
    expect(selectAgentStates(rebuildOfficeState(WS, []))).toEqual({});
    expect(selectTail([], 5)).toEqual([]);
  });

  it("is an empty office when N is 0, even though history exists", () => {
    const rows = scenario();
    expect(selectTail(rows, 0)).toEqual([]);
    expect(rebuildOfficeState(WS, selectTail(rows, 0))).toEqual(empty());
  });

  it.each([-3, Number.NaN, Number.NEGATIVE_INFINITY])("treats N = %s as an empty window", (n) => {
    expect(selectTail(scenario(), n)).toEqual([]);
  });

  it("equals the full-history state when N is larger than the history", () => {
    const rows = scenario();
    const full = rebuildOfficeState(WS, rows);
    expect(rebuildOfficeState(WS, selectTail(rows, rows.length + 100))).toEqual(full);
    expect(rebuildOfficeState(WS, selectTail(rows, rows.length))).toEqual(full);
    expect(Object.values(full.runs).every((r) => !r.partial)).toBe(true);
  });

  it("is exact for the whole history: three agents end up completed, waiting and paused", () => {
    const states = selectAgentStates(rebuildOfficeState(WS, scenario()));
    expect(states[agent(1)]).toMatchObject({ state: "idle", run_id: run(1) });
    expect(states[agent(2)]).toMatchObject({
      state: "waiting_on_you",
      approval_id: "ap1",
      run_id: run(2),
    });
    expect(states[agent(3)]).toMatchObject({
      state: "error_or_paused",
      detail: "user_pause",
      run_id: run(3),
    });
  });

  it("takes the N most recent rows of the workspace feed, across runs", () => {
    const rows = scenario();
    const tail = selectTail(rows, 5);
    expect(tail).toHaveLength(5);
    const cutoff = Date.parse(tail[0]!.created_at);
    const older = rows.filter((r) => !tail.some((t) => t.id === r.id));
    expect(older.every((r) => Date.parse(r.created_at) <= cutoff)).toBe(true);
  });

  it("marks a run cut mid-window as partial and leaves unseen channels unknown, not guessed", () => {
    const rows = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
      ["step.started", { step: 1 }],
      ["tool_call.requested", EFFECT_CASES["tool_call.requested"]!.payload],
      ["tool_call.completed", EFFECT_CASES["tool_call.completed"]!.payload],
      ["message.emitted", { role: "agent", summary: "tail" }],
    ]);
    const view = rebuildOfficeState(WS, selectTail(rows, 3)).runs[run(1)];
    expect(view).toMatchObject({
      partial: true,
      last_seq: 6,
      phase: null,
      step: null,
      tool: null,
      message: { role: "agent", summary: "tail" },
    });
  });

  it("keeps a channel exact when its last event is inside the window although the run is cut", () => {
    const rows = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
      ["step.started", { step: 1 }],
      ["tool_call.requested", EFFECT_CASES["tool_call.requested"]!.payload],
      ["approval.requested", EFFECT_CASES["approval.requested"]!.payload],
      ["budget.usage", { input_tokens: 1, output_tokens: 1 }],
    ]);
    const view = rebuildOfficeState(WS, selectTail(rows, 3)).runs[run(1)];
    expect(view?.approval).toEqual({
      approval_id: "ap1",
      call_id: "k1",
      tier: 3,
      expires_at: WHEN,
    });
    expect(view?.partial).toBe(true);
  });

  it("an agent whose run is cut before its start still shows as thinking, not as a stale state", () => {
    const rows = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
      ["budget.usage", { input_tokens: 1, output_tokens: 1 }],
    ]);
    const state = rebuildOfficeState(WS, selectTail(rows, 1));
    expect(selectAgentStates(state)[agent(1)]).toMatchObject({ state: "thinking" });
  });

  it("gives the same state however the window's rows arrive", () => {
    const window = selectTail(scenario(), 20);
    const forward = rebuildOfficeState(WS, window);
    expect(rebuildOfficeState(WS, [...window].reverse())).toEqual(forward);
    const rotated = [...window.slice(7), ...window.slice(0, 7)];
    expect(rebuildOfficeState(WS, rotated)).toEqual(forward);
  });

  it("rebuilds rows that arrive with a later seq before an earlier one (out of order) as if in order", () => {
    const rows = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
      ["step.started", { step: 2 }],
      ["run.paused", EFFECT_CASES["run.paused"]!.payload],
    ]);
    const shuffled = [rows[3]!, rows[1]!, rows[0]!, rows[2]!];
    expect(rebuildOfficeState(WS, shuffled)).toEqual(rebuildOfficeState(WS, rows));
    expect(rebuildOfficeState(WS, shuffled).runs[run(1)]).toMatchObject({
      phase: { value: "paused", detail: "user_pause" },
      step: 2,
      last_seq: 4,
    });
  });

  it("applies an out-of-order seq live as a gap, never as a silent skip, then heals when the missing row arrives", () => {
    const rows = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
      ["step.started", { step: 4 }],
    ]);
    const gapped = applyOfficeEvents(empty(), [rows[0]!, rows[2]!]);
    expect(gapped.runs[run(1)]).toMatchObject({ last_seq: 1, step: null });
    expect(gapped.gaps[run(1)]).toEqual({ after_seq: 1, seen_seq: 3 });
    const healed = applyOfficeEvents(gapped, [rows[1]!, rows[2]!]);
    expect(healed.gaps).toEqual({});
    expect(healed.runs[run(1)]).toMatchObject({ last_seq: 3, step: 4 });
  });

  it("flags a hole inside a window instead of applying across it", () => {
    const rows = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
      ["step.started", { step: 1 }],
      ["run.paused", EFFECT_CASES["run.paused"]!.payload],
    ]);
    const holed = [rows[0]!, rows[1]!, rows[3]!];
    const state = rebuildOfficeState(WS, holed);
    expect(state.gaps[run(1)]).toEqual({ after_seq: 2, seen_seq: 4 });
    expect(state.runs[run(1)]).toMatchObject({ last_seq: 2, phase: { value: "active" } });
  });

  it("ignores a repeated seq even when it carries a different id and a different payload", () => {
    const rows = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
    ]);
    const impostor = mk({
      run: 1,
      seq: 2,
      type: "run.failed",
      payload: { reason: "tool_error", message: "dup" },
      id: uid(0xe, 1),
    });
    const state = rebuildOfficeState(WS, [...rows, impostor]);
    expect(state.runs[run(1)]?.phase).toEqual({ value: "active", detail: null });
    expect(state.anomalies).toEqual({ unsupported: 0, invalid: 0, foreign: 0 });
  });

  it("de-duplicates the same row (same id) in a window and counts it once", () => {
    const rows = scenario();
    expect(selectTail([...rows, ...rows.slice(-6)], 6)).toEqual(selectTail(rows, 6));
    const doubled = [...rows, ...rows];
    expect(rebuildOfficeState(WS, doubled)).toEqual(rebuildOfficeState(WS, rows));
  });

  it("orders window rows that share one timestamp by id", () => {
    const same = [3, 1, 2].map((n) =>
      mk({
        run: n,
        seq: 1,
        type: "run.created",
        payload: { agent_id: agent(n), task_id: null },
        at: 5,
      }),
    );
    const byId = [...same].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(selectTail(same, 2).map((r) => r.id)).toEqual(byId.slice(1).map((r) => r.id));
  });

  it("counts an unknown event type in the window as unsupported and still applies the rows after it", () => {
    const rows = [
      mk({ run: 1, seq: 1, type: "run.created", payload: EFFECT_CASES["run.created"]!.payload }),
      mk({ run: 1, seq: 2, type: "office.teleported", payload: { to: "moon" } }),
      mk({ run: 1, seq: 3, type: "run.started", payload: {} }),
    ];
    const state = rebuildOfficeState(WS, rows);
    expect(state.anomalies).toEqual({ unsupported: 1, invalid: 0, foreign: 0 });
    expect(state.runs[run(1)]).toMatchObject({ last_seq: 3, phase: { value: "active" } });
    expect(state.gaps).toEqual({});
  });

  it("counts a newer event version as unsupported, leaves the channel it would have set unchanged, and does not throw", () => {
    const rows = [
      mk({ run: 1, seq: 1, type: "run.created", payload: EFFECT_CASES["run.created"]!.payload }),
      mk({ run: 1, seq: 2, type: "run.started", payload: {}, version: 2 }),
      mk({ run: 1, seq: 3, type: "run.started", payload: {}, version: 99 }),
    ];
    let state = empty();
    expect(() => {
      state = rebuildOfficeState(WS, rows);
    }).not.toThrow();
    expect(state.anomalies.unsupported).toBe(2);
    expect(state.runs[run(1)]).toMatchObject({ last_seq: 3, phase: { value: "queued" } });
  });

  it("never lets a foreign-workspace row into runs, agents or the cursor", () => {
    const own = history(1, [
      ["run.created", EFFECT_CASES["run.created"]!.payload],
      ["run.started", {}],
    ]);
    const foreign = [
      mk({
        run: 2,
        seq: 1,
        type: "run.created",
        payload: { agent_id: agent(2), task_id: null },
        ws: OTHER_WS,
        at: 500,
      }),
      mk({
        run: 1,
        seq: 3,
        type: "run.failed",
        payload: { reason: "tool_error", message: "x" },
        ws: OTHER_WS,
        at: 501,
      }),
    ];
    const state = rebuildOfficeState(WS, [...own, ...foreign]);
    expect(state.anomalies.foreign).toBe(2);
    expect(Object.keys(state.runs)).toEqual([run(1)]);
    expect(state.runs[run(1)]?.phase).toEqual({ value: "active", detail: null });
    expect(state.cursor?.created_at).toBe(own[1]!.created_at);
    expect(selectAgentStates(state)[agent(2)]).toBeUndefined();
  });

  it("rebuilds a window made only of foreign rows as an empty office plus a foreign count", () => {
    const foreign = history(1, [["run.created", EFFECT_CASES["run.created"]!.payload]]).map(
      (r) => ({ ...r, workspace_id: OTHER_WS }),
    );
    const state = rebuildOfficeState(WS, foreign);
    expect({ ...state, anomalies: empty().anomalies }).toEqual(empty());
    expect(state.anomalies.foreign).toBe(1);
  });

  it("snapshot at any cut plus the remaining rows equals rebuilding all of them", () => {
    const rows = scenario();
    const ordered = [...rows].sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
    );
    const full = rebuildOfficeState(WS, ordered);
    for (const cut of [0, 1, 9, 17, 34, ordered.length]) {
      const snapshot = JSON.parse(
        JSON.stringify(applyOfficeEvents(empty(), ordered.slice(0, cut))),
      ) as OfficeState;
      expect(applyOfficeEvents(snapshot, ordered.slice(cut))).toEqual(full);
    }
  });
});
