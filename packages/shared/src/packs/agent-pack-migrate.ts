import type { z } from "zod";

import {
  agentPackSchema,
  findSecretShape,
  PACK_VERSION,
  type AgentPack,
} from "./agent-pack-schemas.js";

/**
 * Pack versions and the single entry point that reads a pack (AGO-191). Export writes `PACK_VERSION`;
 * everything that reads a pack calls `parseAgentPack`, so migration and validation never drift apart.
 */

export type PackRecord = Record<string, unknown>;

/** Upgrades a pack from version N to N+1. Pure; must not add secrets, ids or anything not in the old pack. */
export type PackMigration = (pack: PackRecord) => PackRecord;

/**
 * Steps keyed by the version they upgrade FROM. Empty at v1: there is no older format yet. When v2 ships,
 * add `1: (pack) => ({ ...pack, packVersion: 2, ... })` here and bump `PACK_VERSION`.
 */
export const PACK_MIGRATIONS: Readonly<Record<number, PackMigration>> = {};

export interface PackIssue {
  /** Dotted field path, such as `agents.0.name`. Empty for the pack as a whole. */
  path: string;
  message: string;
}

export type PackMigrationResult =
  { ok: true; pack: PackRecord; fromVersion: number } | { ok: false; issues: PackIssue[] };

export type ParseAgentPackResult =
  { ok: true; pack: AgentPack; fromVersion: number } | { ok: false; issues: PackIssue[] };

const VERSION_PATH = "packVersion";

function fail(path: string, message: string): { ok: false; issues: PackIssue[] } {
  return { ok: false, issues: [{ path, message }] };
}

function isRecord(value: unknown): value is PackRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Brings a pack of any known older version up to `PACK_VERSION`, without validating its content.
 * `packVersion` is required and must be a whole number of 1 or more. A newer version than this app knows,
 * or a gap in the chain, is refused with a clear message instead of guessed at.
 */
export function migrateAgentPack(
  input: unknown,
  migrations: Readonly<Record<number, PackMigration>> = PACK_MIGRATIONS,
  currentVersion: number = PACK_VERSION,
): PackMigrationResult {
  if (!isRecord(input)) return fail("", "A pack must be a JSON object.");
  const version = input[VERSION_PATH];
  if (version === undefined) return fail(VERSION_PATH, "packVersion is required.");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return fail(VERSION_PATH, "packVersion must be a whole number of 1 or more.");
  }
  if (version > currentVersion) {
    return fail(
      VERSION_PATH,
      `This pack is version ${String(version)}, newer than this app understands (version ${String(currentVersion)}). Update the app.`,
    );
  }

  let pack: PackRecord = input;
  for (let from = version; from < currentVersion; from += 1) {
    const step = migrations[from];
    if (!step) return fail(VERSION_PATH, `No migration from pack version ${String(from)}.`);
    pack = step(pack);
    if (pack[VERSION_PATH] !== from + 1) {
      return fail(
        VERSION_PATH,
        `Migration from pack version ${String(from)} did not set packVersion ${String(from + 1)}.`,
      );
    }
  }
  return { ok: true, pack, fromVersion: version };
}

/** Shown instead of a path segment (a field name) that looks like a secret. */
const REDACTED_SEGMENT = "(secret-looking name)";

/** Dotted path of a Zod issue (`agents.0.name`). A secret-shaped field name is never written into a path. */
export function formatPackPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => {
      const text = String(segment);
      return typeof segment === "string" && findSecretShape(text) ? REDACTED_SEGMENT : text;
    })
    .join(".");
}

/**
 * The one place a Zod issue becomes a pack issue, shared by the API, the CLI and export. An unrecognized field
 * is reported as the parent path plus a count and never by name: pack text is untrusted and a field name can be
 * a pasted secret. Other messages are Zod's own, which never carry the offending value.
 */
export function formatPackIssue(issue: z.core.$ZodIssue): PackIssue {
  const path = formatPackPath(issue.path);
  if (issue.code === "unrecognized_keys") {
    const count = issue.keys.length;
    return {
      path,
      message: `${String(count)} unrecognized field${count === 1 ? "" : "s"}.`,
    };
  }
  return { path, message: issue.message };
}

/** Migrate, then validate. Unknown fields, wrong types and secret-looking values come back with their path. */
export function parseAgentPack(
  input: unknown,
  migrations: Readonly<Record<number, PackMigration>> = PACK_MIGRATIONS,
): ParseAgentPackResult {
  const migrated = migrateAgentPack(input, migrations);
  if (!migrated.ok) return migrated;
  const parsed = agentPackSchema.safeParse(migrated.pack);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(formatPackIssue),
    };
  }
  return { ok: true, pack: parsed.data, fromVersion: migrated.fromVersion };
}
