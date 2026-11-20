import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXPANDABLE_TEXT_LIMIT } from "./ExpandableText";
import { RunView } from "./RunView";
import {
  HASH,
  OTHER_RUN_ID,
  OTHER_WORKSPACE_ID,
  RUN_ID,
  baseRun,
  ev,
  makeFakeSource,
  stoppedByBudgetRows,
  usageEvent,
  type FakeSource,
} from "./run-view-fixtures";

/** Functional acceptance tests for the run view screen (AGO-153): AC1 live log, AC2 usage, untrusted text. */

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

function show(rows: readonly unknown[], source: FakeSource | null = null) {
  return render(<RunView run={baseRun()} initialRows={rows} serverNowMs={NOW} source={source} />);
}

async function goLive(rows = opening): Promise<FakeSource> {
  const source = makeFakeSource([...rows]);
  show(rows, source);
  await flush();
  source.setStatus("subscribed");
  await flush();
  return source;
}

function logItems(): string[] {
  return within(screen.getByTestId("run-log"))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "[click me](javascript:alert(1))",
  "**bold** _italic_ `code` # heading",
  '<a href="javascript:alert(1)">link</a>',
  "https://example.invalid/phish",
].join(" ");

// Untrusted text must never become an element. The page's own navigation links (always under /app/) are allowed; any
// other link, such as a javascript: or http(s) one coming from agent text, still fails.
const MARKUP_SELECTOR =
  "img, script, a:not([href^='/app/']), b, strong, em, i, code, h1 + p, iframe, svg, style";

