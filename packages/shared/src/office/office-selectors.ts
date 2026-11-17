import {
  TERMINAL_RUN_PHASES,
  type AgentOfficeState,
  type AgentOfficeStateName,
  type OfficeState,
  type RunView,
} from "./office-state.js";

/**
 * Agent state (the six AGO-150 states) as a pure function of the runs. Not stored, so it can never
 * disagree with the runs; stores memoize it on the state object.
 *
 * Rules:
 * - a live run is `waiting_on_you` while an approval is open (the card opens it), else `error_or_paused`
 *   when paused, else `collaborating` with an open handoff, else `working` with a call in flight, else
 *   `thinking`; a queued run is `idle`;
 * - an agent a live run is handing off TO (not yet accepted) is `collaborating` too;
 * - an agent takes the highest-priority state of its live runs (ties: the run with the latest event);
 * - with no live run, the latest ended run decides: completed -> `idle`, failed or stopped ->
 *   `error_or_paused` (the failure stays visible until the agent's next run);
 * - an agent with no run is `idle` (only listed when the caller names it in `agentIds`).
 */
const PRIORITY: Record<AgentOfficeStateName, number> = {
  idle: 0,
  thinking: 1,
  working: 2,
  collaborating: 3,
  error_or_paused: 4,
  waiting_on_you: 5,
};

interface Candidate {
  readonly state: AgentOfficeStateName;
  readonly detail: string | null;
  readonly run: RunView;
  readonly approval_id: string | null;
}

function isEnded(run: RunView): boolean {
  return run.phase !== null && TERMINAL_RUN_PHASES.includes(run.phase.value);
}

function liveRunState(run: RunView): Candidate {
  const phase = run.phase?.value ?? "active";
  const detail = run.phase?.detail ?? null;
  const base = { run, approval_id: null, detail };
  if (run.approval) {
    return { ...base, state: "waiting_on_you", approval_id: run.approval.approval_id };
  }
  if (phase === "paused") return { ...base, state: "error_or_paused" };
  if (phase === "queued") return { ...base, state: "idle" };
  if (run.handoff) return { ...base, state: "collaborating", detail: null };
  if (run.tool) return { ...base, state: "working", detail: null };
  return { ...base, state: "thinking", detail: null };
}

function endedRunState(run: RunView): Candidate {
  const state: AgentOfficeStateName = run.phase?.value === "completed" ? "idle" : "error_or_paused";
  return { state, detail: run.phase?.detail ?? null, run, approval_id: null };
}

function isLater(a: RunView, b: RunView): boolean {
  const byTime = Date.parse(a.last_event_at) - Date.parse(b.last_event_at);
  if (byTime !== 0) return byTime > 0;
  return a.run_id > b.run_id;
}

function better(candidate: Candidate, current: Candidate | undefined): boolean {
  if (!current) return true;
  const byPriority = PRIORITY[candidate.state] - PRIORITY[current.state];
  if (byPriority !== 0) return byPriority > 0;
  return isLater(candidate.run, current.run);
}

/** The state of every agent that has a run (plus every id in `agentIds`, idle when it has none). */
export function selectAgentStates(
  state: OfficeState,
  agentIds: readonly string[] = [],
): Record<string, AgentOfficeState> {
  const live = new Map<string, Candidate>();
  const ended = new Map<string, Candidate>();
  const offer = (agentId: string, candidate: Candidate): void => {
    if (better(candidate, live.get(agentId))) live.set(agentId, candidate);
  };

  for (const run of Object.values(state.runs)) {
    if (isEnded(run)) {
      const current = ended.get(run.agent_id);
      if (!current || isLater(run, current.run)) ended.set(run.agent_id, endedRunState(run));
      continue;
    }
    offer(run.agent_id, liveRunState(run));
    const target = run.handoff && !run.handoff.accepted ? run.handoff.to_agent_id : null;
    if (target) offer(target, { state: "collaborating", detail: null, run, approval_id: null });
  }

  const result: Record<string, AgentOfficeState> = {};
  const agents = new Set<string>([...live.keys(), ...ended.keys(), ...agentIds]);
  for (const agentId of agents) {
    const chosen = live.get(agentId) ?? ended.get(agentId);
    result[agentId] = chosen
      ? {
          agent_id: agentId,
          state: chosen.state,
          detail: chosen.detail,
          run_id: chosen.run.run_id,
          approval_id: chosen.approval_id,
        }
      : { agent_id: agentId, state: "idle", detail: null, run_id: null, approval_id: null };
  }
  return result;
}
