import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createPgGrantedCapabilitySource,
  createToolOffer,
  type GrantedCapabilitySource,
  type ToolOfferScope,
} from "./tool-offer.js";
import { getCurrentTimeTool, type AgentTool } from "./tools.js";

import type { CapabilityTier } from "@ago/shared";

const SCOPE: ToolOfferScope = { workspaceId: "w1", agentId: "a1", runId: "r1" };

function tool(name: string, tier: CapabilityTier, capabilityKey?: string): AgentTool {
  return {
    name,
    description: name,
    tier,
    ...(capabilityKey === undefined ? {} : { capabilityKey }),
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: () => Promise.resolve("ok"),
  };
}

const sourceOf = (keys: readonly string[]): GrantedCapabilitySource => ({
  grantedCapabilities: () => Promise.resolve(keys),
});

describe("createToolOffer (AGO-25)", () => {
  const tools = [
    getCurrentTimeTool,
    tool("read_note", 0, "vault.read"),
    tool("write_note", 2, "vault.write_own"),
    tool("run_code", 3, "code.run"),
    tool("keyless", 1),
  ];

  it("offers granted tools and the built-in, and nothing else", async () => {
    const offer = createToolOffer({ source: sourceOf(["vault.read", "code.run"]) });
    const names = await offer.offeredToolNames(tools, SCOPE);
    expect([...names].sort()).toEqual(["get_current_time", "read_note", "run_code"]);
  });

  it("offers only the built-in when nothing is granted", async () => {
    const offer = createToolOffer({ source: sourceOf([]) });
    expect([...(await offer.offeredToolNames(tools, SCOPE))]).toEqual(["get_current_time"]);
  });

  it("offers a tier 3 tool when it is granted (it still escalates at call time)", async () => {
    const offer = createToolOffer({ source: sourceOf(["code.run"]) });
    expect((await offer.offeredToolNames(tools, SCOPE)).has("run_code")).toBe(true);
  });

  it("withholds a keyless tool unless it is a tier 0 built-in", async () => {
    const offer = createToolOffer({ source: sourceOf(["vault.read"]), builtinTools: ["keyless"] });
    // `keyless` is named a built-in but is tier 1, so it is still withheld.
    expect((await offer.offeredToolNames(tools, SCOPE)).has("keyless")).toBe(false);
  });

  it("a built-in's name is no free pass for a tool that claims a capability", async () => {
    const claims = tool("get_current_time", 0, "vault.read");
    const names = await createToolOffer({ source: sourceOf([]) }).offeredToolNames([claims], SCOPE);
    expect(names.size).toBe(0);
  });

  it("matches on the capability key, not on the tool name", async () => {
    const offer = createToolOffer({ source: sourceOf(["vault.read"]) });
    const names = await offer.offeredToolNames([tool("vault.read", 1, "vault.write_own")], SCOPE);
    expect(names.size).toBe(0);
  });

  it("passes the scope to the source and fails when the source fails", async () => {
    const grantedCapabilities = vi.fn((_scope: ToolOfferScope) =>
      Promise.reject<readonly string[]>(new Error("db down")),
    );
    const offer = createToolOffer({ source: { grantedCapabilities } });
    await expect(offer.offeredToolNames(tools, SCOPE)).rejects.toThrow("db down");
    expect(grantedCapabilities).toHaveBeenCalledWith(SCOPE);
  });

  it("the Postgres source asks the credential store for this workspace and agent only", async () => {
    const grantedCapabilities = vi.fn((_ref: { workspaceId: string; agentId: string }) =>
      Promise.resolve(["vault.read"]),
    );
    const source = createPgGrantedCapabilitySource({ grantedCapabilities });
    expect(await source.grantedCapabilities(SCOPE)).toEqual(["vault.read"]);
    expect(grantedCapabilities).toHaveBeenCalledWith({ workspaceId: "w1", agentId: "a1" });
  });
});
