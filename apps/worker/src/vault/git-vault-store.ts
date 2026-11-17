import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  VAULT_COMMIT_MESSAGE_MAX_LENGTH,
  VAULT_NOTE_MAX_BYTES,
  formatVaultAuthorName,
  isVaultHumanOnlyPath,
  parseVaultAuthorName,
  validateVaultPath,
  vaultPrincipalSchema,
  vaultWorkspaceIdSchema,
} from "@ago/shared";

import type { VaultConfig } from "./vault-config.js";
import type { VaultEntry, VaultResult, VaultStore } from "./vault-store.js";
import type { VaultCommitInfo, VaultDenialReason, VaultPrincipal } from "@ago/shared";

/**
 * Git-backed vault store (AGO-121). One repository per workspace at `<rootDir>/<workspace_id>`.
 *
 * Safety rules, all enforced here and tested:
 * - The repo location comes only from a validated UUID; callers never pass a location.
 * - Every path is checked lexically (`validateVaultPath`) and then on disk: a symlink anywhere on the path
 *   is refused, so nothing resolves outside the workspace's repo.
 * - Git never runs through a shell. Arguments are an array of fixed subcommands; user text goes only after
 *   `--` (a literal pathspec) or on stdin (the commit message), so it can never become a flag.
 * - The git environment is rebuilt from scratch: no user or system config, no hooks, no prompts.
 * - Agents cannot write or remove human-only paths (`_meta/AGENTS.md` and other boot files).
 * - Failures return a reason code and never the note content or the underlying error text.
 */

/** `os.devNull` is `\\.\nul` on Windows, which git cannot open; `NUL` works there. */
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const SYSTEM_AUTHOR = { name: "vault-service", email: "vault-service@vault.invalid" } as const;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;
const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const PASSTHROUGH_ENV = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
];

interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

function ok<T>(value: T): VaultResult<T> {
  return { ok: true, value };
}

function deny(reason: VaultDenialReason): {
  readonly ok: false;
  readonly reason: VaultDenialReason;
} {
  return { ok: false, reason };
}

class VaultDenied extends Error {
  constructor(readonly reason: VaultDenialReason) {
    super(reason);
  }
}

function gitEnv(author: GitAuthor): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

/** Fixed config for every call: no hooks, no line-ending or symlink magic, no signing, no filesystem monitor. */
const GIT_CONFIG_ARGS = [
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.symlinks=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "gc.auto=0",
] as const;

function runGit(
  cwd: string,
  args: readonly string[],
  author: GitAuthor,
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: `shell: false` and an argument array.
    const child = spawn("git", [...GIT_CONFIG_ARGS, ...args], {
      cwd,
      env: gitEnv(author),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(
            `git exited with ${String(code)}: ${Buffer.concat(err).toString("utf8").slice(0, 300)}`,
          ),
        );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
  });
}

function authorFor(principal: VaultPrincipal): GitAuthor {
  const name = formatVaultAuthorName(principal);
  const id = principal.kind === "human" ? principal.userId : principal.agentId;
  return { name, email: `${id}@vault.invalid` };
}

