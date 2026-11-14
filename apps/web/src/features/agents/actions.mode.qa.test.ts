import { beforeEach, describe, expect, it, vi } from "vitest";

// AGO-99 functional QA: cases actions.mode.test.ts does not cover. Same harness: the real requireHumanRequest and
// the real setAgentModeAction run; only the request headers, the revalidate call and the database editor are replaced.
const requestHeaders = vi.hoisted(() => ({ authorization: null as string | null }));
const modeEditor = vi.hoisted(() => ({ setAgentMode: vi.fn() }));
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
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("../../lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }
  return { WorkspaceAccessError, requireWorkspaceRole: vi.fn() };
});
vi.mock("./agent-library", () => ({ agentCreator: {} }));
vi.mock("./agent-editor", () => ({ agentEditor: {} }));
vi.mock("./agent-mode-editor", () => ({ agentModeEditor: modeEditor }));

import { AGENT_MODE_MESSAGES, AGENT_MODES } from "@ago/shared";
import { GENERIC_ERROR } from "./create-agent";
import { ARCHIVED_ERROR, NOT_FOUND_ERROR, OWNER_ONLY_EDIT_ERROR } from "./edit-agent";
import {
  AGENT_CREDENTIAL_MODE_ERROR,
  AgentModeError,
  setAgentModeWith,
  type AgentModeErrorCode,
} from "./promote-agent";
import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { setAgentModeAction } from "./actions";

const IDS = {
  workspaceId: "99000000-0000-4000-8000-0000000000a1",
  agentId: "99000000-0000-4000-8000-0000000000b1",
};
const AGENT_TOKEN = "Bearer ago_agt_" + "0123456789abcdef".repeat(2);

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  requestHeaders.authorization = null;
  modeEditor.setAgentMode.mockReset();
  revalidate.mockReset();
});

describe("AC2: promotion is human-only (action level)", () => {
  it.each([
    ["a lower-case bearer scheme", AGENT_TOKEN.replace("Bearer", "bearer")],
    ["an upper-case bearer scheme", AGENT_TOKEN.replace("Bearer", "BEARER")],
  ])("refuses an agent credential sent with %s", async (_label, header) => {
    requestHeaders.authorization = header;
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "relaxed", confirm: "on" }));
    expect(result).toEqual({ error: AGENT_CREDENTIAL_MODE_ERROR });
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refuses an agent credential that targets its own agent, even with every field valid", async () => {
    // The agent id in the form is the agent that owns the token: a self-promotion attempt.
    requestHeaders.authorization = AGENT_TOKEN;
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(result).toEqual({ error: AGENT_CREDENTIAL_MODE_ERROR });
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("does not leak input validation detail to an agent credential (no field errors)", async () => {
    requestHeaders.authorization = AGENT_TOKEN;
    const result = await setAgentModeAction({}, form({ mode: "permissive" }));
    expect(result).toEqual({ error: AGENT_CREDENTIAL_MODE_ERROR });
    expect(result.fieldErrors).toBeUndefined();
  });

  it("lets a request through that carries a non-agent bearer token (a person's session token)", async () => {
    requestHeaders.authorization = "Bearer eyJhbGciOiJIUzI1NiJ9.person.signature";
    modeEditor.setAgentMode.mockResolvedValue(undefined);
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(result).toEqual({ done: true });
  });
});

