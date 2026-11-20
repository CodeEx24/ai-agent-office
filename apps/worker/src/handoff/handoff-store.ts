import type { HandoffChain, HandoffParty, NarrowedPermissions } from "@ago/shared/handoff";

/**
 * Persistence port for handoffs (AGO-81). A handoff IS a task row: `taskId` is the new task. The Postgres
 * implementation arrives with the schema slot (new columns on `tasks`, written only by a `SECURITY DEFINER`
 * function for `service_role`; agent roles can never write `requesterMemberId` or `narrowed`). Until then the
 * in-memory store in `handoff-store.test-helpers.ts` is the only implementation.
 */
export interface HandoffRecord {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  /** The human member the whole chain acts for. Copied from the root task, never from agent input. */
  readonly requesterMemberId: string;
  /** Agent ids from the first sender to the receiver (inclusive). */
  readonly path: readonly string[];
  readonly depth: number;
  /** The receiver's effective permissions for this task: the intersection computed at handoff time. */
  readonly narrowed: NarrowedPermissions;
  /** The only text the receiver gets. It is untrusted data. */
  readonly title: string;
  readonly description: string;
  readonly acceptedByRunId: string | null;
}

export interface HandoffStore {
  /** What an agent holds right now. Null when the agent does not exist in the workspace. */
  loadParty(workspaceId: string, agentId: string): Promise<HandoffParty | null>;
  /**
   * The chain a sender's run acts in: the handoff chain of the task the run works on, or a new chain rooted at that
   * task's human creator. Null when the run has no task or the task has no human requester.
   */
  loadChainForRun(workspaceId: string, runId: string): Promise<HandoffChain | null>;
  /** Insert the handoff task. Must fail if the task id exists. */
  insert(record: HandoffRecord): Promise<void>;
  /** The handoff a run works on (set by `markAccepted`), or null for an ordinary run. */
  findByRun(workspaceId: string, runId: string): Promise<HandoffRecord | null>;
  findByTask(workspaceId: string, taskId: string): Promise<HandoffRecord | null>;
  /** Link the receiver's run to the handoff. False when it was already accepted. */
  markAccepted(workspaceId: string, taskId: string, runId: string): Promise<boolean>;
}