function cleanMessage(message: string | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are stripped on purpose
  const flat = (message ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const subject = flat.slice(0, VAULT_COMMIT_MESSAGE_MAX_LENGTH);
  return subject === "" ? fallback : subject;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

export class GitVaultStore implements VaultStore {
  private readonly rootDir: string;
  private readonly templateDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly provisioning = new Map<string, Promise<boolean>>();

  constructor(config: VaultConfig) {
    this.rootDir = path.resolve(config.rootDir);
    this.templateDir = path.resolve(config.templateDir);
  }

  async ensureVault(workspaceId: string): Promise<VaultResult<{ readonly created: boolean }>> {
    return this.guard(async () => ok({ created: await this.provision(this.repoDir(workspaceId)) }));
  }

  async read(input: {
    readonly workspaceId: string;
    readonly path: string;
  }): Promise<VaultResult<{ readonly content: string }>> {
    return this.guard(async () => {
      const repo = this.repoDir(input.workspaceId);
      await this.provision(repo);
      const file = await this.resolveExisting(repo, input.path);
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new VaultDenied("not_a_file");
      if (stat.size > VAULT_NOTE_MAX_BYTES) throw new VaultDenied("too_large");
      return ok({ content: await fs.readFile(file, "utf8") });
    });
  }

  async write(input: {
    readonly workspaceId: string;
    readonly principal: VaultPrincipal;
    readonly path: string;
    readonly content: string;
    readonly message?: string | undefined;
  }): Promise<VaultResult<{ readonly sha: string; readonly changed: boolean }>> {
    return this.guard(async () => {
      const principal = this.parsePrincipal(input.principal);
      const repo = this.repoDir(input.workspaceId);
      const rel = this.checkWritablePath(principal, input.path);
      if (typeof input.content !== "string" || input.content.includes("\u0000")) {
        throw new VaultDenied("invalid_content");
      }
      // A lone surrogate does not survive UTF-8, so the round trip changes it.
      if (Buffer.from(input.content, "utf8").toString("utf8") !== input.content) {
        throw new VaultDenied("invalid_content");
      }
      if (Buffer.byteLength(input.content, "utf8") > VAULT_NOTE_MAX_BYTES) {
        throw new VaultDenied("too_large");
      }
      return this.withLock<VaultResult<{ readonly sha: string; readonly changed: boolean }>>(
        repo,
        async () => {
          await this.provision(repo);
          const target = await this.resolveForWrite(repo, rel);
          const previous = await this.readPrevious(target);
          const author = authorFor(principal);
          if (previous === input.content) {
            return ok({ sha: await this.head(repo), changed: false });
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          const temp = path.join(path.dirname(target), `.vault-tmp-${randomUUID()}`);
          try {
            await fs.writeFile(temp, input.content, { encoding: "utf8", flag: "wx" });
            await fs.rename(temp, target);
            await runGit(repo, ["add", "--", rel], author);
            await this.commit(repo, principal, cleanMessage(input.message, `Update ${rel}`));
          } catch (error) {
            await fs.rm(temp, { force: true }).catch(() => undefined);
            await this.rollback(repo, rel, target, previous, author);
            throw error;
          }
          return ok({ sha: await this.head(repo), changed: true });
        },
      );
    });
  }

  async remove(input: {
    readonly workspaceId: string;
    readonly principal: VaultPrincipal;
    readonly path: string;
    readonly message?: string | undefined;
  }): Promise<VaultResult<{ readonly sha: string }>> {
    return this.guard(async () => {
      const principal = this.parsePrincipal(input.principal);
      const repo = this.repoDir(input.workspaceId);
      const rel = this.checkWritablePath(principal, input.path);
      return this.withLock(repo, async () => {
        await this.provision(repo);
        const target = await this.resolveExisting(repo, rel);
        const stat = await fs.lstat(target);
        if (!stat.isFile()) throw new VaultDenied("not_a_file");
        const previous = await fs.readFile(target, "utf8");
        const author = authorFor(principal);
        try {
          await runGit(repo, ["rm", "-q", "--", rel], author);
          await this.commit(repo, principal, cleanMessage(input.message, `Remove ${rel}`));
        } catch (error) {
          await this.rollback(repo, rel, target, previous, author);
          throw error;
        }
        return ok({ sha: await this.head(repo) });
      });
    });
  }

  async list(input: {
    readonly workspaceId: string;
    readonly dir?: string | undefined;
  }): Promise<VaultResult<readonly VaultEntry[]>> {
    return this.guard(async () => {
      const repo = this.repoDir(input.workspaceId);
      await this.provision(repo);
      const rel = input.dir === undefined || input.dir === "" ? "" : this.checkPath(input.dir);
      const dir = rel === "" ? repo : await this.resolveExisting(repo, rel);
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory()) throw new VaultDenied("not_a_file");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const result: VaultEntry[] = [];
      for (const entry of entries) {
        if (rel === "" && entry.name === ".git") continue;
        if (entry.name.startsWith(".vault-tmp-")) continue;
        if (entry.isSymbolicLink()) continue;
        if (!entry.isFile() && !entry.isDirectory()) continue;
        result.push({
          name: entry.name,
          path: rel === "" ? entry.name : `${rel}/${entry.name}`,
          type: entry.isDirectory() ? "dir" : "file",
        });
      }
      result.sort((a, b) => a.path.localeCompare(b.path));
      return ok(result);
    });
  }

  async history(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly limit?: number | undefined;
  }): Promise<VaultResult<readonly VaultCommitInfo[]>> {
    return this.guard(async () => {
      const repo = this.repoDir(input.workspaceId);
      const rel = this.checkPath(input.path);
      await this.provision(repo);
      await this.assertNoSymlink(repo, rel);
      const limit = Math.min(
        Math.max(Math.trunc(input.limit ?? DEFAULT_HISTORY_LIMIT), 1),
        MAX_HISTORY_LIMIT,
      );
      const format = ["%H", "%an", "%aI", "%s", "%b"].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
      const raw = await runGit(
        repo,
        ["log", `-n${String(limit)}`, `--format=${format}`, "--", rel],
        SYSTEM_AUTHOR,
      );
      return ok(raw.split(RECORD_SEPARATOR).flatMap((record) => parseCommit(record)));
    });
  }

  // --- internals ---------------------------------------------------------------------------------------

  private async guard<T>(operation: () => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof VaultDenied) return deny(error.reason);
      return deny("store_failed");
    }
  }

  /** Repo folder for a workspace. Only a UUID gets through, so the id can never carry a path. */
  private repoDir(workspaceId: string): string {
    const parsed = vaultWorkspaceIdSchema.safeParse(workspaceId);
    if (!parsed.success) throw new VaultDenied("invalid_workspace");
    return path.join(this.rootDir, parsed.data.toLowerCase());
  }

  private parsePrincipal(principal: unknown): VaultPrincipal {
    const parsed = vaultPrincipalSchema.safeParse(principal);
    if (!parsed.success) throw new VaultDenied("invalid_principal");
    return parsed.data;
  }

  private checkPath(input: string): string {
    if (typeof input !== "string") throw new VaultDenied("invalid_path");
    const result = validateVaultPath(input);
    if (!result.ok) throw new VaultDenied("invalid_path");
    return result.path;
  }

  private checkWritablePath(principal: VaultPrincipal, input: string): string {
    const rel = this.checkPath(input);
    if (principal.kind === "agent" && isVaultHumanOnlyPath(rel)) {
      throw new VaultDenied("human_only_path");
    }
    return rel;
  }

  /** Refuse a symlink on any existing component of the path. Stops at the first missing component. */
  private async assertNoSymlink(repo: string, rel: string): Promise<void> {
    const repoStat = await fs.lstat(repo);
    if (repoStat.isSymbolicLink()) throw new VaultDenied("symlink_not_allowed");
    let current = repo;
    for (const segment of rel.split("/")) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new VaultDenied("symlink_not_allowed");
    }
  }

  private async resolveExisting(repo: string, input: string): Promise<string> {
    const rel = this.checkPath(input);
    await this.assertNoSymlink(repo, rel);
    const target = path.join(repo, ...rel.split("/"));
    if (!(await exists(target))) throw new VaultDenied("not_found");
    return target;
  }

  private async resolveForWrite(repo: string, rel: string): Promise<string> {
    await this.assertNoSymlink(repo, rel);
    const target = path.join(repo, ...rel.split("/"));
    const relative = path.relative(repo, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new VaultDenied("invalid_path");
    }
    return target;
  }

  private async readPrevious(target: string): Promise<string | null> {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile()) throw new VaultDenied("not_a_file");
    return fs.readFile(target, "utf8");
  }

  private async commit(repo: string, principal: VaultPrincipal, subject: string): Promise<void> {
    const trailer =
      principal.kind === "agent" && principal.runId !== undefined
        ? `\n\nAgent-Run: ${principal.runId}`
        : "";
    await runGit(
      repo,
      ["commit", "-q", "--no-verify", "--no-gpg-sign", "-F", "-"],
      authorFor(principal),
      `${subject}${trailer}\n`,
    );
  }

  private async head(repo: string): Promise<string> {
    return (await runGit(repo, ["rev-parse", "HEAD"], SYSTEM_AUTHOR)).trim();
  }

  /** Put one path back to what it was before a failed write or remove: unstage it and restore its content. */
  private async rollback(
    repo: string,
    rel: string,
    target: string,
    previous: string | null,
    author: GitAuthor,
  ): Promise<void> {
    try {
      await runGit(repo, ["reset", "-q", "--", rel], author);
    } catch {
      // Nothing staged for this path; carry on restoring the file.
    }
    try {
      if (previous === null) await fs.rm(target, { force: true });
      else await fs.writeFile(target, previous, "utf8");
    } catch {
      // Best effort: the caller still receives `store_failed`.
    }
  }

  private async withLock<T>(repo: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(repo) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.locks.set(repo, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(repo) === tail) this.locks.delete(repo);
    }
  }

  /**
   * Create the repo if it is missing. Returns true when this call created it. Built in a temp folder and
   * renamed into place, so two callers racing on first access (in this process or another) never see or
   * leave a half-built repo: the loser discards its copy and uses the winner's.
   */
  private provision(repo: string): Promise<boolean> {
    const pending = this.provisioning.get(repo);
    if (pending) return pending.then(() => false);
    const run = this.provisionOnce(repo).finally(() => this.provisioning.delete(repo));
    this.provisioning.set(repo, run);
    return run;
  }

  private async provisionOnce(repo: string): Promise<boolean> {
    if (await exists(path.join(repo, ".git", "HEAD"))) return false;
    await fs.mkdir(this.rootDir, { recursive: true });
    const temp = path.join(this.rootDir, `.provision-${randomUUID()}`);
    try {
      await fs.cp(this.templateDir, temp, {
        recursive: true,
        filter: async (source) => {
          if (path.basename(source) === ".git") return false;
          return !(await fs.lstat(source)).isSymbolicLink();
        },
      });
      await runGit(temp, ["init", "-q", "--initial-branch=main", "--template="], SYSTEM_AUTHOR);
      await runGit(temp, ["add", "-A"], SYSTEM_AUTHOR);
      await runGit(
        temp,
        ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "Initialize vault"],
        SYSTEM_AUTHOR,
      );
      try {
        await fs.rename(temp, repo);
        return true;
      } catch {
        // Another caller won the race, or something else sits at the repo path.
        if (await exists(path.join(repo, ".git", "HEAD"))) return false;
        throw new VaultDenied("store_failed");
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function parseCommit(record: string): VaultCommitInfo[] {
  const trimmed = record.replace(/^\n+/, "");
  if (trimmed === "") return [];
  const [sha, authorName, at, subject, body] = trimmed.split(FIELD_SEPARATOR);
  if (sha === undefined || authorName === undefined || at === undefined) return [];
  const author = parseVaultAuthorName(authorName);
  const runMatch = /^Agent-Run: ([0-9a-f-]{36})$/im.exec(body ?? "");
  return [
    {
      sha,
      authorKind: author?.kind ?? "unknown",
      authorId: author?.id ?? null,
      runId: runMatch?.[1]?.toLowerCase() ?? null,
      at,
      message: subject ?? "",
    },
  ];
}
