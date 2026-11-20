"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BUDGET_STOP_MESSAGES } from "@ago/shared/budget";

import { formatCostMicros } from "../../approvals/approval-format";
import type { OfficeEventSource } from "../../office/realtime/office-event-source";
import { describeBudgetStop } from "./budget-stop-text";
import { ExpandableText } from "./ExpandableText";
import { createRunLiveSource } from "./live-source";
import {
  applyRunRows,
  buildRunLog,
  createRunLogState,
  type EntryTone,
  type RunLogView,
  type ToolCallView,
} from "./run-log";
import { createRunLogFeed, type RunFeedStatus } from "./run-log-feed";
import {
  PHASE_LABELS,
  TOOL_STATUS_LABELS,
  effectivePhase,
  elapsedMs,
  formatClock,
  formatDuration,
  formatTokens,
  isRunActive,
  isRunEnded,
  type RunSummary,
} from "./run-view-format";

const TONE_CLASS: Record<EntryTone, string> = {
  neutral: "border-border",
  good: "border-success/60",
  warn: "border-warning/70",
  bad: "border-destructive/70",
};

const FEED_LABELS: Record<RunFeedStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  catching_up: "Catching up…",
  reconnecting: "Reconnecting…",
  stopped: "Not live",
};

type Phase = ReturnType<typeof effectivePhase>;

export interface RunViewProps {
  readonly run: RunSummary;
  /** Rows the server already read (untrusted until folded; the fold validates them). */
  readonly initialRows: readonly unknown[];
  readonly serverNowMs: number;
  /** The server read stopped at its row cap; the live feed loads the rest. */
  readonly isCut?: boolean;
  /** A stream source for tests; the browser uses the real one. `null` means no live updates. */
  readonly source?: OfficeEventSource | null;
  /** The PUBLIC Supabase settings (URL and anon key, read on the server) the browser source is built from. */
  readonly supabaseUrl?: string;
  readonly supabaseAnonKey?: string;
}

/** Ticks once a second while `isActive`, starting from the server's clock. */
function useNow(serverNowMs: number, isActive: boolean): number {
  const [nowMs, setNowMs] = useState(serverNowMs);
  useEffect(() => {
    if (!isActive) return;
    const handle = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(handle);
    };
  }, [isActive]);
  return nowMs;
}

export function RunView({
  run,
  initialRows,
  serverNowMs,
  isCut = false,
  source,
  supabaseUrl,
  supabaseAnonKey,
}: RunViewProps) {
  const [initialState] = useState(() =>
    applyRunRows(createRunLogState(run.workspaceId, run.id), initialRows),
  );
  const [logState, setLogState] = useState(initialState);
  const [resolvedSource] = useState<OfficeEventSource | null>(() =>
    source === undefined ? createRunLiveSource(supabaseUrl, supabaseAnonKey) : source,
  );
  const [feedStatus, setFeedStatus] = useState<RunFeedStatus>(
    resolvedSource === null ? "stopped" : "connecting",
  );

  const [hasDropped, setHasDropped] = useState(false);

  useEffect(() => {
    if (resolvedSource === null) return;
    const feed = createRunLogFeed({
      source: resolvedSource,
      initial: initialState,
      onState: setLogState,
      onStatus: (status) => {
        setFeedStatus(status);
        // A drop stays "stale" through the reconnect attempts (connecting, catching up) until the feed is live again.
        if (status === "reconnecting" || status === "stopped") setHasDropped(true);
        else if (status === "live") setHasDropped(false);
      },
    });
    feed.start();
    return () => {
      feed.stop();
    };
  }, [resolvedSource, initialState]);

  const view = useMemo(() => buildRunLog(logState), [logState]);
  const phase = effectivePhase(view, run);
  // Without a live connection a run that has not ended may have moved on: say so, and stop counting up.
  const isStale =
    !isRunEnded(phase) && (hasDropped || feedStatus === "reconnecting" || feedStatus === "stopped");
  const nowMs = useNow(serverNowMs, isRunActive(phase) && !isStale);
  const duration = elapsedMs(view, run, nowMs);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 [&>*]:min-w-0">
      <RunHeader
        run={run}
        phase={phase}
        duration={duration}
        feedStatus={feedStatus}
        view={view}
        isStale={isStale}
      />
      <Banners
        view={view}
        phase={phase}
        isCut={isCut}
        isStale={isStale}
        agentId={run.agentId}
        feedStatus={feedStatus}
      />
      <Totals view={view} />
      <ToolCalls calls={view.toolCalls} />
      <Timeline view={view} phase={phase} />
      <PhaseAnnouncer phase={phase} />
    </div>
  );
}

