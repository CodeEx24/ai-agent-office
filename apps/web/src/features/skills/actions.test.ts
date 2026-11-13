// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const validForms = {
  create: form({ workspaceId: WORKSPACE, name: "Write", description: "", body: "text" }),
  save: form({
    workspaceId: WORKSPACE,
    skillId: SKILL,
    expectedVersion: "1",
    description: "",
    body: "text",
  }),
  assign: form({ workspaceId: WORKSPACE, skillId: SKILL, agentId: AGENT }),
};

const actions = [
  ["createSkillAction", (f: FormData) => createSkillAction({}, f), "create"],
  ["saveSkillAction", (f: FormData) => saveSkillAction({}, f), "save"],
  ["assignSkillAction", (f: FormData) => assignSkillAction({}, f), "assign"],
  ["unassignSkillAction", (f: FormData) => unassignSkillAction({}, f), "assign"],
] as const;

beforeEach(() => {
  state.requestHeaders = new Headers();
  for (const fn of Object.values(library)) fn.mockReset();
  library.createSkill.mockResolvedValue({ id: SKILL });
  library.saveSkill.mockResolvedValue({ version: 2 });
  library.assignSkill.mockResolvedValue(undefined);
  library.unassignSkill.mockResolvedValue(undefined);
});

describe("skill actions are for people only (AGO-154)", () => {
  it.each(actions)(
    "%s rejects an agent credential before touching the library",
    async (_name, run, formKey) => {
      state.requestHeaders = new Headers({ authorization: `Bearer ${AGENT_TOKEN}` });

      const result = await run(validForms[formKey]);

      expect(result.error).toContain("people only");
      for (const fn of Object.values(library)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "%s rejects it even with a session cookie attached",
    async (_name, run, formKey) => {
      state.requestHeaders = new Headers({
        authorization: `Bearer ${AGENT_TOKEN}`,
        cookie: "sb-session=human",
      });

      const result = await run(validForms[formKey]);

      expect(result.error).toContain("people only");
      for (const fn of Object.values(library)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "%s rejects an agent credential even when the input is invalid",
    async (_name, run) => {
      state.requestHeaders = new Headers({ authorization: `Bearer ${AGENT_TOKEN}` });

      const result = await run(form({}));

      expect(result.error).toContain("people only");
    },
  );

  it("still lets a person save a skill (no regression)", async () => {
    const result = await saveSkillAction({}, validForms.save);
    expect(result).toEqual({ savedVersion: 2 });
    expect(library.saveSkill).toHaveBeenCalledTimes(1);
  });

  it("still lets a person assign and unassign a skill", async () => {
    expect(await assignSkillAction({}, validForms.assign)).toEqual({});
    expect(await unassignSkillAction({}, validForms.assign)).toEqual({});
    expect(library.assignSkill).toHaveBeenCalledTimes(1);
    expect(library.unassignSkill).toHaveBeenCalledTimes(1);
  });

  it("still lets a person create a skill", async () => {
    await createSkillAction({}, validForms.create);
    expect(library.createSkill).toHaveBeenCalledTimes(1);
  });
});
