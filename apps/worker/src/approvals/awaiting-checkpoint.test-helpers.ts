import { emptyRunCheckpointState, type CheckpointCall, type RunCheckpointState } from "@ago/shared";

import { approvalIdFor } from "./approval-id.js";

const HASH = "a".repeat(64);

/** A checkpoint saved when a call raised an approval: one call is `awaiting_approval` (plus any `others`). */
export function awaitingApprovalState(options: {
  readonly step?: number;
  readonly callId?: string;
  readonly others?: readonly CheckpointCall[];
}): RunCheckpointState {
  const step = options.step ?? 1;
  return {
    ...emptyRunCheckpointState(),
    steps: step,
    step: {
      step,
      hadError: false,
      calls: [
        {
          call_id: options.callId ?? "toolu_0",
          name: "risky",
          input: {},
          status: "awaiting_approval",
          payload_hash: HASH,
        },
        ...(options.others ?? []),
      ],
    },
  };
}

/** The id the loop gave the approval for that call (see approvalIdFor). */
export function approvalIdOf(options: {
  readonly runId: string;
  readonly step?: number;
  readonly callId?: string;
}): string {
  return approvalIdFor({
    runId: options.runId,
    step: options.step ?? 1,
    callId: options.callId ?? "toolu_0",
  });
}
