import { APPROVAL_STATUS } from "@ago/shared";

import {
  ApprovalConflictError,
  type ApprovalStore,
  type ExpiredApproval,
  type NewApproval,
  type StoredApproval,
} from "./approval-store.js";

interface MemoryApproval extends StoredApproval {
  readonly agentId: string;
  readonly action: string;
}

export interface MemoryApprovalStore extends ApprovalStore {
  /** Every approval, in creation order. */
  all(): readonly MemoryApproval[];
  peek(approvalId: string): MemoryApproval | undefined;
  /** Stand in for a human (or anything else) writing a status. */
  setStatus(approvalId: string, status: string): void;
}

/** An in-memory `ApprovalStore` for tests. It enforces the same scoping and conditions as the SQL. */
export function createMemoryApprovalStore(): MemoryApprovalStore {
  const rows = new Map<string, MemoryApproval>();
  const move = (row: MemoryApproval, now: Date): ExpiredApproval | null => {
    if (
      row.status !== APPROVAL_STATUS.pending ||
      row.consumedAt !== null ||
      row.expiresAt.getTime() > now.getTime()
    ) {
      return null;
    }
    rows.set(row.approvalId, { ...row, status: APPROVAL_STATUS.rejected });
    return {
      approvalId: row.approvalId,
      workspaceId: row.workspaceId,
      runId: row.runId,
      payloadHash: row.payloadHash,
    };
  };
  return {
    all: () => [...rows.values()],
    peek: (approvalId) => rows.get(approvalId),
    setStatus(approvalId, status) {
      const row = rows.get(approvalId);
      if (row !== undefined) rows.set(approvalId, { ...row, status });
    },
    create(input: NewApproval) {
      const existing = rows.get(input.approvalId);
      if (existing === undefined) {
        rows.set(input.approvalId, {
          approvalId: input.approvalId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          agentId: input.agentId,
          action: input.action,
          status: APPROVAL_STATUS.pending,
          payloadHash: input.payloadHash,
          expiresAt: input.expiresAt,
          consumedAt: null,
        });
      }
      const stored = rows.get(input.approvalId);
      if (
        stored?.workspaceId !== input.workspaceId ||
        stored.runId !== input.runId ||
        stored.payloadHash !== input.payloadHash
      ) {
        return Promise.reject(new ApprovalConflictError());
      }
      return Promise.resolve(stored);
    },
    get(ref) {
      const row = rows.get(ref.approvalId);
      return Promise.resolve(row?.workspaceId === ref.workspaceId ? row : null);
    },
    expire(ref, now) {
      const row = rows.get(ref.approvalId);
      return Promise.resolve(row?.workspaceId !== ref.workspaceId ? null : move(row, now));
    },
    consume(ref, payloadHash, now) {
      const row = rows.get(ref.approvalId);
      // The same conditions as the SQL, evaluated and applied in one synchronous step (no await in between).
      if (
        row?.workspaceId !== ref.workspaceId ||
        row.runId !== ref.runId ||
        row.status !== APPROVAL_STATUS.approved ||
        row.consumedAt !== null ||
        row.expiresAt.getTime() <= now.getTime() ||
        row.payloadHash !== payloadHash
      ) {
        return Promise.resolve(null);
      }
      const consumed = { ...row, consumedAt: now };
      rows.set(row.approvalId, consumed);
      return Promise.resolve(consumed);
    },
    rejectPendingForRun(ref) {
      const moved: ExpiredApproval[] = [];
      for (const row of [...rows.values()]) {
        if (
          row.workspaceId !== ref.workspaceId ||
          row.runId !== ref.runId ||
          row.status !== APPROVAL_STATUS.pending ||
          row.consumedAt !== null
        ) {
          continue;
        }
        rows.set(row.approvalId, { ...row, status: APPROVAL_STATUS.rejected });
        moved.push({
          approvalId: row.approvalId,
          workspaceId: row.workspaceId,
          runId: row.runId,
          payloadHash: row.payloadHash,
        });
      }
      return Promise.resolve(moved);
    },
    expireDue(now, limit) {
      const moved: ExpiredApproval[] = [];
      for (const row of [...rows.values()].sort(
        (a, b) => a.expiresAt.getTime() - b.expiresAt.getTime(),
      )) {
        if (moved.length >= limit) break;
        const result = move(row, now);
        if (result !== null) moved.push(result);
      }
      return Promise.resolve(moved);
    },
  };
}
