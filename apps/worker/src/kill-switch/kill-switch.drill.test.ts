import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createToolRegistry, type AgentTool } from "../agent/tools.js";
import { createAgentLoop } from "../agent/agent-loop.js";
import { createMemoryCheckpointStore } from "../agent/checkpoint-store.test-helpers.js";
import { offerAllTools } from "../agent/tool-offer.test-helpers.js";
import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import {
  createCredentialIssuer,
  createCredentialVerifier,
  type CredentialStore,
  type NewCredentialRecord,
  type StoredCredential,
} from "../identity/index.js";
import { createLogger } from "../logger.js";
import { sweepControlRequests } from "../queue/run-control-sweep.js";
import { finalizeStop } from "../queue/run-stop.js";
import { RUN_STATUS } from "../queue/run-store.js";
import { KillSwitchActiveError } from "./kill-switch-guard.js";
import { createMemoryKillSwitch } from "./kill-switch-guard.test-helpers.js";

import type { ModelProvider, ModelResponse } from "../agent/model-provider.js";
import type { PolicyHook } from "../agent/policy-hook.js";
import type { RunExecutionContext } from "../queue/run-processor.js";
import type { RunControl } from "../queue/run-control.js";

/**
 * AGO-84: THE KILL SWITCH DRILL. Repeatable, no database, no model, no network: it runs in CI with `pnpm test`.
 *
 * It stages a small office (two agents in one workspace, one run of another workspace), pulls the switch while a
 * run is mid-step, and proves the three acceptance criteria end to end with the real agent loop, the real credential
 * issuer and verifier, the real stop finalizer and the real control sweep. Only the storage is in memory.
 *
 *  AC1  all credentials for the scope are revoked and runs halt
 *  AC2  state is preserved for review (nothing is deleted; the event log tells what happened)
 *  AC3  this file is the drill, and CI runs it
 *
 * The database side of the same promise (the `activate_kill_switch` function) is proven by pgTAP under the db lock.
 */

const WS = "84000000-0000-4000-8000-000000000001";
const OTHER_WS = "84000000-0000-4000-8000-000000000002";
const AGENT_A = "84000000-0000-4000-8000-0000000000a1";
const AGENT_B = "84000000-0000-4000-8000-0000000000a2";
const OTHER_AGENT = "84000000-0000-4000-8000-0000000000a3";
const HUMAN = "84000000-0000-4000-8000-0000000000d1";
const TEST_ONLY_SIGNING_SECRET = "test-only-not-a-real-secret-for-the-kill-switch-drill";
const CAPS = ["vault.read"];

interface DrillRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  status: string;
}

const run = (n: number, workspaceId: string, agentId: string, status: string): DrillRun => ({
  id: `84000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`,
  workspaceId,
  agentId,
  status,
});

