import { createHash } from "node:crypto";

import {
  APPROVAL_ACTION_MAX_LENGTH,
  APPROVAL_STATUS,
  CONTEXT_TEXT_MAX_LENGTH,
  DEFAULT_CONTEXT_MAX_CHARS,
  emptyRunCheckpointState,
  LOOP_REPEAT_THRESHOLD,
  MIN_NEVER_AUTOMATIC_TIER,
  type CheckpointCall,
  type CheckpointStep,
  type RunCheckpointState,
} from "@ago/shared";
import { z } from "zod";

import { approvalIdFor, type ApprovalStore } from "../approvals/index.js";
import { ContextBuildError, type ContextBuilder } from "../context/index.js";
import { scrubString } from "../logger.js";
import {
  NonRetryableRunError,
  type RunExecutionContext,
  type RunExecutor,
  type RunOutcome,
} from "../queue/run-processor.js";

import {
  CheckpointUnreadableError,
  noopCheckpointStore,
  type CheckpointStore,
} from "./checkpoint-store.js";
import { ModelProviderError, type ModelProvider, type ModelToolCall } from "./model-provider.js";
import type { BudgetGuard, Reservation } from "../budget/index.js";
import type { ModelRouter } from "./model-routing.js";
import type { PolicyDecision, PolicyHook } from "./policy-hook.js";
import type { RunLimitsResolver } from "./run-limits.js";
import type { ToolOffer } from "./tool-offer.js";
import type { ToolRegistry } from "./tools.js";
import type { BudgetScope, BudgetStopReason, CapabilityTier, RetrievedItem } from "@ago/shared";

/**
 * The agent tool loop (AGO-167). One run is: build context -> ask the model -> for each tool call,
 * policy check -> (execute | deny | stop for approval) -> feed the result back, until the model gives a
 * final answer or a limit is hit.
 *
 * Invariants (each has a test in agent-loop.test.ts):
 * - `executeToolCall` is the only function that calls `tool.execute`, and it calls the policy hook first.
 *   The registry is fixed at creation, so a tool cannot be added mid-run to skip the hook.
 * - The model is shown only the tools `toolOffer` returns for that step (granted and enabled, AGO-25), and a
 *   call for any other name is denied `tool_not_offered` without reaching the hook or the tool. This is an
 *   extra layer: a tool that was offered still goes through the policy hook.
 * - A hook that throws, or answers with anything but allow, deny or needs_approval, is a deny.
 * - Tier 3 and 4 tools never run on `allow`: they stop for a human (AGO-125, human in the loop).
 * - `needs_approval` creates a pending `approvals` row (AGO-21), emits `approval.requested` (bound to a payload
 *   hash) and ends the run as paused. The tool is never executed here. On resume the call reads its approval:
 *   still pending and unexpired, the run pauses again; past `expires_at`, the loop expires it itself (timeout
 *   means deny, even if the sweep is late or down) and the model is told; anything else, including `approved`
 *   until AGO-47 binds approvals to the payload hash, is a deny. The tool runs in none of these paths.
 * - Checkpoints (AGO-30): the loop saves its state after the model answers, before each tool runs and after each
 *   one finishes. A retry or a resume restores it: finished calls are not run again, and a call that started
 *   but has no saved result is never re-run (its outcome is recorded as unknown).
 * - Events carry hashes and counts, never raw tool input or output. The model credential is not in
 *   this module at all: only the provider holds it.
 */

