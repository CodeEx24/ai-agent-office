import {
  applyOfficeEvent,
  applyOfficeEvents,
  createOfficeState,
  type OfficeCursor,
  type OfficeState,
} from "@ago/shared";

import type {
  OfficeEventSource,
  OfficeRealtimeStatus,
  SubscriptionStatus,
} from "./office-event-source";
import { DEFAULT_OVERLAP_MS, loadOfficeEvents, loadRunEventsAfter } from "./load-office-events";

const MAX_GAP_ROUNDS = 3;
const MAX_CATCH_UP_LOADS = 20;

export interface OfficeRealtimeOptions {
  readonly source: OfficeEventSource;
  readonly workspaceId: string;
  /** A validated snapshot (AGO-124 `parseOfficeState`), or nothing for an empty office. */
  readonly initialState?: OfficeState;
  /** Called with every new state. The state is immutable: keep it, do not mutate it. */
  readonly onState: (state: OfficeState) => void;
  readonly onStatus?: (status: OfficeRealtimeStatus) => void;
  /** Called when a connection or catch-up failed (the controller retries on its own). Never carries row data. */
  readonly onError?: (error: unknown) => void;
  readonly overlapMs?: number;
  readonly pageSize?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  /** Test seams. Defaults: `setTimeout`, `clearTimeout`, `Math.random`. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly random?: () => number;
}

export interface OfficeRealtime {
  /** Connect, catch up, then stream. Calling it again after `stop` starts a fresh connection. */
  start(): void;
  /** Close the stream. No more state or status callbacks after it returns. */
  stop(): void;
  /** Force a reconnect now (for example when the browser reports it is back online). */
  reconnectNow(): void;
  getState(): OfficeState;
  getStatus(): OfficeRealtimeStatus;
}

/**
 * Realtime delivery with cursor catch-up (AGO-126).
 *
 * - Stream first, then catch up from `state.cursor` minus the overlap, so nothing falls between the two.
 *   Everything runs on one serial queue: live rows that arrive during a catch-up wait and are applied after it.
 * - The reducer (AGO-124) makes every apply idempotent by per-run `seq`, so overlap and duplicates are free,
 *   and a row ahead of its run is held back and reported in `state.gaps`; the controller then fetches that run's
 *   missing rows by `seq` and applies them in order.
 * - Another workspace's rows are never applied (the reducer counts them as `foreign`); RLS keeps them from
 *   arriving at all.
 * - A closed or failed stream reconnects with exponential backoff and catches up again.
 */
export function createOfficeRealtime(options: OfficeRealtimeOptions): OfficeRealtime {
  const { source, workspaceId, onState } = options;
  const overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
  const base = options.backoff?.baseMs ?? 1000;
  const max = options.backoff?.maxMs ?? 30_000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const random = options.random ?? Math.random;

  const seed = options.initialState;
  let state: OfficeState =
    seed?.workspace_id === workspaceId ? seed : createOfficeState(workspaceId);
  let status: OfficeRealtimeStatus = "idle";
  let generation = 0; // bumped on every connect and stop; stale work checks it and quits
  let running = false;
  let unsubscribe: (() => void) | null = null;
  let retryTimer: unknown = null;
  let attempt = 0;
  /** An unfinished catch-up: the overlap start and the last keyset position read. Survives reconnects. */
  let resume: { readonly start: OfficeCursor | null; readonly after: OfficeCursor } | null = null;
  let queue: Promise<void> = Promise.resolve();

  function setStatus(next: OfficeRealtimeStatus): void {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  }

  function setState(next: OfficeState): void {
    if (next === state) return;
    state = next;
    onState(state);
  }

  function enqueue(gen: number, task: () => Promise<void>): void {
    queue = queue.then(async () => {
      if (gen !== generation) return;
      try {
        await task();
      } catch (error) {
        if (gen !== generation) return;
        options.onError?.(error);
        scheduleReconnect();
      }
    });
  }

  async function fillGaps(gen: number): Promise<void> {
    for (let round = 0; round < MAX_GAP_ROUNDS; round += 1) {
      const gaps = Object.entries(state.gaps);
      if (gaps.length === 0) return;
      const before = state;
      for (const [runId, gap] of gaps) {
        const rows = await loadRunEventsAfter(
          source,
          workspaceId,
          runId,
          gap.after_seq,
          options.pageSize,
        );
        if (gen !== generation) return;
        setState(applyOfficeEvents(state, rows));
      }
      if (state === before) return; // no progress: the rows are not there (yet)
    }
  }

  async function catchUp(gen: number): Promise<void> {
    // The overlap start comes from the cursor once. A truncated load continues from its last keyset position,
    // never from the (moved) cursor, until a short page proves the backlog is drained. The position lives on the
    // controller, so a reconnect (after the load cap or a failed fetch) continues where it stopped.
    const pending = resume;
    const start = pending ? pending.start : state.cursor;
    let resumeAfter: OfficeCursor | null = pending ? pending.after : null;
    for (let load = 0; load < MAX_CATCH_UP_LOADS; load += 1) {
      const loaded = await loadOfficeEvents({
        source,
        workspaceId,
        cursor: start,
        resumeAfter,
        overlapMs,
        pageSize: options.pageSize,
      });
      if (gen !== generation) return;
      setState(applyOfficeEvents(state, loaded.rows));
      if (loaded.truncated && loaded.next) resume = { start, after: loaded.next };
      else resume = null; // a short page proved the backlog is drained
      await fillGaps(gen);
      if (gen !== generation) return;
      if (!loaded.truncated) return;
      resumeAfter = loaded.next;
    }
    // Never go live with a backlog left: fail so the reconnect path continues from `resume`.
    throw new Error("catch-up backlog not drained");
  }

  function onRow(gen: number, row: unknown): void {
    enqueue(gen, async () => {
      setState(applyOfficeEvent(state, row));
      if (Object.keys(state.gaps).length > 0) await fillGaps(gen);
    });
  }

  function onSubscriptionStatus(gen: number, subscription: SubscriptionStatus): void {
    if (gen !== generation) return;
    if (subscription === "subscribed") {
      setStatus("catching_up");
      enqueue(gen, async () => {
        await catchUp(gen);
        if (gen !== generation) return;
        attempt = 0;
        setStatus("live");
      });
      return;
    }
    scheduleReconnect();
  }

  function teardown(): void {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    const close = unsubscribe;
    unsubscribe = null;
    close?.();
  }

  function connect(): void {
    teardown();
    generation += 1;
    const gen = generation;
    running = true;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    try {
      unsubscribe = source.subscribe(workspaceId, {
        onRow: (row) => {
          onRow(gen, row);
        },
        onStatus: (s) => {
          onSubscriptionStatus(gen, s);
        },
      });
    } catch (error) {
      options.onError?.(error);
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (!running || retryTimer !== null) return;
    teardown();
    generation += 1; // drop queued work of the dead connection
    setStatus("reconnecting");
    const delay = Math.min(max, base * 2 ** attempt) * (0.5 + random() / 2);
    attempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (running) connect();
    }, delay);
  }

  return {
    start() {
      if (running) return;
      attempt = 0;
      connect();
    },
    stop() {
      running = false;
      generation += 1;
      teardown();
      setStatus("stopped");
    },
    reconnectNow() {
      if (!running) return;
      attempt = 0;
      connect();
    },
    getState: () => state,
    getStatus: () => status,
  };
}
