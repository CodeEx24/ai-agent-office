import { createHash } from "node:crypto";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop, MAX_TOOL_CALLS_PER_STEP, type AgentLoopDeps } from "./agent-loop.js";
import { createClaudeProvider } from "./claude-provider.js";
import { createDenyByDefaultPolicyHook, type PolicyHook } from "./policy-hook.js";
import {
  createToolRegistry,
  getCurrentTimeTool,
  type AgentTool,
  type ToolRegistry,
} from "./tools.js";

import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "./model-provider.js";
import type { CapabilityTier } from "@ago/shared";

// AGO-167 QA: attack scenarios for the agent tool loop. The model is a scripted fake (no network, no
// API key, no spend). Fake secrets are built at runtime so no secret-shaped literal sits in the source.

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const FAKE_KEY = ["sk", "ant", "api03", "QA".repeat(8), "zZ9".repeat(6)].join("-");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const usage = (inputTokens = 10, outputTokens = 5) => ({ inputTokens, outputTokens });
const answer = (text: string, u = usage()): ModelResponse => ({ text, toolCalls: [], usage: u });
const calls = (toolCalls: readonly ModelToolCall[], u = usage()): ModelResponse => ({
  text: "",
  toolCalls,
  usage: u,
});
const one = (name: string, input: unknown = {}, id = "toolu_1", u = usage()) =>
  calls([{ id, name, input }], u);

function runContext(): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
  };
}

function scripted(
  script: (n: number, request: ModelRequest) => ModelResponse | Promise<ModelResponse>,
) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    complete: async (request) => {
      requests.push(request);
      return script(requests.length, request);
    },
  };
  return { provider, requests };
}

