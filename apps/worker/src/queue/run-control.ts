import { randomUUID } from "node:crypto";

import { approvalIdFor } from "../approvals/approval-id.js";
import { createRunEventEmitter, type RunEventStore } from "../events/index.js";
import { withContext, type Logger } from "../logger.js";

import type { RunRef, RunStore } from "./run-store.js";
import type { JobQueue } from "./job-queue.js";
import type { CheckpointStore } from "../agent/checkpoint-store.js";
import type { RunCheckpointState } from "@ago/shared";

/**
 * Pause and resume for a run (AGO-30). These are the seams the control UI (AGO-21) calls; there is no HTTP
 * route in this ticket.
 *
 * Human in the loop: both operations take the acting human as an argument and refuse anything else, so an
 * agent (or the loop itself) can never resume a run. The caller is responsible for having authenticated the
 * human and checked their role in the workspace; this module only enforces the actor kind and the workspace
 * scope of every statement.
 */
export interface HumanActor {
  readonly kind: "human";
  readonly userId: string;
}

/** Anything that is not a human tried to pause or resume a run. */
export class HumanActorRequiredError extends Error {
  constructor() {
    super("only a human can pause or resume a run");
    this.name = "HumanActorRequiredError";
  }
}

export interface RunControlDeps {
  readonly runs: Pick<RunStore, "resumeRun" | "wakeRunAfterExpiry" | "revertResume">;
  readonly checkpoints: Pick<
    CheckpointStore,
    "requestPause" | "clearPause" | "load" | "isPauseRequested"
  >;
  readonly queue: Pick<JobQueue, "enqueueRun">;
  readonly events: RunEventStore;
  readonly logger: Logger;
}

export type ResumeResult = "resumed" | "not_paused";

/** The expired approval to act on: the run it belongs to and its id. */
export interface ExpiredApprovalRef extends RunRef {
  readonly approvalId: string;
}

/**
 * `not_waiting`: the run is not paused on exactly this approval (a different one, none, or no checkpoint).
 * `human_paused`: a human asked for a pause, which an expiry never overrides.
 */
export type ExpiryWakeResult = ResumeResult | "not_waiting" | "human_paused";

export interface RunControl {
  /**
   * Ask a `queued` or `running` run to pause at its next safe point (never in the middle of a model call).
   * False when the run is not in a state that can be paused (or is not in this workspace).
   */
  requestRunPause(ref: RunRef, actor: HumanActor): Promise<boolean>;
  /**
   * Move a `paused` run back to `queued` and enqueue it. Idempotent: only the first of several resumes
   * does anything, the others get `not_paused`.
   */
  resumeRun(ref: RunRef, actor: HumanActor): Promise<ResumeResult>;
  /**
   * Wake a `paused` run whose approval request expired (AGO-21), so the agent is told the call was denied.
   * Takes no actor and is not reachable from a route: only the expiry sweep calls it. It cannot approve
   * anything: the woken loop reads the approval, finds it `rejected`, and closes the call without running it.
   * Writes `run.resumed` with `resumed_by: "timeout"`.
   *
   * It wakes only a run whose checkpoint has a call awaiting exactly this approval, and never a run a human
   * asked to pause: it does not clear that request, so the run stays paused and the expired call is closed
   * `approval_expired` on the next human resume.
   */
  resumeAfterApprovalExpiry(ref: ExpiredApprovalRef): Promise<ExpiryWakeResult>;
}

function assertHuman(actor: HumanActor): void {
  // A runtime check on purpose: callers in other packages are not type-checked against this one.
  if ((actor as { kind?: unknown }).kind !== "human") throw new HumanActorRequiredError();
}

/** True when the checkpoint's open step has a call awaiting exactly this approval (the id is derived, not stored). */
function isAwaitingApproval(
  state: RunCheckpointState | null,
  runId: string,
  approvalId: string,
): boolean {
  const openStep = state?.step;
  if (!openStep) return false;
  return openStep.calls.some(
    (call) =>
      call.status === "awaiting_approval" &&
      approvalIdFor({ runId, step: openStep.step, callId: call.call_id }) === approvalId,
  );
}

export function createRunControl(deps: RunControlDeps): RunControl {
  // A human resume never answers `human_paused`; only the timeout wake can be refused for a human's pause.
  async function resume(ref: RunRef, resumedBy: "human"): Promise<ResumeResult>;
  async function resume(ref: RunRef, resumedBy: "timeout"): Promise<ExpiryWakeResult>;
  async function resume(
    ref: RunRef,
    resumedBy: "human" | "timeout",
  ): Promise<ResumeResult | "human_paused"> {
    // The conditional update is the guard: of two resumes racing, only one sees `paused`. The expiry wake's update
    // also requires "no human pause request" inside the same statement (AGO-58), so there is no window between a
    // flag check and the move for a human's pause to slip into.
    const moved =
      resumedBy === "human"
        ? await deps.runs.resumeRun(ref)
        : await deps.runs.wakeRunAfterExpiry(ref);
    if (!moved) {
      // Only labels the refusal. The decision was already taken atomically above.
      if (resumedBy === "timeout" && (await deps.checkpoints.isPauseRequested(ref))) {
        return "human_paused";
      }
      return "not_paused";
    }

    const logger = withContext(deps.logger, { run_id: ref.runId, workspace_id: ref.workspaceId });
    try {
      // Only a human resume forgets a human's pause request; an expiry never touches it.
      if (resumedBy === "human") await deps.checkpoints.clearPause(ref);
      await createRunEventEmitter({
        workspaceId: ref.workspaceId,
        runId: ref.runId,
        store: deps.events,
        logger,
      }).emit({ type: "run.resumed", payload: { resumed_by: resumedBy } });
      // A fresh key: the key of the first job must not make this one look like a duplicate.
      await deps.queue.enqueueRun({
        workspaceId: ref.workspaceId,
        runId: ref.runId,
        idempotencyKey: `resume:${randomUUID()}`,
        isResume: true,
      });
    } catch (error) {
      // The run must not be left `queued` with no job: put it back so a human can try again.
      await deps.runs.revertResume(ref).catch((revertError: unknown) => {
        logger.error({ err: revertError }, "could not put the run back to paused");
      });
      throw error;
    }
    logger.info({ resumed_by: resumedBy }, "run resumed");
    return "resumed";
  }

  return {
    async requestRunPause(ref, actor) {
      assertHuman(actor);
      return deps.checkpoints.requestPause(ref);
    },

    async resumeRun(ref, actor) {
      assertHuman(actor);
      return resume(ref, "human");
    },

    async resumeAfterApprovalExpiry({ approvalId, ...ref }) {
      const { state } = await deps.checkpoints.load(ref);
      if (!isAwaitingApproval(state, ref.runId, approvalId)) return "not_waiting";
      // A human asked for a pause: the atomic wake refuses and the run stays paused. Their resume closes the
      // expired call.
      return resume(ref, "timeout");
    },
  };
}
