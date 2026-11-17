import { describe, expect, it } from "vitest";
import { compareFeedOrder } from "@ago/shared";

import type { FetchEventsArgs, OfficeEventSource, SubscribeHandlers } from "./office-event-source";
import { createOfficeRealtime } from "./office-realtime";

const BASE_MS = Date.parse("2026-11-17T08:00:00.000Z");
const id = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = id(1, 1);
const AGENT = id(3, 1);
const RUN = id(4, 1);

function row(seq: number) {
  return {
    id: id(2, seq),
    workspace_id: WS,
    run_id: RUN,
    agent_id: AGENT,
    seq,
    type: seq === 1 ? "run.created" : "run.started",
    payload: seq === 1 ? { version: 1, agent_id: AGENT, task_id: null } : { version: 1 },
    created_at: new Date(BASE_MS + seq).toISOString(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3000; i += 1) await Promise.resolve();
}

describe("AC1: a backlog above the per-connection catch-up cap", () => {
  it("is drained across reconnects, not re-read from the same window forever, when the whole backlog sits inside one overlap window", async () => {
    const rows = Array.from({ length: 25 * 40 + 5 }, (_, i) => row(i + 1)); // above 20 loads x 40 pages x 1 row
    let handlers: SubscribeHandlers | null = null;
    const source: OfficeEventSource = {
      fetchEvents: (a: FetchEventsArgs) => {
        const sinceMs = a.since === null ? -Infinity : Date.parse(a.since);
        return Promise.resolve(
          rows
            .filter((r) => Date.parse(r.created_at) >= sinceMs)
            .filter((r) => a.after === null || compareFeedOrder(r, a.after) > 0)
            .sort(compareFeedOrder)
            .slice(0, a.limit),
        );
      },
      fetchRunEvents: (a) =>
        Promise.resolve(rows.filter((r) => r.seq > a.afterSeq).slice(0, a.limit)),
      subscribe: (_ws, h) => {
        handlers = h;
        return () => undefined;
      },
    };
    const timers: (() => void)[] = [];
    const controller = createOfficeRealtime({
      source,
      workspaceId: WS,
      pageSize: 1,
      onState: () => undefined,
      onStatus: () => undefined,
      onError: () => undefined,
      random: () => 1,
      setTimer: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimer: () => undefined,
    });
    controller.start();
    for (let attempt = 0; attempt < 6 && controller.getStatus() !== "live"; attempt += 1) {
      (handlers as SubscribeHandlers | null)?.onStatus("subscribed");
      await flush();
      const next = timers.shift();
      if (controller.getStatus() !== "live") next?.();
    }
    expect(controller.getState().runs[RUN]?.last_seq).toBe(rows.length);
  });
});
