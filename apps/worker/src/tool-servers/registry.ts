import type { ToolServerSnapshot } from "@ago/shared";

/** The reviewed state of a server: the exact snapshot a human looked at and its hash. */
export interface ToolServerPin {
  readonly hash: string;
  readonly snapshot: ToolServerSnapshot;
  readonly pinnedBy: string;
  readonly pinnedAt: string;
}

/**
 * A sticky block (AGO-68 D11): set on the first hash mismatch and kept until a human re-pins. While it is set
 * the server stays blocked even if its live tool list hashes to the pin again.
 */
export interface ToolServerBlock {
  /** The first hash seen that differed from the pin. */
  readonly observedHash: string;
  readonly blockedAt: string;
  /** The last hash an alert was raised for; a new distinct hash raises one more alert. */
  readonly alertedHash: string | null;
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
  /** Null (or absent) when the server is not blocked. Cleared only by a human pin. */
  readonly blocked?: ToolServerBlock | null;
}

/**
 * What the gate may write: it can only tighten (block, note an alert), never allowlist, pin or unblock.
 * Both calls are no-ops for an unknown server.
 */
export interface ToolServerBlockRecorder {
  /** Idempotent: an existing block keeps its first observed hash and time. */
  markBlocked(
    workspaceId: string,
    serverId: string,
    observedHash: string,
    at: string,
  ): Promise<void>;
  /** Record that an alert went out for this hash. */
  markAlerted(workspaceId: string, serverId: string, hash: string): Promise<void>;
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
export interface ToolServerRegistry extends ToolServerLookup, ToolServerBlockRecorder {
  /** Allowlist a server. Replaces any earlier entry and clears its pin: a changed audience needs a new review. */
  allowlist(entry: Omit<ToolServerEntry, "pin">): Promise<void>;
  /** Pin a server and clear any block (the human re-pin). Returns false (and writes nothing) when the workspace has not allowlisted it. */
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
      servers.set(entry.serverId, { ...structuredClone(entry), pin: null, blocked: null });
      byWorkspace.set(entry.workspaceId, servers);
      return Promise.resolve();
    },
    pin(workspaceId, serverId, pin) {
      const servers = byWorkspace.get(workspaceId);
      const entry = servers?.get(serverId);
      if (servers === undefined || entry === undefined) return Promise.resolve(false);
      servers.set(serverId, { ...entry, pin: structuredClone(pin), blocked: null });
      return Promise.resolve(true);
    },
    markBlocked(workspaceId, serverId, observedHash, at) {
      const servers = byWorkspace.get(workspaceId);
      const entry = servers?.get(serverId);
      if (servers === undefined || entry === undefined) return Promise.resolve();
      if (entry.blocked === null || entry.blocked === undefined) {
        servers.set(serverId, {
          ...entry,
          blocked: { observedHash, blockedAt: at, alertedHash: null },
        });
      }
      return Promise.resolve();
    },
    markAlerted(workspaceId, serverId, hash) {
      const servers = byWorkspace.get(workspaceId);
      const entry = servers?.get(serverId);
      if (servers === undefined || entry?.blocked === null || entry?.blocked === undefined) {
        return Promise.resolve();
      }
      servers.set(serverId, { ...entry, blocked: { ...entry.blocked, alertedHash: hash } });
      return Promise.resolve();
    },
  };
}
