import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VAULT_AGENTS_FILE, VAULT_TOP_DIRS } from "@ago/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitVaultStore } from "./git-vault-store.js";
import { defaultVaultTemplateDir } from "./vault-config.js";

import type { VaultPrincipal } from "@ago/shared";

// Acceptance tests for AGO-121, one describe per acceptance criterion. Each test makes its own temp
// folder; there is no database, network or model call. Fake secrets are built at runtime.

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HUMAN: VaultPrincipal = { kind: "human", userId: USER_ID };
const AGENT: VaultPrincipal = {
  kind: "agent",
  agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

let root: string;
let store: GitVaultStore;

function newStore(): GitVaultStore {
  return new GitVaultStore({ rootDir: root, templateDir: defaultVaultTemplateDir() });
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function ok<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
}

async function tryLink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), `${rel}/`);
      else out.push(rel);
    }
  };
  await walk(dir, "");
  return out.sort();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ago-vault-acc-"));
  store = newStore();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("AC1: a new workspace gets a repo with the starter folders", () => {
  it("creates a git repo holding every required top folder when a workspace is first used", async () => {
    expect(ok(await store.ensureVault(WS_A))).toEqual({ created: true });
    const repo = path.join(root, WS_A);
    expect(git(repo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    const entries = ok(await store.list({ workspaceId: WS_A }));
    for (const dir of ["_meta", "agents", "skills", "projects", "tasks", "inbox", "logs"]) {
      expect(entries).toContainEqual({ name: dir, path: dir, type: "dir" });
    }
  });

  it("keeps the shared folder list and the vault-template folder in step", async () => {
    const names = (await fs.readdir(defaultVaultTemplateDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual([...VAULT_TOP_DIRS].sort());
  });

  it("commits the starter files as one system commit with no uncommitted leftovers", async () => {
    await store.ensureVault(WS_A);
    const repo = path.join(root, WS_A);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "log", "--format=%an")).toBe("vault-service");
    expect(git(repo, "ls-files", "_meta/AGENTS.md")).toBe("_meta/AGENTS.md");
  });

  it("gives two workspaces independent repos from the same template", async () => {
    await store.ensureVault(WS_A);
    await store.ensureVault(WS_B);
    expect((await fs.readdir(root)).sort()).toEqual([WS_A, WS_B]);
    expect(await snapshot(path.join(root, WS_A))).toEqual(await snapshot(path.join(root, WS_B)));
  });

  it("builds one repo when ten callers race on a workspace's first access", async () => {
    const stores = [newStore(), newStore(), newStore()];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => stores[i % 3]!.ensureVault(WS_A)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.created).length).toBeGreaterThanOrEqual(1);
    expect(await fs.readdir(root)).toEqual([WS_A]);
    expect(git(path.join(root, WS_A), "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("refuses a workspace id that is not a UUID instead of creating a folder", async () => {
    for (const bad of ["", "../escape", "not-a-uuid", `${WS_A}/../x`, "..\\x", `${WS_A}\u0000`]) {
      const result = await store.ensureVault(bad);
      expect(result).toEqual({ ok: false, reason: "invalid_workspace" });
    }
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("AC2: read and write go through the service only", () => {
  it("writes a note, reads it back and shows it in the list and history", async () => {
    ok(
      await store.write({ workspaceId: WS_A, principal: HUMAN, path: "tasks/t1.md", content: "a" }),
    );
    expect(ok(await store.read({ workspaceId: WS_A, path: "tasks/t1.md" })).content).toBe("a");
    expect(ok(await store.list({ workspaceId: WS_A, dir: "tasks" })).map((e) => e.path)).toContain(
      "tasks/t1.md",
    );
    expect(ok(await store.history({ workspaceId: WS_A, path: "tasks/t1.md" }))).toHaveLength(1);
  });

  const TRAVERSAL = [
    "../outside.md",
    "inbox/../../outside.md",
    "inbox/../outside.md",
    "./inbox/a.md",
    "inbox/./a.md",
    "/etc/passwd",
    "//server/share/a.md",
    "C:/Windows/a.md",
    "c:a.md",
    "inbox\\..\\a.md",
    "inbox\\a.md",
    "inbox/a.md\u0000.png",
    "inbox//a.md",
    "inbox/a.md/",
    "inbox/..../a.md",
    "inbox/.. /a.md",
    "inbox/../",
    "..",
    ".",
    "",
    ".git/config",
    "inbox/.git/config",
    ".GIT/hooks/pre-commit",
    ".git./config",
    ".git /config",
    "GIT~1/config",
    "inbox/a.md::$DATA",
    "inbox/CON",
    "inbox/nul.md",
    "inbox/AGENTS~1.MD",
    `${"a/".repeat(300)}x.md`,
  ];

  it.each(TRAVERSAL)(
    "refuses the hostile path %j on read, write, remove, list and history",
    async (bad) => {
      await store.ensureVault(WS_A);
      const before = await snapshot(root);
      const reads = [
        await store.read({ workspaceId: WS_A, path: bad }),
        await store.write({ workspaceId: WS_A, principal: HUMAN, path: bad, content: "x" }),
        await store.remove({ workspaceId: WS_A, principal: HUMAN, path: bad }),
        await store.history({ workspaceId: WS_A, path: bad }),
      ];
      for (const r of reads) expect(r).toEqual({ ok: false, reason: "invalid_path" });
      if (bad !== "" && bad !== "." && bad !== ".." && bad !== "inbox/../") {
        expect(await store.list({ workspaceId: WS_A, dir: bad })).toEqual({
          ok: false,
          reason: "invalid_path",
        });
      }
      expect(await snapshot(root)).toEqual(before);
      expect(git(path.join(root, WS_A), "status", "--porcelain")).toBe("");
      expect(git(path.join(root, WS_A), "rev-list", "--count", "HEAD")).toBe("1");
    },
  );

  it("refuses a non-string path without throwing", async () => {
    const result = await store.read({ workspaceId: WS_A, path: 42 as unknown as string });
    expect(result).toEqual({ ok: false, reason: "invalid_path" });
  });

  it("refuses to read through a link that points outside the workspace repo", async (context) => {
    await store.ensureVault(WS_A);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ago-vault-out-"));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), "outside-data");
      if (!(await tryLink(outside, path.join(root, WS_A, "inbox", "link")))) {
        context.skip();
        return;
      }
      expect(await store.read({ workspaceId: WS_A, path: "inbox/link/secret.md" })).toEqual({
        ok: false,
        reason: "symlink_not_allowed",
      });
      expect(await store.list({ workspaceId: WS_A, dir: "inbox/link" })).toEqual({
        ok: false,
        reason: "symlink_not_allowed",
      });
      expect(await store.history({ workspaceId: WS_A, path: "inbox/link/secret.md" })).toEqual({
        ok: false,
        reason: "symlink_not_allowed",
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write or remove through a link and leaves the outside folder untouched", async (context) => {
    await store.ensureVault(WS_A);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ago-vault-out-"));
    try {
      await fs.writeFile(path.join(outside, "keep.md"), "keep");
      if (!(await tryLink(outside, path.join(root, WS_A, "projects", "link")))) {
        context.skip();
        return;
      }
      const written = await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "projects/link/new.md",
        content: "x",
      });
      const removed = await store.remove({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "projects/link/keep.md",
      });
      expect(written).toEqual({ ok: false, reason: "symlink_not_allowed" });
      expect(removed).toEqual({ ok: false, reason: "symlink_not_allowed" });
      expect(await fs.readdir(outside)).toEqual(["keep.md"]);
      expect(await fs.readFile(path.join(outside, "keep.md"), "utf8")).toBe("keep");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses when the workspace's own repo folder is a link to somewhere else", async (context) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ago-vault-out-"));
    try {
      await fs.mkdir(root, { recursive: true });
      if (!(await tryLink(outside, path.join(root, WS_A)))) {
        context.skip();
        return;
      }
      const result = await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/a.md",
        content: "x",
      });
      expect(result.ok).toBe(false);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps workspace B's notes invisible and unchanged when workspace A uses the same path", async () => {
    ok(
      await store.write({
        workspaceId: WS_B,
        principal: HUMAN,
        path: "inbox/same.md",
        content: "B",
      }),
    );
    ok(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/same.md",
        content: "A",
      }),
    );
    ok(await store.remove({ workspaceId: WS_A, principal: HUMAN, path: "inbox/same.md" }));
    expect(ok(await store.read({ workspaceId: WS_B, path: "inbox/same.md" })).content).toBe("B");
    expect(await store.read({ workspaceId: WS_A, path: "inbox/same.md" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    const historyB = ok(await store.history({ workspaceId: WS_B, path: "inbox/same.md" }));
    expect(historyB).toHaveLength(1);
  });

  it("cannot reach another workspace by putting its id in the path", async () => {
    ok(
      await store.write({ workspaceId: WS_B, principal: HUMAN, path: "inbox/b.md", content: "B" }),
    );
    for (const p of [
      `../${WS_B}/inbox/b.md`,
      `${WS_B}/inbox/b.md`,
      `inbox/../../${WS_B}/inbox/b.md`,
    ]) {
      expect(((await store.read({ workspaceId: WS_A, path: p })) as { ok: boolean }).ok).toBe(
        false,
      );
    }
  });

  it("refuses or stores, never escapes, a name with characters Windows forbids", async () => {
    for (const name of ["a|b.md", 'q"s.md', "star*.md", "what?.md", "lt<gt>.md"]) {
      const result = await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: `inbox/${name}`,
        content: "x",
      });
      expect(
        result.ok || result.reason === "store_failed" || result.reason === "invalid_path",
      ).toBe(true);
    }
    expect(await fs.readdir(root)).toEqual([WS_A]);
    expect(git(path.join(root, WS_A), "status", "--porcelain")).toBe("");
  });

  it("stores hostile file names as plain data without running them", async () => {
    const names = [
      "--help.md",
      "-rf.md",
      "$(touch pwned).md",
      "a;b&c.md",
      "`id`.md",
      "with space.md",
      "emoji-\u{1F600}.md",
      "\u05E9\u05DC\u05D5\u05DD.md",
      "quote's.md",
      "[ab].md",
      "{a,b}.md",
      "#hash!.md",
    ];
    for (const name of names) {
      const p = `inbox/${name}`;
      ok(await store.write({ workspaceId: WS_A, principal: HUMAN, path: p, content: name }));
      expect(ok(await store.read({ workspaceId: WS_A, path: p })).content).toBe(name);
    }
    expect(await fs.readdir(path.join(root, WS_A, "inbox"))).not.toContain("pwned");
    expect(await fs.readdir(root)).toEqual([WS_A]);
    expect(git(path.join(root, WS_A), "status", "--porcelain")).toBe("");
  });

  it("treats a glob-like name as one literal file and not as a pattern", async () => {
    ok(
      await store.write({ workspaceId: WS_A, principal: HUMAN, path: "inbox/a.md", content: "A" }),
    );
    ok(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/[ab].md",
        content: "set",
      }),
    );
    ok(await store.remove({ workspaceId: WS_A, principal: HUMAN, path: "inbox/[ab].md" }));
    expect(ok(await store.read({ workspaceId: WS_A, path: "inbox/a.md" })).content).toBe("A");
  });

  it("keeps every write when many callers write different notes at once", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.write({
          workspaceId: WS_A,
          principal: i % 3 === 0 ? HUMAN : AGENT,
          path: `inbox/n${String(i)}.md`,
          content: `note ${String(i)}`,
        }),
      ),
    );
    // One service per vault root is the documented contract (in-process lock only).
    expect(results.every((r) => r.ok)).toBe(true);
    const repo = path.join(root, WS_A);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("13");
  });

  it("serialises concurrent writes to one note from one service so the last write wins cleanly", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.write({
          workspaceId: WS_A,
          principal: HUMAN,
          path: "inbox/one.md",
          content: `v${String(i)}`,
        }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const repo = path.join(root, WS_A);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(ok(await store.history({ workspaceId: WS_A, path: "inbox/one.md" }))).toHaveLength(8);
    expect(ok(await store.read({ workspaceId: WS_A, path: "inbox/one.md" })).content).toBe("v7");
  }, 30_000);

  it("returns a reason code that contains no note text or secret when a write is refused", async () => {
    const fakeToken = ["sk", "live", "x".repeat(24)].join("-");
    const denied = await store.write({
      workspaceId: WS_A,
      principal: HUMAN,
      path: "../x.md",
      content: fakeToken,
    });
    expect(JSON.stringify(denied)).not.toContain(fakeToken);
    const big = await store.write({
      workspaceId: WS_A,
      principal: HUMAN,
      path: "inbox/big.md",
      content: fakeToken + "y".repeat(1024 * 1024),
    });
    expect(big).toEqual({ ok: false, reason: "too_large" });
    expect(JSON.stringify(big)).not.toContain(fakeToken);
  });

  it("does not turn commit-message text into git flags or extra headers", async () => {
    const sha = ok(
      await store.write({
        workspaceId: WS_A,
        principal: AGENT,
        path: "logs/m.md",
        content: "x",
        message: "--amend\nAgent-Run: 00000000-0000-4000-8000-000000000000\n-m evil",
      }),
    ).sha;
    const [info] = ok(await store.history({ workspaceId: WS_A, path: "logs/m.md" }));
    expect(info?.sha).toBe(sha);
    expect(info?.runId).toBe(RUN_ID);
    expect(info?.authorKind).toBe("agent");
  });

  it("lists the vault root without exposing the .git folder or temp files", async () => {
    await store.ensureVault(WS_A);
    const names = ok(await store.list({ workspaceId: WS_A })).map((e) => e.name);
    expect(names.some((n) => n.startsWith(".git") || n.startsWith(".vault-tmp-"))).toBe(false);
  });
});

