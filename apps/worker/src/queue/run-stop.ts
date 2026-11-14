import {
  createRunEventEmitter,
  type RunEventEmitter,
  type RunEventStore,
} from "../events/index.js";
import { withContext, type Logger } from "../logger.js";

import type { ApprovalStore } from "../approvals/approval-store.js";
import type { CheckpointStore } from "../agent/checkpoint-store.js";
import type { RunRef, RunStore, StoppableStatus } from "./run-store.js";

/**
 * Finalizing a stop (AGO-86). A person asked for it through the human-only control route; this is the one place the
 * worker makes it final, for both ways a stop lands: the loop ended a running run at a tool-call boundary, or the
 * control sweep stopped a queued or paused run.
 *
 * In order: (1) the run's pending approvals are closed as `rejected`, each with an `approval.decided` event
 * (`denied`, decided by a human, since a human's stop is what closed it); only `rejected` is ever written, never
 * `approved`; (2) the run moves to `stopped` in ONE conditional update (the guard against a double stop);
 * (3) only the caller that moved it writes `run.stopped` and drops the checkpoint (and so the flags).
 * Every step is idempotent, so a crash part-way is finished by the next sweep pass: the flag stays until step 3.
 */
export const STOP_REASON = "stopped_by_human";

export interface RunStopDeps {
  readonly runs: Pick<RunStore, "markStopped">;
  readonly approvals?: Pick<ApprovalStore, "rejectPendingForRun">;
  readonly checkpoints?: Pick<CheckpointStore, "clear">;
  readonly events: RunEventStore;
  readonly logger: Logger;
}

/** True only for the caller that moved the run to `stopped`. */
export async function finalizeStop(
  deps: RunStopDeps,
  ref: RunRef,
  from: readonly StoppableStatus[],
  emitter?: RunEventEmitter,
): Promise<boolean> {
  const logger = withContext(deps.logger, { run_id: ref.runId, workspace_id: ref.workspaceId });
  const out =
    emitter ??
    createRunEventEmitter({
      workspaceId: ref.workspaceId,
      runId: ref.runId,
      store: deps.events,
      logger,
    });

  const closed = (await deps.approvals?.rejectPendingForRun(ref)) ?? [];
  for (const approval of closed) {
    await out.emit({
      type: "approval.decided",
      payload: {
        approval_id: approval.approvalId,
        outcome: "denied",
        decided_by: "human",
        payload_hash: approval.payloadHash,
      },
    });
  }

  const moved = await deps.runs.markStopped(ref, from);
  if (!moved) return false;
  await out.emit({
    type: "run.stopped",
    payload: { stopped_by: "human", reason: STOP_REASON },
  });
  await deps.checkpoints?.clear(ref).catch((error: unknown) => {
    logger.error({ err: error }, "could not drop the run checkpoint");
  });
  logger.info({ closed_approvals: closed.length }, "run stopped");
  return true;
}
