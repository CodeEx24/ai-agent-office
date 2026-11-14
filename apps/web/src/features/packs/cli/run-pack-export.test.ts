import { beforeEach, describe, expect, it, vi } from "vitest";

const exportAgentPack = vi.fn();

vi.mock("../export-agent-pack.ts", () => {
  class ExportAgentPackError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    ExportAgentPackError,
    exportAgentPack: (...args: unknown[]) => exportAgentPack(...args) as unknown,
  };
});

import { ExportAgentPackError } from "../export-agent-pack.ts";
import { runPackExport, type CliDeps } from "./run-pack-export.ts";

const WORKSPACE_ID = "19200000-0000-4000-8000-0000000000a1";
const AGENT_A = "19200000-0000-4000-8000-0000000002a1";
const AGENT_B = "19200000-0000-4000-8000-0000000002a2";
// Built at runtime: fakes for the password and the session token, so the tests can prove neither is printed.
const PASSWORD = ["pw", "Zq7", "Lm3", "Vx9"].join("-");
const SESSION_TOKEN = ["tok", "R4t", "Yu8", "Ip2"].join("-");
const SERVER_MESSAGE = `Invalid login credentials for ${PASSWORD}`;

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:44321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-key",
  AGO_CLI_EMAIL: "dev@example.test",
  AGO_CLI_PASSWORD: PASSWORD,
};

