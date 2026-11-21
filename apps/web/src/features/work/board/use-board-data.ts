"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BoardData } from "./board-types";

/** How often the non-event data (new tasks, approvals) is re-read. Run state does NOT wait for this: it is streamed. */
export const BOARD_POLL_MS = 5_000;
/** The wait grows with consecutive failures, up to this. */
export const BOARD_POLL_MAX_BACKOFF_MS = 15_000;

export interface BoardDataState {
  readonly data: BoardData | null;
  /** The last read failed; `data` is still the last good board. */
  readonly hasError: boolean;
}

/**
 * Keeps the board's tasks, run-to-task map and pending approvals fresh (AGO-146).
 *
 * - Polls `load` every `BOARD_POLL_MS`, never two reads at once, and backs off after failures. A failed read keeps
 *   the last good data (`hasError` tells the screen to say so).
 * - Pauses while the tab is hidden and reads again at once when it is visible.
 * - `officeRunKey` lists the run ids the stream shows. An id the last read has no run row for (a run created after
 *   that read) triggers one extra read, once per id, so a run that belongs to no task never loops.
 *
 * It is a convenience for data the event stream does not carry. Run state itself comes from the office store.
 */
export function useBoardData({
  initial,
  load,
  officeRunKey,
}: {
  initial: BoardData | null;
  load: () => Promise<BoardData>;
  /** The run ids the office store knows, sorted and joined with commas ("" for none). */
  officeRunKey: string;
}): BoardDataState & { readonly refresh: () => void } {
  const [state, setState] = useState<BoardDataState>({ data: initial, hasError: false });
  const loadRef = useRef(load);
  const inFlightRef = useRef(false);
  const again = useRef(false);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requested = useRef(new Set<string>());
  const isUnmounted = useRef(false);
  // Read through functions: a read that was asked for during an await sets these, which narrowing cannot see.
  const wantsRerun = () => again.current;
  const isStopped = () => isUnmounted.current;

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const read = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      again.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        again.current = false;
        try {
          const data = await loadRef.current();
          failures.current = 0;
          if (!isUnmounted.current) setState({ data, hasError: false });
        } catch {
          failures.current += 1;
          if (!isUnmounted.current) setState((s) => ({ data: s.data, hasError: true }));
        }
      } while (wantsRerun() && !isUnmounted.current);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    isUnmounted.current = false;
    const isHidden = () => typeof document !== "undefined" && document.hidden;

    const schedule = (delay: number) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void tick(), delay);
    };
    const tick = async (): Promise<void> => {
      timer.current = null;
      // Hidden: stop polling; the visibility handler starts it again.
      if (isUnmounted.current || isHidden()) return;
      await read();
      if (isStopped() || isHidden()) return;
      const wait = Math.min(
        BOARD_POLL_MAX_BACKOFF_MS,
        BOARD_POLL_MS * 2 ** Math.min(failures.current, 4),
      );
      schedule(failures.current === 0 ? BOARD_POLL_MS : wait);
    };
    const onVisibility = () => {
      if (!isHidden()) {
        if (timer.current !== null) clearTimeout(timer.current);
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    // With server data the first read can wait one interval; without it, read now.
    if (initial === null) void tick();
    else schedule(BOARD_POLL_MS);
    return () => {
      isUnmounted.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    // `initial` is only the starting point; a new value must not restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);

  const { data } = state;
  useEffect(() => {
    if (data === null || officeRunKey === "") return;
    const mapped = new Set(data.runs.map((r) => r.id));
    const fresh = officeRunKey
      .split(",")
      .filter((id) => !mapped.has(id) && !requested.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) requested.current.add(id);
    void read();
  }, [officeRunKey, data, read]);

  const refresh = useCallback(() => void read(), [read]);
  return { ...state, refresh };
}
