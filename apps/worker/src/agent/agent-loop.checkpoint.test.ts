import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { NonRetryableRunError, type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop, type AgentLoopDeps } from "./agent-loop.js";
import {
  createMemoryCheckpointStore,
  type MemoryCheckpointStore,
} from "./checkpoint-store.test-helpers.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { CheckpointStore } from "./checkpoint-store.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";
import type { CapabilityTier } from "@ago/shared";

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const REF = { workspaceId: WS, runId: RUN };
// Built at runtime so no secret-shaped literal sits in the repo.
const FAKE_KEY = ["sk", "ant", "api03", "FAKE-KEY-for-tests-0123456789abcdef"].join("-");

const usage = { inputTokens: 10, outputTokens: 5 };

function runContext(): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
  };
}

function tool(
  name: string,
  tier: CapabilityTier = 0,
  execute: AgentTool["execute"] = () => Promise.resolve(`${name} output`),
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

const allowAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }),
};

/**
 * A model that asks for `calls` (tool name per call) until it has seen a tool result, then answers.
 * `inFlight` counts model calls that have started and not settled.
 */
function scriptedModel(calls: readonly string[], onRequest?: (n: number) => void) {
  const requests: ModelRequest[] = [];
  const state = { inFlight: 0 };
  const provider: ModelProvider = {
    complete: (request) => {
      requests.push(request);
      onRequest?.(requests.length);
      state.inFlight += 1;
      const seenResult = JSON.stringify(request.messages).includes("status: ");
      const response: ModelResponse = seenResult
        ? { text: "All done.", toolCalls: [], usage }
        : {
            text: "",
            toolCalls: calls.map((name, i) => ({ id: `toolu_${String(i)}`, name, input: { i } })),
            usage,
          };
      return Promise.resolve(response).finally(() => {
        state.inFlight -= 1;
      });
    },
  };
  return { provider, requests, state };
}

