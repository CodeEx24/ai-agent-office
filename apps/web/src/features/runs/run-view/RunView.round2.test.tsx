import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExpandableText, EXPANDABLE_TEXT_LIMIT } from "./ExpandableText";
import { RunView } from "./RunView";
import {
  AGENT_ID,
  HASH,
  baseRun,
  ev,
  makeFakeSource,
  stoppedByBudgetRows,
  usageEvent,
  type FakeSource,
} from "./run-view-fixtures";

/**
 * Functional tests for the AGO-153 round-2 changes: overflow structure, heading and links, the stale banner,
 * budget-stop wording per scope, the polite live region and the expand button size. Real layout overflow is
 * checked by the e2e flow (jsdom has no layout), so here the classes that cause the fix are asserted.
 */

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
  ev(1, "run.created", { agent_id: AGENT_ID, task_id: null }),
  ev(2, "run.started"),
  ev(3, "step.started", { step: 1 }),
];

function show(
  rows: readonly unknown[],
  source: FakeSource | null,
  run: ReturnType<typeof baseRun> = baseRun(),
) {
  return render(<RunView run={run} initialRows={rows} serverNowMs={NOW} source={source} />);
}

function stopRows(scope: string, reason: string, used: number, limit: number): unknown[] {
  return [
    ev(1, "run.created", { agent_id: AGENT_ID, task_id: null }),
    ev(2, "run.started"),
    ev(3, "budget.exceeded", { scope, reason, limit, used }),
    ev(4, "run.stopped", { stopped_by: "budget", reason }),
  ];
}

describe("round 2, change 1: long unbroken text cannot widen the page", () => {
  it("expandable text wraps anywhere inside a shrinkable grid track", () => {
    const { container } = render(<ExpandableText text={"x".repeat(450)} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveClass("grid-cols-[minmax(0,1fr)]");
    expect(within(wrapper).getByText(/^x+…?$/)).toHaveClass("wrap-anywhere");
  });

  it("keeps a 450-character unbroken failure message wrapped anywhere, collapsed and expanded", async () => {
    const message = "A".repeat(450);
    show(
      [...opening, ev(4, "run.failed", { reason: "error", message })],
      null,
      baseRun({ status: "failed" }),
    );
    await flush();
    const alert = screen
      .getAllByRole("alert")
      .find((node) => node.textContent.includes("Run failed"))!;
    const text = alert.querySelector("p.wrap-anywhere")!;
    expect(text).not.toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: /Show more/ }));
    expect(within(alert).getByText(message)).toHaveClass("wrap-anywhere");
  });

  it("gives the page grid, the banners, the tool call list and the log list shrinkable tracks", async () => {
    const rows = [
      ...stoppedByBudgetRows(),
      ev(14, "message.emitted", { role: "agent", summary: "tail" }),
    ];
    const { container } = show(rows, null);
    await flush();
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("grid-cols-[minmax(0,1fr)]", "[&>*]:min-w-0");
    expect(screen.getByTestId("budget-stop").parentElement).toHaveClass(
      "grid-cols-[minmax(0,1fr)]",
    );
    const toolList = screen.getByRole("region", { name: "Tool calls" }).querySelector("ul");
    expect(toolList).toHaveClass("grid-cols-[minmax(0,1fr)]");
    expect(toolList?.querySelector("li")).toHaveClass("min-w-0", "grid-cols-[minmax(0,1fr)]");
    const log = screen.getByTestId("run-log");
    expect(log).toHaveClass("grid-cols-[minmax(0,1fr)]");
    for (const item of within(log).getAllByRole("listitem")) {
      expect(item).toHaveClass("min-w-0", "grid-cols-[minmax(0,1fr)]");
    }
  });

  it("lets a 128-character tool name (the schema maximum) break anywhere instead of widening its card", async () => {
    const name = "t".repeat(128);
    const rows = [
      ...opening,
      ev(4, "tool_call.requested", { call_id: "c9", tool_name: name, tier: 1, input_hash: HASH }),
    ];
    show(rows, null);
    await flush();
    expect(screen.getByText(name)).toHaveClass("break-all");
  });
});

