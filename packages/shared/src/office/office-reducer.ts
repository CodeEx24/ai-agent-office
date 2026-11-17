import {
  RUN_EVENT_TYPES,
  RUN_EVENT_VERSION,
  parseStoredRunEvent,
  type RunEvent,
} from "../events/run-events.js";
import { effectOfEvent } from "./office-effects.js";
import {
  compareFeedOrder,
  officeEventRecordSchema,
  type OfficeEventRecord,
} from "./office-event-record.js";
import { createOfficeState, type OfficeState, type RunView } from "./office-state.js";

/**
 * The office reducer (AGO-124). Pure and deterministic: no clock, no randomness, no I/O, and it never
 * throws, whatever a row contains. It returns a new state (the input is never mutated).
 *
 * Per row, in this order:
 * 1. envelope invalid           -> `anomalies.invalid`, nothing else changes
 * 2. another workspace          -> `anomalies.foreign`, ignored (tenant safety)
 * 3. run known, other agent_id  -> `anomalies.invalid`, ignored
 * 4. `seq <= run.last_seq`      -> duplicate, ignored (idempotent)
 * 5. `seq` is not the next one  -> NOT applied; the run is listed in `gaps` so the caller catches up
 * 6. unknown type or version    -> `anomalies.unsupported`; the row's `seq` still advances the run
 *    invalid payload            -> `anomalies.invalid`;       the row's `seq` still advances the run
 * 7. otherwise                  -> the event's effect (see `OFFICE_EVENT_EFFECTS`) is applied
 *
 * A run seen for the first time must start at `seq 1`, unless `allowWindowStart` (rebuilding from a
 * window of the last N events), where it starts wherever the window does and is marked `partial`.
 */
export interface ApplyOptions {
  readonly allowWindowStart?: boolean;
}

type Classified =
  | { readonly kind: "event"; readonly event: RunEvent }
  | { readonly kind: "unsupported" }
  | { readonly kind: "invalid" };

const KNOWN_TYPES: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);

function classify(record: OfficeEventRecord): Classified {
  if (!KNOWN_TYPES.has(record.type)) return { kind: "unsupported" };
  const version = record.payload.version;
  if (typeof version === "number" && Number.isInteger(version) && version > RUN_EVENT_VERSION) {
    return { kind: "unsupported" };
  }
  const event = parseStoredRunEvent({ type: record.type, payload: record.payload });
  return event ? { kind: "event", event } : { kind: "invalid" };
}

function bump(state: OfficeState, key: keyof OfficeState["anomalies"]): OfficeState {
  return { ...state, anomalies: { ...state.anomalies, [key]: state.anomalies[key] + 1 } };
}

function newRunView(record: OfficeEventRecord): RunView {
  return {
    run_id: record.run_id,
    agent_id: record.agent_id,
    last_seq: record.seq,
    last_event_at: record.created_at,
    partial: record.seq !== 1,
    phase: null,
    tool: null,
    approval: null,
    handoff: null,
    step: null,
    error: null,
    message: null,
  };
}

function applyRecord(
  state: OfficeState,
  record: OfficeEventRecord,
  options: ApplyOptions,
): OfficeState {
  if (record.workspace_id !== state.workspace_id) return bump(state, "foreign");

  const run = state.runs[record.run_id];
  if (run && run.agent_id !== record.agent_id) return bump(state, "invalid");
  if (run && record.seq <= run.last_seq) return state;

  const expected = run ? run.last_seq + 1 : options.allowWindowStart ? record.seq : 1;
  if (record.seq !== expected) {
    const previous = state.gaps[record.run_id];
    return {
      ...state,
      gaps: {
        ...state.gaps,
        [record.run_id]: {
          after_seq: run ? run.last_seq : 0,
          seen_seq: Math.max(previous?.seen_seq ?? 0, record.seq),
        },
      },
    };
  }

  const classified = classify(record);
  let next: RunView = {
    ...(run ?? newRunView(record)),
    last_seq: record.seq,
    last_event_at: record.created_at,
  };
  if (classified.kind === "event") next = { ...next, ...effectOfEvent(classified.event) };

  const cursor = { created_at: record.created_at, id: record.id };
  const gap = state.gaps[record.run_id];
  const healed = gap !== undefined && next.last_seq >= gap.seen_seq;
  const gaps = healed
    ? Object.fromEntries(Object.entries(state.gaps).filter(([id]) => id !== record.run_id))
    : state.gaps;

  const applied: OfficeState = {
    ...state,
    cursor: state.cursor && compareFeedOrder(state.cursor, cursor) >= 0 ? state.cursor : cursor,
    runs: { ...state.runs, [record.run_id]: next },
    gaps,
  };
  return classified.kind === "event" ? applied : bump(applied, classified.kind);
}

/** Apply one stored row (any shape: an invalid envelope is counted, never thrown). */
export function applyOfficeEvent(
  state: OfficeState,
  row: unknown,
  options: ApplyOptions = {},
): OfficeState {
  const parsed = officeEventRecordSchema.safeParse(row);
  return parsed.success ? applyRecord(state, parsed.data, options) : bump(state, "invalid");
}

/** Apply rows one after another (they must be in `seq` order within each run). */
export function applyOfficeEvents(
  state: OfficeState,
  rows: readonly unknown[],
  options: ApplyOptions = {},
): OfficeState {
  return rows.reduce<OfficeState>((current, row) => applyOfficeEvent(current, row, options), state);
}

function compareRunOrder(a: OfficeEventRecord, b: OfficeEventRecord): number {
  if (a.run_id !== b.run_id) return a.run_id < b.run_id ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Rebuild the office of one workspace from a window of rows, typically `selectTail(rows, N)` (the last
 * N rows in feed order) or the full history. Rows are folded per run in `seq` order, so the result does
 * not depend on the order the rows arrive in. Runs first seen mid-stream are marked `partial`.
 *
 * To continue from a stored snapshot instead, validate it with `parseOfficeState` and call
 * `applyOfficeEvents` with the rows after `state.cursor`.
 */
export function rebuildOfficeState(workspaceId: string, rows: readonly unknown[]): OfficeState {
  let state = createOfficeState(workspaceId);
  const records: OfficeEventRecord[] = [];
  for (const row of rows) {
    const parsed = officeEventRecordSchema.safeParse(row);
    if (parsed.success) records.push(parsed.data);
    else state = bump(state, "invalid");
  }
  records.sort(compareRunOrder);
  return records.reduce(
    (current, record) => applyRecord(current, record, { allowWindowStart: true }),
    state,
  );
}
