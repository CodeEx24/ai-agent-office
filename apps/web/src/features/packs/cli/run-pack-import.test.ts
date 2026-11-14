import { beforeEach, describe, expect, it, vi } from "vitest";

const previewAgentPackImport = vi.fn();

vi.mock("../preview-agent-pack-import.ts", () => ({
  previewAgentPackImport: (...args: unknown[]) => previewAgentPackImport(...args) as unknown,
}));

import { MAX_PACK_BYTES } from "@ago/shared/pack-import-preview";

import { runPackImport, type ImportCliDeps } from "./run-pack-import.ts";

const WORKSPACE_ID = "19300000-0000-4000-8000-0000000000a1";
const USER_ID = "19300000-0000-4000-8000-0000000003a1";
// Built at runtime: fakes for the password and the session token, so the tests can prove neither is printed.
const PASSWORD = ["pw", "Zq7", "Lm3", "Vx9"].join("-");
const SESSION_TOKEN = ["tok", "R4t", "Yu8", "Ip2"].join("-");

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:44321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-key",
  AGO_CLI_EMAIL: "dev@example.test",
  AGO_CLI_PASSWORD: PASSWORD,
};

const PREVIEW = {
  importable: true,
  packName: "Research team",
  packVersion: 1,
  agents: [
    {
      name: "Scout",
      action: "create",
      conflict: false,
      capabilities: [{ name: "vault.read", tier: 0, status: "applied" }],
    },
  ],
  skills: [{ name: "Citing", action: "create", conflict: false }],
  references: [{ kind: "secret", name: "SEARCH_KEY" }],
  blockers: [],
  summary: {
    agents: { create: 1, update: 0, skip: 0 },
    skills: { create: 1, update: 0, skip: 0 },
  },
};

