import type { ToolServerSnapshot } from "@ago/shared";

/** The reviewed state of a server: the exact snapshot a human looked at and its hash. */
export interface ToolServerPin {
  readonly hash: string;
  readonly snapshot: ToolServerSnapshot;
  readonly pinnedBy: string;
  readonly pinnedAt: string;
}

/** One allowlisted server of one workspace. `pin` is null until a human reviews it for the first time. */
export interface ToolServerEntry {
  readonly workspaceId: string;
  readonly serverId: string;
  /** The audience every credential for this server is bound to (the server's own identifier). */
  readonly audience: string;
  /** `secret:<name>` of the key the broker uses to mint audience-bound tokens for this server. */
  readonly audienceSecretRef: string;
  readonly allowlistedBy: string;
  readonly allowlistedAt: string;
  readonly pin: ToolServerPin | null;
}

/**
 * What the agent path can see: read only. There is no method here that allowlists or pins, so code handed
 * this view cannot change a rule (agents never change their own rules).
 */
export interface ToolServerLookup {
  /** Always scoped by workspace: another workspace's entry is never visible. `null` means unlisted. */
  get(workspaceId: string, serverId: string): Promise<ToolServerEntry | null>;
}

/** Writes. Only the human review path (`review.ts`) is given this. Every method takes the workspace id first. */
export interface ToolServerRegistry extends ToolServerLookup {
  /** Allowlist a server. Replaces any earlier entry and clears its pin: a changed audience needs a new review. */
  allowlist(entry: Omit<ToolServerEntry, "pin">): Promise<void>;
  /** Pin a server. Returns false (and writes nothing) when the workspace has not allowlisted it. */
  pin(workspaceId: string, serverId: string, pin: ToolServerPin): Promise<boolean>;
}

/**
 * In-memory registry (AGO-68). It starts empty and is empty again after a restart, which fails closed: every
 * server is unlisted and blocked until a human allowlists and pins it again. The Postgres implementation (a
 * table with RLS, owner-only writes) is a follow-up that needs the schema slot and plugs in behind the same port.
 */
export function createInMemoryToolServerRegistry(): ToolServerRegistry {
  // workspace id -> server id -> entry. Two levels so no key is built by joining two caller-chosen strings.
  const byWorkspace = new Map<string, Map<string, ToolServerEntry>>();
  return {
    get(workspaceId, serverId) {
      const entry = byWorkspace.get(workspaceId)?.get(serverId);
      return Promise.resolve(entry === undefined ? null : structuredClone(entry));
    },
    allowlist(entry) {
      const servers = byWorkspace.get(entry.workspaceId) ?? new Map<string, ToolServerEntry>();
      servers.set(entry.serverId, { ...structuredClone(entry), pin: null });
      byWorkspace.set(entry.workspaceId, servers);
      return Promise.resolve();
    },
    pin(workspaceId, serverId, pin) {
      const servers = byWorkspace.get(workspaceId);
      const entry = servers?.get(serverId);
      if (servers === undefined || entry === undefined) return Promise.resolve(false);
      servers.set(serverId, { ...entry, pin: structuredClone(pin) });
      return Promise.resolve(true);
    },
  };
}
