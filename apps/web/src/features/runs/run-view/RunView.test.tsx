import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunView } from "./RunView";
import {
  RUN_ID,
  at,
  baseRun,
  ev,
  makeFakeSource,
  stoppedByBudgetRows,
  usageEvent,
  type FakeSource,
} from "./run-view-fixtures";

const NOW = Date.parse("2026-11-20T10:00:30.000Z");

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const opening = [
  ev(1, "run.created", { agent_id: "15300000-0000-4000-8000-0000000000b1", task_id: null }),
  ev(2, "run.started"),
  ev(3, "step.started", { step: 1 }),
];

function renderRun(rows = opening, source: FakeSource | null = makeFakeSource([...rows])) {
  render(<RunView run={baseRun()} initialRows={rows} serverNowMs={NOW} source={source} />);
  return source;
}

describe("live log (AC1)", () => {
  it("shows a new run_events row without a reload", async () => {
    const source = renderRun();
    await flush();
    source?.setStatus("subscribed");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Live");
    expect(screen.queryByText("hello from the agent")).toBeNull();

    const row = ev(4, "message.emitted", { role: "agent", summary: "hello from the agent" });
    source?.stored.push(row);
    act(() => {
      source?.push(row);
    });
    expect(screen.getByText("hello from the agent")).toBeInTheDocument();
  });

  it("catches up after a reconnect with no duplicates and no gaps", async () => {
    const source = renderRun();
    await flush();
    source?.setStatus("subscribed");
    await flush();

    source?.setStatus("closed");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Reconnecting");

    // Rows 4..6 were written while the channel was down; row 4 is also replayed by the stream later.
    const missed = [
      ev(4, "message.emitted", { role: "agent", summary: "one" }),
      ev(5, "message.emitted", { role: "agent", summary: "two" }),
      ev(6, "message.emitted", { role: "agent", summary: "three" }),
    ];
    source?.stored.push(...missed);
    await flush(3_000);
    expect(source?.subscribeCount()).toBe(2);
    source?.setStatus("subscribed");
    await flush();
    act(() => {
      source?.push(missed[0]);
    });

    const items = within(screen.getByTestId("run-log"))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items.filter((t) => t.includes("one"))).toHaveLength(1);
    expect(items.filter((t) => t.includes("two"))).toHaveLength(1);
    expect(items.filter((t) => t.includes("three"))).toHaveLength(1);
    expect(items).toHaveLength(6);
    expect(source?.fetches.at(-1)?.afterSeq).toBe(3);
  });

  it("fills a hole when a row arrives ahead of a missing one", async () => {
    const source = renderRun();
    await flush();
    source?.setStatus("subscribed");
    await flush();
    const four = ev(4, "message.emitted", { role: "agent", summary: "four" });
    const five = ev(5, "message.emitted", { role: "agent", summary: "five" });
    source?.stored.push(four, five);
    act(() => {
      source?.push(five);
    });
    await flush();
    expect(screen.getByText("four")).toBeInTheDocument();
    expect(screen.getByText("five")).toBeInTheDocument();
  });

  it("ignores rows of another run and another workspace on the stream", async () => {
    const source = renderRun();
    await flush();
    source?.setStatus("subscribed");
    await flush();
    act(() => {
      source?.push(
        ev(4, "message.emitted", { role: "agent", summary: "other run" }, 4, "other-run"),
      );
      source?.push(
        ev(4, "message.emitted", { role: "agent", summary: "other ws" }, 4, RUN_ID, "other-ws"),
      );
    });
    expect(screen.queryByText("other run")).toBeNull();
    expect(screen.queryByText("other ws")).toBeNull();
  });

  it("reconnects after a failed catch-up read", async () => {
    const source = renderRun();
    await flush();
    source?.failNextFetch();
    source?.setStatus("subscribed");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Reconnecting");
    await flush(3_000);
    source?.setStatus("subscribed");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Live");
  });

  it("says it is not live when there is no stream, and still shows the stored log", async () => {
    renderRun(opening, null);
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Not live");
    expect(screen.getByText("Step 1 started")).toBeInTheDocument();
  });
});

