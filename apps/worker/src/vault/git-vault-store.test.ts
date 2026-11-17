import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VAULT_NOTE_MAX_BYTES, VAULT_TOP_DIRS } from "@ago/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitVaultStore } from "./git-vault-store.js";
import { defaultVaultTemplateDir, loadVaultConfig } from "./vault-config.js";

import type { VaultPrincipal } from "@ago/shared";

// Every test here spawns git; the repo-wide run (all packages in parallel) is slow on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HUMAN: VaultPrincipal = { kind: "human", userId: USER_ID };
const AGENT: VaultPrincipal = { kind: "agent", agentId: AGENT_ID, runId: RUN_ID };

let root: string;
let store: GitVaultStore;

function newStore(): GitVaultStore {
  return new GitVaultStore({ rootDir: root, templateDir: defaultVaultTemplateDir() });
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ago-vault-"));
  store = newStore();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function value<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
}

describe("provisioning", () => {
  it("gives a new workspace the starter layout from vault-template", async () => {
    expect(value(await store.ensureVault(WS_A))).toEqual({ created: true });
    const names = value(await store.list({ workspaceId: WS_A })).map((entry) => entry.name);
    for (const dir of VAULT_TOP_DIRS) expect(names).toContain(dir);
    expect(names).not.toContain(".git");

    const agentsFile = value(await store.read({ workspaceId: WS_A, path: "_meta/AGENTS.md" }));
    const template = await fs.readFile(
      path.join(defaultVaultTemplateDir(), "_meta", "AGENTS.md"),
      "utf8",
    );
    expect(agentsFile.content).toBe(template);

    const tracked = git(path.join(root, WS_A), "ls-files").split("\n").sort();
    const expected: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        else expected.push(`${prefix}${entry.name}`);
      }
    };
    await walk(defaultVaultTemplateDir(), "");
    expect(tracked).toEqual(expected.sort());
    expect(git(path.join(root, WS_A), "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("is idempotent", async () => {
    await store.ensureVault(WS_A);
    const head = git(path.join(root, WS_A), "rev-parse", "HEAD");
    expect(value(await store.ensureVault(WS_A))).toEqual({ created: false });
    expect(git(path.join(root, WS_A), "rev-parse", "HEAD")).toBe(head);
  });

  it("provisions lazily on first read or write", async () => {
    value(
      await store.write({ workspaceId: WS_B, principal: HUMAN, path: "inbox/a.md", content: "x" }),
    );
    expect(await fs.stat(path.join(root, WS_B, ".git"))).toBeTruthy();
  });

  it("survives concurrent first access from several callers and several store instances", async () => {
    const other = newStore();
    const results = await Promise.all([
      store.ensureVault(WS_A),
      store.ensureVault(WS_A),
      other.ensureVault(WS_A),
      other.write({ workspaceId: WS_A, principal: HUMAN, path: "inbox/race.md", content: "hi" }),
      store.read({ workspaceId: WS_A, path: "_meta/README.md" }),
    ]);
    for (const result of results) expect(result.ok).toBe(true);
    // One repo, one initial commit (plus the one write), no leftover temp folders.
    expect(await fs.readdir(root)).toEqual([WS_A]);
    expect(git(path.join(root, WS_A), "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(path.join(root, WS_A), "status", "--porcelain")).toBe("");
  }, 30_000);
});

describe("read, write, list, history", () => {
  it("round-trips a note and records who wrote it", async () => {
    const written = value(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "projects/plan.md",
        content: "# Plan\n",
        message: "Add plan",
      }),
    );
    expect(written.changed).toBe(true);
    expect(value(await store.read({ workspaceId: WS_A, path: "projects/plan.md" })).content).toBe(
      "# Plan\n",
    );

    value(
      await store.write({
        workspaceId: WS_A,
        principal: AGENT,
        path: "projects/plan.md",
        content: "# Plan v2\n",
      }),
    );
    const history = value(await store.history({ workspaceId: WS_A, path: "projects/plan.md" }));
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      authorKind: "agent",
      authorId: AGENT_ID,
      runId: RUN_ID,
      message: "Update projects/plan.md",
    });
    expect(history[1]).toMatchObject({
      authorKind: "human",
      authorId: USER_ID,
      runId: null,
      message: "Add plan",
    });

    const entries = value(await store.list({ workspaceId: WS_A, dir: "projects" }));
    expect(entries.map((entry) => entry.path)).toEqual(["projects/.gitkeep", "projects/plan.md"]);
  });

  it("treats an unchanged write as a no-op", async () => {
    const first = value(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/n.md",
        content: "same",
      }),
    );
    const second = value(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/n.md",
        content: "same",
      }),
    );
    expect(second).toEqual({ sha: first.sha, changed: false });
  });

  it("removes a note with a commit and reports a missing one", async () => {
    await store.write({ workspaceId: WS_A, principal: HUMAN, path: "inbox/gone.md", content: "x" });
    value(await store.remove({ workspaceId: WS_A, principal: HUMAN, path: "inbox/gone.md" }));
    expect(await store.read({ workspaceId: WS_A, path: "inbox/gone.md" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await store.remove({ workspaceId: WS_A, principal: HUMAN, path: "inbox/gone.md" }),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(git(path.join(root, WS_A), "status", "--porcelain")).toBe("");
  });

  it("refuses oversize, NUL and unpaired-surrogate content", async () => {
    const big = "a".repeat(VAULT_NOTE_MAX_BYTES + 1);
    expect(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/big.md",
        content: big,
      }),
    ).toEqual({
      ok: false,
      reason: "too_large",
    });
    for (const content of ["a\u0000b", "\ud800"]) {
      expect(
        await store.write({ workspaceId: WS_A, principal: HUMAN, path: "inbox/bad.md", content }),
      ).toEqual({
        ok: false,
        reason: "invalid_content",
      });
    }
  });

  it("keeps note text and odd names as data, never as commands or flags", async () => {
    const name = "inbox/a b;touch pwned.md";
    const dash = "inbox/-flag.md";
    value(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: name,
        content: "x",
        message: "$(touch pwned2) --amend",
      }),
    );
    value(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: dash,
        content: "y",
        message: "-S --amend",
      }),
    );
    expect(value(await store.read({ workspaceId: WS_A, path: name })).content).toBe("x");
    const repo = path.join(root, WS_A);
    expect(await fs.readdir(repo)).not.toContain("pwned.md");
    expect(await fs.readdir(repo)).not.toContain("pwned2");
    const history = value(await store.history({ workspaceId: WS_A, path: name }));
    expect(history[0]?.message).toBe("$(touch pwned2) --amend");
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("3");
  });

  it("does not run repository hooks", async () => {
    await store.ensureVault(WS_A);
    const repo = path.join(root, WS_A);
    const marker = path.join(repo, "hook-ran.txt");
    // Repos are created without the sample hooks folder; plant real hooks to prove they never run.
    await fs.mkdir(path.join(repo, ".git", "hooks"), { recursive: true });
    for (const hook of ["pre-commit", "commit-msg", "post-commit"]) {
      await fs.writeFile(
        path.join(repo, ".git", "hooks", hook),
        `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`,
        {
          mode: 0o755,
        },
      );
    }
    value(
      await store.write({ workspaceId: WS_A, principal: HUMAN, path: "inbox/h.md", content: "x" }),
    );
    await expect(fs.stat(marker)).rejects.toThrow();
  });
});

