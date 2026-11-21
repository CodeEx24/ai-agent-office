import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardData } from "./board-types";
import { BOARD_POLL_MS, useBoardData } from "./use-board-data";

const WS = "00000001-0000-4000-8000-000000000001";
const empty = (n = 0): BoardData => ({
  workspaceId: WS,
  tasks: Array.from({ length: n }, (_, i) => ({
    id: `00000002-0000-4000-8000-${String(i).padStart(12, "0")}`,
    title: `T${String(i)}`,
    status: "todo",
    agentId: null,
    createdAt: "2026-11-20T09:00:00.000Z",
    updatedAt: "2026-11-20T09:00:00.000Z",
  })),
  runs: [],
  approvals: [],
  agents: [],
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("useBoardData polling (non-event data only)", () => {
  it("re-reads every interval and shows the new data", async () => {
    const load = vi.fn().mockResolvedValueOnce(empty(1)).mockResolvedValue(empty(2));
    const { result } = renderHook(() =>
      useBoardData({ initial: empty(0), load, officeRunKey: "" }),
    );
    expect(load).not.toHaveBeenCalled(); // the server's data is fresh at the start
    await advance(BOARD_POLL_MS);
    expect(result.current.data?.tasks).toHaveLength(1);
    await advance(BOARD_POLL_MS);
    expect(result.current.data?.tasks).toHaveLength(2);
  });

  it("reads at once when the server gave nothing", async () => {
    const load = vi.fn().mockResolvedValue(empty(1));
    const { result } = renderHook(() => useBoardData({ initial: null, load, officeRunKey: "" }));
    await advance(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.data?.tasks).toHaveLength(1);
  });

  it("pauses while the tab is hidden and reads again when it is visible", async () => {
    const load = vi.fn().mockResolvedValue(empty(1));
    renderHook(() => useBoardData({ initial: empty(0), load, officeRunKey: "" }));
    act(() => {
      setHidden(true);
    });
    await advance(BOARD_POLL_MS * 4);
    expect(load).not.toHaveBeenCalled();
    act(() => {
      setHidden(false);
    });
    await advance(0);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good data on a failed read, says so, backs off and recovers", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(empty(1))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(empty(3));
    const { result } = renderHook(() =>
      useBoardData({ initial: empty(0), load, officeRunKey: "" }),
    );
    await advance(BOARD_POLL_MS); // good read
    await advance(BOARD_POLL_MS); // failed read
    expect(result.current.hasError).toBe(true);
    expect(result.current.data?.tasks).toHaveLength(1);
    await advance(BOARD_POLL_MS); // backed off: the next read is later than one interval
    expect(load).toHaveBeenCalledTimes(2);
    await advance(BOARD_POLL_MS * 2);
    expect(result.current.hasError).toBe(false);
    expect(result.current.data?.tasks).toHaveLength(3);
  });

  it("never runs two reads at once", async () => {
    let release: (d: BoardData) => void = () => undefined;
    const load = vi.fn(() => new Promise<BoardData>((resolve) => (release = resolve)));
    renderHook(() => useBoardData({ initial: null, load, officeRunKey: "" }));
    await advance(BOARD_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);
    release(empty(0));
  });

  it("reads once more for a run the stream shows and no run row maps, once per id", async () => {
    const load = vi.fn().mockResolvedValue(empty(0));
    const { rerender } = renderHook(
      ({ key }: { key: string }) => useBoardData({ initial: empty(0), load, officeRunKey: key }),
      { initialProps: { key: "" } },
    );
    expect(load).not.toHaveBeenCalled();
    rerender({ key: "run-1" });
    await advance(0);
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ key: "run-1" }); // the same id again: no loop, even though the rows still do not map it
    await advance(0);
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ key: "run-1,run-2" });
    await advance(0);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