export interface AgentLoopLimits {
  readonly maxSteps: number;
  /** Input plus output tokens across the whole run. */
  readonly maxTokens: number;
  readonly maxWallMs: number;
  readonly maxOutputTokens: number;
  /** A tool result longer than this is cut before it goes back to the model. */
  readonly maxToolResultChars: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLoopLimits = {
  maxSteps: 25,
  maxTokens: 200_000,
  // Under the job's 15 minute expiry (RUN_JOB_EXPIRE_SECONDS) so the loop stops itself first.
  maxWallMs: 600_000,
  maxOutputTokens: 4_096,
  maxToolResultChars: 20_000,
};

/** Tool calls handled per model step; any more are ignored (and logged). */
export const MAX_TOOL_CALLS_PER_STEP = 8;
/** How long an approval request stays open before it counts as denied (timeout means deny). */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** What a `budget.exceeded` event says: which budget, why, the limit, what was counted and the cost held back. */
interface BudgetStopDetail {
  readonly scope: BudgetScope;
  readonly reason: BudgetStopReason;
  readonly limit: number;
  readonly used: number;
  readonly estimate?: number;
}

const SUMMARY_MAX = 500;
const MESSAGE_MAX = 2_000;
const INPUT_PREVIEW_MAX = 2_000;
const TRUNCATION_MARKER = "\n[truncated]";

export interface AgentLoopDeps {
  /**
   * The model for a run: either one fixed provider, or (production) a router that picks the provider from
   * the agent's own model setting once per run (AGO-94). Exactly one of the two is required.
   */
  readonly provider?: ModelProvider;
  readonly modelRouter?: ModelRouter;
  readonly contextBuilder: ContextBuilder;
  readonly tools: ToolRegistry;
  /**
   * Decides which registered tools the model is shown (AGO-25), asked before every model call. The model can
   * only call what it was shown in that step: any other name is denied before the policy hook runs.
   */
  readonly toolOffer: ToolOffer;
  readonly policy: PolicyHook;
  /**
   * Where the run's state is saved between tool calls (AGO-30), so a retry or a resume continues instead of
   * starting over. Omitted: nothing is saved and a retried run starts from step 1, as before.
   */
  readonly checkpoints?: CheckpointStore;
  /**
   * Where approval requests are kept (AGO-21). A call that needs approval gets a `pending` row here before the
   * run pauses. Omitted: no row is made, and a resumed call is denied (nothing can ever approve it).
   */
  readonly approvals?: ApprovalStore;
  /**
   * The money budgets (AGO-40): checked before every model call, settled after it. A call that would pass the agent's
   * daily or the workspace's monthly budget is not made and the run stops. Omitted: no money check (tests); production
   * always wires it in `wire.ts`.
   */
  readonly budget?: BudgetGuard;
  readonly limits?: Partial<AgentLoopLimits>;
  /**
   * Per-agent step, token and wall-time limits (AGO-166), looked up at the start of each run. They replace the
   * same three fields of `limits`; a resolver that throws falls back to `limits` (the safe values).
   */
  readonly limitsResolver?: RunLimitsResolver;
  /** The context builder's own cap, used to keep the tool history inside it. */
  readonly contextMaxChars?: number;
  readonly approvalTtlMs?: number;
  /** Per-call time budget for the policy hook; capped well below `maxWallMs`. Timeout means deny. */
  readonly policyTimeoutMs?: number;
  /** Tests inject a clock. */
  readonly now?: () => number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const isPlain = ["string", "number", "boolean"].includes(typeof value);
    return isPlain ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function sliceSafe(text: string, length: number): string {
  if (length <= 0) return "";
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

function describeError(error: unknown): string {
  return scrubString(error instanceof Error ? error.message : "unknown error").slice(0, 300);
}

/** Reason code when the model names a tool outside the list it was shown. */
export const TOOL_NOT_OFFERED = "tool_not_offered";
/**
 * Recorded instead of the model's tool name when the call is for a tool it was not offered (AGO-25). The name
 * is model-controlled text, so it is never stored or logged for a call that did not match an offered tool.
 */
export const NOT_OFFERED_TOOL_NAME = "<not_offered>";

const VALID_CALL_ID = /^[\w.:-]{1,128}$/;
const REASON_CODE = /^[a-z0-9_.-]{1,100}$/;

/** The hook's whole answer is untrusted until it parses. Anything else is a deny. */
const policyDecisionSchema = z.strictObject({
  decision: z.enum(["allow", "deny", "needs_approval"]),
  reasonCode: z.string().regex(REASON_CODE),
  ruleId: z.string().max(128).optional(),
});

/** Longest a policy hook may take, unless configured lower. Timeout means deny. */
export const DEFAULT_POLICY_TIMEOUT_MS = 10_000;

/** The run's wall-time limit passed while something was still pending. */
class RunDeadlineError extends Error {
  constructor() {
    super("run wall-time limit reached");
    this.name = "RunDeadlineError";
  }
}

/** The hook's own time budget ran out. */
class PolicyTimeoutError extends Error {
  constructor() {
    super("policy hook timed out");
    this.name = "PolicyTimeoutError";
  }
}

/** Run `fn` so a synchronous throw becomes a rejection. */
function callSafely<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(fn());
  });
}

/** Why a pending await was cut short: a worker shutdown (the queue retries) or the wall-time limit. */
function interruption(shutdown: AbortSignal): Error {
  return shutdown.aborted
    ? new Error("run aborted: the worker is shutting down")
    : new RunDeadlineError();
}

