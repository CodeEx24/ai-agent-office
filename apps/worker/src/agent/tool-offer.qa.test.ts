// AGO-25 QA (tester, independent of the implementer's tests): one test per acceptance criterion, driven through
// the real loop with a scripted fake model. No database, no network, no model key.
//   AC1: the tool list sent to the model contains only granted tools.
//   AC2: a request for an unlisted tool is rejected and logged, and never runs.
//   AC3: no regression in the policy engine hook, loop detection and run limits.
import { LOOP_REPEAT_THRESHOLD } from "@ago/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { createAgentLoop, MAX_TOOL_CALLS_PER_STEP, TOOL_NOT_OFFERED } from "./agent-loop.js";
import { createToolOffer, type GrantedCapabilitySource } from "./tool-offer.js";
import { createToolRegistry, getCurrentTimeTool, type AgentTool } from "./tools.js";

import type { RunExecutionContext } from "../queue/run-processor.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { PolicyHook, PolicyToolCall } from "./policy-hook.js";
import type { CapabilityTier } from "@ago/shared";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_AGENT = "00000000-0000-4000-8000-0000000000a2";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
// Built at runtime so no secret-shaped literal sits in the source.
const SECRET = ["sk", "ant", "api03", "QA-SECRET-0123456789abcdef"].join("-");

const usage = { inputTokens: 10, outputTokens: 5 };
const answer = (text: string): ModelResponse => ({ text, toolCalls: [], usage });
const callsOf = (...calls: { name: string; input?: unknown; id?: string }[]): ModelResponse => ({
  text: "",
  toolCalls: calls.map((c, i) => ({
    id: c.id ?? `toolu_${String(i)}`,
    name: c.name,
    input: c.input ?? {},
  })),
  usage,
});

