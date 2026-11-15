import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const action = vi.hoisted(() => ({ setAgentModeAction: vi.fn() }));
vi.mock("./actions", () => action);

import { AgentModeForm } from "./AgentModeForm";

const WORKSPACE = "99000000-0000-4000-8000-0000000000a1";
const AGENT_ID = "99000000-0000-4000-8000-0000000000b1";
const MODES = [
  { id: "strict", label: "Strict", description: "Every action waits." },
  { id: "standard", label: "Standard", description: "Follows grants." },
  { id: "relaxed", label: "Relaxed", description: "Own notes without asking." },
];

function formFor(currentMode: string, isArchived = false) {
  return (
    <AgentModeForm
      workspaceId={WORKSPACE}
      agentId={AGENT_ID}
      currentMode={currentMode}
      modes={MODES}
      isArchived={isArchived}
    />
  );
}

function setup(currentMode: string, isArchived = false) {
  return render(formFor(currentMode, isArchived));
}

async function submitWith(result: unknown) {
  action.setAgentModeAction.mockResolvedValueOnce(result);
  await act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Change mode" }));
    return Promise.resolve();
  });
}

beforeEach(() => {
  action.setAgentModeAction.mockReset();
});

describe("AgentModeForm", () => {
  it("shows the current mode and starts on it", () => {
    setup("strict");
    expect(screen.getByTestId("agent-mode")).toHaveTextContent("Current mode: Strict");
    expect(screen.getByLabelText("New mode")).toHaveValue("strict");
  });

  it("offers every mode and says Tier 3 and 4 always need approval", () => {
    setup("strict");
    const select = screen.getByLabelText("New mode");
    expect(within(select).getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText(/Tier 3 and 4 always need your approval/)).toBeInTheDocument();
  });

  it("has an unticked confirm box and sends only the ids it needs as hidden fields", () => {
    setup("standard");
    const form = screen.getByRole("form", { name: "Change mode" });
    expect(within(form).getByLabelText(/I reviewed this agent/)).not.toBeChecked();
    const hidden = Array.from(form.querySelectorAll<HTMLInputElement>("input[type=hidden]")).map(
      (input) => [input.name, input.value],
    );
    expect(hidden).toEqual([
      ["workspaceId", WORKSPACE],
      ["agentId", AGENT_ID],
    ]);
    expect(within(form).getByRole("button", { name: "Change mode" })).toBeEnabled();
  });

  it("shows no form for an archived agent", () => {
    setup("strict", true);
    expect(screen.queryByRole("form", { name: "Change mode" })).not.toBeInTheDocument();
    expect(screen.getByText(/Unarchive it to change its mode/)).toBeInTheDocument();
  });

  it("shows the saved mode in the dropdown after a change (UX 1)", async () => {
    const view = setup("strict");
    fireEvent.change(screen.getByLabelText("New mode"), { target: { value: "relaxed" } });
    await submitWith({ done: true });
    // The action revalidates the page, so the new mode arrives as the prop.
    view.rerender(formFor("relaxed"));
    await waitFor(() => {
      expect(screen.getByLabelText("New mode")).toHaveValue("relaxed");
    });
    expect(screen.getByTestId("agent-mode")).toHaveTextContent("Current mode: Relaxed");
    expect(screen.getByRole("status")).toHaveTextContent("Mode changed");
  });

  it("keeps the owner's choice when a submit is refused (UX 1)", async () => {
    setup("strict");
    fireEvent.change(screen.getByLabelText("New mode"), { target: { value: "standard" } });
    await submitWith({
      fieldErrors: {
        confirm: "Confirm that you reviewed this agent's work and want to change its mode.",
      },
      mode: "standard",
    });
    await waitFor(() => {
      expect(screen.getByLabelText("New mode")).toHaveValue("standard");
    });
    expect(screen.getByTestId("agent-mode")).toHaveTextContent("Current mode: Strict");
  });

  it("drops the confirm error as soon as the box is ticked (UX 3)", async () => {
    setup("strict");
    await submitWith({
      fieldErrors: { confirm: "Confirm that you reviewed this agent's work." },
      mode: "strict",
    });
    expect(
      await screen.findByText("Confirm that you reviewed this agent's work."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I reviewed this agent/));
    expect(
      screen.queryByText("Confirm that you reviewed this agent's work."),
    ).not.toBeInTheDocument();
  });

  it("does not point to runs the owner cannot reach (UX 2)", () => {
    setup("strict");
    expect(screen.queryByText(/runs/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/I reviewed this agent's work/)).toBeInTheDocument();
  });

  it("falls back to Strict in the label for an unknown stored mode", () => {
    setup("permissive");
    expect(screen.getByTestId("agent-mode")).toHaveTextContent("Current mode: Strict");
  });
});
