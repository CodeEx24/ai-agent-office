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
  /** The latest hash an alert was claimed for. */
  readonly alertedHash: string | null;
  /** Every hash an alert was claimed for (bounded); a claim is granted once per hash. */
  readonly alertedHashes: readonly string[];
}

/** Most distinct alerted hashes remembered per server; the oldest is forgotten first. */
export const MAX_ALERTED_HASHES = 50;

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
  /**
   * Claim the right to alert for `observedHash`. Sets the blocked state if it is not set yet and records the
   * hash as alerted in ONE atomic step; returns true only for the first caller per (workspace, server, hash)
   * and false for every other caller, concurrent or later. False also for an unknown server.
   *
   * Contract for every implementation: the check and the write must not be separable. The in-memory store is a
   * synchronous compare-and-set. A Postgres store (follow-up) must do it as one conditional statement, for
   * example `INSERT ... ON CONFLICT DO NOTHING RETURNING` on a unique (workspace_id, server_id, hash) row, and
   * return true only when a row came back. A read followed by a write is not acceptable.
   *
   * Blocking never depends on this result: the gate denies every caller whether or not it won the claim.
   */
  claimAlert(
    workspaceId: string,
    serverId: string,
    observedHash: string,
    at: string,
  ): Promise<boolean>;
  /** Give the claim back after the alert could not be sent, so the next check can try again. */
  releaseAlert(workspaceId: string, serverId: string, observedHash: string): Promise<void>;
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
          blocked: { observedHash, blockedAt: at, alertedHash: null, alertedHashes: [] },
        });
      }
      return Promise.resolve();
    },
    claimAlert(workspaceId, serverId, observedHash, at) {
      // Synchronous from the read to the write: no await in between, so two callers cannot both win.
      const servers = byWorkspace.get(workspaceId);
      const entry = servers?.get(serverId);
      if (servers === undefined || entry === undefined) return Promise.resolve(false);
      const block = entry.blocked ?? {
        observedHash,
        blockedAt: at,
        alertedHash: null,
        alertedHashes: [],
      };
      if (block.alertedHashes.includes(observedHash)) return Promise.resolve(false);
      const alertedHashes = [...block.alertedHashes, observedHash].slice(-MAX_ALERTED_HASHES);
      servers.set(serverId, {
        ...entry,
        blocked: { ...block, alertedHash: observedHash, alertedHashes },
      });
      return Promise.resolve(true);
    },
    releaseAlert(workspaceId, serverId, observedHash) {
      const servers = byWorkspace.get(workspaceId);
      const entry = servers?.get(serverId);
      if (servers === undefined || entry?.blocked === null || entry?.blocked === undefined) {
        return Promise.resolve();
      }
      const alertedHashes = entry.blocked.alertedHashes.filter((h) => h !== observedHash);
      servers.set(serverId, {
        ...entry,
        blocked: {
          ...entry.blocked,
          alertedHash: alertedHashes.at(-1) ?? null,
          alertedHashes,
        },
      });
      return Promise.resolve();
    },
  };
}