function spyTool(
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

function spyHook(decide: PolicyHook["check"]) {
  return { check: vi.fn(decide) } satisfies PolicyHook;
}
const allowAll = () =>
  spyHook(() => Promise.resolve({ decision: "allow", reasonCode: "qa_allow" }));

function setup(
  options: {
    provider?: ModelProvider;
    tools?: ToolRegistry;
    policy?: PolicyHook;
    limits?: AgentLoopDeps["limits"];
    now?: () => number;
    approvalTtlMs?: number;
    signal?: AbortSignal;
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
  const contextBuilder = createContextBuilder({
    source: {
      loadRun: () => Promise.resolve(runContext()),
      loadAssignedSkills: () => Promise.resolve([]),
    },
    logger,
  });
  const loop = createAgentLoop({
    toolOffer: offerAllTools,
    provider: options.provider ?? scripted(() => answer("done")).provider,
    contextBuilder,
    tools: options.tools ?? createToolRegistry([getCurrentTimeTool]),
    policy: options.policy ?? createDenyByDefaultPolicyHook(),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs }),
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
  rows.filter((row) => row.type === type).map((row) => row.payload);

/** Resolves with "hung" if `work` has not settled within `ms`: a run that outlives its limit fails the test. */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => {
      resolve("hung");
    }, ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe("AGO-167 QA, AC1: the loop ends with a result or a limit event", () => {
  it("AC1: a model that asks for a tool forever is stopped by the step limit, and the run has no result", async () => {
    // A different input each step: the same call 3 times in a row would be a loop (AGO-166) first.
    const { provider, requests } = scripted((n) => one("get_current_time", { n }));
    const { loop, ctx, rows } = setup({ provider, limits: { maxSteps: 4 } });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 4, end: "limit_reached" });
    expect(requests).toHaveLength(4);
    expect(types(rows).at(-1)).toBe("run.limit_reached");
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "steps", max: 4, observed: 4 }),
    ]);
    expect(types(rows)).not.toContain("message.emitted");
  });

  it("AC1: the token limit counts input plus output and stops before the next model call", async () => {
    const { provider, requests } = scripted(() =>
      one("get_current_time", {}, "t", usage(600, 500)),
    );
    const { loop, ctx, rows } = setup({ provider, limits: { maxTokens: 1_000 } });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(requests).toHaveLength(1);
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "tokens", max: 1_000, observed: 1_100 }),
    ]);
  });

  it("AC1: the wall-time limit uses the clock and stops the run", async () => {
    let clock = 0;
    const { provider } = scripted(() => {
      clock += 400;
      return one("get_current_time");
    });
    const { loop, ctx, rows } = setup({
      provider,
      now: () => clock,
      limits: { maxWallMs: 1_000, maxSteps: 50 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(payloadsOf(rows, "run.limit_reached")[0]).toMatchObject({ limit: "time", max: 1_000 });
  });

  it("AC1: a model call that never returns is aborted at the wall-time limit (real timers)", async () => {
    const { provider } = scripted(
      (_n, request) =>
        new Promise<ModelResponse>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const { loop, ctx, rows } = setup({ provider, limits: { maxWallMs: 150 } });

    const outcome = await settlesWithin(loop.execute(ctx), 3_000);

    expect(outcome).toMatchObject({ end: "limit_reached" });
    expect(payloadsOf(rows, "run.limit_reached")[0]).toMatchObject({ limit: "time" });
  });

  it("AC1: malformed tool calls (empty name, bad id, 300 character name, null and array input) never crash the loop or run anything", async () => {
    const tool = spyTool("get_current_time", 0);
    const bad: ModelToolCall[] = [
      { id: "ok_1", name: "", input: {} },
      { id: "has spaces and ! symbols", name: "x", input: null },
      { id: "", name: "n".repeat(300), input: [1, 2, 3] },
      { id: "x".repeat(500), name: "get-current-time", input: "text" },
      { id: "ok_5", name: "get_current_time\u0000", input: {} },
    ];
    const { provider } = scripted((n) => (n === 1 ? calls(bad) : answer("finished")));
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]) });

    const outcome = await loop.execute(ctx);

    expect(outcome).toMatchObject({ end: "completed", summary: "finished" });
    expect(tool.run).not.toHaveBeenCalled();
    const decisions = payloadsOf(rows, "policy.decision");
    expect(decisions).toHaveLength(bad.length);
    expect(
      decisions.every((d) => d.decision === "deny" && d.reason_code === "tool_not_offered"),
    ).toBe(true);
    const requested = payloadsOf(rows, "tool_call.requested");
    expect(
      requested.every((p) => String(p.call_id).length <= 128 && String(p.tool_name).length <= 128),
    ).toBe(true);
  });

  it("AC1: an unknown tool asked for on every step ends at the step limit and never executes", async () => {
    // A different input each step: three identical denied calls in a row would be a loop (AGO-166) first.
    const { provider } = scripted((n) => one("does_not_exist", { n }));
    const tool = spyTool("get_current_time", 0);
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      limits: { maxSteps: 3 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(tool.run).not.toHaveBeenCalled();
    expect(types(rows).at(-1)).toBe("run.limit_reached");
  });

  it("AC1: a 500,000 character tool result is cut to the cap, announced by a context.cut event, and the next prompt stays bounded", async () => {
    const huge = spyTool("get_current_time", 0, () => Promise.resolve("A".repeat(500_000)));
    const { provider, requests } = scripted((n) =>
      n === 1 ? one("get_current_time") : answer("done"),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([huge]),
      policy: allowAll(),
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    const cut = payloadsOf(rows, "context.cut").find((p) => p.section === "tool_result");
    expect(cut).toMatchObject({ action: "truncated", original_chars: 500_000, kept_chars: 20_000 });
    const prompt = requests[1]?.messages.map((m) => m.content).join("") ?? "";
    expect(prompt.length).toBeLessThan(60_000);
    expect(JSON.stringify(rows)).not.toContain("A".repeat(100));
  });

  it("AC1: an already aborted run signal stops the run with an error (so the queue retries) and runs no tool", async () => {
    const tool = spyTool("get_current_time", 0);
    const controller = new AbortController();
    controller.abort();
    const { provider, requests } = scripted(() => one("get_current_time"));
    const { loop, ctx } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: allowAll(),
      signal: controller.signal,
    });

    await expect(loop.execute(ctx)).rejects.toThrow(/shutting down/);
    expect(requests).toHaveLength(0);
    expect(tool.run).not.toHaveBeenCalled();
  });
});

