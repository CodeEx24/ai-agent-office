"use client";

import { useEffect } from "react";
import { useStore } from "zustand";

import type { OfficeEventSource } from "../realtime/office-event-source";
import {
  createOfficeStore,
  selectOfficeAgentState,
  type OfficeStore,
  type OfficeStoreState,
} from "./office-store";

/** The app-wide office store (one per browser tab; it is scoped to one workspace at a time). */
export const officeStore: OfficeStore = createOfficeStore();

/** Read the office store with a selector (selectors keep components off broad subscriptions). */
export function useOfficeStore<T>(selector: (state: OfficeStoreState) => T): T {
  return useStore(officeStore, selector);
}

/** One agent's office state, or null when no run of it is known. */
export function useAgentOfficeState(agentId: string) {
  return useOfficeStore((state) => selectOfficeAgentState(state, agentId));
}

/**
 * Keep the store connected to one workspace's events while the component is mounted. Switching workspace
 * resets the store; unmounting closes the stream. `source` must be stable (create it once per client).
 */
export function useOfficeConnection(workspaceId: string, source: OfficeEventSource): void {
  useEffect(() => {
    officeStore.getState().connect({ source, workspaceId });
    return () => {
      officeStore.getState().disconnect();
    };
  }, [workspaceId, source]);
}
