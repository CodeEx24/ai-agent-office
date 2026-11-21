import { z } from "zod";

/**
 * The Manager's task proposal (AGO-117). Limits mirror `public.create_goal_tasks`, which is the enforcement boundary;
 * this schema fails early and gives the model a clear refusal. Keep both in step.
 */
export const MAX_PROPOSED_TASKS = 12;
export const MAX_TASK_TITLE_LENGTH = 300;
export const MAX_TASK_BRIEF_LENGTH = 4000;

/** A label for a task inside one proposal, so items can name each other as dependencies. */
export const taskRefSchema = z.string().regex(/^[a-z0-9_-]{1,40}$/);

export const proposedTaskSchema = z.strictObject({
  ref: taskRefSchema,
  title: z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH),
  brief: z.string().trim().min(1).max(MAX_TASK_BRIEF_LENGTH),
  /** An existing, non-archived agent. Advice only: the task stays in the Inbox. */
  suggested_agent_id: z.uuid().optional(),
  /** Refs of EARLIER items in the same proposal. */
  depends_on: z
    .array(taskRefSchema)
    .max(MAX_PROPOSED_TASKS - 1)
    .default([]),
});
export type ProposedTask = z.infer<typeof proposedTaskSchema>;

export const proposeTasksInputSchema = z
  .strictObject({
    goal_id: z.uuid(),
    tasks: z.array(proposedTaskSchema).min(1).max(MAX_PROPOSED_TASKS),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.tasks.forEach((task, index) => {
      if (seen.has(task.ref)) {
        ctx.addIssue({ code: "custom", path: ["tasks", index, "ref"], message: "duplicate ref" });
      }
      for (const dependency of task.depends_on) {
        // Only an earlier item can be named, so a proposal can never hold a cycle or a self reference.
        if (!seen.has(dependency)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "depends_on"],
            message: "a dependency must name an earlier task",
          });
        }
      }
      seen.add(task.ref);
    });
  });
export type ProposeTasksInput = z.infer<typeof proposeTasksInputSchema>;

export const PROPOSE_TASKS_MODEL_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    goal_id: {
      type: "string",
      description: "The id of the goal you are planning (from read_goal).",
    },
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PROPOSED_TASKS,
      items: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "A short label (a-z, 0-9, _ or -) other tasks can depend on.",
          },
          title: { type: "string", maxLength: MAX_TASK_TITLE_LENGTH },
          brief: {
            type: "string",
            maxLength: MAX_TASK_BRIEF_LENGTH,
            description: "What to do and what done looks like.",
          },
          suggested_agent_id: {
            type: "string",
            description: "An existing agent that fits. Optional. You cannot create agents.",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Refs of EARLIER tasks in this list.",
          },
        },
        required: ["ref", "title", "brief"],
        additionalProperties: false,
      },
    },
  },
  required: ["goal_id", "tasks"],
  additionalProperties: false,
};