/**
 * Settle with `promise`, or reject with `makeError()` the moment `signal` aborts, whichever is first.
 * The abandoned promise is still observed, so a late rejection is not an unhandled one.
 */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  makeError: () => Error,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(makeError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(makeError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

interface ToolRecord {
  readonly source: string;
  readonly content: string;
}

type ToolCallResult =
  | {
      readonly kind: "result";
      readonly record: ToolRecord;
      readonly isError: boolean;
      /** Hash of (tool name, canonical input, output); equal fingerprints mean an identical call and result. */
      readonly fingerprint: string;
      readonly toolName: string;
    }
  | { readonly kind: "needs_approval"; readonly payloadHash: string };

/** The result for a call that was closed without running (AGO-30): same shape as any other failed call. */
function unrunResult(
  offeredName: string | undefined,
  call: CheckpointCall,
  errorCode: string,
  text: string,
): ToolCallResult {
  const toolName = offeredName ?? NOT_OFFERED_TOOL_NAME;
  return {
    kind: "result",
    isError: true,
    toolName,
    fingerprint: sha256(`${call.name}
${sha256(canonicalJson(call.input))}
error:${errorCode}`),
    record: {
      source: `tool:${toolName}#${call.call_id}`.slice(0, 200),
      content: `status: error
${text}`,
    },
  };
}

/** A tool input as stored in a checkpoint: scrubbed like every other text the loop keeps. */
function scrubInput(input: unknown): unknown {
  let json: unknown; // undefined at runtime for undefined and functions
  try {
    json = JSON.stringify(input);
  } catch {
    return null;
  }
  if (typeof json !== "string") return null;
  const clean = scrubString(json);
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return clean;
  }
}

export function createAgentLoop(deps: AgentLoopDeps): RunExecutor {
  const limits: AgentLoopLimits = { ...DEFAULT_AGENT_LIMITS, ...deps.limits };
  // Each stored record adds a status line and an input preview to the result, and the builder throws on
  // an item over CONTEXT_TEXT_MAX_LENGTH, so leave room for them.
  if (limits.maxToolResultChars > CONTEXT_TEXT_MAX_LENGTH - INPUT_PREVIEW_MAX - 1_000) {
    throw new Error("maxToolResultChars leaves no room under what the context builder accepts");
  }
  if ((deps.provider === undefined) === (deps.modelRouter === undefined)) {
    throw new Error("createAgentLoop needs exactly one of provider or modelRouter");
  }
  const now = deps.now ?? Date.now;
  const approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  // Well below the wall-time limit, so a silent hook costs a deny, never the run.
  const policyTimeoutFor = (maxWallMs: number): number =>
    Math.max(
      1,
      Math.min(deps.policyTimeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS, Math.floor(maxWallMs / 4)),
    );
  const historyBudgetChars = Math.floor((deps.contextMaxChars ?? DEFAULT_CONTEXT_MAX_CHARS) / 2);

  /** This run's limits: the worker-wide ones, with the agent's own step, token and time limits on top. */
  async function resolveRunLimits(ctx: RunExecutionContext): Promise<AgentLoopLimits> {
    if (deps.limitsResolver === undefined) return limits;
    try {
      const own = await deps.limitsResolver.resolve({
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
      });
      return {
        ...limits,
        maxSteps: own.maxSteps,
        maxTokens: own.maxTokens,
        maxWallMs: own.maxWallMs,
      };
    } catch (error) {
      // Never run unbounded because a lookup failed: the worker-wide limits are the safe fallback.
      ctx.logger.error({ err: error }, "could not resolve the agent's run limits; using defaults");
      return limits;
    }
  }

  /** The single place a tool runs. Policy first, always. */
  async function executeToolCall(
    ctx: RunExecutionContext,
    call: ModelToolCall,
    step: number,
    index: number,
    signal: AbortSignal,
    policyTimeoutMs: number,
    offered: ReadonlySet<string>,
    beforeRun: () => Promise<void> = () => Promise.resolve(),
  ): Promise<ToolCallResult> {
    const { emitter } = ctx;
    const callId = VALID_CALL_ID.test(call.id) ? call.id : `call_${String(step)}_${String(index)}`;
    const tool = deps.tools.get(call.name);
    // Only the catalog's own name for an offered tool is ever stored; anything else gets the placeholder.
    const toolName =
      tool !== undefined && offered.has(call.name) ? tool.name : NOT_OFFERED_TOOL_NAME;
    const tier: CapabilityTier = tool?.tier ?? 4;
    const inputHash = sha256(canonicalJson(call.input));
    // Only ever hashed: different unlisted names still count as different calls for loop detection.
    const fingerprintName = call.name.slice(0, 128);
    const source = `tool:${toolName}#${callId}`.slice(0, 200);
    const fail = (text: string): ToolCallResult => ({
      kind: "result",
      isError: true,
      toolName,
      // A call that fails the same way every time is as much a loop as one that succeeds the same way.
      fingerprint: sha256(`${fingerprintName}\n${inputHash}\nerror:${text}`),
      record: { source, content: `status: error\n${text}` },
    });

    await emitter.emit({
      type: "tool_call.requested",
      payload: { call_id: callId, tool_name: toolName, tier, input_hash: inputHash },
    });

    // The hook gets its own time budget and an abort signal. It also ends with the run: shutdown or the
    // wall-time limit preempts a hook that never answers.
    const consultPolicy = async (): Promise<PolicyDecision> => {
      const hookSignal = AbortSignal.any([signal, AbortSignal.timeout(policyTimeoutMs)]);
      try {
        const answer = await abortable(
          callSafely(() =>
            deps.policy.check(
              {
                callId,
                toolName: call.name,
                input: call.input,
                tier,
                ...(tool?.capabilityKey === undefined ? {} : { capabilityKey: tool.capabilityKey }),
                isRegistered: tool !== undefined,
              },
              {
                workspaceId: ctx.workspaceId,
                runId: ctx.runId,
                agentId: ctx.agentId,
                step,
                signal: hookSignal,
              },
            ),
          ),
          hookSignal,
          () => (signal.aborted ? interruption(ctx.signal) : new PolicyTimeoutError()),
        );
        const parsed = policyDecisionSchema.safeParse(answer);
        return parsed.success
          ? parsed.data
          : { decision: "deny", reasonCode: "policy_invalid_response" };
      } catch (error) {
        if (signal.aborted) throw interruption(ctx.signal);
        const isTimeout = error instanceof PolicyTimeoutError;
        if (!isTimeout) {
          ctx.logger.error({ err: error, call_id: callId }, "policy hook failed; denying the call");
        }
        return { decision: "deny", reasonCode: isTimeout ? "policy_timeout" : "policy_hook_error" };
      }
    };
    // A tool the model was not shown this step is denied outright (AGO-25): the hook is not asked, nothing
    // runs, and the event carries a fixed reason, never the arguments. An unknown or renamed tool lands here too.
    let decision: PolicyDecision;
    if (offered.has(call.name)) {
      decision = await consultPolicy();
    } else {
      ctx.logger.warn(
        { call_id: callId, step },
        "model asked for a tool it was not offered; denied",
      );
      decision = { decision: "deny", reasonCode: TOOL_NOT_OFFERED };
    }
    // Nothing can be executed that is not registered, whatever the hook says.
    if (tool === undefined && decision.decision !== "deny") {
      decision = { decision: "deny", reasonCode: "unknown_tool" };
    }
    // Tier 3 and 4 are never automatic: an `allow` becomes a request for a human.
    if (decision.decision === "allow" && tier >= MIN_NEVER_AUTOMATIC_TIER) {
      decision = { decision: "needs_approval", reasonCode: "tier_requires_approval" };
    }

    await emitter.emit({
      type: "policy.decision",
      payload: {
        call_id: callId,
        decision: decision.decision,
        tier,
        reason_code: decision.reasonCode,
        ...(decision.ruleId === undefined ? {} : { rule_id: decision.ruleId.slice(0, 128) }),
      },
    });

    if (decision.decision === "deny") {
      await emitter.emit({
        type: "tool_call.failed",
        payload: {
          call_id: callId,
          error_code: "policy_denied",
          message: `denied by policy: ${decision.reasonCode}`,
        },
      });
      return fail("The policy denied this tool call. It was not run.");
    }

    if (decision.decision === "needs_approval" || tool === undefined) {
      const payloadHash = sha256(canonicalJson({ tool_name: call.name, input: call.input }));
      // The id comes from the run, step and call, so a retry finds the row it already made (AGO-21).
      const approvalId = approvalIdFor({ runId: ctx.runId, step, callId });
      let expiresAt = new Date(now() + approvalTtlMs);
      if (deps.approvals !== undefined) {
        // The row exists before the event and before the run pauses. A failure here throws: the run errors and
        // the queue retries, and the tool is never run.
        const stored = await deps.approvals.create({
          workspaceId: ctx.workspaceId,
          runId: ctx.runId,
          agentId: ctx.agentId,
          approvalId,
          action: toolName.slice(0, APPROVAL_ACTION_MAX_LENGTH),
          payloadHash,
          expiresAt,
        });
        expiresAt = stored.expiresAt;
      }
      await emitter.emit({
        type: "approval.requested",
        payload: {
          approval_id: approvalId,
          call_id: callId,
          payload_hash: payloadHash,
          tier,
          expires_at: expiresAt.toISOString(),
        },
      });
      return { kind: "needs_approval", payloadHash };
    }

    // From here on the call is allowed.
    const parsedInput = tool.inputSchema.safeParse(call.input);
    if (!parsedInput.success) {
      await emitter.emit({
        type: "tool_call.failed",
        payload: {
          call_id: callId,
          error_code: "invalid_input",
          message: "tool input was invalid",
        },
      });
      return fail("The tool input was invalid. It was not run.");
    }

    // Saved before the tool is touched: a crash after this point never runs the call a second time (AGO-30).
    await beforeRun();
    await emitter.emit({ type: "tool_call.started", payload: { call_id: callId } });
    const startedAt = now();
    let output: string;
    try {
      output = await abortable(
        callSafely(() =>
          tool.execute(parsedInput.data, {
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            agentId: ctx.agentId,
            signal,
          }),
        ),
        signal,
        () => interruption(ctx.signal),
      );
    } catch (error) {
      if (signal.aborted) throw interruption(ctx.signal);
      const message = describeError(error);
      await emitter.emit({
        type: "tool_call.failed",
        payload: { call_id: callId, error_code: "tool_error", message },
      });
      return fail(`The tool failed: ${message}`);
    }

    const safeOutput = scrubString(output);
    await emitter.emit({
      type: "tool_call.completed",
      payload: {
        call_id: callId,
        duration_ms: Math.max(0, now() - startedAt),
        output_hash: sha256(safeOutput),
      },
    });

    let kept = safeOutput;
    if (safeOutput.length > limits.maxToolResultChars) {
      kept = sliceSafe(safeOutput, limits.maxToolResultChars) + TRUNCATION_MARKER;
      await emitter.emit({
        type: "context.cut",
        payload: {
          section: "tool_result",
          source,
          action: "truncated",
          original_chars: safeOutput.length,
          kept_chars: kept.length - TRUNCATION_MARKER.length,
        },
      });
    }
    // Scrubbed: this text is saved in the run checkpoint (AGO-30), so a secret in a tool input must not be in it.
    const inputPreview = scrubString(canonicalJson(call.input).slice(0, INPUT_PREVIEW_MAX));
    return {
      kind: "result",
      isError: false,
      toolName,
      // The hash is of the full scrubbed output, not the truncated copy the model sees.
      fingerprint: sha256(`${fingerprintName}\n${inputHash}\nok:${sha256(safeOutput)}`),
      record: { source, content: `status: ok\ninput: ${inputPreview}\n\n${kept}` },
    };
  }

  /** Keep the newest tool results that fit half the context cap; older ones are dropped (and reported). */
  function windowHistory(history: readonly ToolRecord[]): {
    readonly kept: readonly RetrievedItem[];
    readonly dropped: readonly ToolRecord[];
  } {
    let used = 0;
    let firstKept = history.length;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const record = history[i];
      if (record === undefined) break;
      if (firstKept < history.length && used + record.content.length > historyBudgetChars) break;
      used += record.content.length;
      firstKept = i;
    }
    return { kept: history.slice(firstKept), dropped: history.slice(0, firstKept) };
  }

  return {
    async execute(ctx: RunExecutionContext): Promise<RunOutcome> {
      const { emitter } = ctx;
      const checkpoints = deps.checkpoints ?? noopCheckpointStore;
      const ref = { workspaceId: ctx.workspaceId, runId: ctx.runId };
      const runLimits = await resolveRunLimits(ctx);
      const policyTimeoutMs = policyTimeoutFor(runLimits.maxWallMs);
      const startedAt = now();
      const deadline = startedAt + runLimits.maxWallMs;
      const history: ToolRecord[] = [];
      // Loop detection: the fingerprint of the last tool result and how many in a row were identical.
      let lastFingerprint = "";
      let repeatCount = 0;
      // A function, not a read of `ctx.signal.aborted`, so the check is re-evaluated after each await.
      const isShuttingDown = (): boolean => ctx.signal.aborted;
      let reportedDropped = 0;
      let steps = 0;
      let tokens = 0;
      let completedCalls = 0;
      // The step whose tool calls are not all done yet (AGO-30). Null: the next thing to do is a model call.
      let openStep: CheckpointStep | null = null;
      // A step that paused for an approval already emitted its `step.completed`; its resume must not repeat it.
      let skipStepCompleted = false;

      // AGO-30: pick the run up from its checkpoint. A stored state that cannot be read fails the run for good:
      // starting over would repeat tool calls, and guessing would be worse.
      let loaded;
      try {
        loaded = await checkpoints.load(ref);
      } catch (error) {
        if (error instanceof CheckpointUnreadableError) {
          throw new NonRetryableRunError("checkpoint_unreadable", error.message);
        }
        throw error;
      }
      if (loaded.state !== null) {
        const saved = loaded.state;
        steps = saved.steps;
        tokens = saved.tokens;
        completedCalls = saved.completedCalls;
        lastFingerprint = saved.lastFingerprint;
        repeatCount = saved.repeatCount;
        reportedDropped = saved.reportedDropped;
        history.push(...saved.history.map(({ source, content }) => ({ source, content })));
        openStep = structuredClone(saved.step);
        skipStepCompleted =
          openStep?.calls.some((call) => call.status === "awaiting_approval") ?? false;
        await emitter.emit({
          type: "run.recovered",
          payload: { step: steps, completed_calls: completedCalls },
        });
      }

      /** What a crash right now would have to resume from. Only what the model would still be shown is kept. */
      const snapshot = (): RunCheckpointState => ({
        ...emptyRunCheckpointState(),
        steps,
        tokens,
        completedCalls,
        lastFingerprint,
        repeatCount,
        // Older records are left out, so none of what is stored counts as "already reported" on restore.
        reportedDropped: 0,
        history: windowHistory(history).kept.map(({ source, content }) => ({ source, content })),
        step:
          openStep === null
            ? null
            : {
                step: openStep.step,
                hadError: openStep.hadError,
                calls: openStep.calls.map((call) => ({ ...call, input: scrubInput(call.input) })),
              },
      });
      const persist = (): Promise<void> => checkpoints.save(ref, snapshot());

      const stopForLimit = async (
        limit: "steps" | "tokens" | "time",
        max: number,
        observed: number,
      ): Promise<RunOutcome> => {
        await emitter.emit({
          type: "run.limit_reached",
          payload: { limit, max, observed: Math.max(0, Math.round(observed)) },
        });
        return { steps, end: "limit_reached" };
      };

      // The run's own token budget (AGO-40): the budget event first, so a human sees why, then the terminal event.
      const stopForTokens = async (): Promise<RunOutcome> => {
        await emitter.emit({
          type: "budget.exceeded",
          payload: {
            scope: "run",
            reason: "run_token_limit_reached",
            limit: runLimits.maxTokens,
            used: Math.max(0, Math.round(tokens)),
          },
        });
        return stopForLimit("tokens", runLimits.maxTokens, tokens);
      };

      const emitBudgetExceeded = async (detail: BudgetStopDetail): Promise<void> => {
        await emitter.emit({
          type: "budget.exceeded",
          payload: {
            scope: detail.scope,
            reason: detail.reason,
            limit: detail.limit,
            used: detail.used,
            ...(detail.estimate === undefined ? {} : { estimate: detail.estimate }),
          },
        });
      };

      // A money budget stopped the run (AGO-40): the budget event with its reason, then the terminal `run.stopped`.
      // The run ends as a limit does: failed, no result, nothing more spent.
      const stopForBudget = async (detail: BudgetStopDetail): Promise<RunOutcome> => {
        await emitBudgetExceeded(detail);
        await emitter.emit({
          type: "run.stopped",
          payload: { stopped_by: "budget", reason: detail.reason },
        });
        return { steps, end: "limit_reached" };
      };

      // A human asked for a pause. Reached only between awaits, never in the middle of one: the model call that
      // was in flight has already returned, so a paused run holds no open model call (AGO-30 AC2).
      const stopForPause = async (): Promise<RunOutcome> => {
        await persist();
        return {
          steps,
          end: "paused",
          pauseReason: "user_pause",
          summary: "paused at a human's request",
        };
      };

      // One signal for the whole run: shutdown, or the wall-time limit. Every pending await (model call,
      // policy hook, tool) is raced against it, so nothing can hold the run past `maxWallMs`.
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(runLimits.maxWallMs)]);

      // AGO-94: the model is chosen once, here, from the agent row, so every call of this run uses it and
      // a model change made mid-run waits for the next run. An unknown model fails the run (non-retryable).
      const provider =
        deps.provider ??
        (await abortable(
          callSafely(() => {
            const router = deps.modelRouter;
            if (router === undefined) throw new Error("no model router");
            return router.resolve({ workspaceId: ctx.workspaceId, agentId: ctx.agentId });
          }),
          signal,
          () => interruption(ctx.signal),
        ));

      /** Re-evaluated whenever it is needed, so a grant revoked mid-run drops the tool from the next call. */
      const offerNow = (): Promise<ReadonlySet<string>> =>
        abortable(
          callSafely(() =>
            deps.toolOffer.offeredToolNames(deps.tools.all(), {
              workspaceId: ctx.workspaceId,
              runId: ctx.runId,
              agentId: ctx.agentId,
            }),
          ),
          signal,
          () => interruption(ctx.signal),
        );

      /** A call whose result cannot be learned any more: it is recorded as failed and is never run (AGO-30). */
      const closeWithoutRunning = async (
        call: CheckpointCall,
        errorCode: string,
        message: string,
        text: string,
      ): Promise<ToolCallResult> => {
        await emitter.emit({
          type: "tool_call.failed",
          payload: { call_id: call.call_id, error_code: errorCode, message },
        });
        return unrunResult(deps.tools.get(call.name)?.name, call, errorCode, text);
      };

      /**
       * What a resumed `awaiting_approval` call does (AGO-21): wait again, or close without running. The tool is
       * never run from here, whatever the approval says: `approved` is not honoured until AGO-47 binds it to the
       * payload hash and makes it single use, so it fails closed like every other status except a live `pending`.
       */
      const resolveApproval = async (
        step: number,
        call: CheckpointCall,
      ): Promise<
        | { readonly kind: "waiting" }
        | {
            readonly kind: "closed";
            readonly errorCode: string;
            readonly message: string;
            readonly text: string;
          }
      > => {
        const notGranted = {
          kind: "closed",
          errorCode: "approval_not_granted",
          message: "no approval was recorded for this call",
          text: "The tool call needed a human approval that was not given. It was not run.",
        } as const;
        const store = deps.approvals;
        if (store === undefined) return notGranted;
        const ref = {
          workspaceId: ctx.workspaceId,
          approvalId: approvalIdFor({ runId: ctx.runId, step, callId: call.call_id }),
        };
        let approval = await store.get(ref);
        // No row, or a row for another payload than the one this call stored: nothing is bound to this call.
        if (approval === null || approval.payloadHash !== call.payload_hash) return notGranted;

        if (approval.status === APPROVAL_STATUS.pending) {
          if (approval.expiresAt.getTime() > now()) return { kind: "waiting" };
          // Past its time: timeout means deny, right here, even if the sweep is late or down. Only the caller
          // that moves the row writes the event, so the sweep and this path never both record it.
          const moved = await store.expire(ref, new Date(now()));
          if (moved !== null) {
            await emitter.emit({
              type: "approval.decided",
              payload: {
                approval_id: ref.approvalId,
                outcome: "expired",
                decided_by: "timeout",
                payload_hash: approval.payloadHash,
              },
            });
          }
          approval = await store.get(ref);
          if (approval === null) return notGranted;
          // Still pending after the attempt, though past its time: it is an expiry all the same.
          if (approval.status === APPROVAL_STATUS.pending) {
            return {
              kind: "closed",
              errorCode: "approval_expired",
              message: "the approval request expired",
              text: "The approval request for this tool call expired before a human answered. It was not run.",
            };
          }
        }

        if (approval.status === APPROVAL_STATUS.rejected) {
          return {
            kind: "closed",
            errorCode: "approval_expired",
            message: "the approval request expired",
            text: "The approval request for this tool call expired before a human answered. It was not run.",
          };
        }
        if (approval.status === APPROVAL_STATUS.denied) {
          return {
            kind: "closed",
            errorCode: "approval_denied",
            message: "a human denied the approval request",
            text: "A human denied this tool call. It was not run.",
          };
        }
        return notGranted;
      };

      const runSteps = async (): Promise<RunOutcome> => {
        for (;;) {
          if (isShuttingDown()) throw interruption(ctx.signal);

          let offeredNames: ReadonlySet<string>;
          if (openStep === null) {
            if (steps >= runLimits.maxSteps)
              return stopForLimit("steps", runLimits.maxSteps, steps);
            if (now() >= deadline)
              return stopForLimit("time", runLimits.maxWallMs, now() - startedAt);
            if (tokens >= runLimits.maxTokens) return stopForTokens();
            if (await checkpoints.isPauseRequested(ref)) return stopForPause();

            steps += 1;
            const step = steps;
            await emitter.emit({ type: "step.started", payload: { step } });

            const { kept, dropped } = windowHistory(history);
            for (const record of dropped.slice(reportedDropped)) {
              await emitter.emit({
                type: "context.cut",
                payload: {
                  section: "retrieved",
                  source: record.source,
                  action: "dropped",
                  original_chars: record.content.length,
                  kept_chars: 0,
                },
              });
            }
            reportedDropped = dropped.length;

            let built;
            try {
              built = await deps.contextBuilder.build(ctx.runId, { retrieved: kept });
            } catch (error) {
              if (error instanceof ContextBuildError) {
                throw new NonRetryableRunError(error.code, error.message);
              }
              throw error;
            }
            for (const cut of built.metadata.cuts) {
              await emitter.emit({
                type: "context.cut",
                payload: {
                  section: cut.section,
                  source: cut.source,
                  action: cut.action,
                  original_chars: cut.original_chars,
                  kept_chars: cut.kept_chars,
                },
              });
            }

            // Re-evaluated at every step, so a grant revoked mid-run drops the tool from the next model call.
            offeredNames = await offerNow();
            const offeredTools = deps.tools.list().filter((tool) => offeredNames.has(tool.name));

            // AGO-40: the money check, BEFORE the call. The guard holds the worst-case cost of this call against the
            // agent's daily and the workspace's monthly budget; a refusal means the call is never made.
            const budget = deps.budget;
            const model = provider.model;
            let reservation: Reservation | null = null;
            if (budget !== undefined) {
              const requestChars =
                built.system.length +
                built.messages.reduce((sum, message) => sum + message.content.length, 0) +
                JSON.stringify(offeredTools).length;
              const decision = await abortable(
                callSafely(() =>
                  budget.reserve({
                    workspaceId: ctx.workspaceId,
                    agentId: ctx.agentId,
                    model,
                    inputCharacters: requestChars,
                    maxOutputTokens: runLimits.maxOutputTokens,
                  }),
                ),
                signal,
                () => interruption(ctx.signal),
              );
              if (!decision.allowed) {
                await emitter.emit({ type: "step.completed", payload: { step, outcome: "error" } });
                return stopForBudget({
                  scope: decision.scope,
                  reason: decision.reason,
                  limit: decision.limit,
                  used: decision.used,
                  ...(decision.estimateCents === undefined
                    ? {}
                    : { estimate: decision.estimateCents }),
                });
              }
              reservation = decision.reservation;
            }

            let response;
            try {
              response = await abortable(
                callSafely(() =>
                  provider.complete({
                    system: built.system,
                    messages: built.messages,
                    tools: offeredTools,
                    maxOutputTokens: runLimits.maxOutputTokens,
                    signal,
                  }),
                ),
                signal,
                () => interruption(ctx.signal),
              );
            } catch (error) {
              // A call the provider rejected cost nothing: give the held cents back. An abort or an unknown failure
              // may have been billed, so its reservation stays counted (the ledger over-counts, never under).
              if (
                budget !== undefined &&
                reservation !== null &&
                error instanceof ModelProviderError
              ) {
                await budget.release(reservation);
              }
              if (signal.aborted) throw interruption(ctx.signal);
              if (error instanceof ModelProviderError && !error.isRetryable) {
                // A rejected request or a bad credential fails the same way on every retry; do not replay the run.
                throw new NonRetryableRunError("model_request_rejected", error.message);
              }
              throw error;
            }

            tokens += response.usage.inputTokens + response.usage.outputTokens;

            // AGO-40: the real cost replaces the reservation. The same usage figures feed the ledger and the event
            // below, so the totals match. A lower cost releases the difference; a higher one is an overrun.
            let spentCents: number | undefined;
            let overrun: BudgetStopDetail | null = null;
            if (budget !== undefined && reservation !== null && model !== undefined) {
              const settlement = await budget.settle(reservation, model, response.usage);
              spentCents = settlement.costCents;
              if (settlement.ledgerFailed) {
                overrun = { scope: "ledger", reason: "budget_check_failed", limit: 0, used: 0 };
              } else if (settlement.overran) {
                overrun = {
                  scope: "ledger",
                  reason: "call_cost_overran_reservation",
                  limit: reservation.cents,
                  used: settlement.costCents,
                };
              }
            }
            await emitter.emit({
              type: "budget.usage",
              payload: {
                input_tokens: response.usage.inputTokens,
                output_tokens: response.usage.outputTokens,
                ...(spentCents === undefined ? {} : { cost_cents: spentCents }),
              },
            });
            if (overrun !== null) {
              if (response.toolCalls.length === 0) {
                // The run is finishing with this answer, so nothing more is spent: record it and let it complete.
                await emitBudgetExceeded(overrun);
              } else {
                await emitter.emit({ type: "step.completed", payload: { step, outcome: "error" } });
                return stopForBudget(overrun);
              }
            }

            if (response.toolCalls.length === 0) {
              const text = scrubString(response.text).trim();
              await emitter.emit({ type: "step.completed", payload: { step, outcome: "ok" } });
              if (text !== "") {
                await emitter.emit({
                  type: "message.emitted",
                  payload: { role: "agent", summary: text.slice(0, MESSAGE_MAX) },
                });
              }
              return {
                steps,
                end: "completed",
                ...(text === "" ? {} : { summary: text.slice(0, SUMMARY_MAX) }),
              };
            }

            // Over budget with more tool work requested: stop before running anything else.
            if (tokens >= runLimits.maxTokens) return stopForTokens();

            const calls = response.toolCalls.slice(0, MAX_TOOL_CALLS_PER_STEP);
            if (calls.length < response.toolCalls.length) {
              ctx.logger.warn(
                { requested: response.toolCalls.length, handled: calls.length },
                "model asked for more tool calls than one step handles; the rest were ignored",
              );
            }
            // The model's answer is saved before any tool runs: a crash from here on resumes these exact calls
            // instead of asking the model again (and maybe getting different ones).
            openStep = {
              step,
              hadError: false,
              calls: calls.map((call, index) => ({
                call_id: VALID_CALL_ID.test(call.id)
                  ? call.id
                  : `call_${String(step)}_${String(index)}`,
                name: call.name.slice(0, 128),
                input: call.input,
                status: "pending" as const,
              })),
            };
            await persist();
            // The model call has returned, so pausing here leaves no call open (AGO-30 AC2); nothing has run yet.
            if (await checkpoints.isPauseRequested(ref)) return stopForPause();
          } else {
            offeredNames = await offerNow();
          }

          const current: CheckpointStep = openStep;
          for (const [index, call] of current.calls.entries()) {
            if (call.status === "done") continue;
            let result: ToolCallResult;
            if (call.status === "awaiting_approval") {
              // The run was resumed: read the approval (AGO-21). Live and pending, wait again (no new request, no
              // new step.completed: the first pause already wrote it). Anything else closes the call unrun.
              const resolution = await resolveApproval(current.step, call);
              if (resolution.kind === "waiting") {
                return {
                  steps,
                  end: "paused",
                  pauseReason: "approval_required",
                  summary: "waiting for a human to approve a tool call",
                };
              }
              result = await closeWithoutRunning(
                call,
                resolution.errorCode,
                resolution.message,
                resolution.text,
              );
            } else if (call.status === "started") {
              // The worker stopped after this call began and before its result was saved. It may have run, so it
              // is not run again (AGO-30 AC1); the model learns the outcome is unknown and decides what to do.
              result = await closeWithoutRunning(
                call,
                "outcome_unknown",
                "the worker stopped while this call was running",
                "The worker stopped while this tool call was running, so its outcome is unknown. It was not run again.",
              );
            } else {
              result = await executeToolCall(
                ctx,
                { id: call.call_id, name: call.name, input: call.input },
                current.step,
                index,
                signal,
                policyTimeoutMs,
                offeredNames,
                async () => {
                  call.status = "started";
                  await persist();
                },
              );
            }
            if (result.kind === "needs_approval") {
              call.status = "awaiting_approval";
              call.payload_hash = result.payloadHash;
              await persist();
              await emitter.emit({
                type: "step.completed",
                payload: { step: current.step, outcome: "ok" },
              });
              return {
                steps,
                end: "paused",
                pauseReason: "approval_required",
                summary: "waiting for a human to approve a tool call",
              };
            }
            call.status = "done";
            delete call.payload_hash;
            call.result = {
              record: result.record,
              isError: result.isError,
              fingerprint: result.fingerprint,
              toolName: result.toolName,
            };
            history.push(result.record);
            completedCalls += 1;
            current.hadError ||= result.isError;

            // Loop detection (AGO-166): the same call with the same result, in a row, is not progress.
            repeatCount = result.fingerprint === lastFingerprint ? repeatCount + 1 : 1;
            lastFingerprint = result.fingerprint;
            await persist();
            if (repeatCount >= LOOP_REPEAT_THRESHOLD) {
              await emitter.emit({
                type: "step.completed",
                payload: { step: current.step, outcome: current.hadError ? "error" : "ok" },
              });
              // The event carries the tool name, the fingerprint hash and the count: never the arguments.
              await emitter.emit({
                type: "run.loop_detected",
                payload: {
                  tool_name: result.toolName,
                  call_hash: result.fingerprint,
                  repeat_count: repeatCount,
                },
              });
              return { steps, end: "loop_detected" };
            }
          }
          if (!skipStepCompleted) {
            await emitter.emit({
              type: "step.completed",
              payload: { step: current.step, outcome: current.hadError ? "error" : "ok" },
            });
          }
          skipStepCompleted = false;
          openStep = null;
          await persist();
        }
      };

      try {
        return await runSteps();
      } catch (error) {
        if (error instanceof RunDeadlineError) {
          return await stopForLimit("time", runLimits.maxWallMs, now() - startedAt);
        }
        throw error;
      }
    },
  };
}
