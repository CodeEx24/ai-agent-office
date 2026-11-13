import { createRunEventEmitter, type RunEventStore } from "../events/index.js";
import { withContext, type Logger } from "../logger.js";

import type { ApprovalStore } from "./approval-store.js";
import type { ResumeResult } from "../queue/run-control.js";
import type { RunRef } from "../queue/run-store.js";

/**
 * The approval expiry sweep (AGO-21). A pending approval past `expires_at` becomes `rejected` (timeout means
 * deny), an `approval.decided` event (`expired`, decided by `timeout`) is written, and the paused run is woken
 * so the agent is told its call was denied.
 *
 * Nothing here can approve: the only status it writes is `rejected`, and the only wake-up it uses is
 * `resumeAfterApprovalExpiry`. The loop is what closes the call, and it never runs a call for a `rejected`
 * approval. The loop also expires a late approval itself when it resumes (see agent-loop.ts), so a sweep that
 * is late or down never turns a timeout into a grant.
 */
export const DEFAULT_APPROVAL_SWEEP_INTERVAL_MS = 30_000;
export const DEFAULT_APPROVAL_SWEEP_BATCH = 100;

export interface ApprovalExpiryDeps {
  readonly approvals: Pick<ApprovalStore, "expireDue">;
  readonly events: RunEventStore;
  readonly control: { resumeAfterApprovalExpiry(ref: RunRef): Promise<ResumeResult> };
  readonly logger: Logger;
  readonly now?: () => number;
  readonly batchSize?: number;
  /** Told about a failure that left an expired approval without its event or its wake-up. */
  readonly onError?: (error: unknown, context: { run_id: string; workspace_id: string }) => void;
}

/** One pass. Returns how many approvals it expired. A failure on one approval never stops the others. */
export async function expireDueApprovals(deps: ApprovalExpiryDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const expired = await deps.approvals.expireDue(
    new Date(now()),
    deps.batchSize ?? DEFAULT_APPROVAL_SWEEP_BATCH,
  );
  for (const approval of expired) {
    if (approval.runId === null) continue; // no run to tell; the row is already rejected
    const ref: RunRef = { workspaceId: approval.workspaceId, runId: approval.runId };
    const logger = withContext(deps.logger, { run_id: ref.runId, workspace_id: ref.workspaceId });
    try {
      await createRunEventEmitter({
        workspaceId: ref.workspaceId,
        runId: ref.runId,
        store: deps.events,
        logger,
      }).emit({
        type: "approval.decided",
        payload: {
          approval_id: approval.approvalId,
          outcome: "expired",
          decided_by: "timeout",
          payload_hash: approval.payloadHash,
        },
      });
    } catch (error) {
      // The row is rejected either way (a denial), so still wake the run; the audit gap must not be silent.
      logger.error({ err: error }, "approval.decided event not recorded");
      deps.onError?.(error, { run_id: ref.runId, workspace_id: ref.workspaceId });
    }
    try {
      await deps.control.resumeAfterApprovalExpiry(ref);
    } catch (error) {
      logger.error({ err: error }, "could not wake the run after its approval expired");
      deps.onError?.(error, { run_id: ref.runId, workspace_id: ref.workspaceId });
    }
  }
  return expired.length;
}

export interface ApprovalExpirySweeper {
  start(): void;
  /** Stop the timer. A pass that is running finishes; none starts after this. */
  stop(): void;
}

/** Runs `expireDueApprovals` on a timer. Several workers may run it: the conditional update picks one winner. */
export function createApprovalExpirySweeper(
  deps: ApprovalExpiryDeps & { readonly intervalMs?: number },
): ApprovalExpirySweeper {
  let timer: NodeJS.Timeout | null = null;
  let isRunning = false;
  const pass = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      await expireDueApprovals(deps);
    } catch (error) {
      deps.logger.error({ err: error }, "approval expiry sweep failed");
    } finally {
      isRunning = false;
    }
  };
  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void pass(), deps.intervalMs ?? DEFAULT_APPROVAL_SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
