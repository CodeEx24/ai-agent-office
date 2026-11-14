import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ setAgentModeAction: vi.fn() }));

import { AgentModeForm } from "./AgentModeForm";

const WORKSPACE = "99000000-0000-4000-8000-0000000000a1";
const AGENT_ID = "99000000-0000-4000-8000-0000000000b1";
const MODES = [
  { id: "strict", label: "Strict", description: "Every action waits." },
  { id: "standard", label: "Standard", description: "Follows grants." },
  { id: "relaxed", label: "Relaxed", description: "Own notes without asking." },
];

function setup(currentMode: string, isArchived = false) {
  return render(
    <AgentModeForm
      workspaceId={WORKSPACE}
      agentId={AGENT_ID}
      currentMode={currentMode}
      modes={MODES}
      isArchived={isArchived}
    />,
  );
}

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

  it("falls back to Strict in the label for an unknown stored mode", () => {
    setup("permissive");
    expect(screen.getByTestId("agent-mode")).toHaveTextContent("Current mode: Strict");
  });
});
