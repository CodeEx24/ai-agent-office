import { describe, expect, it, vi } from "vitest";

import { createPgAgentRunLimitsSource } from "./pg-run-limits-source.js";
import { createRunLimitsResolver } from "./run-limits.js";

const DEFAULTS = { maxSteps: 20, maxTokens: 200_000, maxWallMs: 300_000 };
const scope = { workspaceId: "w1", agentId: "a1" };

describe("createPgAgentRunLimitsSource", () => {
  it("scopes the query by workspace and agent together", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ run_limits: { maxSteps: 5 } }] });
    const value = await createPgAgentRunLimitsSource({ query }).get(scope);
    expect(value).toEqual({ maxSteps: 5 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("workspace_id = $1 and id = $2");
    expect(params).toEqual(["w1", "a1"]);
  });

  it("answers null for a missing agent or a null column", async () => {
    const none = createPgAgentRunLimitsSource({ query: () => Promise.resolve({ rows: [] }) });
    const empty = createPgAgentRunLimitsSource({
      query: () => Promise.resolve({ rows: [{ run_limits: null }] }),
    });
    expect(await none.get(scope)).toBeNull();
    expect(await empty.get(scope)).toBeNull();
  });

  it("feeds the resolver: the stored value overrides defaults and is clamped", async () => {
    const source = createPgAgentRunLimitsSource({
      query: () =>
        Promise.resolve({ rows: [{ run_limits: { maxSteps: 5, maxTokens: 999_999_999 } }] }),
    });
    const limits = await createRunLimitsResolver({ defaults: DEFAULTS, source }).resolve(scope);
    expect(limits).toEqual({ maxSteps: 5, maxTokens: 5_000_000, maxWallMs: 300_000 });
  });

  it("falls back to defaults when the query fails", async () => {
    const onSourceError = vi.fn();
    const source = createPgAgentRunLimitsSource({
      query: () => Promise.reject(new Error("db down")),
    });
    const limits = await createRunLimitsResolver({
      defaults: DEFAULTS,
      source,
      onSourceError,
    }).resolve(scope);
    expect(limits).toEqual(DEFAULTS);
    expect(onSourceError).toHaveBeenCalledOnce();
  });
});
