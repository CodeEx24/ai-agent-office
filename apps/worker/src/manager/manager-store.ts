import type { ProposedTask } from "./propose-tasks-schema.js";

/**
 * Persistence port for the Manager's goal splitting (AGO-117). The Postgres implementation is `pg-manager-store.ts`;
 * writes go only through `public.create_goal_tasks`, which re-checks that the run's agent is an active Manager, that the
 * goal is the one the run was asked to plan and that every suggested agent is live. There is no method that creates
 * an agent: the Manager cannot create or hire agents.
 */
export interface PlanGoal {
  readonly goalId: string;
  /** Written by a person. Untrusted data: only ever shown to the model as a tool result (a wrapped block). */
  readonly text: string;
}

export type CreateGoalTasksRefusal =
  "not_manager" | "goal_not_assigned" | "unknown_agent" | "invalid" | "limit_reached";

export type CreateGoalTasksResult =
  | { readonly ok: true; readonly taskIds: readonly string[] }
  | { readonly ok: false; readonly reason: CreateGoalTasksRefusal };

export interface ManagerStore {
  /** The goal the run's task was created for, or null (no task, no goal, or the run's agent is not an active Manager). */
  readGoalForRun(workspaceId: string, runId: string): Promise<PlanGoal | null>;
  /** All or nothing. Never throws for a rule the database enforces; those come back as a refusal. */
  createGoalTasks(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly goalId: string;
    readonly tasks: readonly ProposedTask[];
  }): Promise<CreateGoalTasksResult>;
}
