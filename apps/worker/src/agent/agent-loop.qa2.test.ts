import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import { createClaudeProvider, scrubApiKey } from "./claude-provider.js";
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

// AGO-167 QA round 2 (after fix round 1): attacks on the three fixed defects. The model is a scripted
// fake (no network, no API key, no spend). Fake secrets are built at runtime.

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const FAKE_KEY = ["sk", "ant", "api03", "QA".repeat(8), "zZ9".repeat(6)].join("-");

const usage = { inputTokens: 10, outputTokens: 5 };
const answer = (text: string): ModelResponse => ({ text, toolCalls: [], usage });
const calls = (toolCalls: readonly ModelToolCall[]): ModelResponse => ({
  text: "",
  toolCalls,
  usage,
});
const one = (name: string, id = "toolu_1") => calls([{ id, name, input: {} }]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

const spyHook = (decide: PolicyHook["check"]) => ({ check: vi.fn(decide) }) satisfies PolicyHook;
const allowAll = () =>
  spyHook(() => Promise.resolve({ decision: "allow", reasonCode: "qa_allow" }));

function setup(
  options: {
    provider?: ModelProvider;
    tools?: ToolRegistry;
    policy?: PolicyHook;
    maxWallMs?: number;
    policyTimeoutMs?: number;
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
    provider: options.provider ?? scripted(() => answer("done")).provider,
    contextBuilder,
    tools: options.tools ?? createToolRegistry([getCurrentTimeTool]),
    policy: options.policy ?? createDenyByDefaultPolicyHook(),
    ...(options.maxWallMs === undefined ? {} : { limits: { maxWallMs: options.maxWallMs } }),
    ...(options.policyTimeoutMs === undefined ? {} : { policyTimeoutMs: options.policyTimeoutMs }),
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

/** Resolves with "hung" if `work` has not settled within `ms`. */
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

describe("AGO-167 QA round 2, D1: the policy answer is strictly validated", () => {
  it.each<[string, unknown]>([
    ["deny with an extra allow field", { decision: "deny", reasonCode: "x", allow: true }],
    ["allow with an extra allow field", { decision: "allow", reasonCode: "x", allow: true }],
    ["allow with an extra approved field", { decision: "allow", reasonCode: "x", approved: true }],
    [
      "needs_approval with an extra allow field",
      { decision: "needs_approval", reasonCode: "x", allow: true },
    ],
    ["an array decision", { decision: ["allow"], reasonCode: "x" }],
    [
      "a __proto__ key",
      JSON.parse('{"decision":"allow","reasonCode":"x","__proto__":{"allow":true}}') as unknown,
    ],
  ])("D1: %s is a deny and the tool is not run", async (_label, garbage) => {
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(() => Promise.resolve(garbage as never));
    const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

    const outcome = await loop.execute(ctx);

    expect(tool.run).not.toHaveBeenCalled();
    expect(outcome.end).toBe("completed");
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({ decision: "deny" });
    expect(types(rows)).not.toContain("tool_call.started");
  });

  it("D1: an extra field on a would-be allow reports policy_invalid_response", async () => {
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(() =>
      Promise.resolve({ decision: "allow", reasonCode: "x", allow: true } as never),
    );
    const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "deny",
      reason_code: "policy_invalid_response",
    });
  });

  it("D1 control: a well-formed allow still runs the tool and keeps the rule id", async () => {
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(() =>
      Promise.resolve({ decision: "allow", reasonCode: "ok_rule", ruleId: "r-1" } as const),
    );
    const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
    const { loop, ctx, rows } = setup({ provider, tools: createToolRegistry([tool]), policy });

    await loop.execute(ctx);

    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(payloadsOf(rows, "policy.decision")[0]).toMatchObject({
      decision: "allow",
      rule_id: "r-1",
    });
  });
});

describe("AGO-167 QA round 2, D2: timeouts and the wall-time signal preempt every await", () => {
  it("D2: a hook that resolves allow after its timeout is a deny, and the tool never runs late", async () => {
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(async () => {
      await sleep(150);
      return { decision: "allow", reasonCode: "late_allow" } as const;
    });
    const { provider, requests } = scripted((n) =>
      n <= 2 ? one("get_current_time", `t${String(n)}`) : answer("ok"),
    );
    const { loop, ctx, rows } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy,
      policyTimeoutMs: 40,
    });

    const outcome = await loop.execute(ctx);
    await sleep(400); // let every late answer land

    expect(outcome.end).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(tool.run).not.toHaveBeenCalled();
    expect(types(rows)).not.toContain("tool_call.started");
    expect(types(rows)).not.toContain("tool_call.completed");
    expect(payloadsOf(rows, "policy.decision")).toEqual([
      expect.objectContaining({ decision: "deny", reason_code: "policy_timeout" }),
      expect.objectContaining({ decision: "deny", reason_code: "policy_timeout" }),
    ]);
  });

  it("D2: the hook receives an abort signal that fires at its timeout", async () => {
    let seen: AbortSignal | undefined;
    const policy = spyHook((_call, context) => {
      seen = context.signal;
      return new Promise(() => undefined);
    });
    const { provider } = scripted((n) => (n === 1 ? one("get_current_time") : answer("ok")));
    const { loop, ctx } = setup({
      provider,
      tools: createToolRegistry([spyTool("get_current_time", 0)]),
      policy,
      policyTimeoutMs: 40,
    });

    await loop.execute(ctx);

    expect(seen?.aborted).toBe(true);
  });

  it("D2: a tool that ignores the abort signal cannot hold the run past the wall limit, and its late result is discarded", async () => {
    let finished = false;
    const stubborn = spyTool("get_current_time", 0, async () => {
      await sleep(500); // ignores context.signal entirely
      finished = true;
      return "LATE-RESULT-MARKER";
    });
    const { provider, requests } = scripted(() => one("get_current_time"));
    const { loop, ctx, rows, logLines } = setup({
      provider,
      tools: createToolRegistry([stubborn]),
      policy: allowAll(),
      maxWallMs: 150,
    });
    const startedAt = Date.now();

    const outcome = await settlesWithin(loop.execute(ctx), 3_000);
    const elapsed = Date.now() - startedAt;
    const eventsAtEnd = rows.length;
    await sleep(700); // the tool finishes after the run is over

    expect(outcome).toMatchObject({ end: "limit_reached" });
    expect(elapsed).toBeLessThan(450);
    expect(finished).toBe(true);
    expect(payloadsOf(rows, "run.limit_reached")[0]).toMatchObject({ limit: "time" });
    // The late result produced no event, no log line and no further model request.
    expect(rows).toHaveLength(eventsAtEnd);
    expect(types(rows)).not.toContain("tool_call.completed");
    expect(JSON.stringify(rows)).not.toContain("LATE-RESULT-MARKER");
    expect(logLines.join("\n")).not.toContain("LATE-RESULT-MARKER");
    expect(requests).toHaveLength(1);
  });

  it("D2: a tool that ignores abort and later REJECTS leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const stubborn = spyTool("get_current_time", 0, async () => {
        await sleep(300);
        throw new Error("late failure");
      });
      const { provider } = scripted(() => one("get_current_time"));
      const { loop, ctx } = setup({
        provider,
        tools: createToolRegistry([stubborn]),
        policy: allowAll(),
        maxWallMs: 100,
      });

      const outcome = await settlesWithin(loop.execute(ctx), 3_000);
      await sleep(500);

      expect(outcome).toMatchObject({ end: "limit_reached" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("D2: a model call that ignores the abort signal is also cut at the wall limit", async () => {
    const { provider } = scripted(() => new Promise<ModelResponse>(() => undefined));
    const { loop, ctx } = setup({ provider, maxWallMs: 120 });

    const outcome = await settlesWithin(loop.execute(ctx), 3_000);

    expect(outcome).toMatchObject({ end: "limit_reached" });
  });

  it("D2: a worker shutdown during a hung hook ends the run as an error (the queue retries), not a deny", async () => {
    const controller = new AbortController();
    const tool = spyTool("get_current_time", 0);
    const policy = spyHook(() => new Promise(() => undefined));
    const { provider } = scripted(() => one("get_current_time"));
    const { loop, ctx } = setup({
      provider,
      tools: createToolRegistry([tool]),
      policy,
      signal: controller.signal,
    });
    const run = loop.execute(ctx).catch((error: unknown) => error);
    await sleep(30);
    controller.abort();

    const result = await settlesWithin(run, 3_000);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/shutting down/);
    expect(tool.run).not.toHaveBeenCalled();
  });
});

