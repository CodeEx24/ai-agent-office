// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** AGO-154 tester-functional r1: AC2, agent credentials are rejected on every human-only skill route. */
const state = vi.hoisted(() => ({ requestHeaders: new Headers() }));
const library = vi.hoisted(() => ({
  createSkill: vi.fn(),
  saveSkill: vi.fn(),
  assignSkill: vi.fn(),
  unassignSkill: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(state.requestHeaders) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../workspaces/workspace-access", () => {
  class WorkspaceAccessError extends Error {}
  return { WorkspaceAccessError };
});
vi.mock("./skill-library", () => {
  class SkillLibraryError extends Error {}
  return { SkillLibraryError, ...library };
});

import { isAgentCredentialRequest } from "../../lib/auth/human-only";
import { proxy } from "../../proxy";
import {
  assignSkillAction,
  createSkillAction,
  saveSkillAction,
  unassignSkillAction,
} from "./actions";

const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const SKILL = "00000000-0000-4000-8000-0000000000d1";
const AGENT = "00000000-0000-4000-8000-0000000000b1";
// Built at runtime so no realistic-looking credential sits in the source.
const AGENT_TOKEN = "ago_agt_" + ["header", "payload", "signature"].join(".");
const HUMAN_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c2VyIn0", "c2ln"].join(".");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const forms = {
  create: () => form({ workspaceId: WORKSPACE, name: "Write", description: "", body: "text" }),
  save: () =>
    form({
      workspaceId: WORKSPACE,
      skillId: SKILL,
      expectedVersion: "1",
      description: "",
      body: "text",
    }),
  assign: () => form({ workspaceId: WORKSPACE, skillId: SKILL, agentId: AGENT }),
};
const actions = [
  ["createSkillAction", (f: FormData) => createSkillAction({}, f), forms.create],
  ["saveSkillAction", (f: FormData) => saveSkillAction({}, f), forms.save],
  ["assignSkillAction", (f: FormData) => assignSkillAction({}, f), forms.assign],
  ["unassignSkillAction", (f: FormData) => unassignSkillAction({}, f), forms.assign],
] as const;

const libraryCalls = () => Object.values(library).reduce((n, fn) => n + fn.mock.calls.length, 0);

beforeEach(() => {
  state.requestHeaders = new Headers();
  for (const fn of Object.values(library)) fn.mockReset();
  library.createSkill.mockResolvedValue({ id: SKILL });
  library.saveSkill.mockResolvedValue({ version: 2 });
  library.assignSkill.mockResolvedValue(undefined);
  library.unassignSkill.mockResolvedValue(undefined);
});

describe("AC2: every human-only skill action rejects agent identities", () => {
  const spellings: [string, Record<string, string>][] = [
    ["Bearer", { authorization: `Bearer ${AGENT_TOKEN}` }],
    ["lowercase bearer", { authorization: `bearer ${AGENT_TOKEN}` }],
    ["upper BEARER", { authorization: `BEARER ${AGENT_TOKEN}` }],
    ["extra spaces", { authorization: `Bearer   ${AGENT_TOKEN}` }],
    ["with a human session cookie", { authorization: `Bearer ${AGENT_TOKEN}`, cookie: "sb=1" }],
  ];

  describe.each(actions)("%s", (_name, run, makeForm) => {
    it.each(spellings)("refuses an agent credential (%s) and writes nothing", async (_s, hdrs) => {
      state.requestHeaders = new Headers(hdrs);
      const result = await run(makeForm());
      expect(result.error).toContain("people only");
      expect(libraryCalls()).toBe(0);
    });

    it("refuses before validating: an agent gets no field-level hints", async () => {
      state.requestHeaders = new Headers({ authorization: `Bearer ${AGENT_TOKEN}` });
      const result = await run(form({ workspaceId: "not-a-uuid" }));
      expect(result.error).toContain("people only");
    });

    it("does not echo the credential back", async () => {
      state.requestHeaders = new Headers({ authorization: `Bearer ${AGENT_TOKEN}` });
      const result = await run(makeForm());
      expect(JSON.stringify(result)).not.toContain(AGENT_TOKEN);
    });
  });

  it("the proxy refuses an agent credential on the skill pages too", async () => {
    for (const path of ["/app/skills", `/app/skills/${SKILL}`]) {
      const response = await proxy(
        new NextRequest(`http://localhost${path}`, {
          headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        }),
      );
      expect(response.status, path).toBe(403);
      expect(await response.text()).not.toContain(AGENT_TOKEN);
    }
  });
});

describe("humans are still allowed", () => {
  it.each([
    ["no authorization header", {}],
    ["an ordinary (non-agent) bearer token", { authorization: `Bearer ${HUMAN_JWT}` }],
    ["a session cookie only", { cookie: "sb=1" }],
    ["a basic authorization header", { authorization: "Basic dXNlcjpwYXNz" }],
  ])("create, save, assign and unassign work with %s", async (_name, hdrs) => {
    state.requestHeaders = new Headers(hdrs);

    await createSkillAction({}, forms.create());
    expect(await saveSkillAction({}, forms.save())).toEqual({ savedVersion: 2 });
    expect(await assignSkillAction({}, forms.assign())).toEqual({});
    expect(await unassignSkillAction({}, forms.assign())).toEqual({});

    expect(library.createSkill).toHaveBeenCalledTimes(1);
    expect(library.saveSkill).toHaveBeenCalledTimes(1);
    expect(library.assignSkill).toHaveBeenCalledTimes(1);
    expect(library.unassignSkill).toHaveBeenCalledTimes(1);
  });

  it("a person's invalid input still gets the field message, not the agent message", async () => {
    const result = await saveSkillAction({}, form({ workspaceId: "nope" }));
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("people only");
  });

  it("isAgentCredentialRequest tells the two apart", async () => {
    expect(await isAgentCredentialRequest()).toBe(false);
    state.requestHeaders = new Headers({ authorization: `Bearer ${AGENT_TOKEN}` });
    expect(await isAgentCredentialRequest()).toBe(true);
    state.requestHeaders = new Headers({ authorization: `Bearer ${HUMAN_JWT}` });
    expect(await isAgentCredentialRequest()).toBe(false);
  });
});
