import { verifyToolServerToken } from "./audience.js";

import type { ToolServerClient, ToolServerConnector, ToolServerTransport } from "./client.js";
import type { ToolDescriptor, ToolServerSnapshot } from "@ago/shared";

/**
 * Test only: a local, in-process tool server that can change its tool list mid-test. No network. It plays the
 * server's side of the audience rule too: `call` verifies the token it receives against its own audience.
 */
export interface FakeToolServer extends ToolServerClient, ToolServerTransport {
  snapshot: ToolServerSnapshot;
  failListing: boolean;
  /** Every authorization header it was called with. */
  readonly received: string[];
  setDescription(toolName: string, description: string): void;
  addTool(tool: ToolDescriptor): void;
  removeTool(toolName: string): void;
}

export const SERVER_ID = "crm";
export const AUDIENCE = "https://crm.tools.invalid";
export const SIGNING_KEY = "k".repeat(40);

export function tool(name: string, description = `${name} tool`): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  };
}

export function createFakeToolServer(
  serverId = SERVER_ID,
  tools: readonly ToolDescriptor[] = [tool("lookup"), tool("list")],
): FakeToolServer {
  const received: string[] = [];
  const server: FakeToolServer = {
    snapshot: { serverId, version: "1.0.0", tools: structuredClone([...tools]) },
    failListing: false,
    received,
    listSnapshot() {
      if (server.failListing) return Promise.reject(new Error("connection refused"));
      return Promise.resolve(structuredClone(server.snapshot));
    },
    call(request) {
      received.push(request.authorization);
      const token = request.authorization.replace(/^Bearer\s+/i, "");
      const verdict = verifyToolServerToken(token, SIGNING_KEY, {
        audience: AUDIENCE,
        now: new Date(),
      });
      if (!verdict.ok) return Promise.reject(new Error(`server rejected token: ${verdict.reason}`));
      return Promise.resolve(`ok:${request.toolName}`);
    },
    setDescription(toolName, description) {
      const found = server.snapshot.tools.find((t) => t.name === toolName);
      if (found === undefined) throw new Error("no such tool");
      found.description = description;
    },
    addTool(next) {
      server.snapshot.tools.push(structuredClone(next));
    },
    removeTool(toolName) {
      server.snapshot = {
        ...server.snapshot,
        tools: server.snapshot.tools.filter((t) => t.name !== toolName),
      };
    },
  };
  return server;
}

/** A connector with one fake server per workspace id and server id. */
export function connectorFor(
  servers: Record<string, Record<string, ToolServerClient>>,
): ToolServerConnector {
  return { connect: (workspaceId, serverId) => servers[workspaceId]?.[serverId] ?? null };
}