describe("AC1: the log updates live", () => {
  it("shows several rows pushed one after another without a reload, in seq order", async () => {
    const source = await goLive();
    for (const [seq, summary] of [
      [4, "first"],
      [5, "second"],
      [6, "third"],
    ] as const) {
      const row = ev(seq, "message.emitted", { role: "agent", summary });
      source.stored.push(row);
      act(() => {
        source.push(row);
      });
    }
    expect(
      logItems()
        .slice(-3)
        .map((text) => /first|second|third/.exec(text)?.[0]),
    ).toEqual(["first", "second", "third"]);
    expect(screen.getByRole("heading", { name: "Log (6)" })).toBeInTheDocument();
  });

  it("shows a pushed row once when the stream delivers it twice", async () => {
    const source = await goLive();
    const row = ev(4, "message.emitted", { role: "agent", summary: "only once" });
    source.stored.push(row);
    act(() => {
      source.push(row);
      source.push(row);
    });
    await flush();
    expect(logItems().filter((text) => text.includes("only once"))).toHaveLength(1);
    expect(logItems()).toHaveLength(4);
  });

  it("shows rows that arrive out of order in seq order once the earlier row lands", async () => {
    const source = await goLive();
    const four = ev(4, "message.emitted", { role: "agent", summary: "four" });
    const five = ev(5, "message.emitted", { role: "agent", summary: "five" });
    const six = ev(6, "message.emitted", { role: "agent", summary: "six" });
    // The database has all three; the stream delivers 6, then 5, then 4.
    source.stored.push(four, five, six);
    act(() => {
      source.push(six);
      source.push(five);
      source.push(four);
    });
    await flush();
    const items = logItems();
    expect(items).toHaveLength(6);
    expect(items[3]).toContain("four");
    expect(items[4]).toContain("five");
    expect(items[5]).toContain("six");
  });

  it("tells the reader events are missing while a hole is open, and shows nothing past it", async () => {
    const source = await goLive();
    const five = ev(5, "message.emitted", { role: "agent", summary: "after the hole" });
    // Row 4 is not in the store yet, so the catch-up cannot fill the hole.
    source.stored.push(five);
    act(() => {
      source.push(five);
    });
    await flush();
    expect(screen.getByText(/Some events have not arrived yet/)).toBeInTheDocument();
    expect(screen.queryByText("after the hole")).toBeNull();

    const four = ev(4, "message.emitted", { role: "agent", summary: "the missing one" });
    source.stored.push(four);
    act(() => {
      source.push(four);
    });
    await flush();
    expect(screen.queryByText(/Some events have not arrived yet/)).toBeNull();
    expect(screen.getByText("the missing one")).toBeInTheDocument();
    expect(screen.getByText("after the hole")).toBeInTheDocument();
  });

  it("catches up from the last contiguous row after a drop, with each row shown exactly once", async () => {
    const source = await goLive();
    const live = ev(4, "message.emitted", { role: "agent", summary: "live four" });
    source.stored.push(live);
    act(() => {
      source.push(live);
    });
    source.setStatus("error");
    await flush();
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Reconnecting");

    const missed = [5, 6, 7].map((seq) =>
      ev(seq, "message.emitted", { role: "agent", summary: `missed ${String(seq)}` }),
    );
    source.stored.push(...missed);
    await flush(3_000);
    source.setStatus("subscribed");
    await flush();

    const items = logItems();
    expect(items).toHaveLength(7);
    for (const seq of [5, 6, 7]) {
      expect(items.filter((text) => text.includes(`missed ${String(seq)}`))).toHaveLength(1);
    }
    expect(source.fetches.at(-1)?.afterSeq).toBe(4);
    expect(screen.getByTestId("feed-status")).toHaveTextContent("Live");
  });

  it("ignores a row of another run or another workspace but keeps showing this run's rows", async () => {
    const source = await goLive();
    act(() => {
      source.push(
        ev(4, "message.emitted", { role: "agent", summary: "foreign run" }, 4, OTHER_RUN_ID),
      );
      source.push(
        ev(
          4,
          "message.emitted",
          { role: "agent", summary: "foreign ws" },
          4,
          RUN_ID,
          OTHER_WORKSPACE_ID,
        ),
      );
      source.push({ nonsense: true });
      source.push(null);
    });
    await flush();
    expect(screen.queryByText("foreign run")).toBeNull();
    expect(screen.queryByText("foreign ws")).toBeNull();
    expect(logItems()).toHaveLength(3);

    const own = ev(4, "message.emitted", { role: "agent", summary: "own row" });
    source.stored.push(own);
    act(() => {
      source.push(own);
    });
    expect(screen.getByText("own row")).toBeInTheDocument();
  });

  it("flips the phase to Completed when the final row arrives live", async () => {
    const source = await goLive();
    const done = ev(4, "run.completed", { steps: 1, summary: "finished" });
    source.stored.push(done);
    act(() => {
      source.push(done);
    });
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Completed");
    expect(screen.getByText("finished")).toBeInTheDocument();
  });

  it("shows an empty run as empty, then fills it from the live stream", async () => {
    const source = makeFakeSource([]);
    render(
      <RunView
        run={baseRun({ status: "queued", startedAt: null })}
        initialRows={[]}
        serverNowMs={NOW}
        source={source}
      />,
    );
    await flush();
    source.setStatus("subscribed");
    await flush();
    expect(screen.getByText(/Nothing has happened yet/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Log (0)" })).toBeInTheDocument();

    const first = ev(1, "run.created", {
      agent_id: "15300000-0000-4000-8000-0000000000b1",
      task_id: null,
    });
    source.stored.push(first);
    act(() => {
      source.push(first);
    });
    expect(screen.queryByText(/Nothing has happened yet/)).toBeNull();
    expect(screen.getByText("Run queued")).toBeInTheDocument();
  });

  it("starts from the stored rows and catches up on rows written before the subscription", async () => {
    const written = [
      ...opening,
      ev(4, "message.emitted", { role: "agent", summary: "between read and subscribe" }),
    ];
    const source = makeFakeSource(written);
    show(opening, source);
    await flush();
    source.setStatus("subscribed");
    await flush();
    expect(screen.getByText("between read and subscribe")).toBeInTheDocument();
    expect(source.fetches[0]?.afterSeq).toBe(3);
  });
});

describe("AC2: cost and tokens match the stored usage", () => {
  it("shows totals equal to the summed stored usage events for a run stopped by the budget", async () => {
    const rows = stoppedByBudgetRows();
    show(rows);
    await flush();
    const payloads = rows
      .filter((row) => row.type === "budget.usage")
      .map(
        (row) => row.payload as { input_tokens: number; output_tokens: number; cost_cents: number },
      );
    const cents = payloads.reduce((sum, p) => sum + p.cost_cents, 0);
    expect(screen.getByTestId("usage-input")).toHaveTextContent(
      new Intl.NumberFormat("en-US").format(payloads.reduce((s, p) => s + p.input_tokens, 0)),
    );
    expect(screen.getByTestId("usage-cost")).toHaveTextContent(`$${(cents / 100).toFixed(2)}`);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("This run was stopped: it reached its token budget.");
    expect(banner).toHaveTextContent("Used 4,000 tokens of 4,000 tokens.");
    expect(banner).toHaveTextContent("Next step:");
    expect(screen.getByTestId("run-phase")).toHaveTextContent("Stopped");
  });

  it("shows the cost as not reported, never as zero, when no call recorded a cost", async () => {
    show([...opening, usageEvent(4, 500, 100), usageEvent(5, 250, 50)]);
    await flush();
    const cost = screen.getByTestId("usage-cost");
    expect(cost).toHaveTextContent("not reported");
    expect(cost.textContent).not.toMatch(/\$0|^0/);
    expect(screen.getByTestId("usage-input")).toHaveTextContent("750");
    expect(screen.getByText(/2 model calls have no recorded cost/)).toBeInTheDocument();
  });

  it("shows $0.00 only for a call that recorded a cost of zero", async () => {
    show([...opening, usageEvent(4, 10, 5, 0)]);
    await flush();
    expect(screen.getByTestId("usage-cost")).toHaveTextContent("$0.00");
    expect(screen.queryByText(/no recorded cost/)).toBeNull();
  });

  it("warns that the total may be low when only some calls have a cost", async () => {
    show([...opening, usageEvent(4, 100, 10, 5), usageEvent(5, 100, 10)]);
    await flush();
    expect(screen.getByTestId("usage-cost")).toHaveTextContent("$0.05");
    expect(screen.getByText(/1 model call has no recorded cost/)).toBeInTheDocument();
  });

  it("shows zero tokens and no cost for a run with no usage events", async () => {
    show(opening);
    await flush();
    expect(screen.getByTestId("usage-input")).toHaveTextContent("0");
    expect(screen.getByTestId("usage-calls")).toHaveTextContent("0");
    expect(screen.getByTestId("usage-cost")).toHaveTextContent("not reported");
  });

  it("does not double count a usage row the stream replays", async () => {
    const source = await goLive();
    const row = usageEvent(4, 100, 50, 3);
    source.stored.push(row);
    act(() => {
      source.push(row);
      source.push(row);
    });
    await flush();
    expect(screen.getByTestId("usage-input")).toHaveTextContent("100");
    expect(screen.getByTestId("usage-calls")).toHaveTextContent("1");
    expect(screen.getByTestId("usage-cost")).toHaveTextContent("$0.03");
  });

  it("never prints a hash anywhere on the page", async () => {
    const rows = [...stoppedByBudgetRows()];
    const { container } = show(rows);
    await flush();
    expect(container.innerHTML).not.toContain(HASH);
    expect(container.innerHTML).not.toContain(HASH.slice(0, 16));
  });
});

describe("untrusted text is plain text", () => {
  it("renders hostile agent message text as text with no element, link or markdown", async () => {
    const { container } = show([
      ...opening,
      ev(4, "message.emitted", { role: "agent", summary: HOSTILE }),
    ]);
    await flush();
    expect(container.querySelector(MARKUP_SELECTOR)).toBeNull();
    expect(screen.getByText(HOSTILE)).toBeInTheDocument();
  });

  it("renders a hostile tool name as text", async () => {
    const { container } = show([
      ...opening,
      ev(4, "tool_call.requested", {
        call_id: "c1",
        tool_name: "<img src=x onerror=alert(1)>",
        tier: 1,
        input_hash: HASH,
      }),
    ]);
    await flush();
    expect(container.querySelector(MARKUP_SELECTOR)).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("renders hostile tool error text, error.raised text and run.failed text as text", async () => {
    const { container } = show([
      ...opening,
      ev(4, "tool_call.requested", {
        call_id: "c1",
        tool_name: "web.fetch",
        tier: 1,
        input_hash: HASH,
      }),
      ev(5, "tool_call.failed", { call_id: "c1", error_code: "boom", message: HOSTILE }),
      ev(6, "error.raised", { code: "bad_thing", message: HOSTILE, retryable: false }),
      ev(7, "run.failed", { reason: "model_error", message: HOSTILE }),
    ]);
    await flush();
    expect(container.querySelector(MARKUP_SELECTOR)).toBeNull();
    // Tool card error, tool_call.failed timeline detail, error.raised detail, run.failed banner and its timeline detail.
    expect(screen.getAllByText(HOSTILE)).toHaveLength(5);
  });

  it("renders hostile text that arrives live as text", async () => {
    const source = await goLive();
    const row = ev(4, "message.emitted", { role: "agent", summary: HOSTILE });
    source.stored.push(row);
    act(() => {
      source.push(row);
    });
    expect(document.body.querySelector(MARKUP_SELECTOR)).toBeNull();
    expect(screen.getByText(HOSTILE)).toBeInTheDocument();
  });

  it("does not execute an inline handler: no element carries an on* attribute", async () => {
    const { container } = show([
      ...opening,
      ev(4, "message.emitted", { role: "agent", summary: HOSTILE }),
    ]);
    await flush();
    const withHandler = [...container.querySelectorAll("*")].filter((node) =>
      node.getAttributeNames().some((name) => name.startsWith("on")),
    );
    expect(withHandler).toEqual([]);
  });

  it("shows the whole text without a control when the message is exactly at the limit", async () => {
    const exact = "e".repeat(EXPANDABLE_TEXT_LIMIT);
    show([...opening, ev(4, "message.emitted", { role: "agent", summary: exact })]);
    await flush();
    expect(screen.getByText(exact)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("cuts a message one character over the limit and offers to expand it", async () => {
    const over = "o".repeat(EXPANDABLE_TEXT_LIMIT + 1);
    show([...opening, ev(4, "message.emitted", { role: "agent", summary: over })]);
    await flush();
    expect(screen.queryByText(over)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show more (1 more characters)" }),
    ).toBeInTheDocument();
  });

  it("expands a message at the schema maximum to its full text and collapses it again", async () => {
    const huge = `start-${"z".repeat(1_990)}-end`; // 2,000 characters, the longest message the schema allows
    expect(huge).toHaveLength(2_000);
    show([...opening, ev(4, "message.emitted", { role: "agent", summary: huge })]);
    await flush();
    expect(screen.queryByText(huge)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(screen.getByText(huge)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText(huge)).toBeNull();
  });

  it("shows an unrecognised-event notice, not the text, for a message beyond the schema limit", async () => {
    const tooBig = "w".repeat(10_000);
    const { container } = show([
      ...opening,
      ev(4, "message.emitted", { role: "agent", summary: tooBig }),
    ]);
    await flush();
    expect(container.textContent).not.toContain("w".repeat(500));
    expect(screen.getByText(/1 event was not recognised/)).toBeInTheDocument();
    expect(screen.getByText(/Unrecognised event \(message\.emitted\)/)).toBeInTheDocument();
  });

  it("expands a long tool error message and keeps it as text", async () => {
    const long = `<b>${"e".repeat(480)}</b>`;
    const { container } = show([
      ...opening,
      ev(4, "tool_call.requested", {
        call_id: "c1",
        tool_name: "web.fetch",
        tier: 1,
        input_hash: HASH,
      }),
      ev(5, "tool_call.failed", { call_id: "c1", error_code: "boom", message: long }),
    ]);
    await flush();
    const toolSection = screen.getByRole("region", { name: "Tool calls" });
    fireEvent.click(within(toolSection).getByRole("button", { name: /Show more/ }));
    expect(within(toolSection).getByText(long)).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("keeps unicode, emoji and right-to-left text intact", async () => {
    const text = "Grüße 👩‍💻 مرحبا שלום 日本語";
    show([...opening, ev(4, "message.emitted", { role: "agent", summary: text })]);
    await flush();
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
