import { createHash } from "node:crypto";

/**
 * The id of the approval for one tool call (AGO-21). It is derived from the run, the step and the call id
 * instead of being random, so a crash between "row created" and "checkpoint saved" cannot leave two pending
 * rows for the same call: the retry computes the same id and finds the row it already made. A resumed run
 * finds its approval the same way, without any extra state in the checkpoint.
 *
 * The run id is globally unique, so ids never collide across workspaces. The result is a valid UUID
 * (version 5 layout) because `approvals.id` is a `uuid` column.
 */
export function approvalIdFor(input: {
  readonly runId: string;
  readonly step: number;
  readonly callId: string;
}): string {
  const hex = createHash("sha256")
    .update(`approval\n${input.runId}\n${String(input.step)}\n${input.callId}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
