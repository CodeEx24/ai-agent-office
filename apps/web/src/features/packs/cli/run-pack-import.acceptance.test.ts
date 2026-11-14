// @vitest-environment node
// AGO-193 functional acceptance tests for `pnpm pack:import` (tester round 1). Unlike the builder's unit test,
// the loader and the shared core are REAL here; only the Supabase client is a read-only recording fake that
// throws on anything but a read, so "dry run, no apply path, nothing printed" is proven end to end.
import { describe, expect, it, vi } from "vitest";

import { runPackImport, type ImportCliDeps } from "./run-pack-import.ts";

const WORKSPACE_ID = "19300000-0000-4000-8000-0000000000b1";
const USER_ID = "19300000-0000-4000-8000-0000000003b1";
const PASSWORD = ["pw", "Qa1", "Wd5", "Ez8"].join("-");
const SESSION_TOKEN = ["tok", "Mn6", "Bv4", "Cx2"].join("-");

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:44321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-key",
  AGO_CLI_EMAIL: "owner@example.test",
  AGO_CLI_PASSWORD: PASSWORD,
};

const CATALOG_ROWS = [
  { key: "vault.read", tier: 0, scope: "workspace" },
  { key: "web.search", tier: 1, scope: "external" },
  { key: "code.run", tier: 3, scope: "sandbox" },
  { key: "message.send_outbound", tier: 3, scope: "external" },
  { key: "payments.execute", tier: 4, scope: "external" },
];

const TABLE_ROWS: Record<string, unknown[]> = {
  agents: [
    {
      name: "Scout",
      role: "Researcher",
      model: "claude-sonnet-5-5",
      thinking_effort: "medium",
      prompt: "An older prompt.",
      archived_at: null,
    },
  ],
  skills: [],
  capabilities: CATALOG_ROWS,
};

type Loose = Record<string, unknown>;

function agent(overrides: Loose = {}): Loose {
  return {
    name: "Scout",
    role: "Researcher",
    model: "claude-sonnet-5-5",
    thinkingEffort: "medium",
    prompt: "Find sources.",
    skills: [],
    capabilities: [{ name: "vault.read", scope: "workspace" }],
    dailyBudgetCents: 500,
    autonomyMode: "strict",
    ...overrides,
  };
}

function packOf(overrides: Loose = {}): string {
  return JSON.stringify({
    packVersion: 1,
    metadata: { name: "Team", exportedAt: "2026-11-13T00:00:00Z", appVersion: "0.1.0" },
    agents: [agent()],
    skills: [],
    ...overrides,
  });
}

/** A client that allows reads and throws on any other method, recording every call. */
function readOnlyClient(role: string | null = "owner") {
  const calls: string[] = [];
  const allowed = new Set(["select", "eq", "is", "order", "range", "maybeSingle"]);
  const builder = (table: string): unknown => {
    const state = { table };
    const target: Record<string, unknown> = {};
    return new Proxy(target, {
      get(_t, prop: string) {
        if (prop === "then") return undefined;
        if (!allowed.has(prop)) throw new Error(`write or unknown call attempted: ${prop}`);
        calls.push(`${state.table}.${prop}`);
        if (prop === "maybeSingle") {
          return () => Promise.resolve({ data: role === null ? null : { role }, error: null });
        }
        if (prop === "range") {
          return () => Promise.resolve({ data: TABLE_ROWS[state.table] ?? [], error: null });
        }
        return () => builder(state.table);
      },
    });
  };
  const signInWithPassword = vi.fn(() =>
    Promise.resolve({
      data: { user: { id: USER_ID }, session: { access_token: SESSION_TOKEN } },
      error: null,
    }),
  );
  const client = {
    auth: { signInWithPassword, signOut: vi.fn(() => Promise.resolve({ error: null })) },
    from: (table: string) => builder(table),
    rpc: () => {
      throw new Error("rpc attempted");
    },
  };
  return { client, calls, signInWithPassword };
}

