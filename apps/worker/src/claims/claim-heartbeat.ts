import { CLAIM_TTL_DEFAULT_SECONDS, type ClaimFenceReason, type ClaimRef } from "@ago/shared";

import type { ClaimStore } from "./claim-store.js";

/**
 * Why the holder must stop working on the task. `refused:<reason>` is the database saying the claim is gone
 * (expired, taken over, released). `unreachable` is the worker's own conservative cut-off: it could not renew for
 * a whole ttl, so another agent may already hold the task. Correctness never depends on this timer: the token
 * fence in the database refuses a late write whatever the worker believes.
 */
export type ClaimLostReason = `refused:${ClaimFenceReason}` | "unreachable";

export interface ClaimHeartbeatOptions {
  readonly store: ClaimStore;
  readonly ref: ClaimRef;
  readonly ttlSeconds?: number;
  /** Renew every ttl / 3 unless told otherwise. */
  readonly intervalMs?: number;
  /** Called once when the claim is lost. The caller stops its work. */
  readonly onLost: (reason: ClaimLostReason) => void;
  /** Called on a failed renew that may be transient (the database was unreachable). */
  readonly onError?: (error: unknown) => void;
  /** Clock for the unreachable cut-off (monotonic ms). Defaults to `performance.now`. */
  readonly nowMs?: () => number;
}

export interface ClaimHeartbeat {
  /** Stop renewing (the work finished or the caller released the claim). Safe to call twice. */
  stop(): void;
  readonly isActive: boolean;
}

export function startClaimHeartbeat(options: ClaimHeartbeatOptions): ClaimHeartbeat {
  const ttlSeconds = options.ttlSeconds ?? CLAIM_TTL_DEFAULT_SECONDS;
  const intervalMs = options.intervalMs ?? Math.floor((ttlSeconds * 1000) / 3);
  const nowMs = options.nowMs ?? (() => performance.now());
  const state = { active: true };
  const isLive = (): boolean => state.active;
  let lastRenewedAt = nowMs();
  let inFlight = false;

  const lose = (reason: ClaimLostReason): void => {
    if (!state.active) return;
    state.active = false;
    clearInterval(timer);
    options.onLost(reason);
  };

  const tick = async (): Promise<void> => {
    if (!state.active || inFlight) return;
    inFlight = true;
    try {
      const result = await options.store.renew(options.ref, ttlSeconds);
      if (!isLive()) return;
      if (result.outcome === "renewed") {
        lastRenewedAt = nowMs();
      } else {
        lose(`refused:${result.reason}`);
      }
    } catch (error) {
      options.onError?.(error);
      if (nowMs() - lastRenewedAt >= ttlSeconds * 1000) lose("unreachable");
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  return {
    stop() {
      state.active = false;
      clearInterval(timer);
    },
    get isActive() {
      return state.active;
    },
  };
}
