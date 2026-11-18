import { toolServerSnapshotSchema } from "@ago/shared";

import type { ToolServerSnapshot } from "@ago/shared";

/** One connection to a tool server. The live MCP transport (AGO-88) implements this; tests use local fakes. */
export interface ToolServerClient {
  /** Connect and list tools. The answer is untrusted: it is validated before anything uses it. */
  listSnapshot(signal?: AbortSignal): Promise<unknown>;
}

/** Finds the client for a workspace's server. `null`: nothing to connect to. */
export interface ToolServerConnector {
  connect(workspaceId: string, serverId: string): ToolServerClient | null;
}

/** The server could not be listed, or its answer was not a valid snapshot. Carries no server text. */
export class SnapshotUnavailableError extends Error {
  constructor() {
    super("the tool server's tool list is unavailable");
    this.name = "SnapshotUnavailableError";
  }
}

const SNAPSHOT_TIMEOUT_MS = 10_000;

/** Live snapshot, validated. Any failure (no client, network, timeout, bad shape) is `SnapshotUnavailableError`. */
export async function fetchSnapshot(
  connector: ToolServerConnector,
  workspaceId: string,
  serverId: string,
): Promise<ToolServerSnapshot> {
  try {
    const client = connector.connect(workspaceId, serverId);
    if (client === null) throw new SnapshotUnavailableError();
    const raw = await client.listSnapshot(AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS));
    return toolServerSnapshotSchema.parse(raw);
  } catch {
    throw new SnapshotUnavailableError();
  }
}

/** How a call reaches the server. It gets only the authorization the caller built (see `audience.ts`). */
export interface ToolServerTransport {
  call(request: {
    readonly serverId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly authorization: string;
  }): Promise<string>;
}
