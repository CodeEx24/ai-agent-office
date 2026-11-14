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
 * (3) the caller that moved it writes `run.stopped`, and only then drops the checkpoint (and so the flags).
 * Every step is idempotent. If the `run.stopped` write fails (or the process dies) after step 2, the run is `stopped`
 * and the flag is still set; the control sweep lists such a run and calls this again: `markStopped` moves nothing,
 * and `CheckpointStore.finishStopTail` writes `run.stopped` if no such event exists (under a row lock, so one worker
 * does it) and then drops the flag. So `run.stopped` is written exactly once and the flag outlives a failed write.
 */
export const STOP_REASON = "stopped_by_human";

export interface RunStopDeps {
  readonly runs: Pick<RunStore, "markStopped">;
  readonly approvals?: Pick<ApprovalStore, "rejectPendingForRun">;
  readonly checkpoints?: Pick<CheckpointStore, "clear" | "finishStopTail">;
  readonly events: RunEventStore;
  readonly logger: Logger;
}

/** True for the caller that moved the run to `stopped`, or that finished the tail of a stop an earlier pass left. */
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

  const writeStopped = (): Promise<unknown> =>
    out.emit({ type: "run.stopped", payload: { stopped_by: "human", reason: STOP_REASON } });

  const moved = await deps.runs.markStopped(ref, from);
  if (moved) {
    // The run is `stopped` for good from here, so nothing after this point may throw: a failed event write must
    // leave the flag set (the checkpoint is dropped only after `run.stopped` is written) and the next sweep pass
    // finishes the tail below. The emitter has already logged the failure.
    try {
      await writeStopped();
    } catch (error) {
      logger.error(
        { err: error },
        "run stopped but run.stopped was not written; the sweep will retry",
      );
      return true;
    }
    await deps.checkpoints?.clear(ref).catch((error: unknown) => {
      logger.error({ err: error }, "could not drop the run checkpoint; the sweep will retry");
    });
    logger.info({ closed_approvals: closed.length }, "run stopped");
    return true;
  }

  // Not moved: another caller stopped it, or an earlier pass did and did not finish. Finish that tail (one worker
  // at a time; the event is written only if it is missing, then the flag is dropped). Nothing to finish: false.
  const finished =
    (await deps.checkpoints?.finishStopTail(ref, async (isEventWritten) => {
      if (!isEventWritten) await writeStopped();
    })) ?? false;
  if (finished) logger.info("finished the tail of a stop");
  return finished;
}
