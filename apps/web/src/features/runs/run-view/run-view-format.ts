import type { RunLogView, RunPhase } from "./run-log";

/** Display helpers for the run view (AGO-153). Pure, so the screen and its tests share one definition. */

/** Run facts from the `runs` row, used until (and besides) what the events say. */
export interface RunSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly agentName: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

const KNOWN_PHASES: readonly RunPhase[] = [
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
];

/** The phase to show: the events win once they say anything, the stored `runs.status` covers an empty log. */
export function effectivePhase(view: RunLogView, run: RunSummary): RunPhase | "unknown" {
  if (view.phase !== null) return view.phase;
  const stored = run.status.toLowerCase();
  const match = KNOWN_PHASES.find((phase) => phase === stored);
  return match ?? "unknown";
}

export function isRunActive(phase: RunPhase | "unknown"): boolean {
  return phase === "running";
}

/**
 * Elapsed time of the run in ms, or null before it started. Ends at the finish time; while paused it freezes at the
 * moment of the pause; only a running run keeps counting up to `nowMs`.
 */
export function elapsedMs(view: RunLogView, run: RunSummary, nowMs: number): number | null {
  const startIso = view.startedAt ?? run.startedAt;
  if (startIso === null) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  const phase = effectivePhase(view, run);
  const endIso = view.endedAt ?? run.finishedAt ?? (phase === "paused" ? view.pausedAt : null);
  const end = endIso === null ? nowMs : Date.parse(endIso);
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** "850 ms", "12 s", "3 min 05 s", "1 h 02 min". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "not started";
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${String(totalSeconds)} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${String(totalMinutes)} min ${String(totalSeconds % 60).padStart(2, "0")} s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours)} h ${String(totalMinutes % 60).padStart(2, "0")} min`;
}

export function formatTokens(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

/** UTC clock time, so server and browser render the same text. */
export function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown time";
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

export const PHASE_LABELS: Readonly<Record<RunPhase | "unknown", string>> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Unknown",
};

export const TOOL_STATUS_LABELS = {
  requested: "Requested",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  denied: "Denied by policy",
  awaiting_approval: "Waiting for approval",
} as const;
