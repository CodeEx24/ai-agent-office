import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CREDENTIAL_PREFIX, GOAL_MESSAGES } from "@ago/shared";

// AGO-113: submitGoalAction is people only, validates before it writes, and revalidates the list on success.
// The real isAgentCredentialRequest and Zod schema run; only the request headers and the database are replaced.
const requestHeaders = vi.hoisted(() => ({ authorization: null as string | null }));
const submitter = vi.hoisted(() => ({ submitGoal: vi.fn() }));
const revalidate = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? requestHeaders.authorization : null,
    }),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
vi.mock("../../lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("../workspaces/workspace-access", () => ({
  WorkspaceAccessError: class extends Error {},
  requireWorkspaceRole: vi.fn(),
}));
vi.mock("./goal-inbox", () => ({
  GoalInboxError: class extends Error {},
  goalSubmitter: submitter,
}));

import { submitGoalAction } from "./actions";

const WORKSPACE_ID = "11300000-0000-4000-8000-0000000000a1";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  requestHeaders.authorization = null;
  submitter.submitGoal.mockReset();
  revalidate.mockReset();
});

describe("submitGoalAction", () => {
  it("records a goal for a person and refreshes the list", async () => {
    submitter.submitGoal.mockResolvedValueOnce({ id: "goal-1" });
    const state = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "  Grow signups  " }),
    );
    expect(state).toEqual({ submittedId: "goal-1" });
    expect(submitter.submitGoal).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      text: "Grow signups",
    });
    expect(revalidate).toHaveBeenCalledWith("/app/goals");
  });

  it.each([
    ["empty", ""],
    ["spaces", "    "],
    ["zero-width only", "​‌‍"],
    ["newlines", "\r\n\r\n"],
  ])("rejects %s text before any write", async (_name, text) => {
    const state = await submitGoalAction({}, form({ workspaceId: WORKSPACE_ID, text }));
    expect(state).toEqual({ fieldError: GOAL_MESSAGES.required });
    expect(submitter.submitGoal).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects a form with no text field", async () => {
    const state = await submitGoalAction({}, form({ workspaceId: WORKSPACE_ID }));
    expect(state.fieldError).toBe(GOAL_MESSAGES.required);
    expect(submitter.submitGoal).not.toHaveBeenCalled();
  });

  it("rejects a bad workspace id", async () => {
    const state = await submitGoalAction({}, form({ workspaceId: "nope", text: "x" }));
    expect(state.fieldError).toBeDefined();
    expect(submitter.submitGoal).not.toHaveBeenCalled();
  });

  it("refuses an agent credential before anything else", async () => {
    // Built at runtime: never a realistic-looking token in the source.
    requestHeaders.authorization = `Bearer ${AGENT_CREDENTIAL_PREFIX}${"x".repeat(24)}`;
    const state = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "Grow signups" }),
    );
    expect(state).toEqual({ error: GOAL_MESSAGES.agentCredential });
    expect(submitter.submitGoal).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("does not refresh the list when the goal was not recorded", async () => {
    submitter.submitGoal.mockRejectedValueOnce(new Error("db down"));
    const state = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "Grow signups" }),
    );
    expect(state).toEqual({ error: GOAL_MESSAGES.generic });
    expect(revalidate).not.toHaveBeenCalled();
  });
});
