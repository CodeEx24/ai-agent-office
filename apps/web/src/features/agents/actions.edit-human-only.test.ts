import { beforeEach, describe, expect, it, vi } from "vitest";

// AGO-89 AC (owner decision): an agent credential is rejected on update, duplicate, archive and unarchive.
// The real requireHumanRequest runs; only the request headers and the database editor are replaced.
const requestHeaders = vi.hoisted(() => ({ authorization: null as string | null }));
const editor = vi.hoisted(() => ({
  updateAgent: vi.fn(),
  duplicateAgent: vi.fn(),
  archiveAgent: vi.fn(),
  unarchiveAgent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? requestHeaders.authorization : null,
    }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("../../lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("../workspaces/workspace-access", () => ({ requireWorkspaceRole: vi.fn() }));
vi.mock("./agent-library", () => ({ agentCreator: {} }));
vi.mock("./agent-editor", () => ({ agentEditor: editor }));

import { AGENT_CREDENTIAL_EDIT_ERROR } from "./edit-agent";
import {
  archiveAgentAction,
  duplicateAgentAction,
  unarchiveAgentAction,
  updateAgentAction,
} from "./actions";

const IDS = {
  workspaceId: "89000000-0000-4000-8000-0000000000a1",
  agentId: "89000000-0000-4000-8000-0000000000b1",
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const actions = [
  [
    "updateAgentAction",
    updateAgentAction,
    {
      ...IDS,
      expectedVersion: "1",
      name: "Scout",
      role: "R",
      model: "claude-haiku-5-5",
      thinkingEffort: "low",
      prompt: "p",
      dailyBudget: "1.00",
    },
  ],
  ["duplicateAgentAction", duplicateAgentAction, { ...IDS, name: "Copy" }],
  ["archiveAgentAction", archiveAgentAction, { ...IDS }],
  ["unarchiveAgentAction", unarchiveAgentAction, { ...IDS }],
] as const;

describe("AGO-89 owner actions are human only", () => {
  beforeEach(() => {
    requestHeaders.authorization = null;
    for (const fn of Object.values(editor)) fn.mockReset();
  });

  it.each(actions)(
    "%s refuses a request carrying an agent credential and writes nothing",
    async (_n, action, fields) => {
      requestHeaders.authorization = "Bearer ago_agt_0123456789abcdef0123456789abcdef";
      const result = await action({}, form(fields));
      expect(result).toEqual({ error: AGENT_CREDENTIAL_EDIT_ERROR });
      for (const fn of Object.values(editor)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(actions)("%s reaches the editor for a human request", async (_n, action, fields) => {
    editor.updateAgent.mockResolvedValue({ version: 2 });
    editor.duplicateAgent.mockResolvedValue({ id: "copy-1" });
    editor.archiveAgent.mockResolvedValue(undefined);
    editor.unarchiveAgent.mockResolvedValue(undefined);
    await action({}, form(fields)).catch(() => undefined); // duplicate redirects
    expect(Object.values(editor).some((fn) => fn.mock.calls.length === 1)).toBe(true);
  });
});
