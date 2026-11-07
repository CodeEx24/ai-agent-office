import { RUN_LIMIT_NAMES, clampRunLimit, type RunLimitName } from "@ago/shared";

/** The limits that can differ per agent. The rest of `AgentLoopLimits` stays a worker-wide setting. */
export type ResolvedRunLimits = Readonly<Record<RunLimitName, number>>;

/**
 * Where one agent's stored overrides come from (production: `agents.run_limits`, see pg-run-limits-source.ts).
 * The answer is untrusted: it is validated and clamped by `mergeRunLimits`.
 */
export interface AgentRunLimitsSource {
  get(scope: { readonly workspaceId: string; readonly agentId: string }): Promise<unknown>;
}

export interface RunLimitsResolver {
  resolve(scope: {
    readonly workspaceId: string;
    readonly agentId: string;
  }): Promise<ResolvedRunLimits>;
}

/**
 * Merge `overrides` onto `defaults`. A field that is missing, not an integer or otherwise not a limit keeps its
 * default; a number outside the bounds is pulled to the nearest bound, so an owner can never set "unlimited".
 */
export function mergeRunLimits(defaults: ResolvedRunLimits, overrides: unknown): ResolvedRunLimits {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    return defaults;
  }
  const raw = overrides as Record<string, unknown>;
  const merged = { ...defaults };
  for (const name of RUN_LIMIT_NAMES) {
    merged[name] = clampRunLimit(name, raw[name]) ?? defaults[name];
  }
  return merged;
}

/**
 * Defaults come from the worker config (already bounded). A source that throws or answers nonsense never
 * blocks a run: the agent gets the defaults, which are the safe values.
 */
export function createRunLimitsResolver(options: {
  readonly defaults: ResolvedRunLimits;
  readonly source?: AgentRunLimitsSource;
  readonly onSourceError?: (error: unknown) => void;
}): RunLimitsResolver {
  const defaults = mergeRunLimits(options.defaults, options.defaults);
  return {
    async resolve(scope) {
      if (options.source === undefined) return defaults;
      try {
        return mergeRunLimits(defaults, await options.source.get(scope));
      } catch (error) {
        options.onSourceError?.(error);
        return defaults;
      }
    },
  };
}
