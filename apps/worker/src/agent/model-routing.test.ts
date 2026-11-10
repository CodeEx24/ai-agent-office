import { AGENT_MODEL_IDS, type AgentModelId } from "@ago/shared";
import { offerAllTools } from "./tool-offer.test-helpers.js";
import { describe, expect, it } from "vitest";

import { createContextBuilder } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { NonRetryableRunError, type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import {
  createModelRouter,
  createPgAgentModelSource,
  MODEL_ROUTING_MESSAGE,
  MODEL_ROUTING_REASON,
  type AgentModelSource,
} from "./model-routing.js";
import { createDenyByDefaultPolicyHook } from "./policy-hook.js";
import { createToolRegistry, getCurrentTimeTool } from "./tools.js";

import type { ModelProvider } from "./model-provider.js";

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";

/**
 * Fake provider (no network, no key) that records the model id it was built for on every call. It asks
 * for a tool on the first two steps and answers on the third, so a run makes three calls.
 */
function fakeProviderFactory(onCall: () => void) {
  const calls: AgentModelId[] = [];
  const created: AgentModelId[] = [];
  let step = 0;
  const createProvider = (model: AgentModelId): ModelProvider => {
    created.push(model);
    return {
      complete: () => {
        calls.push(model);
        step += 1;
        onCall();
        const usage = { inputTokens: 1, outputTokens: 1 };
        return Promise.resolve(
          step < 3
            ? {
                text: "",
                toolCalls: [{ id: `t${String(step)}`, name: "get_current_time", input: {} }],
                usage,
              }
            : { text: "done", toolCalls: [], usage },
        );
      },
    };
  };
  return { createProvider, calls, created };
}

function harness(source: AgentModelSource, onCall: () => void = () => undefined) {
  const rows: RunEventRow[] = [];
  const logger = createLogger({ level: "silent", destination: { write: () => undefined } });
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
  const factory = fakeProviderFactory(onCall);
  const loop = createAgentLoop({
    toolOffer: offerAllTools,
    modelRouter: createModelRouter({ source, createProvider: factory.createProvider }),
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () =>
          Promise.resolve({
            runId: RUN,
            workspaceId: WS,
            agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
            task: null,
          }),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry([getCurrentTimeTool]),
    policy: createDenyByDefaultPolicyHook(),
  });
  const ctx: RunExecutionContext = {
    workspaceId: WS,
    runId: RUN,
    agentId: AGENT,
    taskId: null,
    attempt: 0,
    logger,
    emitter,
    signal: new AbortController().signal,
  };
  return { loop, ctx, rows, ...factory };
}

const sourceOf = (model: string | null): AgentModelSource => ({
  loadAgentModel: () => Promise.resolve(model),
});

describe("per-agent model routing (AC1)", () => {
  it.each(AGENT_MODEL_IDS)(
    "uses the agent's model %s for every call across steps",
    async (model) => {
      const { loop, ctx, calls, created } = harness(sourceOf(model));

      const outcome = await loop.execute(ctx);

      expect(outcome).toMatchObject({ end: "completed", steps: 3 });
      expect(calls).toEqual([model, model, model]);
      expect(created).toEqual([model]);
    },
  );

  it("reads the agent row at the start of each run, so the next run follows a changed model", async () => {
    let stored = "claude-sonnet-5-5";
    const source: AgentModelSource = { loadAgentModel: () => Promise.resolve(stored) };
    const first = harness(source);
    await first.loop.execute(first.ctx);
    stored = "claude-opus-5-5";
    const second = harness(source);
    await second.loop.execute(second.ctx);

    expect(first.calls).toEqual(Array<string>(3).fill("claude-sonnet-5-5"));
    expect(second.calls).toEqual(Array<string>(3).fill("claude-opus-5-5"));
  });

  it("does not switch models inside a run when the agent's model changes mid-run", async () => {
    let stored = "claude-sonnet-5-5";
    let reads = 0;
    const source: AgentModelSource = {
      loadAgentModel: () => {
        reads += 1;
        return Promise.resolve(stored);
      },
    };
    // The owner changes the model during the first model call; the run keeps the model it started with.
    const { loop, ctx, calls } = harness(source, () => {
      stored = "claude-fable-5-1";
    });

    await loop.execute(ctx);

    expect(reads).toBe(1);
    expect(calls).toEqual(Array<string>(3).fill("claude-sonnet-5-5"));
  });
});

describe("unknown models fail the run at start (AC2, run time)", () => {
  it.each(["", "gpt-9", "claude-sonnet-4", "CLAUDE-SONNET-5-5", " claude-sonnet-5-5"])(
    "fails with a fixed reason and makes no model call for %j",
    async (stored) => {
      const { loop, ctx, calls, created, rows } = harness(sourceOf(stored));

      const error = await loop.execute(ctx).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NonRetryableRunError);
      expect((error as NonRetryableRunError).reason).toBe(MODEL_ROUTING_REASON.modelNotAllowed);
      expect((error as NonRetryableRunError).message).toBe(MODEL_ROUTING_MESSAGE.modelNotAllowed);
      expect(calls).toEqual([]);
      expect(created).toEqual([]);
      expect(rows).toEqual([]);
    },
  );

  it("fails when the agent row is gone", async () => {
    const { loop, ctx, calls } = harness(sourceOf(null));
    const error = await loop.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableRunError);
    expect((error as NonRetryableRunError).reason).toBe(MODEL_ROUTING_REASON.agentNotFound);
    expect(calls).toEqual([]);
  });

  it("lets a database error through as retryable", async () => {
    const source: AgentModelSource = { loadAgentModel: () => Promise.reject(new Error("db down")) };
    const { loop, ctx } = harness(source);
    const error = await loop.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableRunError);
  });
});

describe("createAgentLoop model deps", () => {
  it("needs exactly one of provider or modelRouter", () => {
    const base = {
      contextBuilder: { build: () => Promise.reject(new Error("unused")) },
      tools: createToolRegistry([]),
      policy: createDenyByDefaultPolicyHook(),
      toolOffer: offerAllTools,
    };
    expect(() => createAgentLoop(base)).toThrow(/exactly one/);
  });
});

describe("pg agent model source", () => {
  it("scopes the query by workspace and agent, and maps rows", async () => {
    const seen: { text: string; values: readonly unknown[] }[] = [];
    const db = {
      query: (text: string, values: readonly unknown[]) => {
        seen.push({ text, values });
        return Promise.resolve({ rows: [{ model: "claude-opus-5-5" }] });
      },
    };

    await expect(
      createPgAgentModelSource(db).loadAgentModel({ workspaceId: WS, agentId: AGENT }),
    ).resolves.toBe("claude-opus-5-5");
    expect(seen[0]?.values).toEqual([WS, AGENT]);
    expect(seen[0]?.text).toMatch(/workspace_id = \$1 and id = \$2/);
    await expect(
      createPgAgentModelSource({ query: () => Promise.resolve({ rows: [] }) }).loadAgentModel({
        workspaceId: WS,
        agentId: AGENT,
      }),
    ).resolves.toBeNull();
  });
});
