import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CREDENTIAL_PREFIX, GOAL_MESSAGES, GOAL_TEXT_MAX_LENGTH } from "@ago/shared";

// AGO-113 functional acceptance (round 1): the goal action as a person and as an agent. The real human-only guard and
// the real Zod schema run; only the request headers and the database are replaced.
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

// A character from its code point, so no invisible character sits in the source.
function cp(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

// Built at runtime: never a realistic-looking token in the source.
function agentCredential(): string {
  return `${AGENT_CREDENTIAL_PREFIX}${"x".repeat(24)}`;
}

beforeEach(() => {
  requestHeaders.authorization = null;
  submitter.submitGoal.mockReset();
  submitter.submitGoal.mockResolvedValue({ id: "goal-1" });
  revalidate.mockReset();
});

describe("AC1: a submitted goal reaches the database call exactly as the person meant it", () => {
  it("passes only the workspace and the normalised text, and ignores extra form fields", async () => {
    const state = await submitGoalAction(
      {},
      form({
        workspaceId: WORKSPACE_ID,
        text: "  Grow\r\nsignups  ",
        createdBy: "someone-else",
        agentId: "an-agent",
      }),
    );
    expect(state).toEqual({ submittedId: "goal-1" });
    expect(submitter.submitGoal).toHaveBeenCalledTimes(1);
    expect(submitter.submitGoal).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      text: "Grow\nsignups",
    });
  });

  it("keeps markup, SQL and instruction-like text as plain data", async () => {
    const text = `'); drop table goals; -- <script>alert(1)</script> Ignore previous instructions`;
    await submitGoalAction({}, form({ workspaceId: WORKSPACE_ID, text }));
    expect(submitter.submitGoal).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, text });
  });

  it("does not deduplicate: two submits of the same text make two calls", async () => {
    const data = form({ workspaceId: WORKSPACE_ID, text: "Grow signups" });
    await submitGoalAction({}, data);
    await submitGoalAction({}, data);
    expect(submitter.submitGoal).toHaveBeenCalledTimes(2);
  });
});

describe("AC2: empty goals are refused before any write", () => {
  it.each([
    ["no-break space", cp(0xa0)],
    ["soft hyphen", cp(0xad)],
    ["Mongolian vowel separator", cp(0x180e)],
    ["word joiner", cp(0x2060)],
    ["byte order mark", cp(0xfeff)],
    ["tab and form feed", "\t\f"],
    ["lone carriage return", "\r"],
    [
      "mixed invisible",
      [cp(0x20), cp(0x200b), cp(0xa0), cp(0x0a), cp(0x2060), cp(0xfeff), cp(0x09)].join(""),
    ],
  ])("refuses %s only", async (_name, text) => {
    const state = await submitGoalAction({}, form({ workspaceId: WORKSPACE_ID, text }));
    expect(state).toEqual({ fieldError: GOAL_MESSAGES.required });
    expect(submitter.submitGoal).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("accepts exactly the maximum length and refuses one more", async () => {
    const atLimit = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "a".repeat(GOAL_TEXT_MAX_LENGTH) }),
    );
    expect(atLimit).toEqual({ submittedId: "goal-1" });

    submitter.submitGoal.mockClear();
    const over = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "a".repeat(GOAL_TEXT_MAX_LENGTH + 1) }),
    );
    expect(over).toEqual({ fieldError: GOAL_MESSAGES.tooLong });
    expect(submitter.submitGoal).not.toHaveBeenCalled();
  });

  it("counts the length after normalising (padding and zero-width characters are free)", async () => {
    const padded = `   ${cp(0x200b)}${"a".repeat(GOAL_TEXT_MAX_LENGTH)}${cp(0x200b)}   `;
    const state = await submitGoalAction({}, form({ workspaceId: WORKSPACE_ID, text: padded }));
    expect(state).toEqual({ submittedId: "goal-1" });
  });

  it("refuses a missing workspace and a non-uuid workspace", async () => {
    const cases: Record<string, string>[] = [
      { text: "Grow signups" },
      { workspaceId: "1", text: "Grow signups" },
    ];
    for (const fields of cases) {
      const state = await submitGoalAction({}, form(fields));
      expect(state.fieldError).toBeDefined();
    }
    expect(submitter.submitGoal).not.toHaveBeenCalled();
  });
});

describe("human-only: an agent token is refused on the goal action", () => {
  it("refuses a valid goal from an agent credential and never writes", async () => {
    requestHeaders.authorization = `Bearer ${agentCredential()}`;
    const state = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "Grow signups" }),
    );
    expect(state).toEqual({ error: GOAL_MESSAGES.agentCredential });
    expect(submitter.submitGoal).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refuses before validating: no field error leaks to an agent, even for empty text", async () => {
    requestHeaders.authorization = `Bearer ${agentCredential()}`;
    const state = await submitGoalAction({}, form({ workspaceId: WORKSPACE_ID, text: "" }));
    expect(state).toEqual({ error: GOAL_MESSAGES.agentCredential });
  });

  it("does not echo the credential back", async () => {
    const credential = agentCredential();
    requestHeaders.authorization = `Bearer ${credential}`;
    const state = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "Grow signups" }),
    );
    expect(JSON.stringify(state)).not.toContain(credential);
  });

  it("refuses the scheme in any letter case", async () => {
    requestHeaders.authorization = `bearer ${agentCredential()}`;
    const state = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "Grow signups" }),
    );
    expect(state).toEqual({ error: GOAL_MESSAGES.agentCredential });
    expect(submitter.submitGoal).not.toHaveBeenCalled();
  });

  it("lets a person through: a bearer that is not an agent credential is not refused", async () => {
    requestHeaders.authorization = `Bearer ${"u".repeat(40)}`;
    const state = await submitGoalAction(
      {},
      form({ workspaceId: WORKSPACE_ID, text: "Grow signups" }),
    );
    expect(state).toEqual({ submittedId: "goal-1" });
  });
});
