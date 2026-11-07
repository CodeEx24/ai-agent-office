import { z } from "zod";

/** The pg-boss queue that carries runs to the worker. */
export const RUN_QUEUE = "agent-run";
/** Jobs that failed every attempt land here and stay visible (health reports the count). */
export const RUN_DEAD_LETTER_QUEUE = "agent-run-dead";

/** Longest a handler may run before pg-boss treats the job as abandoned and retries it. */
export const RUN_JOB_EXPIRE_SECONDS = 900;

/** Retry policy: exponential backoff (jitter included by pg-boss), capped, then dead-letter. */
export interface RunRetryPolicy {
  /** Retries after the first attempt, so the job runs at most `retryLimit + 1` times. */
  readonly retryLimit: number;
  /** Base delay in seconds; the backoff roughly doubles it per retry. */
  readonly retryDelaySeconds: number;
  /** Upper bound for a single backoff delay, in seconds. */
  readonly retryDelayMaxSeconds: number;
  readonly expireInSeconds: number;
}

export const DEFAULT_RUN_RETRY_POLICY: RunRetryPolicy = {
  retryLimit: 4,
  retryDelaySeconds: 5,
  retryDelayMaxSeconds: 300,
  expireInSeconds: RUN_JOB_EXPIRE_SECONDS,
};

/**
 * What a job carries: a run reference, ids only. Never a prompt, a credential or any run content;
 * the worker reads everything else from the database under the workspace scope.
 */
export const runJobSchema = z.strictObject({
  workspace_id: z.uuid(),
  run_id: z.uuid(),
});
export type RunJobPayload = z.infer<typeof runJobSchema>;

/** A caller-chosen idempotency key: short, printable, no surprises in a database key. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w.:@/-]+$/, "use letters, digits and . _ : @ / -");

/**
 * The pg-boss `singletonKey`. It is scoped to the workspace so one tenant's key can never collide
 * with another's. Without a caller key the run id is the key, so enqueueing the same run twice is
 * one job.
 */
export function runJobKey(payload: RunJobPayload, idempotencyKey: string | undefined): string {
  return idempotencyKey === undefined
    ? `${payload.workspace_id}:run:${payload.run_id}`
    : `${payload.workspace_id}:key:${idempotencyKey}`;
}
