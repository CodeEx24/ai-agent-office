import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { NonRetryableRunError, type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop, type AgentLoopDeps } from "./agent-loop.js";
import { createClaudeProvider } from "./claude-provider.js";
import { createDenyByDefaultPolicyHook, type PolicyHook } from "./policy-hook.js";
import {
  createToolRegistry,
  getCurrentTimeTool,
  type AgentTool,
  type ToolRegistry,
} from "./tools.js";

import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { CapabilityTier } from "@ago/shared";

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const FAKE_KEY = "sk-ant-api03-FAKE-KEY-for-tests-0123456789abcdef";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function runContext(over: Partial<RunContext> = {}): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
    ...over,
  };
}

function usage(inputTokens = 10, outputTokens = 5) {
  return { inputTokens, outputTokens };
}
const finalAnswer = (text: string, u = usage()): ModelResponse => ({
  text,
  toolCalls: [],
  usage: u,
});
const callTool = (
  name: string,
  input: unknown = {},
  id = "toolu_1",
  u = usage(),
): ModelResponse => ({
  text: "",
  toolCalls: [{ id, name, input }],
  usage: u,
});

/** Scripted model: `script(requestNumber, request)` returns the response. Records every request. */
function fakeProvider(script: (n: number, request: ModelRequest) => ModelResponse) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve(script(requests.length, request));
    },
  };
  return { provider, requests };
}

function fakeTool(
  name: string,
  tier: CapabilityTier,
  execute: AgentTool["execute"] = () => Promise.resolve("done"),
): AgentTool & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(execute);
  return {
    name,
    description: `${name} tool`,
    tier,
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: run,
    run,
  };
}

function hook(decide: PolicyHook["check"]) {
  const check = vi.fn(decide);
  return { check } satisfies PolicyHook;
}

const allowAll = () => hook(() => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }));

function setup(
  options: {
    provider?: ModelProvider;
    tools?: ToolRegistry;
    policy?: PolicyHook;
    limits?: AgentLoopDeps["limits"];
    context?: RunContext | null;
    now?: () => number;
    signal?: AbortSignal;
    contextMaxChars?: number;
  } = {},
) {
  const rows: RunEventRow[] = [];
  const logLines: string[] = [];
  const logger = createLogger({
    level: "trace",
    destination: {
      write: (chunk) => {
        logLines.push(chunk);
      },
    },
  });
  const emitter = createRunEventEmitter({
    workspaceId: WS,
    runId: RUN,
    logger,
    store: {
      insert: (row) => {
        rows.push(row);
        return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
      },
    },
  });
  const context = options.context === undefined ? runContext() : options.context;
  const contextBuilder = createContextBuilder({
    source: {
      loadRun: () => Promise.resolve(context),
      loadAssignedSkills: () => Promise.resolve([]),
    },
    logger,
    ...(options.contextMaxChars === undefined ? {} : { maxChars: options.contextMaxChars }),
  });
  const model = options.provider ?? fakeProvider(() => finalAnswer("done")).provider;
  const loop = createAgentLoop({
    provider: model,
    contextBuilder,
    tools: options.tools ?? createToolRegistry([getCurrentTimeTool]),
    policy: options.policy ?? createDenyByDefaultPolicyHook(),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.contextMaxChars === undefined ? {} : { contextMaxChars: options.contextMaxChars }),
  });
  const ctx: RunExecutionContext = {
    workspaceId: WS,
    runId: RUN,
    agentId: AGENT,
    taskId: TASK,
    attempt: 0,
    logger,
    emitter,
    signal: options.signal ?? new AbortController().signal,
  };
  return { loop, ctx, rows, logLines };
}

const types = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);
const payloadsOf = (rows: readonly RunEventRow[], type: string) =>
  rows
    .filter((row) => row.type === type)
    .map(({ payload }) => {
      const { version: _version, ...rest } = payload;
      return rest;
    });

