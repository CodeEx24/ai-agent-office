import { z } from "zod";

/**
 * Per-agent run limits (AGO-166). One place for the bounds, so the worker config, the limits resolver and a
 * future settings form all agree. An owner can raise or lower a limit inside these bounds; nobody can set
 * "unlimited". A value outside the bounds is clamped by `clampRunLimit`, never trusted.
 */
export const RUN_LIMIT_BOUNDS = {
  maxSteps: { min: 1, max: 200 },
  maxTokens: { min: 1_000, max: 5_000_000 },
  /** Under the job expiry (900 s) so the loop stops itself before pg-boss gives up on the job. */
  maxWallMs: { min: 1_000, max: 840_000 },
} as const;

export type RunLimitName = keyof typeof RUN_LIMIT_BOUNDS;
export const RUN_LIMIT_NAMES = Object.keys(RUN_LIMIT_BOUNDS) as RunLimitName[];

/** The same tool call, with the same output, this many times in a row stops the run (AGO-166). */
export const LOOP_REPEAT_THRESHOLD = 3;

const limitField = (name: RunLimitName) =>
  z.number().int().min(RUN_LIMIT_BOUNDS[name].min).max(RUN_LIMIT_BOUNDS[name].max);

/** What an owner may store for one agent. Every field is optional: a missing one uses the default. */
export const agentRunLimitsSchema = z
  .strictObject({
    maxSteps: limitField("maxSteps"),
    maxTokens: limitField("maxTokens"),
    maxWallMs: limitField("maxWallMs"),
  })
  .partial();
export type AgentRunLimits = z.infer<typeof agentRunLimitsSchema>;

/** Pulls a number into its bounds. A non-integer or non-finite value is not a limit at all (undefined). */
export function clampRunLimit(name: RunLimitName, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  const { min, max } = RUN_LIMIT_BOUNDS[name];
  return Math.min(max, Math.max(min, value));
}
