import { z } from "zod";

import { classifyBootPath } from "../self-modification/self-modification-schemas.js";

/**
 * Vault contracts (AGO-121). Every workspace has one git repository holding its Markdown vault. These are
 * the pure, dependency-free pieces shared by the worker service and any caller: the starter layout, the
 * principal that authors a change, and the lexical path check. Vault text is untrusted data.
 */

/** Top-level folders every new vault starts with (each has a `.gitkeep` in `vault-template/`). */
export const VAULT_TOP_DIRS = [
  "_meta",
  "agents",
  "skills",
  "projects",
  "tasks",
  "inbox",
  "logs",
] as const;

/** Human-edit-only instructions file, stored under `_meta`. */
export const VAULT_AGENTS_FILE = "_meta/AGENTS.md";

export const VAULT_PATH_MAX_LENGTH = 512;
export const VAULT_NOTE_MAX_BYTES = 1024 * 1024;
export const VAULT_COMMIT_MESSAGE_MAX_LENGTH = 200;

export const vaultWorkspaceIdSchema = z.uuid();

/**
 * Who authors a change. It comes from trusted code (the session or the run), never from vault or model text.
 * The git author is derived from it so provenance (AGO-165) can read it back.
 */
export const vaultPrincipalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), userId: z.uuid() }),
  z.strictObject({ kind: z.literal("agent"), agentId: z.uuid(), runId: z.uuid().optional() }),
]);
export type VaultPrincipal = z.infer<typeof vaultPrincipalSchema>;

export function formatVaultAuthorName(principal: VaultPrincipal): string {
  return principal.kind === "human" ? `human:${principal.userId}` : `agent:${principal.agentId}`;
}

const AUTHOR_NAME_PATTERN =
  /^(human|agent):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Inverse of `formatVaultAuthorName`; null for anything else (for example a commit made outside the service). */
export function parseVaultAuthorName(name: string): { kind: "human" | "agent"; id: string } | null {
  const match = AUTHOR_NAME_PATTERN.exec(name);
  if (!match) return null;
  return { kind: match[1] === "human" ? "human" : "agent", id: (match[2] ?? "").toLowerCase() };
}

export type VaultPathRejection =
  | "empty"
  | "too_long"
  | "nul_or_control"
  | "absolute"
  | "drive_or_unc"
  | "backslash"
  | "traversal"
  | "empty_segment"
  | "git_internal"
  | "ambiguous_name";

export type VaultPathResult =
  | { readonly ok: true; readonly path: string; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: VaultPathRejection };

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DRIVE_LETTER = /^[a-zA-Z]:/;
const SHORT_NAME = /~\d/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

/**
 * Lexical check of a vault-relative path (forward slashes only). It accepts nothing that could leave the
 * repo: no NUL or control characters, no absolute, drive-letter or UNC form, no backslash, no `.` or `..`
 * or empty segment, and nothing inside `.git`. The worker also checks the real filesystem (symlinks).
 */
export function validateVaultPath(input: string): VaultPathResult {
  if (input.length === 0) return { ok: false, reason: "empty" };
  if (input.length > VAULT_PATH_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (CONTROL_CHARACTERS.test(input)) return { ok: false, reason: "nul_or_control" };
  if (input.includes("\\")) return { ok: false, reason: "backslash" };
  if (DRIVE_LETTER.test(input) || input.startsWith("//")) {
    return { ok: false, reason: "drive_or_unc" };
  }
  if (input.startsWith("/")) return { ok: false, reason: "absolute" };
  const segments = input.split("/");
  for (const segment of segments) {
    if (segment === "") return { ok: false, reason: "empty_segment" };
    if (segment === "." || segment === "..") return { ok: false, reason: "traversal" };
    // Windows drops trailing dots and spaces, so `..` and `.git` can hide behind them.
    const trimmed = segment.replace(/[. ]+$/, "").toLowerCase();
    if (trimmed === "") return { ok: false, reason: "traversal" };
    if (trimmed === ".git" || trimmed.startsWith(".git~") || trimmed === "git~1") {
      return { ok: false, reason: "git_internal" };
    }
    // NTFS 8.3 short names (`AGENTS~1.MD`) and device names (`NUL`, `COM1`) can alias another file.
    if (SHORT_NAME.test(trimmed) || DEVICE_NAME.test(trimmed)) {
      return { ok: false, reason: "ambiguous_name" };
    }
    // `:` is a drive separator or an NTFS alternate data stream on Windows.
    if (segment.includes(":")) return { ok: false, reason: "drive_or_unc" };
  }
  return { ok: true, path: input, segments };
}

/** True when only a person may write or remove this path (AGENTS.md and other boot files, AGO-154). */
export function isVaultHumanOnlyPath(path: string): boolean {
  // Windows ignores trailing dots and spaces (`AGENTS.md.` is `AGENTS.md`), so strip them before matching.
  const normalized = path
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.replace(/[. ]+$/, "") || segment)
    .join("/");
  return classifyBootPath(path) || classifyBootPath(normalized);
}

export const VAULT_DENIAL_REASONS = [
  "invalid_workspace",
  "invalid_path",
  "invalid_principal",
  "human_only_path",
  "symlink_not_allowed",
  "not_found",
  "not_a_file",
  "too_large",
  "invalid_content",
  "store_failed",
] as const;
export type VaultDenialReason = (typeof VAULT_DENIAL_REASONS)[number];

export interface VaultCommitInfo {
  readonly sha: string;
  readonly authorKind: "human" | "agent" | "unknown";
  readonly authorId: string | null;
  readonly runId: string | null;
  readonly at: string;
  readonly message: string;
}