describe("agent tool loop: result path (AC1)", () => {
  it("ends with a result when the model answers without tool calls", async () => {
    const { provider, requests } = fakeProvider(() => finalAnswer("Three layouts found."));
    const { loop, ctx, rows } = setup({ provider });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 1, end: "completed", summary: "Three layouts found." });
    expect(types(rows)).toEqual([
      "step.started",
      "budget.usage",
      "step.completed",
      "message.emitted",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools.map((t) => t.name)).toEqual(["get_current_time"]);
  });

  it("runs an allowed tier-0 tool and feeds the result back as untrusted data", async () => {
    const { provider, requests } = fakeProvider((n) =>
      n === 1 ? callTool("get_current_time") : finalAnswer("It is late."),
    );
    const { loop, ctx, rows } = setup({ provider });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    expect(outcome.steps).toBe(2);
    expect(types(rows)).toEqual([
      "step.started",
      "budget.usage",
      "tool_call.requested",
      "policy.decision",
      "tool_call.started",
      "tool_call.completed",
      "step.completed",
      "step.started",
      "budget.usage",
      "step.completed",
      "message.emitted",
    ]);
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "allow",
      reason_code: "tier0_allowlist",
      tier: 0,
    });
    const secondPrompt = requests[1]?.messages[0]?.content ?? "";
    expect(secondPrompt).toContain('source="tool:get_current_time_toolu_1"');
    expect(secondPrompt).toContain("untrusted_data");
  });

  it("never puts raw tool input or output into events (hashes only)", async () => {
    const secret = "needle-in-the-haystack-payload";
    const tool = fakeTool("lookup", 0, () => Promise.resolve(secret));
    const { provider } = fakeProvider((n) =>
      n === 1 ? callTool("lookup", { query: secret }) : finalAnswer("ok"),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: createDenyByDefaultPolicyHook(["lookup"]),
    });

    await loop.execute(ctx);

    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(payloadsOf(rows, "tool_call.completed")[0]).toMatchObject({
      output_hash: sha256(secret),
    });
  });
});

describe("agent tool loop: limits (AC1)", () => {
  const forever = () => fakeProvider(() => callTool("get_current_time"));

  it("stops at the step limit with run.limit_reached", async () => {
    const { provider, requests } = forever();
    const { loop, ctx, rows } = setup({ provider, limits: { maxSteps: 3 } });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "limit_reached" });
    expect(requests).toHaveLength(3);
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      { limit: "steps", max: 3, observed: 3 },
    ]);
    expect(types(rows).at(-1)).toBe("run.limit_reached");
  });

  it("stops at the token limit and does not run the tools the model just asked for", async () => {
    const tool = fakeTool("lookup", 0);
    const { provider, requests } = fakeProvider(() => callTool("lookup", {}, "t", usage(400, 200)));
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: createDenyByDefaultPolicyHook(["lookup"]),
      limits: { maxTokens: 1_000 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    // Step 1 used 600 tokens and ran its tool; step 2 reached 1200 and was stopped before its tool.
    expect(requests).toHaveLength(2);
    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      { limit: "tokens", max: 1_000, observed: 1_200 },
    ]);
  });

  it("stops at the wall-time limit", async () => {
    const clock = { t: 0 };
    const { provider } = fakeProvider(() => {
      clock.t += 600;
      return callTool("get_current_time");
    });
    const { loop, ctx, rows } = setup({
      provider,
      now: () => clock.t,
      limits: { maxWallMs: 1_000 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      { limit: "time", max: 1_000, observed: 1_200 },
    ]);
  });

  it("aborts a model call that outlives the wall-time limit and reports it as a time limit", async () => {
    const hanging: ModelProvider = {
      complete: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    };
    const { loop, ctx, rows } = setup({ provider: hanging, limits: { maxWallMs: 30 } });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(payloadsOf(rows, "run.limit_reached")[0]).toMatchObject({ limit: "time", max: 30 });
  });

  it("throws (so the job is retried) when the worker shuts down mid-run", async () => {
    const shutdown = new AbortController();
    const { loop, ctx } = setup({ signal: shutdown.signal });
    shutdown.abort();

    await expect(loop.execute(ctx)).rejects.toThrow("shutting down");
  });
});

