import type { HandoffRecord, HandoffStore } from "./handoff-store.js";
import type { HandoffChain, HandoffParty } from "@ago/shared/handoff";

/**
 * In-memory `HandoffStore` for tests (AGO-81). The Postgres store arrives with the schema slot. It keeps the same
 * contracts: insert fails on a duplicate task id, `markAccepted` returns false the second time, and every lookup is
 * scoped by workspace.
 */
export interface InMemoryHandoffStore extends HandoffStore {
  readonly records: HandoffRecord[];
  setParty(party: HandoffParty): void;
  /** Declare the chain a run acts in (what the database derives from the run's task). */
  setChainForRun(runId: string, chain: HandoffChain): void;
}

export function createInMemoryHandoffStore(): InMemoryHandoffStore {
  const parties = new Map<string, HandoffParty>();
  const chains = new Map<string, HandoffChain>();
  const records: HandoffRecord[] = [];
  const runToTask = new Map<string, string>();
  const key = (workspaceId: string, id: string): string => `${workspaceId}:${id}`;

  return {
    records,
    setParty(party) {
      parties.set(key(party.workspaceId, party.agentId), party);
    },
    setChainForRun(runId, chain) {
      chains.set(key(chain.workspaceId, runId), chain);
    },
    loadParty: (workspaceId, agentId) =>
      Promise.resolve(parties.get(key(workspaceId, agentId)) ?? null),
    loadChainForRun: (workspaceId, runId) => {
      const accepted = records.find(
        (record) => runToTask.get(key(workspaceId, runId)) === record.taskId,
      );
      if (accepted !== undefined) {
        return Promise.resolve({
          workspaceId,
          requesterMemberId: accepted.requesterMemberId,
          path: accepted.path,
        });
      }
      return Promise.resolve(chains.get(key(workspaceId, runId)) ?? null);
    },
    insert(record) {
      if (records.some((existing) => existing.taskId === record.taskId)) {
        return Promise.reject(new Error("duplicate task id"));
      }
      records.push(record);
      return Promise.resolve();
    },
    findByRun(workspaceId, runId) {
      const taskId = runToTask.get(key(workspaceId, runId));
      return Promise.resolve(
        records.find((r) => r.workspaceId === workspaceId && r.taskId === taskId) ?? null,
      );
    },
    findByTask: (workspaceId, taskId) =>
      Promise.resolve(
        records.find((r) => r.workspaceId === workspaceId && r.taskId === taskId) ?? null,
      ),
    markAccepted(workspaceId, taskId, runId) {
      const index = records.findIndex((r) => r.workspaceId === workspaceId && r.taskId === taskId);
      const record = records[index];
      if (record === undefined) return Promise.resolve(false);
      if (record.acceptedByRunId !== null) return Promise.resolve(false);
      records[index] = { ...record, acceptedByRunId: runId };
      runToTask.set(key(workspaceId, runId), taskId);
      return Promise.resolve(true);
    },
  };
}