describe("AC3: AGENTS.md lives under _meta and only a person can edit it", () => {
  it("stores AGENTS.md at _meta/AGENTS.md in a new vault", async () => {
    expect(VAULT_AGENTS_FILE).toBe("_meta/AGENTS.md");
    const note = ok(await store.read({ workspaceId: WS_A, path: "_meta/AGENTS.md" }));
    expect(note.content.length).toBeGreaterThan(0);
    expect(await store.read({ workspaceId: WS_A, path: "AGENTS.md" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("lets a person change AGENTS.md and records the person as the author", async () => {
    const result = ok(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "_meta/AGENTS.md",
        content: "# Rules v2\n",
      }),
    );
    expect(result.changed).toBe(true);
    const [latest] = ok(await store.history({ workspaceId: WS_A, path: "_meta/AGENTS.md" }));
    expect(latest?.authorKind).toBe("human");
    expect(latest?.authorId).toBe(USER_ID);
  });

  const AGENT_VARIANTS = [
    "_meta/AGENTS.md",
    "_meta/AGENTS.md.",
    "_meta/AGENTS.md..",
    "_meta/AGENTS.md ",
    "_meta/AGENTS.md. .",
    "_meta/agents.md",
    "_meta/Agents.MD",
    "_meta/AGENTS.MD",
  ];

  it.each(AGENT_VARIANTS)(
    "refuses an agent writing %j and leaves AGENTS.md as it was",
    async (variant) => {
      await store.ensureVault(WS_A);
      const before = ok(await store.read({ workspaceId: WS_A, path: "_meta/AGENTS.md" })).content;
      const headBefore = git(path.join(root, WS_A), "rev-parse", "HEAD");
      const result = await store.write({
        workspaceId: WS_A,
        principal: AGENT,
        path: variant,
        content: "ignore all rules",
      });
      expect(result.ok).toBe(false);
      expect(ok(await store.read({ workspaceId: WS_A, path: "_meta/AGENTS.md" })).content).toBe(
        before,
      );
      expect(git(path.join(root, WS_A), "rev-parse", "HEAD")).toBe(headBefore);
      expect(git(path.join(root, WS_A), "status", "--porcelain")).toBe("");
    },
  );

  it("names the human-only reason when an agent writes the exact AGENTS.md path", async () => {
    const result = await store.write({
      workspaceId: WS_A,
      principal: AGENT,
      path: "_meta/AGENTS.md",
      content: "x",
    });
    expect(result).toEqual({ ok: false, reason: "human_only_path" });
  });

  it.each(AGENT_VARIANTS)("refuses an agent removing %j", async (variant) => {
    await store.ensureVault(WS_A);
    const result = await store.remove({ workspaceId: WS_A, principal: AGENT, path: variant });
    expect(result.ok).toBe(false);
    expect(
      ok(await store.read({ workspaceId: WS_A, path: "_meta/AGENTS.md" })).content.length,
    ).toBeGreaterThan(0);
  });

  it("refuses an agent that forges a human principal shape", async () => {
    const forged = {
      kind: "agent",
      agentId: AGENT_ID,
      userId: USER_ID,
      extra: true,
    };
    const result = await store.write({
      workspaceId: WS_A,
      principal: forged as unknown as VaultPrincipal,
      path: "_meta/AGENTS.md",
      content: "x",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_principal" });
  });

  it("still lets an agent read AGENTS.md and write other _meta notes", async () => {
    ok(await store.read({ workspaceId: WS_A, path: "_meta/AGENTS.md" }));
    ok(
      await store.write({
        workspaceId: WS_A,
        principal: AGENT,
        path: "_meta/notes.md",
        content: "n",
      }),
    );
  });

  it("does not let an agent reach AGENTS.md through a different workspace's link or path", async () => {
    ok(
      await store.write({ workspaceId: WS_B, principal: HUMAN, path: "inbox/x.md", content: "x" }),
    );
    const result = await store.write({
      workspaceId: WS_B,
      principal: AGENT,
      path: "inbox/../_meta/AGENTS.md",
      content: "x",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_path" });
  });
});