describe("AGO-167 QA round 2, D3: no provider error body, key scrubbed in every form", () => {
  const b64 = Buffer.from(FAKE_KEY).toString("base64");
  const b64url = Buffer.from(FAKE_KEY).toString("base64url");
  const hex = Buffer.from(FAKE_KEY).toString("hex");
  const forms = [
    FAKE_KEY,
    b64,
    b64.replace(/=+$/, ""),
    b64url,
    hex,
    hex.toUpperCase(),
    encodeURIComponent(FAKE_KEY),
  ];
  const half = Math.floor(FAKE_KEY.length / 2);
  const partA = FAKE_KEY.slice(0, half);
  const partB = FAKE_KEY.slice(half);

  const scan = (surface: string) => {
    for (const form of forms) expect(surface).not.toContain(form);
  };

  async function failWith(body: string, status = 500) {
    const echo: typeof fetch = () => Promise.resolve(new Response(body, { status }));
    const provider = createClaudeProvider({ apiKey: FAKE_KEY, model: "m", fetch: echo });
    const { loop, ctx, rows, logLines } = setup({ provider });
    const failure = await loop.execute(ctx).catch((error: unknown) => error);
    const surface = [
      failure instanceof Error ? `${failure.message}\n${failure.stack ?? ""}` : String(failure),
      JSON.stringify(rows),
      logLines.join("\n"),
    ].join("\n");
    return { failure, surface };
  }

  it("D3: a key split across two error fields never reaches the error, events or logs (nor either half)", async () => {
    const { failure, surface } = await failWith(
      JSON.stringify({ error: { type: "x", message: `bad ${partA}`, detail: `${partB} end` } }),
    );

    expect(failure).toBeInstanceOf(Error);
    scan(surface);
    expect(surface).not.toContain(partA);
    expect(surface).not.toContain(partB);
    expect((failure as Error).message).toMatch(/status 500/);
  });

  it("D3: a key hidden in a nested JSON string (double-encoded) is dropped with the body", async () => {
    const nested = JSON.stringify({
      error: { message: JSON.stringify({ inner: { key: FAKE_KEY } }) },
    });
    const { surface } = await failWith(nested);

    scan(surface);
    expect(surface).not.toContain(partA);
    expect(surface).not.toContain(JSON.stringify(JSON.stringify(FAKE_KEY)));
  });

  it("D3: a 400 echoing the key keeps only the status category", async () => {
    const { failure, surface } = await failWith(`{"error":"${FAKE_KEY}"}`, 400);

    scan(surface);
    expect((failure as Error).message).toMatch(/status 400/);
  });

  it("D3: a 401 echoing hex-of-base64url and line-folded chunks stays out of every surface", async () => {
    const folded = FAKE_KEY.match(/.{1,6}/g)?.join("\n") ?? "";
    const hexOfB64url = Buffer.from(b64url).toString("hex");
    const { surface } = await failWith(`${hexOfB64url}\n${folded}`, 401);

    scan(surface);
    expect(surface).not.toContain(hexOfB64url);
  });

  it("D3: scrubApiKey removes every encoding (helper unit check)", () => {
    scan(scrubApiKey(forms.map((f) => `<${f}>`).join(" "), FAKE_KEY));
  });

  it("D3: a 200 that is HTML echoing the key fails without echoing its text", async () => {
    const { failure, surface } = await failWith(`<html>${FAKE_KEY}</html>`, 200);

    expect(failure).toBeInstanceOf(Error);
    scan(surface);
    expect((failure as Error).message).toBe("model response was not in the expected shape");
  });
});
