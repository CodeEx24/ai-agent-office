import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ updateAgentAction: vi.fn(), unarchiveAgentAction: vi.fn() }));

import { updateAgentAction } from "./actions";
import { AgentEditForm, type EditableAgent } from "./AgentEditForm";

const WORKSPACE = "89000000-0000-4000-8000-0000000000a1";
const AGENT: EditableAgent = {
  id: "89000000-0000-4000-8000-0000000000b1",
  name: "Scout",
  role: "Researcher",
  model: "claude-haiku-5-5",
  thinkingEffort: "medium",
  prompt: "Find sources.",
  dailyBudgetCents: 500,
  version: 4,
  isArchived: false,
};

function setup(agent: EditableAgent = AGENT) {
  const user = userEvent.setup();
  const view = render(<AgentEditForm workspaceId={WORKSPACE} agent={agent} />);
  const hidden = (name: string): string => {
    const input = view.container.querySelector<HTMLInputElement>(
      `input[type="hidden"][name="${name}"]`,
    );
    if (!input) throw new Error(`hidden input ${name} not found`);
    return input.value;
  };
  return { user, hidden };
}

describe("AgentEditForm", () => {
  it("shows the current settings, with the budget in dollars", () => {
    setup();
    expect(screen.getByLabelText("Name")).toHaveValue("Scout");
    expect(screen.getByLabelText("Role")).toHaveValue("Researcher");
    expect(screen.getByLabelText("Model")).toHaveValue("claude-haiku-5-5");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("medium");
    expect(screen.getByLabelText("Prompt")).toHaveValue("Find sources.");
    expect(screen.getByLabelText(/Daily budget/)).toHaveValue("5.00");
  });

  it("sends the ids and the version it was loaded with, and nothing about mode or status", () => {
    const { hidden } = setup();
    expect(hidden("workspaceId")).toBe(WORKSPACE);
    expect(hidden("agentId")).toBe(AGENT.id);
    expect(hidden("expectedVersion")).toBe("4");
    expect(
      document.querySelector('[name="mode"], [name="status"], [name="archivedAt"]'),
    ).toBeNull();
  });

  it("lists the three thinking effort levels", () => {
    setup();
    const options = screen
      .getAllByRole("option")
      .map((option) => option.getAttribute("value"))
      .filter((value) => ["low", "medium", "high"].includes(value ?? ""));
    expect(options).toEqual(["low", "medium", "high"]);
  });

  it("names the field in each error, shows it next to the field and focuses the first one", async () => {
    const { user } = setup();
    await user.clear(screen.getByLabelText("Name"));
    await user.clear(screen.getByLabelText(/Daily budget/));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alerts = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(alerts[0]).toMatch(/^Name is required/);
    expect(alerts.some((text) => text.startsWith("Daily budget is required"))).toBe(true);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(/Name is required/);
  });

  it("is read-only for an archived agent and says how to change it", () => {
    setup({ ...AGENT, isArchived: true });
    expect(screen.getByRole("status")).toHaveTextContent(/archived.*unarchive/i);
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeEnabled();
    const unarchiveForm = screen.getByRole("form", { name: "Unarchive Scout" });
    expect(unarchiveForm.parentElement?.closest("form")).toBeNull();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("keeps the saved model and thinking effort on screen, so the next save sends them again", async () => {
    const { user } = setup();
    vi.mocked(updateAgentAction).mockResolvedValue({ done: true, version: 5 });

    await user.selectOptions(screen.getByLabelText("Model"), "claude-opus-5-5");
    await user.selectOptions(screen.getByLabelText("Thinking effort"), "high");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved. This agent is now at version 5.");

    expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-5-5");
    expect(screen.getByLabelText("Thinking effort")).toHaveValue("high");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const sent = vi.mocked(updateAgentAction).mock.calls[1]?.[1];
    if (!(sent instanceof FormData)) throw new Error("the second save did not send a FormData");
    expect(sent.get("model")).toBe("claude-opus-5-5");
    expect(sent.get("thinkingEffort")).toBe("high");
    expect(sent.get("expectedVersion")).toBe("5");
  });

  it("starts an agent created before budgets existed with an empty budget the owner must fill", () => {
    setup({ ...AGENT, dailyBudgetCents: null });
    expect(screen.getByLabelText(/Daily budget/)).toHaveValue("");
  });
});
