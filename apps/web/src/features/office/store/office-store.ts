import { createStore } from "zustand/vanilla";
import {
  createOfficeState,
  selectAgentStates,
  type AgentOfficeState,
  type OfficeState,
} from "@ago/shared";

import { createOfficeRealtime } from "../realtime/office-realtime";
import type { OfficeRealtime, OfficeRealtimeOptions } from "../realtime/office-realtime";
import type { OfficeEventSource, OfficeRealtimeStatus } from "../realtime/office-event-source";

/**
 * The office store (AGO-142): the single read model of the office UI. The 3D scene and the agent cards read
 * state only from here.
 *
 * Driven only by events:
 * - the state is `OfficeState` (AGO-124) and changes ONLY by the realtime controller (AGO-126) folding
 *   office events through the shared reducer;
 * - the store exposes no setter for it: the returned handle has no `setState`, and the only actions are
 *   `connect` and `disconnect` (they open and close the event stream, they do not write state);
 * - nothing is persisted: a reload starts from an empty office and rebuilds it from the stored events
 *   (cursor catch-up), then applies live events. Snapshots of derived state are never trusted.
 */
export interface OfficeStoreData {
  /** The workspace the store is scoped to; null before the first `connect`. */
  readonly workspaceId: string | null;
  /** The office of that workspace (null before the first `connect`). */
  readonly office: OfficeState | null;
  readonly status: OfficeRealtimeStatus;
}

export interface OfficeConnectOptions extends Pick<
  OfficeRealtimeOptions,
  "overlapMs" | "pageSize" | "backoff" | "setTimer" | "clearTimer" | "random" | "onError"
> {
  readonly source: OfficeEventSource;
  readonly workspaceId: string;
}

export interface OfficeStoreActions {
  /**
   * Scope the store to one workspace and start its event stream. Connecting to another workspace resets the
   * office first (one workspace's events only). Connecting to the same workspace again is a no-op.
   */
  connect(options: OfficeConnectOptions): void;
  /** Close the stream. The last state stays readable; no more events are applied. */
  disconnect(): void;
}

export type OfficeStoreState = OfficeStoreData & OfficeStoreActions;

/** What consumers get: read and subscribe, never `setState`. */
export interface OfficeStore {
  getState(): OfficeStoreState;
  getInitialState(): OfficeStoreState;
  subscribe(listener: (state: OfficeStoreState, previous: OfficeStoreState) => void): () => void;
}

export function createOfficeStore(): OfficeStore {
  let controller: OfficeRealtime | null = null;
  let connectedWorkspace: string | null = null;

  const store = createStore<OfficeStoreState>()((set, get) => {
    function closeStream(): void {
      controller?.stop();
      controller = null;
      connectedWorkspace = null;
    }

    return {
      workspaceId: null,
      office: null,
      status: "idle",

      connect(options) {
        if (controller && connectedWorkspace === options.workspaceId) return;
        closeStream();
        const { source, workspaceId, ...rest } = options;
        connectedWorkspace = workspaceId;
        set({ workspaceId, office: createOfficeState(workspaceId), status: "idle" });
        const own: OfficeRealtime = createOfficeRealtime({
          ...rest,
          source,
          workspaceId,
          onState: (office) => {
            if (controller === own && get().workspaceId === workspaceId) set({ office });
          },
          onStatus: (status) => {
            if (controller === own) set({ status });
          },
        });
        controller = own;
        own.start();
      },

      disconnect() {
        closeStream();
        if (get().workspaceId !== null) set({ status: "stopped" });
      },
    };
  });

  return {
    getState: store.getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
  };
}

/** The six-state agent view. Memoized on the office object, so a selector returns a stable reference. */
const agentStatesCache = new WeakMap<OfficeState, Record<string, AgentOfficeState>>();

const NO_AGENT_STATES: Readonly<Record<string, AgentOfficeState>> = Object.freeze({});

export function selectOfficeAgentStates(
  store: OfficeStoreState,
): Readonly<Record<string, AgentOfficeState>> {
  const office = store.office;
  if (!office) return NO_AGENT_STATES;
  let states = agentStatesCache.get(office);
  if (!states) {
    states = selectAgentStates(office);
    agentStatesCache.set(office, states);
  }
  return states;
}

/** One agent's state, or null when no run of it is known (the caller shows idle). */
export function selectOfficeAgentState(
  store: OfficeStoreState,
  agentId: string,
): AgentOfficeState | null {
  return selectOfficeAgentStates(store)[agentId] ?? null;
}