describe("agent tool loop: every tool call passes the policy hook (AC2)", () => {
  it("never executes a call the policy denies, and tells the model", async () => {
    const tool = fakeTool("delete_everything", 2);
    const deny = hook(() => Promise.resolve({ decision: "deny", reasonCode: "no_way" }));
    const { provider, requests } = fakeProvider((n) =>
      n === 1 ? callTool("delete_everything") : finalAnswer("gave up"),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: deny,
    });

    await loop.execute(ctx);

    expect(tool.run).not.toHaveBeenCalled();
    expect(types(rows)).not.toContain("tool_call.started");
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "deny",
      reason_code: "no_way",
    });
    expect(payloadsOf(rows, "tool_call.failed")[0]).toMatchObject({ error_code: "policy_denied" });
    expect(requests[1]?.messages[0]?.content).toContain("policy denied");
  });

  it("denies by default: a tier-1 tool is not run by the default hook", async () => {
    const tool = fakeTool("write_note", 1);
    const { provider } = fakeProvider((n) =>
      n === 1 ? callTool("write_note") : finalAnswer("ok"),
    );
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]) });

    await loop.execute(ctx);

    expect(tool.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "deny",
      reason_code: "default_deny",
    });
  });

  it("calls the hook once per tool call, before the tool runs", async () => {
    const order: string[] = [];
    const tool = fakeTool("lookup", 0, () => {
      order.push("execute");
      return Promise.resolve("r");
    });
    const policy = hook(() => {
      order.push("check");
      return Promise.resolve({ decision: "allow", reasonCode: "ok" });
    });
    const { provider } = fakeProvider((n) =>
      n === 1
        ? {
            text: "",
            usage: usage(),
            toolCalls: [
              { id: "a", name: "lookup", input: {} },
              { id: "b", name: "lookup", input: {} },
            ],
          }
        : finalAnswer("ok"),
    );
    const { loop, ctx } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(order).toEqual(["check", "execute", "check", "execute"]);
    expect(policy.check).toHaveBeenCalledTimes(2);
  });

  it("denies when the hook throws or answers with something that is not a decision", async () => {
    const tool = fakeTool("lookup", 0);
    for (const bad of [
      hook(() => Promise.reject(new Error("engine down"))),
      hook(() => Promise.resolve({ decision: "maybe", reasonCode: "x" } as never)),
      hook(() => Promise.resolve({ decision: "allow", reasonCode: "NOT VALID!" })),
    ]) {
      const { provider } = fakeProvider((n) => (n === 1 ? callTool("lookup") : finalAnswer("ok")));
      const { loop, ctx, rows } = setup({
        provider,
        tools: createToolRegistry([tool]),
        policy: bad,
      });

      await loop.execute(ctx);

      expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({ decision: "deny" });
    }
    expect(tool.run).not.toHaveBeenCalled();
  });

  it("cannot be skipped: an unknown tool is reported to the hook, denied and never run, even if the hook says allow", async () => {
    const real = fakeTool("lookup", 0);
    const policy = allowAll();
    const { provider } = fakeProvider((n) =>
      n === 1 ? callTool("not_a_registered_tool") : finalAnswer("ok"),
    );
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([real]), policy });

    await loop.execute(ctx);

    expect(policy.check).toHaveBeenCalledTimes(1);
    expect(policy.check.mock.calls[0]?.[0]).toMatchObject({
      toolName: "not_a_registered_tool",
      isRegistered: false,
      tier: 4,
    });
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "deny",
      reason_code: "unknown_tool",
      tier: 4,
    });
    expect(real.run).not.toHaveBeenCalled();
  });

  it("cannot be skipped: a tool added to the list after the registry was built is unknown", () => {
    const tools: AgentTool[] = [fakeTool("lookup", 0)];
    const registry = createToolRegistry(tools);
    tools.push(fakeTool("sneaky", 0));

    expect(registry.get("sneaky")).toBeUndefined();
    expect(registry.list().map((t) => t.name)).toEqual(["lookup"]);
    expect(Object.keys(registry)).toEqual(["list", "get"]);
  });

  it("does not run a tool whose input fails its own schema", async () => {
    const tool: AgentTool & { run: ReturnType<typeof vi.fn> } = {
      ...fakeTool("lookup", 0),
      inputSchema: z.strictObject({ q: z.string() }),
    };
    const { provider } = fakeProvider((n) =>
      n === 1 ? callTool("lookup", { q: 42 }) : finalAnswer("ok"),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: allowAll(),
    });

    await loop.execute(ctx);

    expect(tool.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "tool_call.failed")[0]).toMatchObject({ error_code: "invalid_input" });
  });
});

describe("agent tool loop: approvals stop the step (AC2)", () => {
  it("needs_approval emits approval.requested with the payload hash, never executes, and pauses", async () => {
    const tool = fakeTool("send_email", 2);
    const input = { to: "a@example.com", body: "hi" };
    const ask = hook(() =>
      Promise.resolve({ decision: "needs_approval", reasonCode: "human_required" }),
    );
    const { provider, requests } = fakeProvider(() => callTool("send_email", input, "call-9"));
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: ask,
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("paused");
    expect(tool.run).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1); // the model is not asked again until a human decides
    const [approval] = payloadsOf(rows, "approval.requested");
    expect(approval).toMatchObject({
      call_id: "call-9",
      tier: 2,
      payload_hash: sha256('{"input":{"body":"hi","to":"a@example.com"},"tool_name":"send_email"}'),
    });
    expect(Date.parse((approval as { expires_at: string }).expires_at)).toBeGreaterThan(Date.now());
    expect(types(rows)).not.toContain("tool_call.started");
  });

  it("turns an allow for a tier 3 or 4 tool into a request for a human (never automatic)", async () => {
    for (const tier of [3, 4] as const) {
      const tool = fakeTool("wire_money", tier);
      const { provider } = fakeProvider(() => callTool("wire_money"));
      const { loop, ctx, rows } = setup({
        provider,
        tools: createToolRegistry([tool]),
        policy: allowAll(),
      });

      const outcome = await loop.execute(ctx);

      expect(outcome.end).toBe("paused");
      expect(tool.run).not.toHaveBeenCalled();
      expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
        decision: "needs_approval",
        reason_code: "tier_requires_approval",
        tier,
      });
      expect(types(rows)).toContain("approval.requested");
    }
  });
});