function office() {
  const logger = createLogger({ level: "silent" });
  const checkpoints = createMemoryCheckpointStore();
  const latch = createMemoryKillSwitch();
  const runs = new Map<string, DrillRun>();
  const events = new Map<string, RunEventRow[]>();
  const toolLog: string[] = [];
  const credentialRows = new Map<
    string,
    NewCredentialRecord & { revokedAt: Date | null; archived: boolean }
  >();

  const store: CredentialStore = {
    grantedCapabilities: () => Promise.resolve([...CAPS]),
    isAgentActive: () => Promise.resolve(true),
    insert(record) {
      credentialRows.set(record.tokenHash, { ...record, revokedAt: null, archived: false });
      return Promise.resolve();
    },
    findByTokenHash(hash): Promise<StoredCredential | null> {
      const row = credentialRows.get(hash);
      if (row === undefined) return Promise.resolve(null);
      return Promise.resolve({
        ...row,
        agentArchived: false,
        liveCapabilities: [...CAPS],
      });
    },
    revokeForRun({ workspaceId, runId }) {
      let count = 0;
      for (const row of credentialRows.values()) {
        if (row.workspaceId === workspaceId && row.runId === runId && row.revokedAt === null) {
          row.revokedAt = new Date();
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
  };
  const issuer = createCredentialIssuer({
    store,
    secret: TEST_ONLY_SIGNING_SECRET,
    killSwitch: latch,
  });
  const verifier = createCredentialVerifier({ store, secret: TEST_ONLY_SIGNING_SECRET });

  const refOf = (r: DrillRun) => ({ workspaceId: r.workspaceId, runId: r.id });
  const add = (r: DrillRun): DrillRun => {
    runs.set(r.id, r);
    events.set(r.id, []);
    if (r.status !== RUN_STATUS.running) checkpoints.setRunStatus(refOf(r), r.status);
    return r;
  };

  /**
   * What `public.activate_kill_switch` does in the database, in memory: latch the scope, flag every live run in
   * scope for a stop, and revoke every credential of those runs. It writes no run events (the worker does).
   */
  async function activate(workspaceId: string, scope: "workspace" | "agent", agentId?: string) {
    latch.activate(workspaceId, scope, agentId);
    let runsStopped = 0;
    let credentialsRevoked = 0;
    for (const r of runs.values()) {
      const isInScope =
        r.workspaceId === workspaceId && (scope === "workspace" || r.agentId === agentId);
      const isLive = ["queued", "running", "paused"].includes(r.status);
      if (!isInScope || !isLive) continue;
      checkpoints.flagStop(refOf(r), HUMAN);
      runsStopped += 1;
      credentialsRevoked += await store.revokeForRun(refOf(r));
    }
    return { runsStopped, credentialsRevoked };
  }

  const markStopped = (ref: { workspaceId: string; runId: string }, from: readonly string[]) => {
    const r = runs.get(ref.runId);
    if (r === undefined || !from.includes(r.status)) return Promise.resolve(false);
    r.status = RUN_STATUS.stopped;
    return Promise.resolve(true);
  };
  /** One store for every run: routes a row to its run's list. */
  const sharedEvents = {
    insert: (row: RunEventRow) => {
      const list = events.get(row.run_id) ?? [];
      list.push(row);
      events.set(row.run_id, list);
      return Promise.resolve({ id: String(list.length), seq: list.length, created_at: "now" });
    },
  };

  const makeTool = (name: string, onRun?: () => Promise<void>): AgentTool => ({
    name,
    description: `${name} tool`,
    tier: 1,
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: vi.fn(async () => {
      toolLog.push(`tool:${name}`);
      await onRun?.();
      return `${name} output`;
    }),
  });
  const policy: PolicyHook = {
    check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }),
  };
  const provider: ModelProvider = {
    complete: (request) => {
      const seenResult = JSON.stringify(request.messages).includes("status: ");
      const response: ModelResponse = seenResult
        ? { text: "All done.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
        : {
            text: "",
            toolCalls: ["a", "b", "c"].map((name, i) => ({
              id: `toolu_${String(i)}`,
              name,
              input: { i },
            })),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
      return Promise.resolve(response);
    },
  };

  /** Run the real loop for one run, then finalize like the run processor does. Returns the loop's end. */
  async function execute(r: DrillRun, onToolA?: () => Promise<void>): Promise<string | undefined> {
    r.status = RUN_STATUS.running;
    const emitter = createRunEventEmitter({
      workspaceId: r.workspaceId,
      runId: r.id,
      logger,
      store: sharedEvents,
    });
    const taskId = r.id.replace("-0000000001", "-0000000002");
    const context: RunContext = {
      runId: r.id,
      workspaceId: r.workspaceId,
      agent: {
        id: r.agentId,
        workspaceId: r.workspaceId,
        name: "Scout",
        role: "Researches.",
        prompt: null,
      },
      task: {
        id: taskId,
        workspaceId: r.workspaceId,
        title: "Task",
        description: "Do it.",
      },
    };
    const loop = createAgentLoop({
      toolOffer: offerAllTools,
      provider,
      contextBuilder: createContextBuilder({
        source: {
          loadRun: () => Promise.resolve(context),
          loadAssignedSkills: () => Promise.resolve([]),
        },
        logger,
      }),
      tools: createToolRegistry([makeTool("a", onToolA), makeTool("b"), makeTool("c")]),
      policy,
      checkpoints,
      killSwitch: latch,
    });
    const ctx: RunExecutionContext = {
      workspaceId: r.workspaceId,
      runId: r.id,
      agentId: r.agentId,
      taskId,
      attempt: 0,
      logger,
      emitter,
      signal: new AbortController().signal,
    };
    const outcome = await loop.execute(ctx);
    if (outcome.end === "stopped") {
      await finalizeStop(
        { runs: { markStopped }, events: sharedEvents, checkpoints, logger },
        refOf(r),
        ["running"],
        emitter,
      );
    } else {
      r.status = RUN_STATUS.succeeded;
    }
    return outcome.end ?? "completed";
  }

  const sweep = () =>
    sweepControlRequests({
      runs: { markStopped },
      events: sharedEvents,
      checkpoints,
      control: { resumeRun: () => Promise.resolve("resumed" as const) } satisfies Pick<
        RunControl,
        "resumeRun"
      >,
      logger,
    });

  const issueFor = (r: DrillRun) =>
    issuer.issue({ workspaceId: r.workspaceId, agentId: r.agentId, runId: r.id });
  const verify = (token: string, r: DrillRun) =>
    verifier.verify(token, {
      workspaceId: r.workspaceId,
      runId: r.id,
      agentId: r.agentId,
      capability: CAPS[0] ?? "",
    });

  return {
    events,
    toolLog,
    latch,
    add,
    activate,
    execute,
    sweep,
    issueFor,
    verify,
    credentialRows,
  };
}

const types = (rows: readonly RunEventRow[] | undefined): string[] =>
  (rows ?? []).map((r) => r.type);

describe("AGO-84 drill: workspace kill switch pulled while an office is working", () => {
  it("revokes every credential in scope, halts every run, leaves other workspaces alone and keeps the record", async () => {
    const o = office();
    const running = o.add(run(1, WS, AGENT_A, RUN_STATUS.running));
    const queued = o.add(run(2, WS, AGENT_B, RUN_STATUS.queued));
    const paused = o.add(run(3, WS, AGENT_A, RUN_STATUS.paused));
    const bystander = o.add(run(4, OTHER_WS, OTHER_AGENT, RUN_STATUS.queued));
    const tokens = new Map<string, string>();
    for (const r of [running, queued, paused, bystander]) {
      tokens.set(r.id, (await o.issueFor(r)).token);
    }
    for (const r of [running, queued, paused, bystander]) {
      expect(await o.verify(tokens.get(r.id) ?? "", r)).toMatchObject({ ok: true });
    }

    // The switch is pulled while the first run is inside its first tool call.
    // The result is captured here and asserted after the loop returns: the loop catches anything a
    // tool throws, so an expect inside the callback could never fail the test.
    let activation: unknown;
    const end = await o.execute(running, async () => {
      activation = await o.activate(WS, "workspace");
    });
    await o.sweep();
    expect(activation).toEqual({ runsStopped: 3, credentialsRevoked: 3 });

    // AC1: runs halt. The running one finished its current call and started none after it.
    expect(end).toBe("stopped");
    expect(o.toolLog).toEqual(["tool:a"]);
    for (const r of [running, queued, paused]) expect(r.status).toBe(RUN_STATUS.stopped);
    expect(bystander.status).toBe(RUN_STATUS.queued);

    // AC1: every credential of the scope is revoked; the other workspace's credential still works.
    for (const r of [running, queued, paused]) {
      expect(await o.verify(tokens.get(r.id) ?? "", r)).toEqual({ ok: false, reason: "revoked" });
    }
    expect(await o.verify(tokens.get(bystander.id) ?? "", bystander)).toMatchObject({ ok: true });

    // Nothing new starts in scope: no credential is issued, and a run created now is stopped before any tool.
    await expect(o.issueFor(o.add(run(5, WS, AGENT_B, RUN_STATUS.queued)))).rejects.toBeInstanceOf(
      KillSwitchActiveError,
    );
    const late = o.add(run(6, WS, AGENT_B, RUN_STATUS.queued));
    expect(await o.execute(late)).toBe("stopped");
    expect(o.toolLog).toEqual(["tool:a"]);
    expect(late.status).toBe(RUN_STATUS.stopped);

    // AC2: state is preserved. Rows still exist (revoked, not deleted); each stopped run says it stopped, once.
    expect(o.credentialRows.size).toBe(4);
    for (const r of [running, queued, paused, late]) {
      expect(types(o.events.get(r.id)).filter((t) => t === "run.stopped")).toHaveLength(1);
    }
    expect(types(o.events.get(running.id))).toContain("tool_call.requested");
  });

  it("an agent scope halts that agent only; the other agent finishes its work", async () => {
    const o = office();
    const targeted = o.add(run(1, WS, AGENT_A, RUN_STATUS.queued));
    const other = o.add(run(2, WS, AGENT_B, RUN_STATUS.queued));
    const targetedToken = (await o.issueFor(targeted)).token;
    const otherToken = (await o.issueFor(other)).token;

    await o.activate(WS, "agent", AGENT_A);
    await o.sweep();

    expect(targeted.status).toBe(RUN_STATUS.stopped);
    expect(await o.verify(targetedToken, targeted)).toEqual({ ok: false, reason: "revoked" });
    expect(await o.execute(other)).toBe("completed");
    expect(await o.verify(otherToken, other)).toMatchObject({ ok: true });
    expect(o.toolLog).toEqual(["tool:a", "tool:b", "tool:c"]);
    await expect(o.issueFor(o.add(run(3, WS, AGENT_A, RUN_STATUS.queued)))).rejects.toBeInstanceOf(
      KillSwitchActiveError,
    );
    await expect(o.issueFor(o.add(run(4, WS, AGENT_B, RUN_STATUS.queued)))).resolves.toBeDefined();
  });

  it("stop is final: releasing the switch lets new work start but never revives a stopped run", async () => {
    const o = office();
    const victim = o.add(run(1, WS, AGENT_A, RUN_STATUS.queued));
    await o.activate(WS, "workspace");
    await o.sweep();
    expect(victim.status).toBe(RUN_STATUS.stopped);

    o.latch.release(WS);

    expect(victim.status).toBe(RUN_STATUS.stopped);
    await expect(o.issueFor(o.add(run(2, WS, AGENT_A, RUN_STATUS.queued)))).resolves.toBeDefined();
    const fresh = o.add(run(3, WS, AGENT_A, RUN_STATUS.queued));
    expect(await o.execute(fresh)).toBe("completed");
  });

  it("fails closed: a latch that cannot be read stops the attempt before any tool runs", async () => {
    const o = office();
    const r = o.add(run(1, WS, AGENT_A, RUN_STATUS.queued));
    o.latch.failReads();

    await expect(o.execute(r)).rejects.toThrow();

    expect(o.toolLog).toEqual([]);
    await expect(o.issueFor(r)).rejects.toThrow();
  });

  it("is repeatable: pulling the switch twice stops nothing twice and writes run.stopped once", async () => {
    const o = office();
    const r = o.add(run(1, WS, AGENT_A, RUN_STATUS.paused));
    await o.activate(WS, "workspace");
    await o.sweep();
    await o.activate(WS, "workspace");
    await o.sweep();

    expect(r.status).toBe(RUN_STATUS.stopped);
    expect(types(o.events.get(r.id)).filter((t) => t === "run.stopped")).toHaveLength(1);
  });
});