function setup(
  options: {
    env?: Partial<ImportCliDeps["env"]>;
    signInError?: unknown;
    role?: string | null;
    size?: number;
    readError?: boolean;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const signInWithPassword = vi.fn(() =>
    Promise.resolve(
      options.signInError
        ? { data: { user: null }, error: options.signInError }
        : {
            data: { user: { id: USER_ID }, session: { access_token: SESSION_TOKEN } },
            error: null,
          },
    ),
  );
  const signOut = vi.fn(() => Promise.resolve({ error: null }));
  const memberQueries: [string, unknown][] = [];
  const members = {
    select: () => members,
    eq: (column: string, value: unknown) => {
      memberQueries.push([column, value]);
      return members;
    },
    is: () => members,
    maybeSingle: () =>
      Promise.resolve({
        data: options.role === null ? null : { role: options.role ?? "owner" },
        error: null,
      }),
  };
  const client = { auth: { signInWithPassword, signOut }, from: vi.fn(() => members) };
  const fileSize = vi.fn(() => Promise.resolve(options.size ?? 100));
  const readFile = vi.fn(() =>
    options.readError ? Promise.reject(new Error("ENOENT")) : Promise.resolve('{"packVersion":1}'),
  );
  const createClient = vi.fn(() => client as never);
  const deps: ImportCliDeps = {
    env: { ...ENV, ...options.env },
    createClient,
    fileSize,
    readFile,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return {
    deps,
    out,
    err,
    signInWithPassword,
    signOut,
    fileSize,
    readFile,
    createClient,
    memberQueries,
  };
}

const ARGS = ["--workspace", WORKSPACE_ID, "--file", "pack.json"];

describe("runPackImport (pnpm pack:import)", () => {
  beforeEach(() => {
    previewAgentPackImport.mockReset();
    previewAgentPackImport.mockResolvedValue({ ok: true, preview: PREVIEW });
  });

  it("previews as the signed-in owner and prints a readable summary, exit 0", async () => {
    const { deps, out, err, signOut, memberQueries } = setup();
    expect(await runPackImport(ARGS, deps)).toBe(0);
    expect(previewAgentPackImport).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WORKSPACE_ID,
      text: '{"packVersion":1}',
    });
    const text = out.join("\n");
    expect(text).toContain("Agents: 1 to create, 0 to update, 0 to skip");
    expect(text).toContain("capability vault.read [tier 0]: applied");
    expect(text).toContain("set up afterwards: secret SEARCH_KEY");
    expect(text).toContain("Nothing was written.");
    expect(err).toEqual([]);
    expect(memberQueries).toContainEqual(["workspace_id", WORKSPACE_ID]);
    expect(signOut).toHaveBeenCalled();
  });

  it("prints JSON with --json", async () => {
    const { deps, out } = setup();
    expect(await runPackImport([...ARGS, "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({
      importable: true,
      packName: "Research team",
    });
  });

  it("exits 1 for a blocked preview but still prints it", async () => {
    previewAgentPackImport.mockResolvedValue({
      ok: true,
      preview: {
        ...PREVIEW,
        importable: false,
        blockers: [{ code: "model_not_allowed", message: "Model not allowed" }],
      },
    });
    const { deps, out } = setup();
    expect(await runPackImport(ARGS, deps)).toBe(1);
    expect(out.join("\n")).toContain("BLOCKED: Model not allowed");
    expect(out.join("\n")).toContain("Importable: no.");
  });

  it("has no apply option: --apply says so and does nothing", async () => {
    const { deps, err, createClient } = setup();
    expect(await runPackImport([...ARGS, "--apply"], deps)).toBe(2);
    expect(err.join("\n")).toContain("not available yet");
    expect(createClient).not.toHaveBeenCalled();
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it("prints usage for --help and for unknown or incomplete flags", async () => {
    expect(await runPackImport(["--help"], setup().deps)).toBe(0);
    expect(await runPackImport(["--bogus"], setup().deps)).toBe(2);
    expect(await runPackImport(["--workspace"], setup().deps)).toBe(2);
  });

  it.each([
    ["no workspace", ["--file", "pack.json"]],
    ["a bad workspace id", ["--workspace", "nope", "--file", "pack.json"]],
    ["no file", ["--workspace", WORKSPACE_ID]],
  ])("exits 2 for %s", async (_label, args) => {
    const { deps, createClient } = setup();
    expect(await runPackImport(args, deps)).toBe(2);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("exits 2 and names the missing variables (never their values)", async () => {
    const { deps, err } = setup({ env: { AGO_CLI_PASSWORD: undefined } });
    expect(await runPackImport(ARGS, deps)).toBe(2);
    expect(err.join("\n")).toContain("AGO_CLI_PASSWORD");
  });

  it("refuses a file over the limit before reading it", async () => {
    const { deps, err, readFile } = setup({ size: MAX_PACK_BYTES + 1 });
    expect(await runPackImport(ARGS, deps)).toBe(1);
    expect(err.join("\n")).toContain("too large");
    expect(readFile).not.toHaveBeenCalled();
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it("reports an unreadable file with a fixed line", async () => {
    const { deps, err } = setup({ readError: true });
    expect(await runPackImport(ARGS, deps)).toBe(1);
    expect(err).toEqual(["The pack file could not be read."]);
  });

  it("prints a fixed line for a failed sign-in, never the server's text or the password", async () => {
    const { deps, err, out } = setup({ signInError: { message: `Invalid login for ${PASSWORD}` } });
    expect(await runPackImport(ARGS, deps)).toBe(1);
    const all = [...err, ...out].join("\n");
    expect(all).toContain("Sign-in failed");
    expect(all).not.toContain(PASSWORD);
    expect(previewAgentPackImport).not.toHaveBeenCalled();
  });

  it.each([["member"], ["viewer"], [null]])(
    "denies a %s of the workspace and previews nothing",
    async (role) => {
      const { deps, err, signOut } = setup({ role });
      expect(await runPackImport(ARGS, deps)).toBe(1);
      expect(err.join("\n")).toContain("owners can");
      expect(previewAgentPackImport).not.toHaveBeenCalled();
      expect(signOut).toHaveBeenCalled();
    },
  );

  it("prints a rejection's fixed message and issues, exit 1", async () => {
    previewAgentPackImport.mockResolvedValue({
      ok: false,
      error: {
        code: "invalid_pack",
        message: "The file is not a valid agent pack (1 problem).",
        issues: [{ path: "agents.0.model", message: "Invalid option" }],
      },
    });
    const { deps, err } = setup();
    expect(await runPackImport(ARGS, deps)).toBe(1);
    expect(err).toEqual([
      "The file is not a valid agent pack (1 problem).",
      "  agents.0.model: Invalid option",
    ]);
  });

  it("prints a generic line when the read fails and never leaks the password or token", async () => {
    previewAgentPackImport.mockRejectedValue(new Error(`boom ${PASSWORD} ${SESSION_TOKEN}`));
    const { deps, err, out, signOut } = setup();
    expect(await runPackImport(ARGS, deps)).toBe(1);
    const all = [...err, ...out].join("\n");
    expect(all).toContain("The preview failed. Nothing was written.");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(SESSION_TOKEN);
    expect(signOut).toHaveBeenCalled();
  });
});