/** A polite live region so a screen reader hears when the run changes phase (the log itself stays quiet). */
function PhaseAnnouncer({ phase }: { readonly phase: Phase }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="phase-announcer">
      Run status: {PHASE_LABELS[phase]}
    </p>
  );
}

function RunHeader({
  run,
  phase,
  duration,
  feedStatus,
  view,
  isStale,
}: {
  readonly run: RunSummary;
  readonly phase: Phase;
  readonly duration: number | null;
  readonly feedStatus: RunFeedStatus;
  readonly view: RunLogView;
  readonly isStale: boolean;
}) {
  const completedSteps = view.steps.filter((step) => step.outcome === "ok").length;
  const started = view.startedAt ?? run.startedAt;
  const isDurationStale = isStale && isRunActive(phase);
  return (
    <header className="grid gap-2">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/app/office" className="text-primary underline-offset-2 hover:underline">
          Back to the office
        </Link>
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          Run{" "}
          <span className="font-mono" title={run.id} data-testid="run-short-id">
            {shortRunId(run.id)}
          </span>
        </h1>
        <span
          data-testid="run-phase"
          className="rounded-full border px-3 py-0.5 text-sm font-medium"
        >
          {PHASE_LABELS[phase]}
          {view.phaseDetail !== null && phase !== "running"
            ? ` (${view.phaseDetail.replaceAll("_", " ")})`
            : ""}
          {isStale && !isRunEnded(phase) ? " · last known" : ""}
        </span>
        <span data-testid="feed-status" role="status" className="text-xs text-muted-foreground">
          {FEED_LABELS[feedStatus]}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Fact
          label="Agent"
          value={run.agentName ?? "Unknown agent"}
          href={`/app/agents/${run.agentId}`}
        />
        <Fact
          label="Duration"
          value={`${formatDuration(duration)}${isDurationStale ? " (not updating)" : ""}`}
          testId="run-duration"
        />
        <Fact
          label="Steps"
          value={`${String(view.steps.length)} (${String(completedSteps)} done)`}
        />
        <Fact label="Started" value={started === null ? "Not started" : formatClock(started)} />
      </dl>
    </header>
  );
}

/** The first 8 characters of the run id: enough to tell runs apart and quote them; the full id is in the tooltip. */
function shortRunId(id: string): string {
  return id.slice(0, 8);
}

function Fact({
  label,
  value,
  testId,
  href,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
  /** An in-app path: the value becomes a link. */
  readonly href?: string;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="font-medium wrap-anywhere">
        {href === undefined ? (
          value
        ) : (
          <Link href={href} className="text-primary underline-offset-2 hover:underline">
            {value}
          </Link>
        )}
      </dd>
    </div>
  );
}

function Totals({ view }: { readonly view: RunLogView }) {
  const { usage } = view;
  return (
    <section
      aria-label="Usage"
      className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4"
    >
      <Fact label="Input tokens" value={formatTokens(usage.inputTokens)} testId="usage-input" />
      <Fact label="Output tokens" value={formatTokens(usage.outputTokens)} testId="usage-output" />
      <Fact label="Cost" value={formatCostMicros(usage.costMicros)} testId="usage-cost" />
      <Fact label="Model calls" value={String(usage.calls)} testId="usage-calls" />
      {usage.callsWithoutCost > 0 ? (
        <p className="col-span-full text-xs text-muted-foreground">
          {usage.callsWithoutCost === 1
            ? "1 model call has"
            : `${String(usage.callsWithoutCost)} model calls have`}{" "}
          no recorded cost, so the cost total may be lower than the real spend.
        </p>
      ) : null}
    </section>
  );
}