function setup(text: string, role: string | null = "owner") {
  const out: string[] = [];
  const err: string[] = [];
  const { client, calls, signInWithPassword } = readOnlyClient(role);
  const createClient = vi.fn(() => client as never);
  const deps: ImportCliDeps = {
    env: ENV,
    createClient,
    fileSize: () => Promise.resolve(Buffer.byteLength(text)),
    readFile: () => Promise.resolve(text),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { deps, out, err, calls, createClient, signInWithPassword };
}

const ARGS = ["--workspace", WORKSPACE_ID, "--file", "pack.json"];

function hasControlOrBidi(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n") continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

describe("AC1: the CLI preview is a dry run with no apply path", () => {
  it("reads only the three workspace tables and the caller's membership, and never writes", async () => {
    const { deps, out, err, calls } = setup(packOf());
    expect(await runPackImport(ARGS, deps)).toBe(0);
    expect(err).toEqual([]);
    const tables = new Set(calls.map((call) => call.split(".")[0]));
    expect([...tables].sort()).toEqual(["agents", "capabilities", "members", "skills"]);
    expect(calls.every((call) => /\.(select|eq|is|order|range|maybeSingle)$/.test(call))).toBe(
      true,
    );
    expect(out.join("\n")).toContain("Agents: 0 to create, 1 to update, 0 to skip");
    expect(out.join("\n")).toContain("Nothing was written.");
  });

  it.each([[["--apply", ...ARGS]], [[...ARGS, "--apply"]], [[...ARGS, "--json", "--apply"]]])(
    "refuses --apply wherever it appears, before signing in or touching a file",
    async (argv) => {
      const { deps, err, createClient, signInWithPassword } = setup(packOf());
      const readFile = vi.spyOn(deps, "readFile");
      expect(await runPackImport(argv, deps)).toBe(2);
      expect(err.join("\n")).toContain("not available yet");
      expect(createClient).not.toHaveBeenCalled();
      expect(signInWithPassword).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it("exits 1 for a blocked preview, prints it, and says nothing was written", async () => {
    const { deps, out } = setup(packOf({ agents: [agent({ model: "not-a-model" })] }));
    expect(await runPackImport(ARGS, deps)).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("BLOCKED:");
    expect(text).toContain("Importable: no. Nothing was written.");
  });

  it("does not read the workspace for a member (owners only) and exits 1", async () => {
    const { deps, err, calls } = setup(packOf(), "member");
    expect(await runPackImport(ARGS, deps)).toBe(1);
    expect(err.join("\n")).toContain("may not preview imports");
    expect(calls.every((call) => call.startsWith("members."))).toBe(true);
  });

  it("does not read the workspace for a caller with no membership at all", async () => {
    const { deps, calls } = setup(packOf(), null);
    expect(await runPackImport(ARGS, deps)).toBe(1);
    expect(calls.every((call) => call.startsWith("members."))).toBe(true);
  });
});

describe("AC2: the readable summary shows tiers and flags", () => {
  const trifectaPack = packOf({
    agents: [
      agent({
        name: "Leaky",
        capabilities: [
          { name: "web.search", scope: "external" },
          { name: "vault.read", scope: "workspace" },
          { name: "message.send_outbound", scope: "external" },
          { name: "payments.execute", scope: "external" },
        ],
      }),
    ],
  });

  it("prints every capability with its tier, and the ignored ones as ignored", async () => {
    const { deps, out } = setup(trifectaPack);
    await runPackImport(ARGS, deps);
    const text = out.join("\n");
    expect(text).toContain("capability web.search [tier 1]: applied");
    expect(text).toContain("capability message.send_outbound [tier 3]: ignored");
    expect(text).toContain("capability payments.execute [tier 4]: ignored");
  });

  it("warns about a declared trifecta combination in the readable summary, not only in --json", async () => {
    const { deps, out } = setup(trifectaPack);
    await runPackImport(ARGS, deps);
    expect(out.join("\n").toLowerCase()).toContain("trifecta");
  });

  it("carries the trifecta flag in --json", async () => {
    const { deps, out } = setup(trifectaPack);
    await runPackImport([...ARGS, "--json"], deps);
    const preview = JSON.parse(out.join("\n")) as {
      agents: {
        trifecta: { declared: boolean };
        capabilities: { name: string; tier3plus: boolean }[];
      }[];
    };
    expect(preview.agents[0]?.trifecta.declared).toBe(true);
    expect(
      preview.agents[0]?.capabilities.find((c) => c.name === "payments.execute")?.tier3plus,
    ).toBe(true);
  });
});

describe("untrusted text and secrets never reach the terminal", () => {
  it("prints no escape or control character from a pack, in text or JSON mode", async () => {
    const dirty = "Evil\u001b[2Jname\u{202e}end";
    const text = packOf({
      metadata: { name: dirty, exportedAt: "2026-11-13T00:00:00Z", appVersion: "1" },
      agents: [agent({ name: dirty, department: dirty })],
    });
    const plain = setup(text);
    await runPackImport(ARGS, plain.deps);
    expect(hasControlOrBidi(plain.out.join("\n"))).toBe(false);
    const json = setup(text);
    await runPackImport([...ARGS, "--json"], json.deps);
    expect(json.out.join("\n")).not.toContain("\u001b");
    expect(json.out.join("\n")).not.toContain("\u{202e}");
  });

  it("prints no prompt, role, skill body or note, in text or JSON mode", async () => {
    const text = packOf({
      agents: [agent({ prompt: "PROMPT-MARK-31ab", role: "ROLE-MARK-77cd", skills: ["Helper"] })],
      skills: [{ name: "Helper", version: 1, body: "BODY-MARK-90ef" }],
      notes: [{ title: "NOTE-TITLE-11aa", body: "NOTE-MARK-22bb" }],
    });
    for (const extra of [[], ["--json"]]) {
      const run = setup(text);
      await runPackImport([...ARGS, ...extra], run.deps);
      const all = [...run.out, ...run.err].join("\n");
      for (const marker of ["PROMPT-MARK", "ROLE-MARK", "BODY-MARK", "NOTE-TITLE", "NOTE-MARK"]) {
        expect(all).not.toContain(marker);
      }
    }
  });

  it("prints no password and no session token on success, on a rejection or on a blocked preview", async () => {
    const secretValue = ["gh", "p_", "Q".repeat(36)].join("");
    const files = [
      packOf(),
      packOf({ agents: [agent({ model: "nope" })] }),
      packOf({ agents: [agent({ prompt: `use ${secretValue}` })] }),
      "{ not json",
    ];
    for (const file of files) {
      const run = setup(file);
      await runPackImport(ARGS, run.deps);
      const all = [...run.out, ...run.err].join("\n");
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain(SESSION_TOKEN);
      expect(all).not.toContain(secretValue);
    }
  });

  it("reports a secret-looking value by its path in the terminal output, never the value", async () => {
    const secretValue = ["AK", "IA", "R".repeat(16)].join("");
    const run = setup(packOf({ agents: [agent({ prompt: `key ${secretValue}` })] }));
    expect(await runPackImport(ARGS, run.deps)).toBe(1);
    const all = run.err.join("\n");
    expect(all).toContain("agents.0.prompt");
    expect(all).not.toContain(secretValue);
  });

  it("does not print a secret-looking value that was used as an unknown field name", async () => {
    const secretValue = ["gh", "p_", "S".repeat(36)].join("");
    const run = setup(packOf({ agents: [agent({ [secretValue]: 1 })] }));
    expect(await runPackImport(ARGS, run.deps)).toBe(1);
    expect([...run.out, ...run.err].join("\n")).not.toContain(secretValue);
  });

  it.each([
    ["the pack root", (key: string) => packOf({ [key]: 1 })],
    [
      "metadata",
      (key: string) =>
        packOf({
          metadata: {
            name: "T",
            exportedAt: "2026-11-13T00:00:00Z",
            appVersion: "1",
            [key]: { a: 1 },
          },
        }),
    ],
    ["agents[0]", (key: string) => packOf({ agents: [agent({ [key]: [1, { b: 2 }] })] })],
    [
      "agents[0].capabilities[1]",
      (key: string) =>
        packOf({
          agents: [
            agent({
              capabilities: [
                { name: "vault.read", scope: "workspace" },
                { name: "web.search", scope: "external", [key]: "x" },
              ],
            }),
          ],
        }),
    ],
    [
      "skills[0]",
      (key: string) => packOf({ skills: [{ name: "S", version: 1, body: "b", [key]: null }] }),
    ],
    ["notes[0]", (key: string) => packOf({ notes: [{ title: "T", body: "b", [key]: "x" }] })],
  ])(
    "prints a count and the location, never a secret-shaped field name, for %s (stdout and stderr)",
    async (_label, build) => {
      const key = ["AK", "IA", "N".repeat(16)].join("");
      const run = setup(build(key));
      expect(await runPackImport(ARGS, run.deps)).toBe(1);
      expect(run.out.join("\n")).not.toContain(key);
      expect(run.err.join("\n")).not.toContain(key);
      expect(run.err.join("\n")).toContain("unrecognized field");
    },
  );

  it("prints no secret-shaped field name in --json output either", async () => {
    const key = ["gh", "p_", "J".repeat(36)].join("");
    const run = setup(packOf({ agents: [agent({ [key]: 1 })] }));
    await runPackImport([...ARGS, "--json"], run.deps);
    expect([...run.out, ...run.err].join("\n")).not.toContain(key);
  });

  it("rejects invalid JSON with a fixed message that holds none of the file's text", async () => {
    const run = setup("{ PLANTED-TEXT-4f2e not json");
    expect(await runPackImport(ARGS, run.deps)).toBe(1);
    expect(run.err.join("\n")).toContain("not valid JSON");
    expect(run.err.join("\n")).not.toContain("PLANTED-TEXT");
  });
});
