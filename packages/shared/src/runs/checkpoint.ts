import { z } from "zod";

/**
 * The durable state of an agent run between tool calls (AGO-30). The loop writes it after every point
 * where a crash would otherwise lose work, and reads it back to resume without repeating a tool call.
 *
 * Content rules: tool inputs and results are stored already scrubbed and already cut to the loop's own caps
 * (the same text the model sees). The table that holds this has no grant for the API roles, so only the worker
 * reads it. A stored state that does not parse is never guessed at: the run fails, it does not restart.
 */
export const RUN_CHECKPOINT_VERSION = 1 as const;

/** Hard cap on one serialized state; the history window and per-result caps keep real states far below it. */
export const RUN_CHECKPOINT_MAX_BYTES = 1_000_000;

const count = z.number().int().nonnegative();

/** One tool result as the loop keeps it for the model (source label plus text). */
export const checkpointToolRecordSchema = z.strictObject({
  source: z.string().max(200),
  content: z.string().max(200_000),
});

/** What the loop learned from one finished tool call: enough to skip the call on resume. */
export const checkpointCallResultSchema = z.strictObject({
  record: checkpointToolRecordSchema,
  isError: z.boolean(),
  fingerprint: z.string().max(128),
  toolName: z.string().max(128),
});

export const CHECKPOINT_CALL_STATUS = ["pending", "started", "awaiting_approval", "done"] as const;

export const checkpointCallSchema = z.strictObject({
  call_id: z.string().min(1).max(128),
  name: z.string().max(128),
  input: z.unknown(),
  status: z.enum(CHECKPOINT_CALL_STATUS),
  /** Set while `awaiting_approval`: the hash the approval is bound to (AGO-34, AGO-21). */
  payload_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** Set once `done`. */
  result: checkpointCallResultSchema.optional(),
});

/** The step whose calls are not all done yet. A null step means the next thing to do is a model call. */
export const checkpointStepSchema = z.strictObject({
  step: z.number().int().min(1),
  calls: z.array(checkpointCallSchema).max(64),
  hadError: z.boolean(),
});

export const runCheckpointStateSchema = z.strictObject({
  version: z.literal(RUN_CHECKPOINT_VERSION),
  /** Steps started so far (the loop's counter), carried over so a crash cannot reset the step limit. */
  steps: count,
  /** Tokens used so far, carried over for the same reason. */
  tokens: count,
  /** Tool calls finished so far (any outcome); reported when a retry picks the run up (`run.recovered`). */
  completedCalls: count,
  /** Loop detection (AGO-166) state. */
  lastFingerprint: z.string().max(128),
  repeatCount: count,
  reportedDropped: count,
  /** The tool records the loop would still show the model; older ones were already dropped from context. */
  history: z.array(checkpointToolRecordSchema).max(1_000),
  step: checkpointStepSchema.nullable(),
});

export type CheckpointToolRecord = z.infer<typeof checkpointToolRecordSchema>;
export type CheckpointCall = z.infer<typeof checkpointCallSchema>;
export type CheckpointCallResult = z.infer<typeof checkpointCallResultSchema>;
export type CheckpointStep = z.infer<typeof checkpointStepSchema>;
export type RunCheckpointState = z.infer<typeof runCheckpointStateSchema>;

/** The empty state: a run that has done nothing yet. */
export function emptyRunCheckpointState(): RunCheckpointState {
  return {
    version: RUN_CHECKPOINT_VERSION,
    steps: 0,
    tokens: 0,
    completedCalls: 0,
    lastFingerprint: "",
    repeatCount: 0,
    reportedDropped: 0,
    history: [],
    step: null,
  };
}

/** Result of reading a stored state: ok, or a reason code (never the stored content). */
export type ParsedCheckpoint =
  | { readonly ok: true; readonly state: RunCheckpointState }
  | { readonly ok: false; readonly reason: "invalid" | "unsupported_version" };

export function parseRunCheckpointState(value: unknown): ParsedCheckpoint {
  const version = (value as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version !== RUN_CHECKPOINT_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  const parsed = runCheckpointStateSchema.safeParse(value);
  return parsed.success ? { ok: true, state: parsed.data } : { ok: false, reason: "invalid" };
}