describe("path confinement", () => {
  const attacks = [
    "../outside.md",
    `../${WS_B}/inbox/x.md`,
    "inbox/../../outside.md",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "C:/Windows/win.ini",
    "\\\\server\\share\\x.md",
    "//server/share/x.md",
    "inbox/a\u0000.md",
    ".git/config",
    "inbox/.git/hooks/pre-commit",
    "",
  ];

  it.each(attacks)("refuses %j for read, write, remove, list and history", async (attack) => {
    const denied = { ok: false, reason: "invalid_path" };
    expect(await store.read({ workspaceId: WS_A, path: attack })).toEqual(denied);
    expect(
      await store.write({ workspaceId: WS_A, principal: HUMAN, path: attack, content: "x" }),
    ).toEqual(denied);
    expect(await store.remove({ workspaceId: WS_A, principal: HUMAN, path: attack })).toEqual(
      denied,
    );
    expect(await store.history({ workspaceId: WS_A, path: attack })).toEqual(denied);
    if (attack !== "") expect(await store.list({ workspaceId: WS_A, dir: attack })).toEqual(denied);
    // Nothing was created outside or beside the repo.
    expect((await fs.readdir(root)).filter((name) => name !== WS_A)).toEqual([]);
  });

  it("refuses a symlink that points out of the repo", async (context) => {
    await store.ensureVault(WS_A);
    await store.write({
      workspaceId: WS_B,
      principal: HUMAN,
      path: "inbox/secret.md",
      content: "B's note",
    });
    const link = path.join(root, WS_A, "inbox", "link");
    try {
      await fs.symlink(path.join(root, WS_B, "inbox"), link, "junction");
    } catch {
      context.skip();
      return;
    }
    const denied = { ok: false, reason: "symlink_not_allowed" };
    expect(await store.read({ workspaceId: WS_A, path: "inbox/link/secret.md" })).toEqual(denied);
    expect(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/link/new.md",
        content: "x",
      }),
    ).toEqual(denied);
    expect(await store.list({ workspaceId: WS_A, dir: "inbox/link" })).toEqual(denied);
    await expect(fs.stat(path.join(root, WS_B, "inbox", "new.md"))).rejects.toThrow();
    const listed = value(await store.list({ workspaceId: WS_A, dir: "inbox" }));
    expect(listed.map((entry) => entry.name)).not.toContain("link");
  });
});