describe("AC2: input is validated before the one write", () => {
  it.each(AGENT_MODES)("accepts %s as a target mode", async (mode) => {
    modeEditor.setAgentMode.mockResolvedValue(undefined);
    const result = await setAgentModeAction({}, form({ ...IDS, mode, confirm: "on" }));
    expect(result).toEqual({ done: true });
    expect(modeEditor.setAgentMode).toHaveBeenCalledWith({ ...IDS, mode, confirm: "on" });
  });

  it.each([
    ["a capitalised mode", "Standard"],
    ["a mode with a trailing space", "standard "],
    ["an injection string", "standard'; drop table agents; --"],
  ])("refuses %s as an unknown mode and writes nothing", async (_label, mode) => {
    const result = await setAgentModeAction({}, form({ ...IDS, mode, confirm: "on" }));
    expect(result.fieldErrors?.mode).toBe(AGENT_MODE_MESSAGES.modeUnknown);
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("asks for a mode when none is sent", async () => {
    const result = await setAgentModeAction({}, form({ ...IDS, confirm: "on" }));
    expect(result.fieldErrors?.mode).toBe(AGENT_MODE_MESSAGES.modeRequired);
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it.each([["true"], ["off"], [""]])(
    "does not accept confirm=%j as a ticked box",
    async (confirm) => {
      const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm }));
      expect(result.fieldErrors?.confirm).toBe(AGENT_MODE_MESSAGES.confirmRequired);
      expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
    },
  );

  it("reports a bad mode and a missing confirm together", async () => {
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "permissive" }));
    expect(result.fieldErrors?.mode).toBeTruthy();
    expect(result.fieldErrors?.confirm).toBeTruthy();
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("returns the generic error, not a field error, when an id is not a UUID", async () => {
    const result = await setAgentModeAction(
      {},
      form({
        workspaceId: IDS.workspaceId,
        agentId: "not-a-uuid",
        mode: "standard",
        confirm: "on",
      }),
    );
    expect(result).toEqual({ error: GENERIC_ERROR });
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("refuses an empty form without calling the editor", async () => {
    const result = await setAgentModeAction({}, form({}));
    expect(result.done).toBeUndefined();
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("refuses a forged actor or timestamp field, however it is named", async () => {
    const extras: Record<string, string>[] = [
      { changed_by: "m1" },
      { createdAt: "2020-01-01T00:00:00Z" },
      { fromMode: "strict" },
    ];
    for (const extra of extras) {
      const result = await setAgentModeAction(
        {},
        form({ ...IDS, mode: "standard", confirm: "on", ...extra }),
      );
      expect(result).toEqual({ error: GENERIC_ERROR });
    }
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });
});

describe("AC2: every refusal reaches the person as a safe message and leaves pages unrevalidated", () => {
  const cases: [AgentModeErrorCode, Awaited<ReturnType<typeof setAgentModeAction>>][] = [
    ["not_found", { error: NOT_FOUND_ERROR }],
    ["archived", { error: ARCHIVED_ERROR }],
    ["invalid", { fieldErrors: { mode: AGENT_MODE_MESSAGES.modeUnknown } }],
    ["failed", { error: GENERIC_ERROR }],
  ];

  it.each(cases)("maps a %s database refusal for the form", async (code, expected) => {
    modeEditor.setAgentMode.mockRejectedValueOnce(new AgentModeError(code));
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(result).toEqual(expected);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("tells a signed-out caller to sign in again instead of saying they are not an owner", async () => {
    modeEditor.setAgentMode.mockRejectedValueOnce(new WorkspaceAccessError("unauthenticated"));
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(result).toEqual({ error: "Your session has expired. Please sign in again." });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("gives a member or viewer (not an owner) the owner-only message", async () => {
    modeEditor.setAgentMode.mockRejectedValueOnce(new WorkspaceAccessError("forbidden"));
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(result).toEqual({ error: OWNER_ONLY_EDIT_ERROR });
  });

  it("calls the editor exactly once per submit, so one submit is at most one log row", async () => {
    modeEditor.setAgentMode.mockResolvedValue(undefined);
    await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(modeEditor.setAgentMode).toHaveBeenCalledTimes(1);
  });

  it("never throws out of the action for a non-Error rejection", async () => {
    modeEditor.setAgentMode.mockRejectedValueOnce("boom");
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(result).toEqual({ error: GENERIC_ERROR });
  });
});

describe("setAgentModeWith (pure mapping, no request)", () => {
  it("reports done only when the editor resolves", async () => {
    modeEditor.setAgentMode.mockResolvedValue(undefined);
    expect(await setAgentModeWith(modeEditor, { ...IDS, mode: "relaxed", confirm: "on" })).toEqual({
      done: true,
    });
  });

  it("does not report done when the editor rejects", async () => {
    modeEditor.setAgentMode.mockRejectedValue(new AgentModeError("forbidden"));
    const result = await setAgentModeWith(modeEditor, { ...IDS, mode: "relaxed", confirm: "on" });
    expect(result.done).toBeUndefined();
  });
});
