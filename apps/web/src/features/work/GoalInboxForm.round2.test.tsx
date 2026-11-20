import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOAL_MESSAGES, GOAL_TEXT_MAX_LENGTH } from "@ago/shared";

const action = vi.hoisted(() => ({ submitGoalAction: vi.fn() }));
vi.mock("./actions", () => action);

import { GoalInboxForm } from "./GoalInboxForm";

const WORKSPACE_ID = "11300000-0000-4000-8000-0000000000a1";
const MAX = String(GOAL_TEXT_MAX_LENGTH);
// Invisible characters are created at runtime, never typed literally.
const INVISIBLE = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e];

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value } });
}

async function submit() {
  await act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Submit goal" }));
    return Promise.resolve();
  });
}

beforeEach(() => {
  action.submitGoalAction.mockReset();
  render(<GoalInboxForm workspaceId={WORKSPACE_ID} />);
});

describe("AGO-113 AC2: character counter (round 2)", () => {
  it("shows 0 on first render", () => {
    expect(screen.getByText(`0/${MAX}`)).toBeInTheDocument();
  });

  it.each(INVISIBLE)("shows 0 when the text is only code point %i", (codePoint) => {
    type(String.fromCodePoint(codePoint));
    expect(screen.getByText(`0/${MAX}`)).toBeInTheDocument();
  });

  it("shows 0 for every invisible code point together", () => {
    type(String.fromCodePoint(...INVISIBLE));
    expect(screen.getByText(`0/${MAX}`)).toBeInTheDocument();
  });

  it("counts only the visible characters when invisible ones are mixed in", () => {
    const z = String.fromCodePoint(...INVISIBLE);
    type(`${z}ab${z}cd${z}`);
    expect(screen.getByText(`4/${MAX}`)).toBeInTheDocument();
  });

  it("counts an astral character as two units, the same unit the form limit uses", () => {
    type(String.fromCodePoint(0x1f600));
    expect(screen.getByText(`2/${MAX}`)).toBeInTheDocument();
  });

  it("refuses zero-width-only text on submit even though the box is not empty", async () => {
    type(String.fromCodePoint(...INVISIBLE));
    await submit();
    expect(screen.getByTestId("goal-field-error")).toHaveTextContent(GOAL_MESSAGES.required);
    expect(action.submitGoalAction).not.toHaveBeenCalled();
  });
});

describe("AGO-113 no-Manager link (round 2)", () => {
  it("does not show the link before anything is submitted", () => {
    expect(screen.queryByTestId("goal-create-manager-link")).not.toBeInTheDocument();
  });

  it.each([
    ["forbidden", GOAL_MESSAGES.forbidden],
    ["agent credential", GOAL_MESSAGES.agentCredential],
    ["session expired", GOAL_MESSAGES.sessionExpired],
    ["generic", GOAL_MESSAGES.generic],
  ])("shows no create-Manager link for the %s error", async (_name, message) => {
    action.submitGoalAction.mockResolvedValueOnce({ error: message });
    type("Grow signups");
    await submit();
    expect(await screen.findByTestId("goal-form-error")).toHaveTextContent(message);
    expect(screen.queryByTestId("goal-create-manager-link")).not.toBeInTheDocument();
  });

  it("shows no link for a field error", async () => {
    action.submitGoalAction.mockResolvedValueOnce({ fieldError: GOAL_MESSAGES.tooLong });
    type("Grow signups");
    await submit();
    expect(await screen.findByTestId("goal-field-error")).toHaveTextContent(GOAL_MESSAGES.tooLong);
    expect(screen.queryByTestId("goal-create-manager-link")).not.toBeInTheDocument();
  });

  it("shows exactly one working link to agent creation for the no-Manager message", async () => {
    action.submitGoalAction.mockResolvedValueOnce({ error: GOAL_MESSAGES.noManager });
    type("Grow signups");
    await submit();
    const links = await screen.findAllByTestId("goal-create-manager-link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/app/agents/new");
    expect(screen.getByRole("link", { name: "Create a Manager agent" })).toBe(links[0]);
  });

  it("removes the link when a later submit succeeds", async () => {
    action.submitGoalAction.mockResolvedValueOnce({ error: GOAL_MESSAGES.noManager });
    type("Grow signups");
    await submit();
    expect(await screen.findByTestId("goal-create-manager-link")).toBeInTheDocument();
    type("Grow signups");
    action.submitGoalAction.mockResolvedValueOnce({ submittedId: "goal-1" });
    await submit();
    expect(await screen.findByTestId("goal-submitted")).toBeInTheDocument();
    expect(screen.queryByTestId("goal-create-manager-link")).not.toBeInTheDocument();
  });
});

describe("AGO-113 placeholder style (round 2)", () => {
  it("styles the placeholder with the muted-foreground token and no hard-coded colour", () => {
    const cls = screen.getByLabelText("Goal").className;
    expect(cls).toContain("placeholder:text-muted-foreground");
    expect(cls).not.toMatch(/placeholder:text-(gray|slate|zinc|neutral|stone)-/);
  });
});
