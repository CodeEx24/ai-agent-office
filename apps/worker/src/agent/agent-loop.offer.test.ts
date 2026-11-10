// AGO-25: the model is shown only granted tools, and a request for any other tool is rejected and logged.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { createAgentLoop, TOOL_NOT_OFFERED } from "./agent-loop.js";
import {
  createToolOffer,
  type GrantedCapabilitySource,
  type ToolOfferScope,
} from "./tool-offer.js";
import { createToolRegistry, getCurrentTimeTool, type AgentTool } from "./tools.js";

import type { RunExecutionContext } from "../queue/run-processor.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { PolicyHook, PolicyToolCall } from "./policy-hook.js";
import type { CapabilityTier } from "@ago/shared";

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const SECRET_ARG = ["sk", "ant", "api03", "SECRET-ARGUMENT-0123456789"].join("-");

const usage = { inputTokens: 10, outputTokens: 5 };
const answer = (text: string): ModelResponse => ({ text, toolCalls: [], usage });
const callOf = (name: string, input: unknown = {}, id = "toolu_1"): ModelResponse => ({
  text: "",
  toolCalls: [{ id, name, input }],
  usage,
});

function fakeTool(name: string, tier: CapabilityTier, capabilityKey: string) {
  const run = vi.fn((_input: unknown) => Promise.resolve("done"));
  const tool: AgentTool = {
    name,
    description: `${name} tool`,
    tier,
    capabilityKey,
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: run,
  };
  return { tool, run };
}

const readNote = fakeTool("read_note", 0, "vault.read");
const writeNote = fakeTool("write_note", 2, "vault.write_own");
const runCode = fakeTool("run_code", 3, "code.run");
const sendEmail = fakeTool("send_email", 1, "email.send");

const allowCheck = () =>
  vi.fn((_call: PolicyToolCall) =>
    Promise.resolve({ decision: "allow" as const, reasonCode: "test_allow" }),
  );

function setup(options: {
  script: (n: number, request: ModelRequest) => ModelResponse;
  /** The grants the database holds at the moment of each lookup. */
  grants: () => readonly string[];
  policy?: PolicyHook;
  onGrantLookup?: (scope: ToolOfferScope) => void;
  source?: GrantedCapabilitySource;
}) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve(options.script(requests.length, request));
    },
  };
  const rows: RunEventRow[] = [];
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
  const check = allowCheck();
  const policy = options.policy ?? { check };
  const source: GrantedCapabilitySource = options.source ?? {
    grantedCapabilities: (scope) => {
      options.onGrantLookup?.(scope);
      return Promise.resolve(options.grants());
    },
  };
  const loop = createAgentLoop({
    provider,
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () =>
          Promise.resolve({
            runId: RUN,
            workspaceId: WS,
            agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
            task: { id: TASK, workspaceId: WS, title: "t", description: "d" },
          }),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry([
      getCurrentTimeTool,
      readNote.tool,
      writeNote.tool,
      runCode.tool,
      sendEmail.tool,
    ]),
    toolOffer: createToolOffer({ source }),
    policy,
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
  return { loop, ctx, rows, requests, check };
}

const names = (request: ModelRequest | undefined) => request?.tools.map((t) => t.name).sort();
const payloads = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type).map((row) => row.payload);

describe("tool list sent to the model (AC1)", () => {
  it("contains exactly the granted tools plus the built-in, on every model call", async () => {
    const { loop, ctx, requests } = setup({
      grants: () => ["vault.read", "vault.write_own"],
      script: (n) => (n < 3 ? callOf("read_note", {}, `toolu_${String(n)}`) : answer("done")),
    });
    await loop.execute(ctx);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(names(request)).toEqual(["get_current_time", "read_note", "write_note"]);
    }
  });

  it("offers a tier 3 tool only when it is granted", async () => {
    const withGrant = setup({ grants: () => ["code.run"], script: () => answer("x") });
    await withGrant.loop.execute(withGrant.ctx);
    expect(names(withGrant.requests[0])).toEqual(["get_current_time", "run_code"]);

    const without = setup({ grants: () => ["vault.read"], script: () => answer("x") });
    await without.loop.execute(without.ctx);
    expect(names(without.requests[0])).not.toContain("run_code");
  });

  it("offers only the built-in when the agent holds no grants", async () => {
    const { loop, ctx, requests } = setup({ grants: () => [], script: () => answer("x") });
    await loop.execute(ctx);
    expect(names(requests[0])).toEqual(["get_current_time"]);
  });

  it("drops a tool from the next model call when its grant is revoked mid-run", async () => {
    readNote.run.mockClear();
    let isRevoked = false;
    readNote.run.mockImplementationOnce(() => {
      isRevoked = true;
      return Promise.resolve("first ok");
    });
    const { loop, ctx, requests, rows } = setup({
      grants: () => (isRevoked ? ["vault.write_own"] : ["vault.read", "vault.write_own"]),
      script: (n) => (n <= 2 ? callOf("read_note", {}, `toolu_${String(n)}`) : answer("done")),
    });
    await loop.execute(ctx);
    expect(names(requests[0])).toEqual(["get_current_time", "read_note", "write_note"]);
    expect(names(requests[1])).toEqual(["get_current_time", "write_note"]);
    // The model still asked for it in step 2: rejected, logged, and not run a second time.
    expect(readNote.run).toHaveBeenCalledTimes(1);
    expect(payloads(rows, "policy.decision").at(-1)).toMatchObject({
      decision: "deny",
      reason_code: TOOL_NOT_OFFERED,
    });
  });

  it("looks the grants up for this run's workspace and agent before every model call", async () => {
    const lookups: ToolOfferScope[] = [];
    const { loop, ctx } = setup({
      grants: () => ["vault.read"],
      onGrantLookup: (scope) => lookups.push(scope),
      script: (n) => (n === 1 ? callOf("read_note") : answer("done")),
    });
    await loop.execute(ctx);
    expect(lookups).toEqual([
      { workspaceId: WS, agentId: AGENT, runId: RUN },
      { workspaceId: WS, agentId: AGENT, runId: RUN },
    ]);
  });

  it("fails the attempt, with no model call, when the grants cannot be read", async () => {
    const { loop, ctx, requests } = setup({
      grants: () => [],
      source: { grantedCapabilities: () => Promise.reject(new Error("db down")) },
      script: () => answer("x"),
    });
    await expect(loop.execute(ctx)).rejects.toThrow("db down");
    expect(requests).toHaveLength(0);
  });
});