function setup(overrides: Partial<CliDeps["env"]> = {}, signInError: unknown = null) {
  const out: string[] = [];
  const err: string[] = [];
  const signInWithPassword = vi.fn(() =>
    Promise.resolve(
      signInError
        ? { data: { session: null }, error: signInError }
        : { data: { session: { access_token: SESSION_TOKEN } }, error: null },
    ),
  );
  const signOut = vi.fn(() => Promise.resolve({ error: null }));
  const client = { auth: { signInWithPassword, signOut } };
  const writeFile = vi.fn(() => Promise.resolve());
  const createClient = vi.fn(() => client as never);
  const deps: CliDeps = {
    env: { ...ENV, ...overrides },
    createClient,
    writeFile,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { deps, out, err, signInWithPassword, signOut, writeFile, createClient, client };
}

const EXPORTED = {
  json: '{"agents":[]}\n',
  checksum: "cd".repeat(32),
  pack: { agents: [{}, {}], skills: [{}] },
};

describe("runPackExport (pnpm pack:export)", () => {
  beforeEach(() => {
    exportAgentPack.mockReset();
    exportAgentPack.mockResolvedValue(EXPORTED);
  });

  it("signs in as the person, exports through the shared code path and writes the file", async () => {
    const { deps, out, writeFile, signInWithPassword, client } = setup();
    const code = await runPackExport(
      [
        "--workspace",
        WORKSPACE_ID,
        "--agent",
        AGENT_A,
        "--agent",
        AGENT_B,
        "--name",
        "Team",
        "--out",
        "team.json",
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: ENV.AGO_CLI_EMAIL,
      password: PASSWORD,
    });
    expect(exportAgentPack).toHaveBeenCalledWith(client, {
      workspaceId: WORKSPACE_ID,
      agentIds: [AGENT_A, AGENT_B],
      name: "Team",
    });
    expect(writeFile).toHaveBeenCalledWith("team.json", EXPORTED.json);
    expect(out.join("\n")).toContain("Exported 2 agent(s) and 1 skill(s) to team.json");
    expect(out.join("\n")).toContain(`sha256:${EXPORTED.checksum}`);
  });

  it("exports every active agent when no --agent is given, to the default file", async () => {
    const { deps, writeFile } = setup();
    expect(await runPackExport(["--workspace", WORKSPACE_ID], deps)).toBe(0);
    expect(exportAgentPack).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WORKSPACE_ID,
      agentIds: undefined,
      name: undefined,
    });
    expect(writeFile).toHaveBeenCalledWith("agent-pack.json", EXPORTED.json);
  });

  it("creates the client from the public anon key only", async () => {
    const { deps, createClient } = setup();
    await runPackExport(["--workspace", WORKSPACE_ID], deps);
    expect(createClient).toHaveBeenCalledWith(
      ENV.NEXT_PUBLIC_SUPABASE_URL,
      ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  });

  it("a wrong login fails cleanly: fixed message, nothing exported or written, no secret echoed", async () => {
    const { deps, out, err, writeFile } = setup({}, { message: SERVER_MESSAGE, status: 400 });
    const code = await runPackExport(["--workspace", WORKSPACE_ID], deps);
    expect(code).toBe(1);
    expect(err).toEqual(["Sign-in failed. Check AGO_CLI_EMAIL and AGO_CLI_PASSWORD."]);
    expect(exportAgentPack).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    const printed = [...out, ...err].join("\n");
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain(SERVER_MESSAGE);
  });

  it("never prints the password or the session token, on success or on failure", async () => {
    const success = setup();
    await runPackExport(["--workspace", WORKSPACE_ID], success.deps);
    exportAgentPack.mockRejectedValue(new ExportAgentPackError("failed"));
    const failure = setup();
    await runPackExport(["--workspace", WORKSPACE_ID], failure.deps);
    for (const printed of [...success.out, ...success.err, ...failure.out, ...failure.err]) {
      expect(printed).not.toContain(PASSWORD);
      expect(printed).not.toContain(SESSION_TOKEN);
    }
  });

  it("signs out after an export, and after a failed export", async () => {
    const ok = setup();
    await runPackExport(["--workspace", WORKSPACE_ID], ok.deps);
    expect(ok.signOut).toHaveBeenCalledTimes(1);
    exportAgentPack.mockRejectedValue(new ExportAgentPackError("not_found"));
    const bad = setup();
    await runPackExport(["--workspace", WORKSPACE_ID], bad.deps);
    expect(bad.signOut).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not_found", "An agent was not found in that workspace."],
    ["no_agents", "There are no agents to export."],
    ["forbidden", "Your account may not export agents in that workspace (members and owners can)."],
    ["invalid_pack", "The agents cannot form a valid pack"],
    ["failed", "The export failed. Nothing was written."],
  ])("explains a %s failure in plain words and writes nothing", async (failure, message) => {
    exportAgentPack.mockRejectedValue(new ExportAgentPackError(failure as never));
    const { deps, err, writeFile } = setup();
    expect(await runPackExport(["--workspace", WORKSPACE_ID], deps)).toBe(1);
    expect(err.join("\n")).toContain(message);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not leak an unexpected error's text", async () => {
    exportAgentPack.mockRejectedValue(new Error(`boom ${PASSWORD}`));
    const { deps, err } = setup();
    expect(await runPackExport(["--workspace", WORKSPACE_ID], deps)).toBe(1);
    expect(err).toEqual(["The export failed. Nothing was written."]);
  });

  it("names the missing environment variables, never their values, and does not sign in", async () => {
    const { deps, err, signInWithPassword } = setup({
      AGO_CLI_PASSWORD: undefined,
      AGO_CLI_EMAIL: "",
    });
    expect(await runPackExport(["--workspace", WORKSPACE_ID], deps)).toBe(2);
    expect(err.join("\n")).toContain("AGO_CLI_EMAIL, AGO_CLI_PASSWORD");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it.each([
    ["no arguments", []],
    ["a bad workspace id", ["--workspace", "nope"]],
    ["a bad agent id", ["--workspace", WORKSPACE_ID, "--agent", "nope"]],
    ["an unknown flag", ["--workspace", WORKSPACE_ID, "--force", "yes"]],
    ["a flag with no value", ["--workspace"]],
  ])("answers usage (exit 2) for %s, before any sign-in", async (_label, argv) => {
    const { deps, err, signInWithPassword } = setup();
    expect(await runPackExport(argv, deps)).toBe(2);
    expect(err.join("\n")).toContain("Usage: pnpm pack:export");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("prints usage for --help and exits 0", async () => {
    const { deps, out } = setup();
    expect(await runPackExport(["--help"], deps)).toBe(0);
    expect(out.join("\n")).toContain("Usage: pnpm pack:export");
  });
});
