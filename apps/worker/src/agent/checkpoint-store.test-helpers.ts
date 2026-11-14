import { parseRunCheckpointState, type RunCheckpointState } from "@ago/shared";

import {
  CheckpointUnreadableError,
  type CheckpointRef,
  type ControlRequest,
  type CheckpointStore,
} from "./checkpoint-store.js";

/** What a test can see of one stored row. `raw` is what was saved, as JSON (so a test can corrupt it). */
interface MemoryRow {
  raw: unknown;
  pauseRequested: boolean;
  stopRequested: boolean;
  resumeRequested: boolean;
  requestedBy: string | null;
}

export interface MemoryCheckpointStore extends CheckpointStore {
  /** Every save in order, as a deep copy: a test asserts on what a crash at that point would have left. */
  readonly saves: readonly RunCheckpointState[];
  /** Replace what is stored for a run with anything, to test a damaged state. */
  setRaw(ref: CheckpointRef, raw: unknown): void;
  /** The stored state (parsed), or null. */
  peek(ref: CheckpointRef): RunCheckpointState | null;
  /** Make the next `save` calls fail. */
  failSaves(): void;
  /**
   * The pause flag read synchronously, so a fake run store can do "move only if not pause-requested" in one
   * step like the real conditional update (`RunStore.wakeRunAfterExpiry`, AGO-58).
   */
  isPauseRequestedNow(ref: CheckpointRef): boolean;
  /** AGO-86: what a person's request to the control route would have recorded. */
  flagStop(ref: CheckpointRef, requestedBy?: string | null): void;
  flagResume(ref: CheckpointRef, requestedBy?: string | null): void;
  flagPause(ref: CheckpointRef): void;
  isStopRequestedNow(ref: CheckpointRef): boolean;
  isResumeRequestedNow(ref: CheckpointRef): boolean;
  /** One entry (the run id) per `readControl` call, in order: a test counts the checks before each tool call. */
  controlReads(): readonly string[];
  failControlReads(): void;
  /** Runs (and awaits) before `readControl` answers: a test records a request landing in that window. */
  onControlRead(hook: (() => Promise<void>) | null): void;
}

const keyOf = ({ workspaceId, runId }: CheckpointRef): string => `${workspaceId}:${runId}`;

/** An in-memory `CheckpointStore` for tests: values go through JSON like a database column would. */
export function createMemoryCheckpointStore(
  options: { readonly runsPausable?: boolean } = {},
): MemoryCheckpointStore {
  const rows = new Map<string, MemoryRow>();
  const saves: RunCheckpointState[] = [];
  const reads: string[] = [];
  let saveFails = false;
  let readsFail = false;
  let onControlRead: (() => Promise<void>) | null = null;
  const row = (ref: CheckpointRef): MemoryRow => {
    const key = keyOf(ref);
    const existing = rows.get(key);
    if (existing !== undefined) return existing;
    const created: MemoryRow = {
      raw: null,
      pauseRequested: false,
      stopRequested: false,
      resumeRequested: false,
      requestedBy: null,
    };
    rows.set(key, created);
    return created;
  };
  return {
    saves,
    setRaw(ref, raw) {
      row(ref).raw = raw;
    },
    peek(ref) {
      const raw = rows.get(keyOf(ref))?.raw;
      if (raw === undefined || raw === null) return null;
      const parsed = parseRunCheckpointState(raw);
      return parsed.ok ? parsed.state : null;
    },
    failSaves() {
      saveFails = true;
    },
    isPauseRequestedNow(ref) {
      return rows.get(keyOf(ref))?.pauseRequested === true;
    },
    load(ref) {
      const raw = rows.get(keyOf(ref))?.raw;
      if (raw === undefined || raw === null) return Promise.resolve({ state: null });
      const parsed = parseRunCheckpointState(raw);
      if (!parsed.ok) return Promise.reject(new CheckpointUnreadableError(parsed.reason));
      return Promise.resolve({ state: parsed.state });
    },
    save(ref, state) {
      if (saveFails) return Promise.reject(new Error("checkpoint store is down"));
      const copy = JSON.parse(JSON.stringify(state)) as unknown;
      row(ref).raw = copy;
      saves.push(JSON.parse(JSON.stringify(state)) as RunCheckpointState);
      return Promise.resolve();
    },
    isPauseRequested(ref) {
      return Promise.resolve(rows.get(keyOf(ref))?.pauseRequested === true);
    },
    requestPause(ref) {
      if (options.runsPausable === false) return Promise.resolve(false);
      row(ref).pauseRequested = true;
      return Promise.resolve(true);
    },
    clearPause(ref) {
      const existing = rows.get(keyOf(ref));
      if (existing !== undefined) {
        existing.pauseRequested = false;
        existing.resumeRequested = false;
      }
      return Promise.resolve();
    },
    readControl(ref) {
      reads.push(ref.runId);
      if (readsFail) return Promise.reject(new Error("checkpoint store is down"));
      const existing = rows.get(keyOf(ref));
      const flags = {
        pauseRequested: existing?.pauseRequested === true,
        stopRequested: existing?.stopRequested === true,
      };
      const hook = onControlRead;
      return hook === null ? Promise.resolve(flags) : hook().then(() => flags);
    },
    clearResumeRequest(ref) {
      const existing = rows.get(keyOf(ref));
      if (existing !== undefined) existing.resumeRequested = false;
      return Promise.resolve();
    },
    listControlRequests() {
      const open: ControlRequest[] = [];
      for (const [key, value] of rows) {
        if (!value.stopRequested && !value.resumeRequested) continue;
        const [workspaceId = "", runId = ""] = key.split(":");
        open.push({
          workspaceId,
          runId,
          stopRequested: value.stopRequested,
          resumeRequested: value.resumeRequested,
          requestedBy: value.requestedBy,
        });
      }
      return Promise.resolve(open);
    },
    flagStop(ref, requestedBy = null) {
      const target = row(ref);
      target.stopRequested = true;
      target.requestedBy = requestedBy;
    },
    flagResume(ref, requestedBy = null) {
      const target = row(ref);
      target.resumeRequested = true;
      target.requestedBy = requestedBy;
    },
    flagPause(ref) {
      row(ref).pauseRequested = true;
    },
    controlReads() {
      return reads;
    },
    failControlReads() {
      readsFail = true;
    },
    onControlRead(hook) {
      onControlRead = hook;
    },
    isStopRequestedNow(ref) {
      return rows.get(keyOf(ref))?.stopRequested === true;
    },
    isResumeRequestedNow(ref) {
      return rows.get(keyOf(ref))?.resumeRequested === true;
    },
    clear(ref) {
      rows.delete(keyOf(ref));
      return Promise.resolve();
    },
  };
}