describe("AGO-167 QA, AC2: every tool call passes the policy hook", () => {
  it("AC2: a hook that rejects denies and the tool is not run", async () => {
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(() => Promise.reject(new Error("engine crashed")));
    const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(tool.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "deny",
      reason_code: "policy_hook_error",
    });
  });

  it("AC2: a hook that throws synchronously also denies", async () => {
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(() => {
      throw new Error("sync boom");
    });
    const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(tool.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({ decision: "deny" });
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a bare string", "allow"],
    ["a wrong-case decision", { decision: "ALLOW", reasonCode: "x" }],
    ["an unknown decision", { decision: "approve", reasonCode: "x" }],
    ["an allow with no reason code", { decision: "allow" }],
    ["an allow with a numeric reason code", { decision: "allow", reasonCode: 123 }],
    ["an allow with a reason code that is not a code", { decision: "allow", reasonCode: "A B" }],
  ])(
    "AC2: a hook that answers with %s is a deny: the tool is not run and the run does not crash",
    async (_label, garbage) => {
      const tool = spyTool("get_current_time", 0);
      const policy = spyHook(() => Promise.resolve(garbage as never));
      const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
      const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

      const outcome = await loop.execute(ctx);

      expect(tool.run).not.toHaveBeenCalled();
      expect(outcome.end).toBe("completed");
      expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({ decision: "deny" });
    },
  );

  it("AC2: a slow hook cannot hold the run past its wall-time limit (hook that never answers)", async () => {
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(() => new Promise(() => undefined));
    const { provider } = scripted(() => one("get_current_time"));
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy,
      limits: { maxWallMs: 200 },
    });

    const outcome = await settlesWithin(loop.execute(ctx), 3_000);

    expect(outcome).not.toBe("hung");
    expect(tool.run).not.toHaveBeenCalled();
    expect(types(rows)).not.toContain("tool_call.started");
  });

  it("AC2: parallel calls in one model turn each get their own policy check before their own execution", async () => {
    const order: string[] = [];
    const tool = spyTool("get_current_time", 0, () => {
      order.push("execute");
      return Promise.resolve("t");
    });
    const policy = spyHook(() => {
      order.push("check");
      return Promise.resolve({ decision: "allow", reasonCode: "qa_allow" } as const);
    });
    const turn = calls([
      { id: "a", name: "get_current_time", input: {} },
      { id: "b", name: "get_current_time", input: {} },
      { id: "c", name: "get_current_time", input: {} },
    ]);
    const { provider } = scripted((n) => (n === 1 ? turn : answer("ok")));
    const { loop, ctx } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(order).toEqual(["check", "execute", "check", "execute", "check", "execute"]);
    expect(policy.check.mock.calls.map(([call]) => call.callId)).toEqual(["a", "b", "c"]);
  });

  it("AC2: a turn with more calls than the per-step cap runs at most the cap, and the extras reach neither hook nor tool", async () => {
    const tool = spyTool("get_current_time", 0);
    const policy = allowAll();
    const many = Array.from({ length: MAX_TOOL_CALLS_PER_STEP + 7 }, (_, i) => ({
      id: `c${String(i)}`,
      name: "get_current_time",
      // Distinct inputs: identical results in a row would stop the run as a loop (AGO-166).
      input: { i },
    }));
    const { provider } = scripted((n) => (n === 1 ? calls(many) : answer("ok")));
    const { loop, ctx } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(tool.run).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_STEP);
    expect(policy.check).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_STEP);
  });

  it("AC2: a renamed, re-cased, padded or look-alike tool name is an unknown tool, denied even when the hook allows it", async () => {
    const tool = spyTool("get_current_time", 0);
    const names = [
      "GET_CURRENT_TIME",
      "get_current_time ",
      " get_current_time",
      "get_current_time\n",
      "get-current-time",
      "get_current_tіme", // Cyrillic i
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ];
    const policy = allowAll();
    const { provider } = scripted((n) =>
      n === 1
        ? calls(names.map((name, i) => ({ id: `n${String(i)}`, name, input: {} })))
        : answer("ok"),
    );
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(tool.run).not.toHaveBeenCalled();
    // None of them was offered to the model, so each is denied before the policy hook is consulted (AGO-25).
    expect(policy.check).not.toHaveBeenCalled();
    const decisions = payloadsOf(rows, "policy.decision");
    expect(decisions.length).toBeGreaterThan(0);
    expect(
      decisions.every((d) => d.decision === "deny" && d.reason_code === "tool_not_offered"),
    ).toBe(true);
    expect(payloadsOf(rows, "tool_call.started")).toEqual([]);
  });

  it("AC2: tools cannot be added after the registry is built (no register, list is stable)", () => {
    const registry = createToolRegistry([getCurrentTimeTool]);
    const before = registry.list().map((t) => t.name);

    expect(Object.keys(registry).sort()).toEqual(["all", "get", "list"]);
    expect(registry.get("late_tool")).toBeUndefined();
    expect(registry.list().map((t) => t.name)).toEqual(before);
  });

  it("AC2: a tier 3 tool is never run on allow, even with an allow-everything hook (never automatic)", async () => {
    const tool = spyTool("wire_money", 3);
    const policy = allowAll();
    const { provider } = scripted(() => one("wire_money", { amount: 1 }));
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("paused");
    expect(tool.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "needs_approval",
      reason_code: "tier_requires_approval",
    });
  });

  it("AC2: the default hook denies a registered tier 1 to 4 tool, even one that borrows the allowlisted name", async () => {
    for (const tier of [1, 2, 3, 4] as const) {
      const tool = spyTool("get_current_time", tier);
      const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
      const { loop, ctx } = setup({ provider, tools: createToolRegistry([tool]) });

      await loop.execute(ctx);

      expect(tool.run, `tier ${String(tier)}`).not.toHaveBeenCalled();
    }
  });

  it("AC2: needs_approval emits approval.requested with a payload hash and expiry, and a later call in the same turn never runs", async () => {
    const approvalTool = spyTool("send_email", 2);
    const later = spyTool("get_current_time", 0);
    const policy = spyHook((call) =>
      Promise.resolve(
        call.toolName === "send_email"
          ? ({ decision: "needs_approval", reasonCode: "human_required" } as const)
          : ({ decision: "allow", reasonCode: "qa_allow" } as const),
      ),
    );
    const { provider } = scripted(() =>
      calls([
        { id: "first", name: "send_email", input: { to: "a@example.test", body: "hi" } },
        { id: "second", name: "get_current_time", input: {} },
      ]),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([approvalTool, later]),
      policy,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      approvalTtlMs: 60_000,
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("paused");
    expect(approvalTool.run).not.toHaveBeenCalled();
    expect(later.run).not.toHaveBeenCalled();
    expect(policy.check).toHaveBeenCalledTimes(1);
    const [approval] = payloadsOf(rows, "approval.requested");
    expect(approval?.payload_hash).toBe(
      sha256('{"input":{"body":"hi","to":"a@example.test"},"tool_name":"send_email"}'),
    );
    expect(approval?.expires_at).toBe("2026-01-01T00:01:00.000Z");
    expect(types(rows).indexOf("policy.decision")).toBeLessThan(
      types(rows).indexOf("approval.requested"),
    );
    expect(types(rows)).not.toContain("tool_call.started");
  });

  it("AC2: the approval hash is the same for the same call with keys in another order, and differs for another input", async () => {
    const hashes: unknown[] = [];
    const inputs = [
      { a: 1, b: { c: 2, d: 3 } },
      { b: { d: 3, c: 2 }, a: 1 },
      { a: 1, b: { c: 2, d: 4 } },
    ];
    for (const input of inputs) {
      const { provider } = scripted(() => one("send_email", input));
      const { loop, ctx, rows } = setup({
        provider,
        tools: createToolRegistry([spyTool("send_email", 2)]),
        policy: spyHook(() => Promise.resolve({ decision: "needs_approval", reasonCode: "human" })),
      });
      await loop.execute(ctx);
      hashes.push(payloadsOf(rows, "approval.requested")[0]?.payload_hash);
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it("AC2: the loop never grants an approval itself: the request expires (timeout means deny) and nothing executes", async () => {
    const tool = spyTool("send_email", 2);
    const { provider } = scripted(() => one("send_email"));
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy: spyHook(() => Promise.resolve({ decision: "needs_approval", reasonCode: "human" })),
    });

    await loop.execute(ctx);

    const [approval] = payloadsOf(rows, "approval.requested");
    expect(Date.parse(String(approval?.expires_at))).toBeGreaterThan(Date.now());
    expect(tool.run).not.toHaveBeenCalled();
    expect(types(rows)).not.toContain("tool_call.completed");
  });

  it("AC2: a tool that honours the abort signal cannot outlive the wall-time limit", async () => {
    const slow = spyTool(
      "get_current_time",
      0,
      (_input, context) =>
        new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            reject(new Error("tool aborted"));
          });
        }),
    );
    const { provider } = scripted(() => one("get_current_time"));
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([slow]),
      policy: allowAll(),
      limits: { maxWallMs: 200 },
    });

    const outcome = await settlesWithin(loop.execute(ctx), 3_000);

    expect(outcome).toMatchObject({ end: "limit_reached" });
    expect(payloadsOf(rows, "run.limit_reached")[0]).toMatchObject({ limit: "time" });
  });
});

