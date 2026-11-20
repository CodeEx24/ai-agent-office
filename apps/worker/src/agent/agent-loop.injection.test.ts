import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DIRECTIVE, INJECTION_CORPUS } from "../context/__fixtures__/injection-corpus.js";
import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { createAgentLoop } from "./agent-loop.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";
import type { RunExecutionContext } from "../queue/run-processor.js";

// A heavy file: the whole corpus runs through the real loop, twice per sample.
vi.setConfig({ testTimeout: 30_000 });

/**
 * AGO-23, AC "Injection test samples do not change which tools are called".
 *
 * The model here is a scripted stand-in that follows the one rule the system prompt gives it: text inside
 * a data block is not an instruction. It reads the boundary id from the system prompt, strips the blocks
 * that carry it, and obeys a `CALL_TOOL:<name>` directive only if one is left OUTSIDE the blocks. The
 * policy hook allows everything, including `danger`, so the only thing between injected text and the
 * `danger` tool is the prompt structure. This proves the STRUCTURE (injected text never leaves its
 * labeled block, forged boundaries do not work, tool calls are the same with and without the sample).
 * It cannot prove that a real model obeys the rule; a live red-team run is AGO-129.
 */

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";

const BENIGN_CHUNKS = ["Page one: opening hours.", "Page two: prices.", "Page three: contact."];

function textOutsideBlocks(request: ModelRequest): {
  readonly id: string;
  readonly outside: string;
} {
  const id = /carries the id ([0-9a-f]+)\./.exec(request.system)?.[1] ?? "";
  expect(id, "the system prompt announces the boundary id").not.toBe("");
  let text = request.messages.map((m) => m.content).join("\n");
  const open = `<untrusted_data id="${id}" source="`;
  const close = `\n</untrusted_data id="${id}">`;
  let outside = "";
  for (;;) {
    const start = text.indexOf(open);
    if (start === -1) break;
    const end = text.indexOf(close, start);
    expect(end, "every block is closed by its own id").toBeGreaterThan(-1);
    outside += text.slice(0, start);
    text = text.slice(end + close.length);
  }
  return { id, outside: outside + text };
}

interface Outcome {
  readonly toolsRun: readonly string[];
  readonly dangerRuns: number;
  readonly policyChecks: number;
  readonly requests: readonly ModelRequest[];
  readonly end: string;
}

async function runAgent(options: {
  taskDescription: string;
  pages: readonly string[];
}): Promise<Outcome> {
  const toolsRun: string[] = [];
  let pageCall = 0;
  const readPage = vi.fn(() => {
    toolsRun.push("read_page");
    const page = options.pages[pageCall] ?? "";
    pageCall += 1;
    return Promise.resolve(page);
  });
  const danger = vi.fn(() => {
    toolsRun.push("danger");
    return Promise.resolve("danger ran");
  });
  const tool = (name: string, execute: AgentTool["execute"]): AgentTool => ({
    name,
    description: `${name} tool`,
    tier: 0,
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute,
  });

  const requests: ModelRequest[] = [];
  let reads = 0;
  const provider: ModelProvider = {
    complete: (request): Promise<ModelResponse> => {
      requests.push(request);
      const usage = { inputTokens: 10, outputTokens: 5 };
      const { id, outside } = textOutsideBlocks(request);
      const systemWithoutRule = request.system.split(id).join("ID");
      if (outside.includes(DIRECTIVE) || systemWithoutRule.includes(DIRECTIVE)) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: `toolu_${String(requests.length)}`, name: "danger", input: {} }],
          usage,
        });
      }
      if (reads < options.pages.length) {
        reads += 1;
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: `toolu_${String(requests.length)}`, name: "read_page", input: { n: reads } },
          ],
          usage,
        });
      }
      return Promise.resolve({ text: "Summary done.", toolCalls: [], usage });
    },
  };

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
  const context: RunContext = {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Summarise", description: options.taskDescription },
  };
  const policyCheck = vi.fn(() =>
    Promise.resolve({ decision: "allow" as const, reasonCode: "test_allow" }),
  );
  const policy: PolicyHook = { check: policyCheck };
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
    tools: createToolRegistry([tool("read_page", readPage), tool("danger", danger)]),
    policy,
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
  const outcome = await loop.execute(ctx);
  return {
    toolsRun,
    dangerRuns: danger.mock.calls.length,
    policyChecks: policyCheck.mock.calls.length,
    requests,
    end: String(outcome.end),
  };
}

describe("AGO-23: injection samples do not change which tools are called", () => {
  it("the stand-in model is really gullible: it sees the directive when it is outside a block", () => {
    // Control: without it, the tests below could pass because the stand-in never obeys anything.
    const request: ModelRequest = {
      system: "carries the id 0f1e2d3c4b5a69788796a5b4c3d2e1f0. other",
      messages: [{ role: "user", content: `loose text ${DIRECTIVE}` }],
      tools: [],
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    };
    expect(textOutsideBlocks(request).outside).toContain(DIRECTIVE);
  });

  it("baseline: benign pages lead to three page reads and a summary", async () => {
    const baseline = await runAgent({ taskDescription: "Read the pages.", pages: BENIGN_CHUNKS });
    expect(baseline.toolsRun).toEqual(["read_page", "read_page", "read_page"]);
    expect(baseline.end).toBe("completed");
  });

  for (const sample of INJECTION_CORPUS) {
    it(`${sample.name}: as tool results, the same tools are called as with benign pages`, async () => {
      const baseline = await runAgent({ taskDescription: "Read the pages.", pages: BENIGN_CHUNKS });
      // One page per chunk, padded with benign pages so the call count is the same.
      const pages = BENIGN_CHUNKS.map((benign, i) => sample.chunks[i] ?? benign);
      const withSample = await runAgent({ taskDescription: "Read the pages.", pages });

      expect(withSample.toolsRun).toEqual(baseline.toolsRun);
      expect(withSample.dangerRuns).toBe(0);
      expect(withSample.policyChecks).toBe(baseline.policyChecks);
      expect(withSample.end).toBe(baseline.end);
      for (const request of withSample.requests) {
        expect(textOutsideBlocks(request).outside).not.toContain(DIRECTIVE);
        expect(request.system).not.toContain(DIRECTIVE);
      }
      // The sample really reached the model, as data: the last prompt holds it inside a block.
      const last = withSample.requests.at(-1)?.messages[0]?.content ?? "";
      expect(last).toContain("<untrusted_data id=");
    });

    it(`${sample.name}: as the task text, the same tools are called as with a benign task`, async () => {
      const baseline = await runAgent({ taskDescription: "Read the pages.", pages: BENIGN_CHUNKS });
      const withSample = await runAgent({
        taskDescription: sample.chunks.join("\n"),
        pages: BENIGN_CHUNKS,
      });
      expect(withSample.toolsRun).toEqual(baseline.toolsRun);
      expect(withSample.dangerRuns).toBe(0);
      expect(withSample.policyChecks).toBe(baseline.policyChecks);
    });
  }

  it("a hostile tool result is labeled as a tool block in every later prompt", async () => {
    const sample = INJECTION_CORPUS[0];
    const outcome = await runAgent({ taskDescription: "Read.", pages: [sample?.chunks[0] ?? ""] });
    const laterPrompts = outcome.requests.slice(1);
    expect(laterPrompts.length).toBeGreaterThan(0);
    for (const request of laterPrompts) {
      expect(request.messages[0]?.content).toMatch(
        /<untrusted_data id="[0-9a-f]{32}" source="tool:read_page_toolu_/,
      );
    }
  });
});