function attempt(options: {
  provider: ModelProvider;
  tools: readonly AgentTool[];
  store: CheckpointStore;
  policy?: PolicyHook;
  limits?: AgentLoopDeps["limits"];
  rows?: RunEventRow[];
}) {
  const rows = options.rows ?? [];
  const logger = createLogger({ level: "silent" });
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
  const loop = createAgentLoop({
    toolOffer: offerAllTools,
    provider: options.provider,
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () => Promise.resolve(runContext()),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry(options.tools),
    policy: options.policy ?? allowAll,
    checkpoints: options.store,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const ctx: RunExecutionContext = {
    workspaceId: WS,
    runId: RUN,
    agentId: AGENT,
    taskId: TASK,
    attempt: 0,
    logger,
    emitter,
    signal: new AbortController().signal,
  };
  return { loop, ctx, rows };
}

/** A store whose `save` number `n` dies like a killed worker: before the write, or right after it. */
function crashingStore(
  inner: MemoryCheckpointStore,
  n: number,
  when: "before" | "after",
): CheckpointStore {
  let count = 0;
  return {
    ...inner,
    save: async (ref, state) => {
      count += 1;
      if (count === n && when === "before") throw new Error("worker died");
      await inner.save(ref, state);
      if (count === n && when === "after") throw new Error("worker died");
    },
  };
}

const types = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);

describe("checkpoint: a crash resumes without repeating completed tool calls (AC1)", () => {
  const names = ["alpha", "beta", "gamma"];

  // The saves of one uninterrupted run: how many places a worker could die.
  async function countSaves(): Promise<number> {
    const store = createMemoryCheckpointStore();
    const { loop, ctx } = attempt({
      provider: scriptedModel(names).provider,
      tools: names.map((n) => tool(n)),
      store,
    });
    await loop.execute(ctx);
    return store.saves.length;
  }

  for (const when of ["before", "after"] as const) {
    it(`dying ${when} any one save: every tool runs at most once and the run completes`, async () => {
      const total = await countSaves();
      expect(total).toBeGreaterThan(names.length * 2);
      for (let n = 1; n <= total; n += 1) {
        const store = createMemoryCheckpointStore();
        const tools = names.map((name) => tool(name));
        const first = attempt({
          provider: scriptedModel(names).provider,
          tools,
          store: crashingStore(store, n, when),
        });
        await expect(first.loop.execute(first.ctx)).rejects.toThrow("worker died");

        const second = attempt({ provider: scriptedModel(names).provider, tools, store });
        const outcome = await second.loop.execute(second.ctx);

        expect(outcome.end, `save ${String(n)} (${when})`).toBe("completed");
        for (const t of tools) {
          expect(
            t.run.mock.calls.length,
            `${t.name}, save ${String(n)} (${when})`,
          ).toBeLessThanOrEqual(1);
        }
      }
    });
  }

  it("does not run a call again once its result was saved, and reuses the saved result", async () => {
    const store = createMemoryCheckpointStore();
    const tools = names.map((name) => tool(name));
    // Saves: [step, a started, a done, b started, b done, ...]. Die right after the second tool's result.
    const first = attempt({
      provider: scriptedModel(names).provider,
      tools,
      store: crashingStore(store, 5, "after"),
    });
    await expect(first.loop.execute(first.ctx)).rejects.toThrow("worker died");
    expect(tools.map((t) => t.run.mock.calls.length)).toEqual([1, 1, 0]);

    const model = scriptedModel(names);
    const second = attempt({ provider: model.provider, tools, store });
    const outcome = await second.loop.execute(second.ctx);

    expect(outcome.end).toBe("completed");
    // Only the third call ran in the second attempt; the model was asked once (for the final answer) and
    // saw all three results, including the two it never re-ran.
    expect(tools.map((t) => t.run.mock.calls.length)).toEqual([1, 1, 1]);
    expect(model.requests).toHaveLength(1);
    const seen = JSON.stringify(model.requests[0]?.messages);
    for (const name of names) expect(seen).toContain(`${name} output`);
    expect(outcome.steps).toBe(2);
  });

  it("does not ask the model again for a step whose calls were already saved", async () => {
    const store = createMemoryCheckpointStore();
    const tools = names.map((name) => tool(name));
    const first = scriptedModel(names);
    // Save 1 is the step's calls: die right after it, before any tool runs.
    const a = attempt({ provider: first.provider, tools, store: crashingStore(store, 1, "after") });
    await expect(a.loop.execute(a.ctx)).rejects.toThrow("worker died");
    expect(first.requests).toHaveLength(1);

    const second = scriptedModel(names);
    const b = attempt({ provider: second.provider, tools, store });
    const outcome = await b.loop.execute(b.ctx);

    expect(outcome.end).toBe("completed");
    // The one model call of the second attempt is the final answer, not step 1 over again.
    expect(second.requests).toHaveLength(1);
    expect(tools.map((t) => t.run.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("never re-runs a call that started but has no result, and tells the model the outcome is unknown", async () => {
    const store = createMemoryCheckpointStore();
    const tools = [tool("alpha"), tool("beta")];
    // Saves: step, alpha started, alpha done, beta started, beta done. Die before alpha's result is saved.
    const a = attempt({
      provider: scriptedModel(["alpha", "beta"]).provider,
      tools,
      store: crashingStore(store, 3, "before"),
    });
    await expect(a.loop.execute(a.ctx)).rejects.toThrow("worker died");
    expect(tools[0]?.run).toHaveBeenCalledTimes(1);

    const model = scriptedModel(["alpha", "beta"]);
    const b = attempt({ provider: model.provider, tools, store });
    const outcome = await b.loop.execute(b.ctx);

    expect(outcome.end).toBe("completed");
    expect(tools[0]?.run).toHaveBeenCalledTimes(1); // not run again
    expect(tools[1]?.run).toHaveBeenCalledTimes(1);
    const failed = b.rows.filter((row) => row.type === "tool_call.failed");
    expect(failed.map((row) => row.payload.error_code)).toEqual(["outcome_unknown"]);
    expect(JSON.stringify(model.requests[0]?.messages)).toContain("outcome is unknown");
  });

  it("reports the recovery with counts only, and not on a fresh start", async () => {
    const store = createMemoryCheckpointStore();
    const tools = names.map((name) => tool(name));
    const a = attempt({
      provider: scriptedModel(names).provider,
      tools,
      store: crashingStore(store, 5, "after"),
    });
    await expect(a.loop.execute(a.ctx)).rejects.toThrow("worker died");
    expect(types(a.rows)).not.toContain("run.recovered");

    const b = attempt({ provider: scriptedModel(names).provider, tools, store });
    await b.loop.execute(b.ctx);
    const recovered = b.rows.filter((row) => row.type === "run.recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.payload).toMatchObject({ step: 1, completed_calls: 2 });
  });

  it("fails the run for good when the saved state cannot be read, and asks the model nothing", async () => {
    const store = createMemoryCheckpointStore();
    store.setRaw(REF, { version: 99, whatever: true });
    const model = scriptedModel(names);
    const a = attempt({ provider: model.provider, tools: names.map((n) => tool(n)), store });

    const error = await a.loop.execute(a.ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableRunError);
    expect((error as NonRetryableRunError).reason).toBe("checkpoint_unreadable");
    expect(model.requests).toHaveLength(0);
  });

  it("carries steps over, so a pause-and-resume cannot escape the step limit", async () => {
    const store = createMemoryCheckpointStore();
    const model = () => {
      const requests: ModelRequest[] = [];
      const provider: ModelProvider = {
        complete: (request) => {
          requests.push(request);
          // A different input every time, so loop detection does not fire first.
          return Promise.resolve({
            text: "",
            toolCalls: [
              { id: `t${String(requests.length)}`, name: "alpha", input: { n: requests.length } },
            ],
            usage,
          });
        },
      };
      return { provider, requests };
    };
    const alpha = tool("alpha", 0, () => {
      void store.requestPause(REF); // a human pauses while step 1's tool runs
      return Promise.resolve("ok");
    });
    const first = model();
    const a = attempt({ provider: first.provider, tools: [alpha], store, limits: { maxSteps: 2 } });
    const paused = await a.loop.execute(a.ctx);
    expect(paused).toMatchObject({ end: "paused", pauseReason: "user_pause", steps: 1 });

    await store.clearPause(REF);
    const second = model();
    const b = attempt({
      provider: second.provider,
      tools: [tool("alpha")],
      store,
      limits: { maxSteps: 2 },
    });
    const outcome = await b.loop.execute(b.ctx);

    expect(outcome).toMatchObject({ end: "limit_reached", steps: 2 });
    expect(first.requests.length + second.requests.length).toBe(2);
  });

  it("stores scrubbed inputs and results only", async () => {
    const store = createMemoryCheckpointStore();
    const secretTool = tool("alpha", 0, () => Promise.resolve(`token is ${FAKE_KEY}`));
    const provider: ModelProvider = {
      complete: (request) =>
        Promise.resolve(
          JSON.stringify(request.messages).includes("status: ")
            ? { text: "ok", toolCalls: [], usage }
            : {
                text: "",
                toolCalls: [{ id: "t1", name: "alpha", input: { key: FAKE_KEY } }],
                usage,
              },
        ),
    };
    const a = attempt({ provider, tools: [secretTool], store });
    await a.loop.execute(a.ctx);

    expect(store.saves.length).toBeGreaterThan(0);
    expect(JSON.stringify(store.saves)).not.toContain(FAKE_KEY);
  });
});

describe("checkpoint: pause holds no open model call (AC2)", () => {
  it("lets an in-flight model call finish, then pauses before any tool runs", async () => {
    const store = createMemoryCheckpointStore();
    const alpha = tool("alpha");
    const model = scriptedModel(["alpha"], () => {
      // A human asks for the pause while the model call is in flight.
      void store.requestPause(REF);
    });
    const a = attempt({ provider: model.provider, tools: [alpha], store });

    const outcome = await a.loop.execute(a.ctx);

    expect(outcome).toMatchObject({ end: "paused", pauseReason: "user_pause" });
    expect(model.state.inFlight).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(alpha.run).not.toHaveBeenCalled();
    // The model's answer was kept, so the resume runs these calls instead of asking again.
    expect(store.peek(REF)?.step?.calls.map((c) => c.status)).toEqual(["pending"]);

    // Resume: same store, the pause request cleared. No new model call until it runs.
    await store.clearPause(REF);
    const again = scriptedModel(["alpha"]);
    const b = attempt({ provider: again.provider, tools: [alpha], store });
    const resumed = await b.loop.execute(b.ctx);
    expect(resumed.end).toBe("completed");
    expect(alpha.run).toHaveBeenCalledTimes(1);
    expect(again.requests).toHaveLength(1); // only the final answer
  });

  it("pauses before the first model call when a pause was requested before the run started", async () => {
    const store = createMemoryCheckpointStore();
    await store.requestPause(REF);
    const model = scriptedModel(["alpha"]);
    const a = attempt({ provider: model.provider, tools: [tool("alpha")], store });

    const outcome = await a.loop.execute(a.ctx);

    expect(outcome).toMatchObject({ end: "paused", pauseReason: "user_pause", steps: 0 });
    expect(model.requests).toHaveLength(0);
  });

  it("keeps a pause for approval as it was, and denies the stored call when the run is resumed", async () => {
    const store = createMemoryCheckpointStore();
    const risky = tool("risky", 3);
    const model = scriptedModel(["risky"]);
    const a = attempt({ provider: model.provider, tools: [risky], store });

    const outcome = await a.loop.execute(a.ctx);

    expect(outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    const stored = store.peek(REF)?.step?.calls[0];
    expect(stored?.status).toBe("awaiting_approval");
    expect(stored?.payload_hash).toMatch(/^[a-f0-9]{64}$/);

    // Resumed with nothing recording an approval: the call is a deny, never an execution.
    const again = scriptedModel(["risky"]);
    const b = attempt({ provider: again.provider, tools: [risky], store });
    const resumed = await b.loop.execute(b.ctx);

    expect(resumed.end).toBe("completed");
    expect(risky.run).not.toHaveBeenCalled();
    expect(
      b.rows.filter((row) => row.type === "tool_call.failed").map((r) => r.payload.error_code),
    ).toEqual(["approval_not_granted"]);
    // step.completed was already written when the run paused; the resume must not write it twice.
    expect(types(b.rows).filter((t) => t === "step.completed")).toHaveLength(1);
  });
});
