import type { VaultCommitInfo, VaultDenialReason, VaultPrincipal } from "@ago/shared";

/**
 * The vault service contract (AGO-121). Everything that reads or writes a workspace's vault goes through
 * this interface; the git backend is one implementation. Later tickets build on it: the write tool with
 * checkpoints (AGO-144), provenance (AGO-165) and backups (AGO-109).
 *
 * Every call takes a workspace id and a vault-relative path, never a repo location. A denial carries a
 * reason code only, never note content. Vault text is untrusted data.
 */
export type VaultResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: VaultDenialReason };

export interface VaultEntry {
  readonly name: string;
  /** Vault-relative path with forward slashes. */
  readonly path: string;
  readonly type: "file" | "dir";
}

export interface VaultStore {
  /** Create the workspace's repo from the starter template if it does not exist. Idempotent and race safe. */
  ensureVault(workspaceId: string): Promise<VaultResult<{ readonly created: boolean }>>;

  read(input: {
    readonly workspaceId: string;
    readonly path: string;
  }): Promise<VaultResult<{ readonly content: string }>>;

  /** `principal` must come from trusted code. Agents cannot write human-only paths (`_meta/AGENTS.md`). */
  write(input: {
    readonly workspaceId: string;
    readonly principal: VaultPrincipal;
    readonly path: string;
    readonly content: string;
    readonly message?: string | undefined;
  }): Promise<VaultResult<{ readonly sha: string; readonly changed: boolean }>>;

  remove(input: {
    readonly workspaceId: string;
    readonly principal: VaultPrincipal;
    readonly path: string;
    readonly message?: string | undefined;
  }): Promise<VaultResult<{ readonly sha: string }>>;

  /** List one folder (the vault root when `dir` is omitted). */
  list(input: {
    readonly workspaceId: string;
    readonly dir?: string | undefined;
  }): Promise<VaultResult<readonly VaultEntry[]>>;

  /** Commits that touched the path, newest first, with the principal that made each one. */
  history(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly limit?: number | undefined;
  }): Promise<VaultResult<readonly VaultCommitInfo[]>>;
}