describe("workspace isolation", () => {
  it("never lets one workspace see or change another's vault", async () => {
    value(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: "inbox/only-a.md",
        content: "A",
      }),
    );
    value(
      await store.write({
        workspaceId: WS_B,
        principal: HUMAN,
        path: "inbox/only-b.md",
        content: "B",
      }),
    );
    expect(await store.read({ workspaceId: WS_B, path: "inbox/only-a.md" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await store.read({ workspaceId: WS_A, path: "inbox/only-b.md" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(git(path.join(root, WS_A), "log", "--format=%s", "--", "inbox/only-b.md")).toBe("");
    expect(
      value(await store.list({ workspaceId: WS_B, dir: "inbox" })).map((entry) => entry.name),
    ).toEqual([".gitkeep", "only-b.md"]);
  });

  it.each([
    "../escape",
    "not-a-uuid",
    "",
    `${WS_A}/../${WS_B}`,
    `${WS_A}\\x`,
    "11111111-1111-4111-8111-11111111111g",
  ])("refuses workspace id %j", async (workspaceId) => {
    const denied = { ok: false, reason: "invalid_workspace" };
    expect(await store.ensureVault(workspaceId)).toEqual(denied);
    expect(await store.read({ workspaceId, path: "inbox/a.md" })).toEqual(denied);
    expect(
      await store.write({ workspaceId, principal: HUMAN, path: "inbox/a.md", content: "x" }),
    ).toEqual(denied);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("treats workspace ids that differ only by case as one vault", async () => {
    await store.write({ workspaceId: WS_A, principal: HUMAN, path: "inbox/c.md", content: "x" });
    expect(
      value(await store.read({ workspaceId: WS_A.toUpperCase(), path: "inbox/c.md" })).content,
    ).toBe("x");
    expect(await fs.readdir(root)).toEqual([WS_A]);
  });
});

describe("human-only AGENTS.md", () => {
  const agentsPath = "_meta/AGENTS.md";

  it("lets a person write it and everyone read it", async () => {
    value(
      await store.write({
        workspaceId: WS_A,
        principal: HUMAN,
        path: agentsPath,
        content: "# Rules v2\n",
      }),
    );
    expect(value(await store.read({ workspaceId: WS_A, path: agentsPath })).content).toBe(
      "# Rules v2\n",
    );
    const history = value(await store.history({ workspaceId: WS_A, path: agentsPath }));
    expect(history[0]?.authorKind).toBe("human");
  });

  it.each([
    agentsPath,
    "_meta/agents.md",
    "_META/Agents.MD",
    "_meta/AGENTS.md.",
    "_meta/AGENTS.md ",
    "projects/AGENTS.md",
    "CLAUDE.md",
    "_boot/start.md",
  ])("refuses an agent write or remove on %j and leaves the file untouched", async (target) => {
    const before = value(await store.read({ workspaceId: WS_A, path: agentsPath })).content;
    const head = git(path.join(root, WS_A), "rev-parse", "HEAD");
    const denied = { ok: false, reason: "human_only_path" };
    expect(
      await store.write({ workspaceId: WS_A, principal: AGENT, path: target, content: "pwned" }),
    ).toEqual(denied);
    expect(await store.remove({ workspaceId: WS_A, principal: AGENT, path: target })).toEqual(
      denied,
    );
    expect(value(await store.read({ workspaceId: WS_A, path: agentsPath })).content).toBe(before);
    expect(git(path.join(root, WS_A), "rev-parse", "HEAD")).toBe(head);
    expect(git(path.join(root, WS_A), "status", "--porcelain")).toBe("");
  });

  it("lets an agent read it and write ordinary notes", async () => {
    expect((await store.read({ workspaceId: WS_A, path: agentsPath })).ok).toBe(true);
    expect(
      (
        await store.write({
          workspaceId: WS_A,
          principal: AGENT,
          path: "inbox/ok.md",
          content: "ok",
        })
      ).ok,
    ).toBe(true);
  });

  it("rejects a malformed or forged principal", async () => {
    const forged = { kind: "human", userId: "not-a-uuid" } as unknown as VaultPrincipal;
    const extra = { kind: "agent", agentId: AGENT_ID, isHuman: true } as unknown as VaultPrincipal;
    for (const principal of [forged, extra, undefined as unknown as VaultPrincipal]) {
      expect(
        await store.write({ workspaceId: WS_A, principal, path: agentsPath, content: "x" }),
      ).toEqual({
        ok: false,
        reason: "invalid_principal",
      });
    }
  });
});

describe("vault config", () => {
  it("reads the root and template from the environment with safe defaults", () => {
    const configured = loadVaultConfig(
      { VAULT_ROOT_DIR: "data/vaults", VAULT_TEMPLATE_DIR: "tpl" },
      root,
    );
    expect(configured).toEqual({
      rootDir: path.join(root, "data", "vaults"),
      templateDir: path.join(root, "tpl"),
    });
    const defaults = loadVaultConfig({}, root);
    expect(defaults.rootDir).toBe(path.join(root, ".vault-data"));
    expect(defaults.templateDir).toBe(defaultVaultTemplateDir());
  });
});
