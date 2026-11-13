import { createHash, randomUUID } from "node:crypto";

/**
 * Own-notes revert (AGO-43). In Relaxed mode the policy engine lets `vault.write_own` (Tier 2) run
 * without approval (`allowed_tier2_own_notes`). That is only safe because every such edit can be
 * undone: the write tool must call `recordOwnNoteEdit` BEFORE it writes, and a person (or the agent
 * for its own note) can call `revertOwnNoteEdit` afterwards.
 *
 * Fail closed: a revert is refused when the record belongs to another workspace or agent, was already
 * reverted, or the note changed after the edit (someone else wrote to it; reverting would destroy that).
 * Note content is never logged and never put in an error message.
 *
 * No vault write tool exists yet and records live in memory behind `OwnNoteRevertStore`; the Postgres
 * store is a follow-up (owner-approved deferral).
 */

export interface OwnNoteEditRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly noteId: string;
  /** Content before the edit; null when the edit created the note. */
  readonly previousContent: string | null;
  readonly appliedHash: string;
  readonly createdAt: string;
  readonly isReverted: boolean;
}

export interface OwnNoteRevertStore {
  save(record: OwnNoteEditRecord): Promise<void>;
  get(workspaceId: string, id: string): Promise<OwnNoteEditRecord | null>;
  markReverted(workspaceId: string, id: string): Promise<void>;
}

export function createInMemoryOwnNoteRevertStore(): OwnNoteRevertStore {
  const records = new Map<string, OwnNoteEditRecord>();
  const key = (workspaceId: string, id: string): string => `${workspaceId}:${id}`;
  return {
    save(record) {
      records.set(key(record.workspaceId, record.id), record);
      return Promise.resolve();
    },
    get(workspaceId, id) {
      return Promise.resolve(records.get(key(workspaceId, id)) ?? null);
    },
    markReverted(workspaceId, id) {
      const record = records.get(key(workspaceId, id));
      if (record !== undefined) records.set(key(workspaceId, id), { ...record, isReverted: true });
      return Promise.resolve();
    },
  };
}

export function hashNoteContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface OwnNoteEditInput {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly noteId: string;
  readonly previousContent: string | null;
  readonly newContent: string;
}

/** Snapshot an own-note edit. Call before writing; if this throws, do not write. */
export async function recordOwnNoteEdit(
  store: OwnNoteRevertStore,
  input: OwnNoteEditInput,
  now: () => Date = () => new Date(),
): Promise<OwnNoteEditRecord> {
  const record: OwnNoteEditRecord = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    noteId: input.noteId,
    previousContent: input.previousContent,
    appliedHash: hashNoteContent(input.newContent),
    createdAt: now().toISOString(),
    isReverted: false,
  };
  await store.save(record);
  return record;
}

export const REVERT_REFUSAL_CODES = [
  "not_found",
  "wrong_agent",
  "already_reverted",
  "note_changed",
] as const;
export type RevertRefusalCode = (typeof REVERT_REFUSAL_CODES)[number];

export type OwnNoteRevertResult =
  | { readonly outcome: "reverted"; readonly previousContent: string | null }
  | { readonly outcome: "refused"; readonly reasonCode: RevertRefusalCode };

/**
 * Undo one edit. `currentContent` is the note as it is now (null when it does not exist). Returns the
 * content to restore (null means delete the note); the caller writes it. Workspace scoped: another
 * workspace's record is `not_found`.
 */
export async function revertOwnNoteEdit(
  store: OwnNoteRevertStore,
  request: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly recordId: string;
    readonly currentContent: string | null;
  },
): Promise<OwnNoteRevertResult> {
  const record = await store.get(request.workspaceId, request.recordId);
  if (record === null) return { outcome: "refused", reasonCode: "not_found" };
  if (record.agentId !== request.agentId) return { outcome: "refused", reasonCode: "wrong_agent" };
  if (record.isReverted) return { outcome: "refused", reasonCode: "already_reverted" };
  if (
    request.currentContent === null ||
    hashNoteContent(request.currentContent) !== record.appliedHash
  ) {
    return { outcome: "refused", reasonCode: "note_changed" };
  }
  await store.markReverted(request.workspaceId, request.recordId);
  return { outcome: "reverted", previousContent: record.previousContent };
}