function fakeTool(name: string, tier: CapabilityTier, capabilityKey: string | undefined) {
  const run = vi.fn((_input: unknown) => Promise.resolve("done"));
  const tool: AgentTool = {
    name,
    description: `${name} tool`,
    tier,
    ...(capabilityKey === undefined ? {} : { capabilityKey }),
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
const allTools = [readNote, writeNote, runCode, sendEmail];

const allow = () =>
  vi.fn((_call: PolicyToolCall) =>
    Promise.resolve({ decision: "allow" as const, reasonCode: "test_allow" }),
  );

interface SetupOptions {
  script: (n: number, request: ModelRequest) => ModelResponse;
  /** Grants as the database holds them at each lookup, keyed by who asks. */
  grants: (workspaceId: string, agentId: string) => readonly string[];
  policy?: PolicyHook;
  policyTimeoutMs?: number;
  limits?: { maxSteps?: number };
  workspaceId?: string;
  agentId?: string;
  extraTools?: readonly AgentTool[];
}

function setup(options: SetupOptions) {
  const workspaceId = options.workspaceId ?? WS;
  const agentId = options.agentId ?? AGENT;
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
    workspaceId,
    runId: RUN,
    logger,
    store: {
      insert: (row) => {
        rows.push(row);
        return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
      },
    },
  });
  const check = allow();
  const source: GrantedCapabilitySource = {
    grantedCapabilities: (scope) =>
      Promise.resolve(options.grants(scope.workspaceId, scope.agentId)),
  };
  const loop = createAgentLoop({
    provider,
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () =>
          Promise.resolve({
            runId: RUN,
            workspaceId,
            agent: { id: agentId, workspaceId, name: "Scout", role: "Researches.", prompt: null },
            task: { id: TASK, workspaceId, title: "t", description: "d" },
          }),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry([
      getCurrentTimeTool,
      ...allTools.map((t) => t.tool),
      ...(options.extraTools ?? []),
    ]),
    toolOffer: createToolOffer({ source }),
    policy: options.policy ?? { check },
    ...(options.policyTimeoutMs === undefined ? {} : { policyTimeoutMs: options.policyTimeoutMs }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const ctx: RunExecutionContext = {
    workspaceId,
    runId: RUN,
    agentId,
    taskId: null,
    attempt: 0,
    logger,
    emitter,
    signal: new AbortController().signal,
  };
  return { loop, ctx, rows, requests, check };
}

const names = (request: ModelRequest | undefined) => request?.tools.map((t) => t.name).sort();
const ofType = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type).map((row) => row.payload);
const resetRuns = () => {
  for (const t of allTools) t.run.mockClear();
};

describe("AC1: the tool list sent to the model contains only granted tools", () => {
  it("AC1: every model call lists exactly the granted tools, as grants are added and revoked mid-run", async () => {
    resetRuns();
    let held: readonly string[] = ["vault.read"];
    const { loop, ctx, requests } = setup({
      grants: () => held,
      script: (n) => {
        // After call 1 a grant is added; after call 2 the first one is revoked.
        if (n === 1) held = ["vault.read", "email.send"];
        if (n === 2) held = ["email.send"];
        return n < 4
          ? callsOf({ name: "get_current_time", id: `toolu_${String(n)}` })
          : answer("done");
      },
    });
    await loop.execute(ctx);
    expect(requests.map(names)).toEqual([
      ["get_current_time", "read_note"],
      ["get_current_time", "read_note", "send_email"],
      ["get_current_time", "send_email"],
      ["get_current_time", "send_email"],
    ]);
  });

  it("AC1: a grant held by another workspace or another agent is never offered", async () => {
    const grantsBy = (w: string, a: string): readonly string[] => {
      if (w === WS && a === AGENT) return ["vault.read"];
      if (w === OTHER_WS && a === OTHER_AGENT) return ["email.send", "code.run"];
      if (w === OTHER_WS) return ["vault.write_own"];
      return ["web.search"];
    };
    const mine = setup({ grants: grantsBy, script: () => answer("x") });
    await mine.loop.execute(mine.ctx);
    expect(names(mine.requests[0])).toEqual(["get_current_time", "read_note"]);

    // The same agent id in the wrong workspace gets only what that workspace granted it.
    const wrong = setup({
      grants: grantsBy,
      workspaceId: OTHER_WS,
      agentId: AGENT,
      script: () => answer("x"),
    });
    await wrong.loop.execute(wrong.ctx);
    expect(names(wrong.requests[0])).toEqual(["get_current_time", "write_note"]);
  });

  it("AC1: a keyless tool, or a capability tool without its grant, is not a free pass", async () => {
    const impostor = fakeTool("impostor", 0, undefined);
    const lookalike = fakeTool("lookalike", 0, "vault.read");
    const { loop, ctx, requests } = setup({
      grants: () => [],
      extraTools: [impostor.tool, lookalike.tool],
      script: () => answer("x"),
    });
    await loop.execute(ctx);
    expect(names(requests[0])).toEqual(["get_current_time"]);
  });

  it("AC1: a capability the catalog disabled (the source stops returning it) drops out on the next call", async () => {
    let isCatalogEnabled = true;
    const { loop, ctx, requests } = setup({
      grants: () => (isCatalogEnabled ? ["vault.read"] : []),
      script: (n) => {
        if (n === 1) isCatalogEnabled = false;
        return n < 3
          ? callsOf({ name: "get_current_time", id: `toolu_${String(n)}` })
          : answer("done");
      },
    });
    await loop.execute(ctx);
    expect(names(requests[0])).toContain("read_note");
    expect(names(requests[1])).not.toContain("read_note");
  });
});

describe("AC2: a request for an unlisted tool is rejected, logged and never executed", () => {
  it.each([
    ["unknown", "delete_everything"],
    ["ungranted", "send_email"],
    ["upper-cased", "READ_NOTE"],
    ["title-cased", "Read_Note"],
    ["leading space", " read_note"],
    ["trailing newline", "read_note\n"],
    ["NUL suffix", "read_note\u0000"],
    ["hyphenated rename", "read-note"],
    ["zero-width joiner", "read‍_note"],
    ["Cyrillic lookalike", "rеad_note"],
    ["capability key", "email.send"],
    ["empty name", ""],
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["10k characters", "a".repeat(10_000)],
  ])(
    "AC2: %s name is denied tool_not_offered, with no argument in any event",
    async (_label, name) => {
      resetRuns();
      const { loop, ctx, rows, check } = setup({
        // read_note IS granted: the spelled-differently names must not reach it.
        grants: () => ["vault.read"],
        script: (n) => (n === 1 ? callsOf({ name, input: { token: SECRET } }) : answer("done")),
      });
      const outcome = await loop.execute(ctx);

      expect(outcome.end).toBe("completed");
      for (const t of allTools) expect(t.run).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(ofType(rows, "policy.decision")).toEqual([
        expect.objectContaining({ decision: "deny", reason_code: TOOL_NOT_OFFERED }),
      ]);
      expect(ofType(rows, "tool_call.failed")).toHaveLength(1);
      const types = rows.map((r) => r.type);
      expect(types).not.toContain("tool_call.started");
      expect(types).not.toContain("tool_call.succeeded");
      expect(types).not.toContain("approval.requested");
      expect(JSON.stringify(rows)).not.toContain(SECRET);
      // A bounded name: nothing longer than the event's own cap is stored.
      for (const row of rows) expect(JSON.stringify(row.payload).length).toBeLessThan(2_000);
    },
  );

  it("AC2: a secret smuggled into the tool NAME is not written to the events verbatim", async () => {
    const { loop, ctx, rows } = setup({
      grants: () => [],
      script: (n) => (n === 1 ? callsOf({ name: SECRET }) : answer("done")),
    });
    await loop.execute(ctx);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("AC2: in a mixed step the listed call runs and the unlisted ones are denied", async () => {
    resetRuns();
    const { loop, ctx, rows } = setup({
      grants: () => ["vault.read"],
      script: (n) =>
        n === 1
          ? callsOf(
              { name: "read_note", id: "toolu_ok" },
              { name: "send_email", id: "toolu_bad" },
              { name: "run_code", id: "toolu_bad2" },
            )
          : answer("done"),
    });
    await loop.execute(ctx);
    expect(readNote.run).toHaveBeenCalledTimes(1);
    expect(sendEmail.run).not.toHaveBeenCalled();
    expect(runCode.run).not.toHaveBeenCalled();
    expect(
      ofType(rows, "policy.decision").map((p) => [p.call_id, p.decision, p.reason_code]),
    ).toEqual([
      ["toolu_ok", "allow", "test_allow"],
      ["toolu_bad", "deny", TOOL_NOT_OFFERED],
      ["toolu_bad2", "deny", TOOL_NOT_OFFERED],
    ]);
    expect(rows.map((r) => r.type)).not.toContain("approval.requested");
  });

  it("AC2: the model is told the call was not run, and the rejection does not end the run", async () => {
    const { loop, ctx, requests } = setup({
      grants: () => [],
      script: (n) => (n === 1 ? callsOf({ name: "send_email" }) : answer("recovered")),
    });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("completed");
    expect(requests[1]?.messages.map((m) => m.content).join("\n")).toContain("It was not run");
  });

  it("AC2: an unlisted call is denied at once even when the policy hook would never answer", async () => {
    resetRuns();
    const check = vi.fn(() => new Promise<never>(() => undefined));
    const { loop, ctx, rows } = setup({
      grants: () => [],
      policy: { check },
      policyTimeoutMs: 50,
      script: (n) => (n === 1 ? callsOf({ name: "send_email" }) : answer("done")),
    });
    await loop.execute(ctx);
    expect(check).not.toHaveBeenCalled();
    expect(ofType(rows, "policy.decision")[0]).toMatchObject({ reason_code: TOOL_NOT_OFFERED });
  });

  it("AC2: grants that cannot be read fail the attempt before any model call (fail closed)", async () => {
    const requests: ModelRequest[] = [];
    const { loop, ctx } = setup({
      grants: () => {
        throw new Error("grant store unavailable");
      },
      script: (_n, request) => {
        requests.push(request);
        return answer("x");
      },
    });
    await expect(loop.execute(ctx)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("AC3: filtering only removes; the policy engine, loop detection and run limits still work", () => {
  it("AC3: a listed tier 3 tool still pauses for approval and is not executed, even if the hook says allow", async () => {
    resetRuns();
    const { loop, ctx, rows } = setup({
      grants: () => ["code.run"],
      script: (n) => (n === 1 ? callsOf({ name: "run_code" }) : answer("done")),
    });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("paused");
    expect(runCode.run).not.toHaveBeenCalled();
    expect(ofType(rows, "policy.decision")[0]).toMatchObject({
      decision: "needs_approval",
      reason_code: "tier_requires_approval",
    });
    expect(rows.map((r) => r.type)).toContain("approval.requested");
  });

  it.each([
    [
      "denies",
      () => Promise.resolve({ decision: "deny" as const, reasonCode: "rule_deny" }),
      "rule_deny",
    ],
    ["throws", () => Promise.reject(new Error("boom")), "policy_hook_error"],
    [
      "answers nonsense",
      () => Promise.resolve({ decision: "yes please" }),
      "policy_invalid_response",
    ],
  ])(
    "AC3: a listed tool is not run when the policy hook %s",
    async (_label, answerWith, reason) => {
      resetRuns();
      const { loop, ctx, rows } = setup({
        grants: () => ["vault.read"],
        policy: { check: answerWith as unknown as PolicyHook["check"] },
        script: (n) => (n === 1 ? callsOf({ name: "read_note" }) : answer("done")),
      });
      await loop.execute(ctx);
      expect(readNote.run).not.toHaveBeenCalled();
      expect(ofType(rows, "policy.decision")[0]).toMatchObject({
        decision: "deny",
        reason_code: reason,
      });
    },
  );

  it("AC3: a listed tool whose policy hook never answers is denied after the timeout (timeout means deny)", async () => {
    resetRuns();
    const { loop, ctx, rows } = setup({
      grants: () => ["vault.read"],
      policy: { check: () => new Promise<never>(() => undefined) },
      policyTimeoutMs: 50,
      script: (n) => (n === 1 ? callsOf({ name: "read_note" }) : answer("done")),
    });
    await loop.execute(ctx);
    expect(readNote.run).not.toHaveBeenCalled();
    expect(ofType(rows, "policy.decision")[0]).toMatchObject({
      decision: "deny",
      reason_code: "policy_timeout",
    });
  });

  it("AC3: loop detection still stops a model that keeps asking for the same unlisted tool", async () => {
    const { loop, ctx, rows } = setup({
      grants: () => [],
      script: (n) => callsOf({ name: "send_email", id: `toolu_${String(n)}` }),
    });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("loop_detected");
    expect(outcome.steps).toBe(LOOP_REPEAT_THRESHOLD);
    expect(ofType(rows, "run.loop_detected")).toHaveLength(1);
  });

  it("AC3: the step limit still ends a run whose model keeps asking for different unlisted tools", async () => {
    const { loop, ctx, rows } = setup({
      grants: () => [],
      limits: { maxSteps: 4 },
      // A different name every step, so loop detection does not fire first.
      script: (n) => callsOf({ name: `tool_${String(n)}`, id: `toolu_${String(n)}` }),
    });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("limit_reached");
    expect(ofType(rows, "run.limit_reached")[0]).toMatchObject({ limit: "steps", max: 4 });
  });

  it("AC3: calls past the per-step cap are not run, even when listed", async () => {
    resetRuns();
    const { loop, ctx } = setup({
      grants: () => ["vault.read"],
      script: (n) =>
        n === 1
          ? callsOf(
              ...Array.from({ length: MAX_TOOL_CALLS_PER_STEP + 4 }, (_v, i) => ({
                name: "read_note",
                id: `toolu_${String(i)}`,
                input: { i },
              })),
            )
          : answer("done"),
    });
    await loop.execute(ctx);
    expect(readNote.run.mock.calls.length).toBeLessThanOrEqual(MAX_TOOL_CALLS_PER_STEP);
  });
});
