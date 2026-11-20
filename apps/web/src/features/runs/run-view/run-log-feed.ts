import type { OfficeEventSource } from "../../office/realtime/office-event-source";
import { applyRunRows, type RunLogState } from "./run-log";

/**
 * Live feed for one run's log (AGO-153), over the AGO-126 `OfficeEventSource` port (the user-scoped client, RLS
 * decides what arrives; the source never uses a service role).
 *
 * Start from the rows the server already loaded, subscribe to the workspace stream (this run's rows are kept, others
 * ignored), and after every `SUBSCRIBED` read the run's rows with `seq > contiguousSeq` so rows inserted between the
 * server read and the subscription, or during a drop, are not missed. A row that arrives ahead of a missing one
 * triggers the same read. Because the state dedupes by `seq`, replays and overlaps change nothing: no duplicates and
 * no gaps. A closed or failed channel (or a failed read) reconnects with a capped, doubling delay.
 */

export type RunFeedStatus = "connecting" | "live" | "catching_up" | "reconnecting" | "stopped";

export interface RunLogFeedOptions {
  readonly source: OfficeEventSource;
  readonly initial: RunLogState;
  readonly onState: (state: RunLogState) => void;
  readonly onStatus: (status: RunFeedStatus) => void;
}

export interface RunLogFeed {
  start(): void;
  stop(): void;
}

const PAGE_SIZE = 500;
/** One catch-up reads at most this many pages; more means the next catch-up continues from where this stopped. */
const MAX_PAGES = 40;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export function createRunLogFeed(options: RunLogFeedOptions): RunLogFeed {
  const { source, onState, onStatus } = options;
  let state = options.initial;
  let stopped = true;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = BACKOFF_START_MS;
  let work: Promise<void> = Promise.resolve();
  // Bumped on every (re)connect and on stop, so a late callback of an old channel is ignored.
  let generation = 0;

  const publish = (next: RunLogState): void => {
    if (next === state) return;
    state = next;
    onState(state);
  };

  // A function, not an inline comparison: `stopped` and `generation` change while an await is pending.
  const isCurrent = (gen: number): boolean => !stopped && gen === generation;

  async function catchUp(gen: number): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (!isCurrent(gen)) return;
      const rows = await source.fetchRunEvents({
        workspaceId: state.workspaceId,
        runId: state.runId,
        afterSeq: state.contiguousSeq,
        limit: PAGE_SIZE,
      });
      if (!isCurrent(gen)) return;
      const before = state.contiguousSeq;
      publish(applyRunRows(state, rows));
      // A short page proves the run's backlog is drained; no progress means nothing more to read.
      if (rows.length < PAGE_SIZE || state.contiguousSeq === before) return;
    }
  }

  function enqueueCatchUp(gen: number, announce: boolean): void {
    work = work
      .then(async () => {
        if (!isCurrent(gen)) return;
        if (announce) onStatus("catching_up");
        await catchUp(gen);
        if (!isCurrent(gen)) return;
        backoffMs = BACKOFF_START_MS;
        onStatus("live");
      })
      .catch(() => {
        if (isCurrent(gen)) scheduleReconnect();
      });
  }

  function connect(): void {
    if (stopped) return;
    generation += 1;
    const gen = generation;
    unsubscribe?.();
    onStatus("connecting");
    unsubscribe = source.subscribe(state.workspaceId, {
      onRow: (row) => {
        if (stopped || gen !== generation) return;
        // Rows of other runs of the workspace are not ours; a row of another workspace is rejected by the state.
        if (
          typeof row === "object" &&
          row !== null &&
          (row as { run_id?: unknown }).run_id !== state.runId
        )
          return;
        publish(applyRunRows(state, [row]));
        if (state.highestSeq > state.contiguousSeq) enqueueCatchUp(gen, false);
      },
      onStatus: (status) => {
        if (stopped || gen !== generation) return;
        if (status === "subscribed") enqueueCatchUp(gen, true);
        else scheduleReconnect();
      },
    });
  }

  function scheduleReconnect(): void {
    if (stopped || timer !== null) return;
    generation += 1; // drop callbacks of the failed channel
    unsubscribe?.();
    unsubscribe = null;
    onStatus("reconnecting");
    const jitter = 0.75 + Math.random() * 0.5;
    const delay = Math.min(BACKOFF_CAP_MS, backoffMs) * jitter;
    backoffMs = Math.min(BACKOFF_CAP_MS, backoffMs * 2);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      backoffMs = BACKOFF_START_MS;
      connect();
    },
    stop() {
      stopped = true;
      generation += 1;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      onStatus("stopped");
    },
  };
}
