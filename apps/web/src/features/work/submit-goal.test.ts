import { describe, expect, it, vi } from "vitest";
import { GOAL_MESSAGES } from "@ago/shared";

vi.mock("server-only", () => ({}));
vi.mock("../../lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError, requireWorkspaceRole: vi.fn() };
});

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { GoalInboxError, type GoalSubmitter } from "./goal-inbox";
import { submitGoalWith } from "./submit-goal";

const INPUT = { workspaceId: "11300000-0000-4000-8000-0000000000a1", text: "Grow signups" };

function submitterThatThrows(error: unknown): GoalSubmitter {
  return { submitGoal: vi.fn().mockRejectedValue(error) };
}

describe("submitGoalWith", () => {
  it("returns the new goal id on success and passes the input through", async () => {
    const submitGoal = vi.fn().mockResolvedValue({ id: "goal-1" });
    const submitter: GoalSubmitter = { submitGoal };
    await expect(submitGoalWith(submitter, INPUT)).resolves.toEqual({ submittedId: "goal-1" });
    expect(submitGoal).toHaveBeenCalledWith(INPUT);
  });

  it("explains a workspace with no Manager and stores nothing", async () => {
    const state = await submitGoalWith(
      submitterThatThrows(new GoalInboxError("no_manager")),
      INPUT,
    );
    expect(state).toEqual({ error: GOAL_MESSAGES.noManager });
  });

  it("shows the empty message against the field when the database refuses the text", async () => {
    const state = await submitGoalWith(submitterThatThrows(new GoalInboxError("invalid")), INPUT);
    expect(state).toEqual({ fieldError: GOAL_MESSAGES.required });
  });

  it("maps a refused role and an expired session to their own messages", async () => {
    expect(
      await submitGoalWith(submitterThatThrows(new GoalInboxError("forbidden")), INPUT),
    ).toEqual({
      error: GOAL_MESSAGES.forbidden,
    });
    expect(
      await submitGoalWith(submitterThatThrows(new WorkspaceAccessError("forbidden")), INPUT),
    ).toEqual({ error: GOAL_MESSAGES.forbidden });
    expect(
      await submitGoalWith(submitterThatThrows(new WorkspaceAccessError("unauthenticated")), INPUT),
    ).toEqual({ error: GOAL_MESSAGES.sessionExpired });
  });

  it("does not leak an unknown error", async () => {
    const state = await submitGoalWith(
      submitterThatThrows(new Error("relation goals secret detail")),
      INPUT,
    );
    expect(state).toEqual({ error: GOAL_MESSAGES.generic });
  });
});
