import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentVersion } from "@ago/shared";

import { AgentVersionList, formatVersionTime } from "./AgentVersionList";

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    version: 2,
    changeKind: "edit",
    changedFields: ["model", "thinking_effort"],
    name: "Scout",
    role: "Researcher",
    model: "claude-sonnet-5-5",
    thinkingEffort: "high",
    prompt: "Find sources.",
    dailyBudgetCents: 750,
    changedByName: "Ada",
    createdAt: "2026-11-10T09:30:00.000Z",
    ...overrides,
  };
}

describe("AgentVersionList", () => {
  it("shows what changed, who changed it and when, newest first as given", () => {
    render(
      <AgentVersionList
        versions={[
          version(),
          version({ version: 1, changeKind: "create", changedFields: [], changedByName: "Ada" }),
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Version history" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Version 2 · Edited");
    expect(items[0]).toHaveTextContent("Changed model, thinking effort.");
    expect(items[0]).toHaveTextContent("By Ada.");
    expect(items[0]).toHaveTextContent("2026-11-10 09:30 UTC");
    expect(items[1]).toHaveTextContent("Version 1 · Created");
  });

  it("gives archive and unarchive rows a plain summary, even though the database lists archived_at as changed", () => {
    render(
      <AgentVersionList
        versions={[
          version({
            version: 5,
            changeKind: "unarchive",
            changedFields: ["archived_at"],
            changedByName: null,
          }),
          version({
            version: 4,
            changeKind: "archive",
            changedFields: ["archived_at"],
            changedByName: "Ada",
          }),
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Version history" })).getAllByRole(
      "listitem",
    );
    expect(items[0]).toHaveTextContent("Version 5 · Unarchived");
    expect(items[0]).toHaveTextContent("By an unknown member.");
    expect(items[1]).toHaveTextContent("Version 4 · Archived");
    expect(items[1]).toHaveTextContent("By Ada.");
    for (const item of items) expect(item).not.toHaveTextContent("Changed");
  });

  it("labels archive and unarchive changes", () => {
    render(
      <AgentVersionList
        versions={[
          version({ version: 4, changeKind: "unarchive", changedFields: [] }),
          version({ version: 3, changeKind: "archive", changedFields: [] }),
        ]}
      />,
    );
    expect(screen.getByText(/Version 4 · Unarchived/)).toBeInTheDocument();
    expect(screen.getByText(/Version 3 · Archived/)).toBeInTheDocument();
  });

  it("shows the prompt as plain text, never as markup", () => {
    const { container } = render(
      <AgentVersionList versions={[version({ prompt: "<script>alert(1)</script><b>hi</b>" })]} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("pre b")).toBeNull();
    expect(container.querySelector("pre")).toHaveTextContent("<script>alert(1)</script><b>hi</b>");
  });

  it("handles a missing author, a missing budget and an empty history", () => {
    const { rerender } = render(
      <AgentVersionList versions={[version({ changedByName: null, dailyBudgetCents: null })]} />,
    );
    expect(screen.getByText(/By an unknown member\./)).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
    rerender(<AgentVersionList versions={[]} />);
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
  });

  it("formats times the same on server and browser", () => {
    expect(formatVersionTime("2026-11-10T09:30:45.000Z")).toBe("2026-11-10 09:30 UTC");
    expect(formatVersionTime("nonsense")).toBe("unknown time");
  });
});
