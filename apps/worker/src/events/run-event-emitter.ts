import { RUN_EVENT_TYPES, RUN_EVENT_VERSION, runEventSchema, toRunEventColumns } from "@ago/shared";

import type { Logger } from "../logger.js";
import type { RunEventInput, RunEventType } from "@ago/shared";

/** A row as stored: only what the database hands back. `seq` is assigned by the database (AGO-102). */
export interface StoredRunEvent {
  readonly id: string;
  readonly seq: number;
  readonly created_at: string;
}

export interface RunEventRow {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly type: RunEventType;
  readonly payload: Record<string, unknown>;
}

/**
 * Persistence port. The implementation must insert WITHOUT a `seq` so the database assigns the
 * next per-run number under its advisory lock; the emitter never invents sequence numbers.
 */
export interface RunEventStore {
  insert(row: RunEventRow): Promise<StoredRunEvent>;
}

/** What the agent tool loop (AGO-167) and other runtime code depends on. */
export interface RunEventEmitter {
  /** Validate, then append. Rejects (and writes nothing) when the event does not match its schema. */
  emit(event: RunEventInput): Promise<StoredRunEvent>;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** An event failed its schema. Carries paths and messages only, never the offending values. */
export class RunEventValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(`invalid run event: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "RunEventValidationError";
    this.issues = issues;
  }
}

/** The store failed. The cause is kept for debugging; the message never includes the payload. */
export class RunEventWriteError extends Error {
  constructor(eventType: string, cause: unknown) {
    super(`could not write run event "${eventType}"`, { cause });
    this.name = "RunEventWriteError";
  }
}

export interface RunEventEmitterOptions {
  readonly workspaceId: string;
  readonly runId: string;
  readonly store: RunEventStore;
  /** Optional; use `withContext` so lines carry run/agent/workspace ids. Only type and seq are logged. */
  readonly logger?: Logger;
}

/** Zod embeds caller-supplied key names in this message, so it is replaced with a fixed one. */
const UNRECOGNIZED_KEYS_CODE = "unrecognized_keys";

function toIssues(error: {
  issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[];
}): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.code === UNRECOGNIZED_KEYS_CODE ? "Unrecognized key" : issue.message,
  }));
}

/** Caller strings are never logged: only a type the schema knows is safe to record. */
function loggableType(type: unknown): string {
  return RUN_EVENT_TYPES.find((known) => known === type) ?? "unknown";
}

/** Emitter bound to one workspace and run. Every event is validated against `runEventSchema` first. */
export function createRunEventEmitter(options: RunEventEmitterOptions): RunEventEmitter {
  const { workspaceId, runId, store, logger } = options;
  return {
    async emit(input: RunEventInput): Promise<StoredRunEvent> {
      const candidate = { type: input.type, version: RUN_EVENT_VERSION, payload: input.payload };
      const parsed = runEventSchema.safeParse(candidate);
      if (!parsed.success) {
        const issues = toIssues(parsed.error);
        logger?.warn({ event_type: loggableType(input.type), issues }, "run event rejected");
        throw new RunEventValidationError(issues);
      }
      const columns = toRunEventColumns(parsed.data);
      try {
        const stored = await store.insert({
          workspace_id: workspaceId,
          run_id: runId,
          type: columns.type,
          payload: columns.payload,
        });
        logger?.debug({ event_type: columns.type, seq: stored.seq }, "run event written");
        return stored;
      } catch (error) {
        logger?.error({ event_type: columns.type }, "run event write failed");
        throw new RunEventWriteError(columns.type, error);
      }
    },
  };
}