describe("AGO-167 QA, AC3: credentials never appear in prompts, events, logs or errors", () => {
  const b64 = Buffer.from(FAKE_KEY).toString("base64");
  const b64url = Buffer.from(FAKE_KEY).toString("base64url");
  const hex = Buffer.from(FAKE_KEY).toString("hex");
  const urlEncoded = encodeURIComponent(FAKE_KEY);
  const forms = [FAKE_KEY, b64, b64url, hex, urlEncoded];

  const scan = (surface: string) => {
    for (const form of forms) expect(surface).not.toContain(form);
  };

  it("AC3: the key stays out of every surface across a full run with tool calls (raw, base64, hex, URL-encoded)", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fakeFetch: typeof fetch = (_url, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      n += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content:
              n === 1
                ? [{ type: "tool_use", id: "toolu_1", name: "get_current_time", input: {} }]
                : [{ type: "text", text: "All done." }],
            usage: { input_tokens: 12, output_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const provider = createClaudeProvider({ apiKey: FAKE_KEY, model: "m", fetch: fakeFetch });
    const { loop, ctx, rows, logLines } = setup({ provider });

    await loop.execute(ctx);

    scan(JSON.stringify(rows));
    scan(logLines.join("\n"));
    for (const body of bodies) scan(body);
  });

  it("AC3: an API error body that echoes the key in raw, base64, URL-encoded and hex forms never reaches events, logs or the thrown error", async () => {
    const echo: typeof fetch = () =>
      Promise.resolve(
        new Response(`bad key ${FAKE_KEY} / ${b64} / ${b64url} / ${urlEncoded} / ${hex}`, {
          status: 500,
        }),
      );
    const provider = createClaudeProvider({ apiKey: FAKE_KEY, model: "m", fetch: echo });
    const { loop, ctx, rows, logLines } = setup({ provider });

    const failure = await loop.execute(ctx).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    scan((failure as Error).message);
    scan((failure as Error).stack ?? "");
    scan(JSON.stringify(rows));
    scan(logLines.join("\n"));
  });

  it("AC3: a key printed by a tool is scrubbed from the events and from the next prompt", async () => {
    const leaky = spyTool("get_current_time", 0, () => Promise.resolve(`token is ${FAKE_KEY} ok`));
    const { provider, requests } = scripted((n) =>
      n === 1 ? one("get_current_time") : answer("done"),
    );
    const { loop, ctx, rows, logLines } = setup({
      provider,
      tools: createToolRegistry([leaky]),
      policy: allowAll(),
    });

    await loop.execute(ctx);

    expect(leaky.run).toHaveBeenCalledTimes(1);
    scan(JSON.stringify(rows));
    scan(logLines.join("\n"));
    scan(
      requests.map((r) => `${r.system}\n${r.messages.map((m) => m.content).join("\n")}`).join("\n"),
    );
  });

  it("AC3: a key the model echoes in its final answer is scrubbed from the summary and the message event", async () => {
    const { provider } = scripted(() => answer(`my key is ${FAKE_KEY}`));
    const { loop, ctx, rows } = setup({ provider });

    const outcome = await loop.execute(ctx);

    scan(JSON.stringify(outcome));
    scan(JSON.stringify(rows));
  });

  it("AC3: a key the model puts in a tool input is never stored in events or logs (only the input hash)", async () => {
    const { provider } = scripted((n) =>
      n === 1 ? one("send_note", { text: FAKE_KEY }) : answer("ok"),
    );
    const { loop, ctx, rows, logLines } = setup({
      provider,
      tools: createToolRegistry([spyTool("send_note", 2)]),
      policy: spyHook(() => Promise.resolve({ decision: "needs_approval", reasonCode: "human" })),
    });

    await loop.execute(ctx);

    scan(JSON.stringify(rows));
    scan(logLines.join("\n"));
  });

  it("AC3: the provider puts the key only in the x-api-key header, never in the URL or body", async () => {
    const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fakeFetch: typeof fetch = (url, init) => {
      seen.push({
        url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        body: typeof init?.body === "string" ? init.body : "",
        headers: init?.headers as Record<string, string>,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
      );
    };
    const provider = createClaudeProvider({ apiKey: FAKE_KEY, model: "m", fetch: fakeFetch });
    const { loop, ctx } = setup({ provider });

    await loop.execute(ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(seen[0]?.url).not.toContain(FAKE_KEY);
    expect(seen[0]?.body).not.toContain(FAKE_KEY);
    expect(
      Object.entries(seen[0]?.headers ?? {}).filter(
        ([k, v]) => k !== "x-api-key" && v.includes(FAKE_KEY),
      ),
    ).toEqual([]);
  });
});
