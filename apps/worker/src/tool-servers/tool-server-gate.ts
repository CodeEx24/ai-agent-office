import { hashSnapshot } from "./canonical-hash.js";
import { fetchSnapshot } from "./client.js";
import { diffSnapshots } from "./snapshot-diff.js";

import type { ToolServerAlertSink, ToolServerScope } from "./alerts.js";
import type { ToolServerConnector } from "./client.js";
import type { ToolServerBlockRecorder, ToolServerLookup } from "./registry.js";
import type { ToolServerDenialReason, ToolServerDiffSummary } from "@ago/shared";

/**
 * The tool server gate (AGO-68). For one workspace and server it answers: may the agent use this server's
 * tools right now? Yes only when the workspace allowlisted the server, a human pinned it, and the live tool
 * list (identity, version, every tool's name, description and schema) still hashes to the pin. Everything
 * else is a typed deny: unknown server, no pin yet, hash mismatch, tool list unavailable, a diff that could
 * not be computed. Nothing is trusted on first use, and a thrown error is a deny.
 *
 * It is an extra gate in front of the tool offer, never a replacement for the policy engine: an allowed
 * server's tool call still goes through the policy check, and tier 3 or 4 still stops for a human.
 */
export type ToolServerVerdict =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly reason: ToolServerDenialReason };

export interface ToolServerGate {
  check(scope: ToolServerScope, serverId: string): Promise<ToolServerVerdict>;
}

interface GateLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ToolServerGateDeps {
  /** Read only plus the block recorder: the gate cannot allowlist, pin or unblock. */
  readonly registry: ToolServerLookup & ToolServerBlockRecorder;
  readonly now?: () => Date;
  readonly connector: ToolServerConnector;
  readonly alerts?: ToolServerAlertSink;
  readonly logger?: GateLogger;
}

export function createToolServerGate(deps: ToolServerGateDeps): ToolServerGate {
  const now = deps.now ?? (() => new Date());

  function deny(
    scope: ToolServerScope,
    serverId: string,
    reason: ToolServerDenialReason,
  ): ToolServerVerdict {
    deps.logger?.warn(
      {
        workspace_id: scope.workspaceId,
        agent_id: scope.agentId,
        run_id: scope.runId,
        server_id: serverId,
        reason,
      },
      "tool server blocked",
    );
    return { ok: false, reason };
  }

  /**
   * One alert per distinct hash: the first caller to win the atomic claim sends it. Losing the claim (or the
   * claim failing) never changes the verdict: the caller is denied either way.
   */
  async function alert(
    scope: ToolServerScope,
    serverId: string,
    pinnedHash: string,
    liveHash: string,
    diff: ToolServerDiffSummary | null,
  ): Promise<void> {
    try {
      const won = await deps.registry.claimAlert(
        scope.workspaceId,
        serverId,
        liveHash,
        now().toISOString(),
      );
      if (!won) return;
      try {
        await deps.alerts?.changed(scope, { serverId, pinnedHash, liveHash, diff });
      } catch {
        // Only the alert failed. Give the claim back so the next check tries again.
        await deps.registry.releaseAlert(scope.workspaceId, serverId, liveHash);
        throw new Error("alert failed");
      }
    } catch {
      deps.logger?.warn(
        { workspace_id: scope.workspaceId, run_id: scope.runId, server_id: serverId },
        "tool server change alert failed",
      );
    }
  }

  return {
    async check(scope, serverId) {
      try {
        const entry = await deps.registry.get(scope.workspaceId, serverId);
        if (entry === null) return deny(scope, serverId, "server_not_allowlisted");
        if (entry.pin === null) return deny(scope, serverId, "pin_missing");

        let live;
        try {
          live = await fetchSnapshot(deps.connector, scope.workspaceId, serverId);
        } catch {
          return deny(scope, serverId, "snapshot_unavailable");
        }

        let liveHash: string;
        try {
          liveHash = hashSnapshot(live);
        } catch {
          return deny(scope, serverId, "diff_error");
        }

        const matchesPin = liveHash === entry.pin.hash && live.serverId === serverId;
        const isBlocked = entry.blocked !== null && entry.blocked !== undefined;
        // Sticky (D11): a block set earlier holds even when the live list matches the pin again.
        if (matchesPin && !isBlocked) return { ok: true, hash: liveHash };
        if (matchesPin) return deny(scope, serverId, "hash_mismatch");

        await deps.registry.markBlocked(scope.workspaceId, serverId, liveHash, now().toISOString());

        let diff: ToolServerDiffSummary | null = null;
        try {
          diff = diffSnapshots(entry.pin.snapshot, live);
        } catch {
          diff = null;
        }
        await alert(scope, serverId, entry.pin.hash, liveHash, diff);
        return deny(scope, serverId, diff === null ? "diff_error" : "hash_mismatch");
      } catch {
        // Anything unexpected (a registry outage included) is a deny.
        return deny(scope, serverId, "snapshot_unavailable");
      }
    },
  };
}
