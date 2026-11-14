import { withContext } from "../logger.js";
import { finalizeStop, type RunStopDeps } from "./run-stop.js";

import type { RunControl } from "./run-control.js";
import type { CheckpointStore } from "../agent/checkpoint-store.js";

/**
 * The control sweep (AGO-86). A person's stop or resume request is only RECORDED by the web route (a flag in
 * `private.run_checkpoints`); this pass makes it happen for runs that have no loop to notice the flag:
 *  - stop on a `queued` or `paused` run: finalized here (`finalizeStop`). A `running` run is left alone: its own
 *    loop sees the flag before its next tool call and ends the run, so no call is cut short;
 *  - resume on a `paused` run: `RunControl.resumeRun` with the person who asked. A stop beats a resume: a run with
 *    a stop request is never resumed (the stop is checked first here, and `resumeRun` refuses it in the database).
 * The resume flag is forgotten after one attempt, whatever came of it, so a request that no longer applies is not
 * retried forever. Resuming never bypasses an approval or a budget: the woken loop reads the approval again and
 * waits or closes the call, and checks its limits before the next step.
 */
export const DEFAULT_CONTROL_SWEEP_INTERVAL_MS = 5_000;
export const DEFAULT_CONTROL_SWEEP_BATCH = 100;

export interface ControlSweepDeps extends RunStopDeps {
  readonly checkpoints: Pick<
    CheckpointStore,
    "clear" | "listControlRequests" | "clearResumeRequest"
  >;
  readonly control: Pick<RunControl, "resumeRun">;
  readonly batchSize?: number;
  readonly onError?: (error: unknown, context: { run_id: string; workspace_id: string }) => void;
}

/** One pass. Returns how many requests it handled. A failure on one run never stops the others. */
export async function sweepControlRequests(deps: ControlSweepDeps): Promise<number> {
  const requests = await deps.checkpoints.listControlRequests(
    deps.batchSize ?? DEFAULT_CONTROL_SWEEP_BATCH,
  );
  let handled = 0;
  for (const request of requests) {
    const ref = { workspaceId: request.workspaceId, runId: request.runId };
    const logger = withContext(deps.logger, { run_id: ref.runId, workspace_id: ref.workspaceId });
    try {
      if (request.stopRequested) {
        // A running run is not touched here (its loop ends it); a finished run's flag was dropped with its checkpoint.
        if (await finalizeStop(deps, ref, ["queued", "paused"])) handled += 1;
        continue;
      }
      if (request.resumeRequested) {
        if (request.requestedBy === null) {
          logger.error("a resume request names no person; ignored");
        } else {
          const result = await deps.control.resumeRun(ref, {
            kind: "human",
            userId: request.requestedBy,
          });
          if (result === "resumed") handled += 1;
        }
        await deps.checkpoints.clearResumeRequest(ref);
      }
    } catch (error) {
      logger.error({ err: error }, "could not apply a run control request");
      deps.onError?.(error, { run_id: ref.runId, workspace_id: ref.workspaceId });
    }
  }
  return handled;
}

export interface ControlSweeper {
  start(): void;
  /** Stop the timer. A pass that is running finishes; none starts after this. */
  stop(): void;
}

/** Runs `sweepControlRequests` on a timer. Several workers may run it: every write is a conditional update. */
export function createControlSweeper(
  deps: ControlSweepDeps & { readonly intervalMs?: number },
): ControlSweeper {
  let timer: NodeJS.Timeout | null = null;
  let isRunning = false;
  const pass = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      await sweepControlRequests(deps);
    } catch (error) {
      deps.logger.error({ err: error }, "run control sweep failed");
    } finally {
      isRunning = false;
    }
  };
  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void pass(), deps.intervalMs ?? DEFAULT_CONTROL_SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
