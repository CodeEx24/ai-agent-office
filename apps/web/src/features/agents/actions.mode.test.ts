import { beforeEach, describe, expect, it, vi } from "vitest";

// AGO-99 AC "Promotion is logged and human-only": an agent credential cannot change a mode (its own included),
// a person must tick the confirm box, and the single write goes through the editor (one database call that also
// appends the log row). The real requireHumanRequest runs; only the headers and the database editor are replaced.
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

import { GENERIC_ERROR } from "./create-agent";
import { AGENT_CREDENTIAL_MODE_ERROR, AgentModeError, MODE_UNCHANGED_ERROR } from "./promote-agent";
import { OWNER_ONLY_EDIT_ERROR } from "./edit-agent";
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

describe("AGO-99 setAgentModeAction", () => {
  beforeEach(() => {
    requestHeaders.authorization = null;
    modeEditor.setAgentMode.mockReset();
    revalidate.mockReset();
  });

  it("refuses a request carrying an agent credential and writes nothing", async () => {
    requestHeaders.authorization = AGENT_TOKEN;
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "relaxed", confirm: "on" }));
    expect(result).toEqual({ error: AGENT_CREDENTIAL_MODE_ERROR });
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refuses an agent credential before it even reads the input", async () => {
    requestHeaders.authorization = AGENT_TOKEN;
    const result = await setAgentModeAction({}, form({ junk: "x" }));
    expect(result).toEqual({ error: AGENT_CREDENTIAL_MODE_ERROR });
  });

  it("changes the mode for a person and revalidates the agent pages", async () => {
    modeEditor.setAgentMode.mockResolvedValue(undefined);
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard", confirm: "on" }));
    expect(result).toEqual({ done: true });
    expect(modeEditor.setAgentMode).toHaveBeenCalledTimes(1);
    expect(modeEditor.setAgentMode).toHaveBeenCalledWith({
      ...IDS,
      mode: "standard",
      confirm: "on",
    });
    expect(revalidate).toHaveBeenCalledWith(`/app/agents/${IDS.agentId}`);
  });

  it("needs the confirm box: without it nothing is written", async () => {
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "standard" }));
    expect(result.fieldErrors?.confirm).toBeTruthy();
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("refuses a mode off the list", async () => {
    const result = await setAgentModeAction(
      {},
      form({ ...IDS, mode: "permissive", confirm: "on" }),
    );
    expect(result.fieldErrors?.mode).toBeTruthy();
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("refuses fields a caller must not choose, such as who changed it", async () => {
    const result = await setAgentModeAction(
      {},
      form({ ...IDS, mode: "standard", confirm: "on", changedBy: "someone-else" }),
    );
    expect(result).toEqual({ error: GENERIC_ERROR });
    expect(modeEditor.setAgentMode).not.toHaveBeenCalled();
  });

  it("maps an owner-only refusal and an unchanged mode to safe messages", async () => {
    modeEditor.setAgentMode.mockRejectedValueOnce(new AgentModeError("forbidden"));
    expect(await setAgentModeAction({}, form({ ...IDS, mode: "relaxed", confirm: "on" }))).toEqual({
      error: OWNER_ONLY_EDIT_ERROR,
    });

    modeEditor.setAgentMode.mockRejectedValueOnce(new AgentModeError("unchanged"));
    expect(await setAgentModeAction({}, form({ ...IDS, mode: "strict", confirm: "on" }))).toEqual({
      error: MODE_UNCHANGED_ERROR,
    });

    modeEditor.setAgentMode.mockRejectedValueOnce(new WorkspaceAccessError("forbidden"));
    expect(await setAgentModeAction({}, form({ ...IDS, mode: "relaxed", confirm: "on" }))).toEqual({
      error: OWNER_ONLY_EDIT_ERROR,
    });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("never shows database text for an unexpected failure", async () => {
    modeEditor.setAgentMode.mockRejectedValueOnce(new Error("relation agent_mode_changes missing"));
    const result = await setAgentModeAction({}, form({ ...IDS, mode: "relaxed", confirm: "on" }));
    expect(result).toEqual({ error: GENERIC_ERROR });
  });
});