describe("a request for an unlisted tool (AC2)", () => {
  it.each([
    ["an ungranted tool", "send_email"],
    ["an unknown tool", "delete_everything"],
    ["a renamed tool (case)", "Read_Note"],
    ["a renamed tool (padding)", "read_note "],
    ["a capability key used as a tool name", "vault.read"],
    ["a prototype name", "constructor"],
  ])("rejects %s, logs it, and never runs it", async (_label, name) => {
    for (const t of [sendEmail, readNote]) t.run.mockClear();
    const { loop, ctx, rows, check } = setup({
      grants: () => ["vault.read"],
      script: (n) => (n === 1 ? callOf(name, { token: SECRET_ARG }) : answer("done")),
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    expect(sendEmail.run).not.toHaveBeenCalled();
    expect(readNote.run).not.toHaveBeenCalled();
    // The policy hook is not even asked about a tool the model was never shown.
    expect(check).not.toHaveBeenCalled();
    expect(payloads(rows, "policy.decision")).toEqual([
      expect.objectContaining({ decision: "deny", reason_code: TOOL_NOT_OFFERED }),
    ]);
    expect(payloads(rows, "tool_call.failed")).toEqual([
      expect.objectContaining({ error_code: "policy_denied" }),
    ]);
    const emitted = rows.map((row) => row.type);
    expect(emitted).not.toContain("tool_call.started");
    expect(emitted).not.toContain("approval.requested");
    // No arguments or secrets in any event.
    expect(JSON.stringify(rows)).not.toContain(SECRET_ARG);
  });

  it("denies an unlisted tier 3 tool without raising an approval request", async () => {
    runCode.run.mockClear();
    const { loop, ctx, rows } = setup({
      grants: () => ["vault.read"],
      script: (n) => (n === 1 ? callOf("run_code") : answer("done")),
    });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("completed");
    expect(runCode.run).not.toHaveBeenCalled();
    expect(rows.map((row) => row.type)).not.toContain("approval.requested");
  });

  it("tells the model the call was not run, so it can carry on", async () => {
    const { loop, ctx, requests } = setup({
      grants: () => ["vault.read"],
      script: (n) => (n === 1 ? callOf("send_email") : answer("done")),
    });
    await loop.execute(ctx);
    expect(requests[1]?.messages.map((m) => m.content).join("\n")).toContain("It was not run");
  });
});

describe("filtering is an extra layer, not a replacement (the policy engine still runs)", () => {
  it("still asks the policy hook about a listed tool, and honours its deny", async () => {
    readNote.run.mockClear();
    const check = vi.fn(() =>
      Promise.resolve({ decision: "deny" as const, reasonCode: "deny_rule" }),
    );
    const { loop, ctx, rows } = setup({
      grants: () => ["vault.read"],
      policy: { check },
      script: (n) => (n === 1 ? callOf("read_note") : answer("done")),
    });
    await loop.execute(ctx);
    expect(check).toHaveBeenCalledTimes(1);
    expect(readNote.run).not.toHaveBeenCalled();
    expect(payloads(rows, "policy.decision")[0]).toMatchObject({
      decision: "deny",
      reason_code: "deny_rule",
    });
  });

  it("a listed tier 3 tool still stops for a human, even when the hook says allow", async () => {
    runCode.run.mockClear();
    const { loop, ctx, rows } = setup({
      grants: () => ["code.run"],
      script: (n) => (n === 1 ? callOf("run_code") : answer("done")),
    });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("paused");
    expect(runCode.run).not.toHaveBeenCalled();
    expect(rows.map((row) => row.type)).toContain("approval.requested");
  });

  it("a listed tool runs when the hook allows it", async () => {
    readNote.run.mockClear();
    const { loop, ctx } = setup({
      grants: () => ["vault.read"],
      script: (n) => (n === 1 ? callOf("read_note") : answer("done")),
    });
    await loop.execute(ctx);
    expect(readNote.run).toHaveBeenCalledTimes(1);
  });
});
