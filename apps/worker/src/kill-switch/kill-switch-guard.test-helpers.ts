import type { KillSwitchScope } from "@ago/shared";

import type { KillSwitchGuard } from "./kill-switch-guard.js";

/** An in-memory latch for tests: what `private.kill_switches` would hold, and the same scope rule as the SQL. */
export interface MemoryKillSwitch extends KillSwitchGuard {
  activate(workspaceId: string, scope: KillSwitchScope, agentId?: string): void;
  release(workspaceId: string): void;
  /** Make every read fail (the guard must then fail closed). */
  failReads(): void;
  /** How many times the latch was read. */
  readCount(): number;
}

export function createMemoryKillSwitch(): MemoryKillSwitch {
  const live: { workspaceId: string; scope: KillSwitchScope; agentId: string | null }[] = [];
  let isFailing = false;
  let reads = 0;
  return {
    activate(workspaceId, scope, agentId) {
      live.push({ workspaceId, scope, agentId: agentId ?? null });
    },
    release(workspaceId) {
      for (let i = live.length - 1; i >= 0; i -= 1) {
        if (live[i]?.workspaceId === workspaceId) live.splice(i, 1);
      }
    },
    failReads() {
      isFailing = true;
    },
    readCount: () => reads,
    isKilled({ workspaceId, agentId }) {
      reads += 1;
      if (isFailing) return Promise.reject(new Error("kill switch unreadable"));
      return Promise.resolve(
        live.some(
          (k) =>
            k.workspaceId === workspaceId && (k.scope === "workspace" || k.agentId === agentId),
        ),
      );
    },
  };
}