describe("usage matches the stored events (AC2)", () => {
  it("shows tokens and cost of a run stopped by budget.exceeded", async () => {
    renderRun(stoppedByBudgetRows(), null);
    await flush();
    expect(screen.getByTestId("usage-input")).toHaveTextContent("3,200");
    expect(screen.getByTestId("usage-output")).toHaveTextContent("800");
    expect(screen.getByTestId("usage-cost")).toHaveTextContent("$0.19");
    expect(screen.getByTestId("usage-calls")).toHaveTextContent("2");
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped by the budget (run)");
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Stopped");
  });

  it("updates the totals when a usage row arrives live", async () => {
    const source = renderRun();
    await flush();
    source?.setStatus("subscribed");
    await flush();
    const row = usageEvent(4, 100, 50, 3);
    source?.stored.push(row);
    act(() => {
      source?.push(row);
    });
    expect(screen.getByTestId("usage-input")).toHaveTextContent("100");
    expect(screen.getByTestId("usage-cost")).toHaveTextContent("$0.03");
  });

  it("does not show tool hashes", async () => {
    renderRun(stoppedByBudgetRows(), null);
    await flush();
    expect(document.body.textContent).not.toContain("abababab");
  });
});

describe("duration", () => {
  it("ticks while the run is running", async () => {
    renderRun(opening, null);
    await flush();
    expect(screen.getByTestId("run-duration")).toHaveTextContent("28 s");
    await flush(5_000);
    expect(screen.getByTestId("run-duration")).toHaveTextContent("33 s");
  });

  it("is fixed for a finished run", async () => {
    renderRun(stoppedByBudgetRows(), null);
    await flush();
    const before = screen.getByTestId("run-duration").textContent;
    await flush(10_000);
    expect(screen.getByTestId("run-duration").textContent).toBe(before);
    expect(before).toBe("11 s");
  });
});

describe("states", () => {
  it("shows an empty queued run", async () => {
    render(
      <RunView
        run={baseRun({ status: "queued", startedAt: null })}
        initialRows={[]}
        serverNowMs={NOW}
        source={null}
      />,
    );
    await flush();
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Queued");
    expect(screen.getByText(/Nothing has happened yet/)).toBeInTheDocument();
    expect(screen.getByText("No tool calls yet.")).toBeInTheDocument();
    expect(screen.getByTestId("run-duration")).toHaveTextContent("not started");
  });

  it("shows paused, failed and completed", async () => {
    const paused = [
      ...opening,
      ev(4, "run.paused", { requested_by: "human", reason: "user_pause" }),
    ];
    const first = render(
      <RunView run={baseRun()} initialRows={paused} serverNowMs={NOW} source={null} />,
    );
    await flush();
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Paused");
    expect(screen.getByText(/waiting for a person to resume/)).toBeInTheDocument();
    first.unmount();

    const failed = [...opening, ev(4, "run.failed", { reason: "model_error", message: "boom" })];
    const second = render(
      <RunView run={baseRun()} initialRows={failed} serverNowMs={NOW} source={null} />,
    );
    await flush();
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Run failed: model error");
    second.unmount();

    const completed = [...opening, ev(4, "run.completed", { steps: 1, summary: "all done" })];
    render(<RunView run={baseRun()} initialRows={completed} serverNowMs={NOW} source={null} />);
    await flush();
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Completed");
    expect(screen.getByText("all done")).toBeInTheDocument();
  });

  it("falls back to the stored status when the log is empty", async () => {
    render(
      <RunView
        run={baseRun({ status: "failed", finishedAt: at(5) })}
        initialRows={[]}
        serverNowMs={NOW}
        source={null}
      />,
    );
    await flush();
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Failed");
    expect(screen.getByText("No events were recorded for this run.")).toBeInTheDocument();
  });
});

describe("untrusted text", () => {
  const hostile =
    '<img src=x onerror="alert(1)"><script>alert(1)</script> **bold** [x](javascript:alert(1))';

  it("renders agent and tool text as plain text only", async () => {
    const rows = [
      ...opening,
      ev(4, "message.emitted", { role: "agent", summary: hostile }),
      ev(5, "tool_call.requested", {
        call_id: "c9",
        tool_name: "<b>tool</b>",
        tier: 1,
        input_hash: "ab".repeat(32),
      }),
      ev(6, "tool_call.failed", { call_id: "c9", error_code: "boom", message: hostile }),
    ];
    const { container } = render(
      <RunView run={baseRun()} initialRows={rows} serverNowMs={NOW} source={null} />,
    );
    await flush();
    expect(container.querySelector("img, script, b, a")).toBeNull();
    expect(screen.getAllByText(hostile).length).toBeGreaterThan(0);
    expect(screen.getByText("<b>tool</b>")).toBeInTheDocument();
  });

  it("truncates a very large message and expands it on request", async () => {
    const big = "x".repeat(2_000);
    const rows = [...opening, ev(4, "message.emitted", { role: "agent", summary: big })];
    render(<RunView run={baseRun()} initialRows={rows} serverNowMs={NOW} source={null} />);
    await flush();
    expect(screen.queryByText(big)).toBeNull();
    const button = screen.getByRole("button", { name: /Show more/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(screen.getByText(big)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