describe("round 2, change 3: heading, agent link and back link", () => {
  const ID = "abcdef12-0000-4000-8000-0000000000a1";

  it("shows Run and the first 8 characters of the id, with the full id as tooltip", async () => {
    show(opening, null, baseRun({ id: ID }));
    await flush();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/^Run abcdef12$/);
    expect(screen.getByTestId("run-short-id")).toHaveAttribute("title", ID);
    expect(heading).not.toHaveTextContent(ID);
  });

  it("links the agent name to the agent page", async () => {
    show(opening, null);
    await flush();
    expect(screen.getByRole("link", { name: "Scout" })).toHaveAttribute(
      "href",
      `/app/agents/${AGENT_ID}`,
    );
  });

  it("still links to the agent when the agent has no name, labelled Unknown agent", async () => {
    show(opening, null, baseRun({ agentName: null }));
    await flush();
    expect(screen.getByRole("link", { name: "Unknown agent" })).toHaveAttribute(
      "href",
      `/app/agents/${AGENT_ID}`,
    );
  });

  it("shows a hostile agent name as link text, never as markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { container } = show(opening, null, baseRun({ agentName: hostile }));
    await flush();
    expect(screen.getByRole("link", { name: hostile })).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("offers a Back to the office link above the heading", async () => {
    show(opening, null);
    await flush();
    const back = screen.getByRole("link", { name: "Back to the office" });
    expect(back).toHaveAttribute("href", "/app/office");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("round 2, change 4: the page does not overstate while the feed is down", () => {
  it("shows no stale banner while the first connection is still being made", async () => {
    const source = makeFakeSource([...opening]);
    vi.spyOn(source, "fetchRunEvents").mockImplementation(() => new Promise(() => undefined));
    show(opening, source);
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Connecting");
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    source.setStatus("subscribed");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Catching up");
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    expect(screen.getByTestId("run-phase")).not.toHaveTextContent("last known");
  });

  it("keeps the alert banner through Connecting and Catching up until the feed is Live again", async () => {
    const source = makeFakeSource([...opening]);
    show(opening, source);
    await flush();
    source.setStatus("subscribed");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Live");

    source.setStatus("error");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Reconnecting");
    expect(screen.getByTestId("stale-banner")).toHaveAttribute("role", "alert");

    // Hold the catch-up read open so "Catching up" can be observed after the channel comes back.
    let release: (rows: never[]) => void = () => undefined;
    vi.spyOn(source, "fetchRunEvents").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await flush(3_000);
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Connecting");
    expect(screen.getByTestId("stale-banner")).toBeInTheDocument();
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Running · last known");

    source.setStatus("subscribed");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Catching up");
    expect(screen.getByTestId("stale-banner")).toBeInTheDocument();
    expect(screen.getByTestId("run-duration")).toHaveTextContent("(not updating)");

    release([]);
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Live");
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    expect(screen.getByTestId("run-phase")).not.toHaveTextContent("last known");
    expect(screen.getByTestId("run-duration")).not.toHaveTextContent("not updating");
  });

  it("freezes the duration across the whole outage and counts again after recovery", async () => {
    const source = makeFakeSource([...opening]);
    show(opening, source);
    await flush();
    source.setStatus("subscribed");
    await flush(2_000);
    source.setStatus("closed");
    await flush();
    const frozen = screen.getByTestId("run-duration").textContent;
    expect(frozen).toMatch(/\(not updating\)$/);
    await flush(10_000);
    expect(screen.getByTestId("run-duration").textContent).toBe(frozen);
    source.setStatus("subscribed");
    await flush();
    await flush(4_000);
    expect(screen.getByTestId("run-duration").textContent).not.toBe(frozen);
  });

  it("names the reconnecting cause in the banner when the channel closed, and Reload when there is no stream", async () => {
    const source = makeFakeSource([...opening]);
    const first = show(opening, source);
    await flush();
    source.setStatus("subscribed");
    await flush();
    source.setStatus("closed");
    await flush();
    expect(screen.getByTestId("stale-banner")).toHaveTextContent("is reconnecting");
    first.unmount();

    show(opening, null);
    await flush();
    expect(screen.getByTestId("stale-banner")).toHaveTextContent("Reload the page");
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Not live");
  });

  it.each([
    ["completed", [...opening, ev(4, "run.completed", { steps: 1, summary: "done" })]],
    ["failed", [...opening, ev(4, "run.failed", { reason: "error", message: "boom" })]],
    ["stopped", stoppedByBudgetRows()],
  ])(
    "shows no stale banner and no last-known wording for a %s run when the feed is down",
    async (_n, rows) => {
      show(rows, null);
      await flush();
      expect(screen.getByTestId("feed-status")).toHaveTextContent("Not live");
      expect(screen.queryByTestId("stale-banner")).toBeNull();
      expect(screen.getByTestId("run-phase")).not.toHaveTextContent("last known");
      expect(screen.getByTestId("run-duration")).not.toHaveTextContent("not updating");
    },
  );

  it("shows a null-source run that has not started as last known, not as live", async () => {
    show([], null, baseRun({ status: "queued", startedAt: null }));
    await flush();
    expect(screen.getByTestId("stale-banner")).toBeInTheDocument();
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Queued · last known");
  });
});

describe("round 2, change 5: budget stop in plain words, per scope", () => {
  const AGENT_HREF = `/app/agents/${AGENT_ID}`;

  it("run scope shows tokens used of the limit, a next step, and a link to the agent", async () => {
    show(stopRows("run", "run_token_limit_reached", 4_000, 4_000), null);
    await flush();
    const banner = screen.getByTestId("budget-stop");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("it reached its token budget");
    expect(banner).toHaveTextContent("Used 4,000 tokens of 4,000 tokens.");
    expect(banner).toHaveTextContent("Next step:");
    expect(within(banner).getByRole("link", { name: "Open the agent" })).toHaveAttribute(
      "href",
      AGENT_HREF,
    );
  });

  it("agent daily scope shows dollars of the daily budget and links to the agent", async () => {
    show(stopRows("agent_daily", "agent_daily_limit_would_be_exceeded", 250, 500), null);
    await flush();
    const banner = screen.getByTestId("budget-stop");
    expect(banner).toHaveTextContent("the agent reached its daily budget");
    expect(banner).toHaveTextContent("Used $2.50 of $5.00 today.");
    expect(banner).toHaveTextContent("midnight UTC");
    expect(within(banner).getByRole("link", { name: "Open the agent" })).toHaveAttribute(
      "href",
      AGENT_HREF,
    );
  });

  it("workspace monthly scope names a workspace owner and has no agent link", async () => {
    show(
      stopRows("workspace_monthly", "workspace_monthly_limit_would_be_exceeded", 1_000, 2_000),
      null,
    );
    await flush();
    const banner = screen.getByTestId("budget-stop");
    expect(banner).toHaveTextContent("the workspace reached its monthly budget");
    expect(banner).toHaveTextContent("Used $10.00 of $20.00 this month.");
    expect(banner).toHaveTextContent("ask a workspace owner");
    expect(within(banner).queryByRole("link")).toBeNull();
  });

  it.each([
    ["pricing", "model_not_priced"],
    ["ledger", "budget_check_failed"],
  ])(
    "%s scope says the budget could not be checked safely, with no usage line and no agent link",
    async (scope, reason) => {
      show(stopRows(scope, reason, 0, 0), null);
      await flush();
      const banner = screen.getByTestId("budget-stop");
      expect(banner).toHaveTextContent("its budget could not be checked safely");
      expect(banner).toHaveTextContent("Next step: start a new run");
      expect(banner).not.toHaveTextContent(/Used .* of /);
      expect(within(banner).queryByRole("link")).toBeNull();
    },
  );

  it("shows the specific shared reason text under the title", async () => {
    show(stopRows("ledger", "call_cost_overran_reservation", 5, 4), null);
    await flush();
    expect(screen.getByTestId("budget-stop")).toHaveTextContent(
      "A model call cost more than was reserved for it, so the run was stopped.",
    );
  });

  it("always names a person or a new run as the next step, never the agent, in any scope", async () => {
    const scopes: [string, string][] = [
      ["run", "run_token_limit_reached"],
      ["agent_daily", "agent_daily_limit_would_be_exceeded"],
      ["workspace_monthly", "workspace_monthly_limit_would_be_exceeded"],
      ["pricing", "model_not_priced"],
      ["ledger", "budget_check_failed"],
    ];
    for (const [scope, reason] of scopes) {
      const view = show(stopRows(scope, reason, 1, 2), null);
      await flush();
      expect(screen.getByTestId("budget-stop").textContent).toMatch(
        /someone who manages|workspace owner|start a new run/,
      );
      view.unmount();
    }
  });

  it("shows no budget banner for a run that was not stopped by a budget", async () => {
    show([...opening, ev(4, "run.completed", { steps: 1, summary: "ok" })], null);
    await flush();
    expect(screen.queryByTestId("budget-stop")).toBeNull();
  });
});

describe("round 2, other changes", () => {
  it("announces the phase in a polite live region and updates it when the phase changes", async () => {
    const source = makeFakeSource([...opening]);
    show(opening, source);
    await flush();
    source.setStatus("subscribed");
    await flush();
    const announcer = screen.getByTestId("phase-announcer");
    expect(announcer).toHaveAttribute("role", "status");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    expect(announcer).toHaveTextContent("Run status: Running");

    const done = ev(4, "run.completed", { steps: 1, summary: "finished" });
    source.stored.push(done);
    act(() => {
      source.push(done);
    });
    expect(screen.getByTestId("phase-announcer")).toHaveTextContent("Run status: Completed");
  });

  it("keeps the log itself out of any live region", async () => {
    show(opening, null);
    await flush();
    expect(screen.getByTestId("run-log").closest("[aria-live]")).toBeNull();
    expect(screen.getByTestId("run-log")).not.toHaveAttribute("aria-live");
  });

  it("gives the expand button a touch target of at least 24px", () => {
    render(<ExpandableText text={"y".repeat(EXPANDABLE_TEXT_LIMIT + 1)} />);
    expect(screen.getByRole("button", { name: /Show more/ })).toHaveClass("min-h-6");
  });

  it("shows tool text and usage without raw palette colours (tokens only)", async () => {
    const { container } = show([...stoppedByBudgetRows(), usageEvent(14, 1, 1, 1)], null);
    await flush();
    expect(container.innerHTML).not.toMatch(
      /(?:border|text|bg)-(?:red|green|amber|yellow)-\d{2,3}/,
    );
  });
});
