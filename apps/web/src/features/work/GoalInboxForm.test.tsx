import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOAL_MESSAGES, GOAL_TEXT_MAX_LENGTH } from "@ago/shared";

const action = vi.hoisted(() => ({ submitGoalAction: vi.fn() }));
vi.mock("./actions", () => action);

import { GoalInboxForm } from "./GoalInboxForm";

const WORKSPACE_ID = "11300000-0000-4000-8000-0000000000a1";

function setup() {
  return render(<GoalInboxForm workspaceId={WORKSPACE_ID} />);
}

async function submit() {
  await act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Submit goal" }));
    return Promise.resolve();
  });
}

beforeEach(() => {
  action.submitGoalAction.mockReset();
});

describe("GoalInboxForm", () => {
  it("has a labelled goal box and a submit button", () => {
    setup();
    expect(screen.getByLabelText("Goal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit goal" })).toBeEnabled();
  });

  it.each([
    ["nothing", ""],
    ["spaces", "    "],
    ["zero-width characters only", "​‍﻿"],
  ])("rejects %s inline and sends no request", async (_name, text) => {
    setup();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: text } });
    await submit();
    expect(screen.getByTestId("goal-field-error")).toHaveTextContent(GOAL_MESSAGES.required);
    expect(screen.getByLabelText("Goal")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Goal")).toHaveAccessibleDescription(GOAL_MESSAGES.required);
    expect(action.submitGoalAction).not.toHaveBeenCalled();
  });

  it("clears the inline error as soon as the person types", async () => {
    setup();
    await submit();
    expect(screen.getByTestId("goal-field-error")).toHaveTextContent(GOAL_MESSAGES.required);
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Grow signups" } });
    expect(screen.getByTestId("goal-field-error")).toBeEmptyDOMElement();
  });

  it("sends the workspace and the text, then clears the box and confirms", async () => {
    action.submitGoalAction.mockResolvedValueOnce({ submittedId: "goal-1" });
    setup();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Grow signups" } });
    await submit();
    expect(action.submitGoalAction).toHaveBeenCalledTimes(1);
    const sent = action.submitGoalAction.mock.calls[0]?.[1] as FormData;
    expect(sent.get("workspaceId")).toBe(WORKSPACE_ID);
    expect(sent.get("text")).toBe("Grow signups");
    expect(await screen.findByTestId("goal-submitted")).toBeInTheDocument();
    expect(screen.getByLabelText("Goal")).toHaveValue("");
  });

  it("shows the no-Manager message and keeps the text", async () => {
    action.submitGoalAction.mockResolvedValueOnce({ error: GOAL_MESSAGES.noManager });
    setup();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Grow signups" } });
    await submit();
    expect(await screen.findByTestId("goal-form-error")).toHaveTextContent(GOAL_MESSAGES.noManager);
    expect(screen.getByLabelText("Goal")).toHaveValue("Grow signups");
    expect(screen.queryByTestId("goal-submitted")).not.toBeInTheDocument();
  });

  it("links the no-Manager message to agent creation, and only that message", async () => {
    action.submitGoalAction.mockResolvedValueOnce({ error: GOAL_MESSAGES.noManager });
    setup();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Grow signups" } });
    await submit();
    const link = await screen.findByTestId("goal-create-manager-link");
    expect(link).toHaveAttribute("href", "/app/agents/new");

    action.submitGoalAction.mockResolvedValueOnce({ error: GOAL_MESSAGES.generic });
    await submit();
    expect(await screen.findByText(GOAL_MESSAGES.generic)).toBeInTheDocument();
    expect(screen.queryByTestId("goal-create-manager-link")).not.toBeInTheDocument();
  });

  it("counts visible characters only: zero-width text shows 0", () => {
    setup();
    const zeroWidth = String.fromCodePoint(0x200b, 0x200d, 0xfeff);
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: zeroWidth } });
    expect(screen.getByText(`0/${String(GOAL_TEXT_MAX_LENGTH)}`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: `ab${zeroWidth}c` } });
    expect(screen.getByText(`3/${String(GOAL_TEXT_MAX_LENGTH)}`)).toBeInTheDocument();
  });

  it("uses the muted-foreground token for the placeholder", () => {
    setup();
    expect(screen.getByLabelText("Goal").className).toContain("placeholder:text-muted-foreground");
  });

  it("shows a server-side field error under the box", async () => {
    action.submitGoalAction.mockResolvedValueOnce({ fieldError: GOAL_MESSAGES.tooLong });
    setup();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Grow signups" } });
    await submit();
    expect(await screen.findByTestId("goal-field-error")).toHaveTextContent(GOAL_MESSAGES.tooLong);
  });
});