function Banners({
  view,
  phase,
  isCut,
  isStale,
  agentId,
  feedStatus,
}: {
  readonly view: RunLogView;
  readonly phase: Phase;
  readonly isCut: boolean;
  readonly isStale: boolean;
  readonly agentId: string;
  readonly feedStatus: RunFeedStatus;
}) {
  const stop = view.budgetStop;
  const stopMessage =
    stop === null
      ? null
      : ((BUDGET_STOP_MESSAGES as Partial<Record<string, string>>)[stop.reason] ?? stop.reason);
  const stopText = stop === null ? null : describeBudgetStop(stop);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 empty:hidden">
      {isStale ? (
        <div
          role="alert"
          data-testid="stale-banner"
          className="rounded-lg border border-warning/70 p-3 text-sm"
        >
          <p className="font-medium">This page may be out of date</p>
          <p>
            {feedStatus === "reconnecting"
              ? "The live connection was lost and is reconnecting. What you see is the last known state, and the duration has stopped counting."
              : "Live updates are not connected on this page. What you see is the last known state, and the duration is not counting. Reload the page to refresh it."}
          </p>
        </div>
      ) : null}
      {stop !== null && stopText !== null ? (
        <div
          role="alert"
          data-testid="budget-stop"
          className="rounded-lg border border-destructive/70 p-3 text-sm"
        >
          <p className="font-medium">{stopText.title}</p>
          <p>{stopMessage}</p>
          {stopText.usage !== null ? (
            <p className="text-muted-foreground">{stopText.usage}</p>
          ) : null}
          <p>
            {stopText.nextStep}
            {stopText.linksToAgent ? (
              <>
                {" "}
                <Link
                  href={`/app/agents/${agentId}`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Open the agent
                </Link>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {view.failure !== null ? (
        <div role="alert" className="rounded-lg border border-destructive/70 p-3 text-sm">
          <p className="font-medium">Run failed: {view.failure.reason.replaceAll("_", " ")}</p>
          <ExpandableText text={view.failure.message} />
        </div>
      ) : null}
      {phase === "paused" ? (
        <p role="status" className="rounded-lg border border-warning/70 p-3 text-sm">
          This run is paused and waiting for a person to resume it.
        </p>
      ) : null}
      {view.isCatchingUp ? (
        <p role="status" className="text-sm text-muted-foreground">
          Some events have not arrived yet. The log shows everything up to the first missing one.
        </p>
      ) : null}
      {isCut ? (
        <p role="status" className="text-sm text-muted-foreground">
          This run has a very long log. The rest is loading.
        </p>
      ) : null}
      {view.unrecognised > 0 ? (
        <p className="text-sm text-muted-foreground">
          {view.unrecognised === 1 ? "1 event was" : `${String(view.unrecognised)} events were`} not
          recognised by this version of the app.
        </p>
      ) : null}
    </div>
  );
}

function ToolCalls({ calls }: { readonly calls: readonly ToolCallView[] }) {
  return (
    <section aria-label="Tool calls" className="grid gap-2">
      <h2 className="text-lg font-semibold">Tool calls ({calls.length})</h2>
      {calls.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tool calls yet.</p>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
          {calls.map((call) => (
            <li
              key={call.callId}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-lg border p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-medium break-all">{call.toolName}</span>
                <span className="text-xs text-muted-foreground">
                  Tier {String(call.tier)} · {TOOL_STATUS_LABELS[call.status]}
                  {call.durationMs === null ? "" : ` · ${formatDuration(call.durationMs)}`}
                </span>
              </div>
              {call.policy !== null ? (
                <p className="text-xs text-muted-foreground">
                  Policy: {call.policy.decision.replaceAll("_", " ")} ({call.policy.reasonCode})
                </p>
              ) : null}
              {call.errorCode !== null ? (
                <div className="text-sm">
                  <p className="font-medium">Error: {call.errorCode}</p>
                  {call.errorMessage !== null ? <ExpandableText text={call.errorMessage} /> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Tool inputs and results are not shown here: they are not stored where this page can read
        them.
      </p>
    </section>
  );
}

function Timeline({ view, phase }: { readonly view: RunLogView; readonly phase: Phase }) {
  return (
    <section aria-label="Log" className="grid gap-2">
      <h2 className="text-lg font-semibold">Log ({view.shownEvents})</h2>
      {view.timeline.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {phase === "queued" || phase === "unknown"
            ? "Nothing has happened yet. Events appear here as the run progresses."
            : "No events were recorded for this run."}
        </p>
      ) : (
        <ol className="grid grid-cols-[minmax(0,1fr)] gap-2" data-testid="run-log">
          {view.timeline.map((entry) => (
            <li
              key={entry.seq}
              className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 border-l-4 pl-3 ${TONE_CLASS[entry.tone]}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="text-xs text-muted-foreground">{formatClock(entry.at)}</span>
                <span className="font-medium">{entry.label}</span>
              </div>
              {entry.detail !== null ? <ExpandableText text={entry.detail} /> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
