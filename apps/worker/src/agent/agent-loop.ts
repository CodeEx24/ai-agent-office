import { createHash, randomUUID } from "node:crypto";

import {
  CONTEXT_TEXT_MAX_LENGTH,
  DEFAULT_CONTEXT_MAX_CHARS,
  MIN_NEVER_AUTOMATIC_TIER,
} from "@ago/shared";
import { z } from "zod";

import { ContextBuildError, type ContextBuilder } from "../context/index.js";
import { scrubString } from "../logger.js";
import {
  NonRetryableRunError,
  type RunExecutionContext,
  type RunExecutor,
  type RunOutcome,
} from "../queue/run-processor.js";

import { ModelProviderError, type ModelProvider, type ModelToolCall } from "./model-provider.js";
import type { PolicyDecision, PolicyHook } from "./policy-hook.js";
import type { ToolRegistry } from "./tools.js";
import type { CapabilityTier, RetrievedItem } from "@ago/shared";

/**
 * The agent tool loop (AGO-167). One run is: build context -> ask the model -> for each tool call,
 * policy check -> (execute | deny | stop for approval) -> feed the result back, until the model gives a
 * final answer or a limit is hit.
 *
 * Invariants (each has a test in agent-loop.test.ts):
 * - `executeToolCall` is the only function that calls `tool.execute`, and it calls the policy hook first.
 *   The registry is fixed at creation, so a tool cannot be added mid-run to skip the hook.
 * - A hook that throws, or answers with anything but allow, deny or needs_approval, is a deny.
 * - Tier 3 and 4 tools never run on `allow`: they stop for a human (AGO-125, human in the loop).
 * - `needs_approval` emits `approval.requested` (bound to a payload hash) and ends the run as paused.
 *   The tool is never executed here. Resuming is AGO-30; an approval nobody decides expires = deny.
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

const SUMMARY_MAX = 500;
const MESSAGE_MAX = 2_000;
const INPUT_PREVIEW_MAX = 2_000;
const TRUNCATION_MARKER = "\n[truncated]";

export interface AgentLoopDeps {
  readonly provider: ModelProvider;
  readonly contextBuilder: ContextBuilder;
  readonly tools: ToolRegistry;
  readonly policy: PolicyHook;
  readonly limits?: Partial<AgentLoopLimits>;
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
  | { readonly kind: "result"; readonly record: ToolRecord; readonly isError: boolean }
  | { readonly kind: "needs_approval" };

export function createAgentLoop(deps: AgentLoopDeps): RunExecutor {
  const limits: AgentLoopLimits = { ...DEFAULT_AGENT_LIMITS, ...deps.limits };
  // Each stored record adds a status line and an input preview to the result, and the builder throws on
  // an item over CONTEXT_TEXT_MAX_LENGTH, so leave room for them.
  if (limits.maxToolResultChars > CONTEXT_TEXT_MAX_LENGTH - INPUT_PREVIEW_MAX - 1_000) {
    throw new Error("maxToolResultChars leaves no room under what the context builder accepts");
  }
  const now = deps.now ?? Date.now;
  const approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  // Well below the wall-time limit, so a silent hook costs a deny, never the run.
  const policyTimeoutMs = Math.max(
    1,
    Math.min(deps.policyTimeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS, Math.floor(limits.maxWallMs / 4)),
  );
  const historyBudgetChars = Math.floor((deps.contextMaxChars ?? DEFAULT_CONTEXT_MAX_CHARS) / 2);

  /** The single place a tool runs. Policy first, always. */
  async function executeToolCall(
    ctx: RunExecutionContext,
    call: ModelToolCall,
    step: number,
    index: number,
    signal: AbortSignal,
  ): Promise<ToolCallResult> {
    const { emitter } = ctx;
    const callId = VALID_CALL_ID.test(call.id) ? call.id : `call_${String(step)}_${String(index)}`;
    const toolName = call.name.slice(0, 128) === "" ? "unnamed" : call.name.slice(0, 128);
    const tool = deps.tools.get(call.name);
    const tier: CapabilityTier = tool?.tier ?? 4;
    const inputHash = sha256(canonicalJson(call.input));
    const source = `tool:${toolName}#${callId}`.slice(0, 200);
    const fail = (text: string): ToolCallResult => ({
      kind: "result",
      isError: true,
      record: { source, content: `status: error\n${text}` },
    });

    await emitter.emit({
      type: "tool_call.requested",
      payload: { call_id: callId, tool_name: toolName, tier, input_hash: inputHash },
    });

    // The hook gets its own time budget and an abort signal. It also ends with the run: shutdown or the
    // wall-time limit preempts a hook that never answers.
    const hookSignal = AbortSignal.any([signal, AbortSignal.timeout(policyTimeoutMs)]);
    let decision: PolicyDecision;
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
      decision = parsed.success
        ? parsed.data
        : { decision: "deny", reasonCode: "policy_invalid_response" };
    } catch (error) {
      if (signal.aborted) throw interruption(ctx.signal);
      const isTimeout = error instanceof PolicyTimeoutError;
      if (!isTimeout) {
        ctx.logger.error({ err: error, call_id: callId }, "policy hook failed; denying the call");
      }
      decision = {
        decision: "deny",
        reasonCode: isTimeout ? "policy_timeout" : "policy_hook_error",
      };
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
      await emitter.emit({
        type: "approval.requested",
        payload: {
          approval_id: randomUUID(),
          call_id: callId,
          payload_hash: sha256(canonicalJson({ tool_name: call.name, input: call.input })),
          tier,
          expires_at: new Date(now() + approvalTtlMs).toISOString(),
        },
      });
      return { kind: "needs_approval" };
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
    const inputPreview = canonicalJson(call.input).slice(0, INPUT_PREVIEW_MAX);
    return {
      kind: "result",
      isError: false,
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
      const startedAt = now();
      const deadline = startedAt + limits.maxWallMs;
      const history: ToolRecord[] = [];
      // A function, not a read of `ctx.signal.aborted`, so the check is re-evaluated after each await.
      const isShuttingDown = (): boolean => ctx.signal.aborted;
      let reportedDropped = 0;
      let steps = 0;
      let tokens = 0;

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

      // One signal for the whole run: shutdown, or the wall-time limit. Every pending await (model call,
      // policy hook, tool) is raced against it, so nothing can hold the run past `maxWallMs`.
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(limits.maxWallMs)]);

      const runSteps = async (): Promise<RunOutcome> => {
        for (;;) {
          if (isShuttingDown()) throw interruption(ctx.signal);
          if (steps >= limits.maxSteps) return stopForLimit("steps", limits.maxSteps, steps);
          if (now() >= deadline) return stopForLimit("time", limits.maxWallMs, now() - startedAt);
          if (tokens >= limits.maxTokens) return stopForLimit("tokens", limits.maxTokens, tokens);

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

          let response;
          try {
            response = await abortable(
              callSafely(() =>
                deps.provider.complete({
                  system: built.system,
                  messages: built.messages,
                  tools: deps.tools.list(),
                  maxOutputTokens: limits.maxOutputTokens,
                  signal,
                }),
              ),
              signal,
              () => interruption(ctx.signal),
            );
          } catch (error) {
            if (signal.aborted) throw interruption(ctx.signal);
            if (error instanceof ModelProviderError && !error.isRetryable) {
              // A rejected request or a bad credential fails the same way on every retry; do not replay the run.
              throw new NonRetryableRunError("model_request_rejected", error.message);
            }
            throw error;
          }

          tokens += response.usage.inputTokens + response.usage.outputTokens;
          await emitter.emit({
            type: "budget.usage",
            payload: {
              input_tokens: response.usage.inputTokens,
              output_tokens: response.usage.outputTokens,
            },
          });

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
          if (tokens >= limits.maxTokens) return stopForLimit("tokens", limits.maxTokens, tokens);

          const calls = response.toolCalls.slice(0, MAX_TOOL_CALLS_PER_STEP);
          if (calls.length < response.toolCalls.length) {
            ctx.logger.warn(
              { requested: response.toolCalls.length, handled: calls.length },
              "model asked for more tool calls than one step handles; the rest were ignored",
            );
          }
          let hadError = false;
          for (const [index, call] of calls.entries()) {
            const result = await executeToolCall(ctx, call, step, index, signal);
            if (result.kind === "needs_approval") {
              await emitter.emit({ type: "step.completed", payload: { step, outcome: "ok" } });
              return {
                steps,
                end: "paused",
                summary: "waiting for a human to approve a tool call",
              };
            }
            history.push(result.record);
            hadError ||= result.isError;
          }
          await emitter.emit({
            type: "step.completed",
            payload: { step, outcome: hadError ? "error" : "ok" },
          });
        }
      };

      try {
        return await runSteps();
      } catch (error) {
        if (error instanceof RunDeadlineError) {
          return await stopForLimit("time", limits.maxWallMs, now() - startedAt);
        }
        throw error;
      }
    },
  };
}