describe("agent tool loop: archived agents and context size (AGO-145 carry-overs)", () => {
  it("refuses a run for an archived agent before any model call", async () => {
    const { provider, requests } = fakeProvider(() => finalAnswer("hi"));
    const { loop, ctx } = setup({ provider, context: runContext({ agentArchived: true }) });

    const failure = await loop.execute(ctx).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NonRetryableRunError);
    expect((failure as NonRetryableRunError).reason).toBe("agent_archived");
    expect(requests).toHaveLength(0);
  });

  it("fails a run that does not exist without retrying", async () => {
    const { loop, ctx } = setup({ context: null });

    const failure = await loop.execute(ctx).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NonRetryableRunError);
    expect((failure as NonRetryableRunError).reason).toBe("run_not_found");
  });

  it("cuts an oversized tool result before passing it back, and emits a cut event", async () => {
    const huge = "x".repeat(150_000); // over the builder's 100k per-item limit
    const tool = fakeTool("dump", 0, () => Promise.resolve(huge));
    const { provider, requests } = fakeProvider((n) =>
      n === 1 ? callTool("dump") : finalAnswer("ok"),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: createDenyByDefaultPolicyHook(["dump"]),
      limits: { maxToolResultChars: 1_000 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    expect(payloadsOf(rows, "context.cut")).toContainEqual({
      section: "tool_result",
      source: "tool:dump#toolu_1",
      action: "truncated",
      original_chars: 150_000,
      kept_chars: 1_000,
    });
    const prompt = requests[1]?.messages[0]?.content ?? "";
    expect(prompt.length).toBeLessThan(10_000);
    // The event keeps the hash of the FULL output, not of the cut text.
    expect(payloadsOf(rows, "tool_call.completed")[0]).toMatchObject({
      output_hash: sha256(huge),
    });
  });

  it("drops the oldest tool results first when the history outgrows the context cap, and reports it", async () => {
    const tool = fakeTool("dump", 0, () => Promise.resolve("y".repeat(900)));
    const { provider, requests } = fakeProvider((n) =>
      n <= 6 ? callTool("dump", { n }, `call-${String(n)}`) : finalAnswer("ok"),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: createDenyByDefaultPolicyHook(["dump"]),
      contextMaxChars: 8_000,
      limits: { maxToolResultChars: 1_000 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    const dropped = payloadsOf(rows, "context.cut").filter((p) => p.action === "dropped");
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]).toMatchObject({ section: "retrieved", source: "tool:dump#call-1" });
    const lastPrompt = requests.at(-1)?.messages[0]?.content ?? "";
    expect(lastPrompt).toContain('source="tool:dump_call-6"'); // the newest result is kept
    expect(lastPrompt).not.toContain('source="tool:dump_call-1"'); // the oldest is gone
  });
});

describe("agent tool loop: credentials never leak (AC3)", () => {
  it("keeps the model key out of every event, log line, prompt and tool input", async () => {
    const bodies: string[] = [];
    const headers: Record<string, string>[] = [];
    const fakeFetch: typeof fetch = (_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      headers.push(init?.headers as Record<string, string>);
      const first = bodies.length === 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: first
              ? [{ type: "tool_use", id: "toolu_1", name: "get_current_time", input: {} }]
              : [{ type: "text", text: "All done." }],
            usage: { input_tokens: 12, output_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const provider = createClaudeProvider({
      apiKey: FAKE_KEY,
      model: "claude-sonnet-5-5",
      fetch: fakeFetch,
    });
    const { loop, ctx, rows, logLines } = setup({ provider });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    expect(bodies).toHaveLength(2);
    // The key travels in exactly one place: the x-api-key header of the provider's own request.
    expect(headers.every((h) => h["x-api-key"] === FAKE_KEY)).toBe(true);
    for (const surface of [JSON.stringify(rows), logLines.join("\n"), ...bodies]) {
      expect(surface).not.toContain(FAKE_KEY);
      expect(surface).not.toContain("FAKE-KEY-for-tests");
    }
  });

  it("does not echo the key when the API fails and its body mentions it", async () => {
    const leaky: typeof fetch = () =>
      Promise.resolve(new Response(`invalid x-api-key: ${FAKE_KEY}`, { status: 401 }));
    const provider = createClaudeProvider({ apiKey: FAKE_KEY, model: "m", fetch: leaky });
    const { loop, ctx, rows, logLines } = setup({ provider });

    const failure = await loop.execute(ctx).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    for (const surface of [(failure as Error).message, JSON.stringify(rows), logLines.join("\n")]) {
      expect(surface).not.toContain(FAKE_KEY);
    }
  });
});
