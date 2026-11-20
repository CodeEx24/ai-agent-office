import type { EgressDecision } from "@ago/shared";

/** Blocked-request lines kept per run before the rest are counted instead of logged. */
export const MAX_EGRESS_BLOCK_LINES_PER_RUN = 20;

const MAX_TRACKED_RUNS = 1_000;

/**
 * Keeps a flood of blocked requests from becoming a flood of log lines (AGO-85, before AGO-104 ships logs).
 * The first `maxPerRun` blocks of a run go to `log` unchanged; later ones are only counted. `flush(runId)`
 * (called when the run ends) reports the count once through `onSuppressed` and forgets the run. Allowed
 * requests always pass through. Only counters per run id are kept, never request data.
 */
export function createEgressLogLimiter(
  log: (decision: EgressDecision) => void,
  onSuppressed: (summary: { readonly runId: string; readonly suppressed: number }) => void,
  maxPerRun: number = MAX_EGRESS_BLOCK_LINES_PER_RUN,
): {
  readonly onDecision: (decision: EgressDecision) => void;
  readonly flush: (runId: string) => number;
} {
  const counts = new Map<string, number>();
  return {
    onDecision(decision) {
      if (decision.event !== "egress.blocked") {
        log(decision);
        return;
      }
      const count = (counts.get(decision.run_id) ?? 0) + 1;
      counts.set(decision.run_id, count);
      // Bounded: a worker that never flushes still holds at most this many run counters.
      if (counts.size > MAX_TRACKED_RUNS) {
        const oldest = counts.keys().next();
        if (oldest.done !== true) counts.delete(oldest.value);
      }
      if (count <= maxPerRun) log(decision);
    },
    flush(runId) {
      const count = counts.get(runId) ?? 0;
      counts.delete(runId);
      const suppressed = Math.max(0, count - maxPerRun);
      if (suppressed > 0) onSuppressed({ runId, suppressed });
      return suppressed;
    },
  };
}
