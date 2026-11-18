# Office store

Ticket: AGO-142. Code: `apps/web/src/features/office/store/`. Built on the office contract (AGO-124, `packages/shared/src/office/`) and realtime delivery (AGO-126, `apps/web/src/features/office/realtime/`).

The office store is the one place the UI (agent cards, the 3D office floor) reads office state from. It never writes state itself: the state is a fold of `run_events` rows.

## How it works
1. `connect({ source, workspaceId })` scopes the store to one workspace, starts it from an empty office and starts the AGO-126 controller.
2. The controller catches up from the stored events, then streams live rows. Each row goes through the shared reducer, which ignores duplicates, holds back rows that are ahead of their run and refills the gap by `seq`.
3. Every new state the controller produces is put in the store. That is the only write.

## Reload
Nothing is persisted. After a reload the store starts empty and rebuilds from the stored events, then applies live ones, so it equals the state before the reload, including events that arrived while the page was gone.

## Using it
```tsx
useOfficeConnection(workspaceId, source); // once per workspace, `source` stable
const states = useOfficeStore(selectOfficeAgentStates); // six agent states, memoized
const card = useAgentOfficeState(agentId); // null: no run known, show idle
const status = useOfficeStore((s) => s.status);
```
Use selectors, not the whole store. Switching `workspaceId` resets the store; unmounting disconnects. Agent text in the state (errors, messages) is untrusted: render it as plain text.

## Rules
- No setter. `createOfficeStore()` returns `getState`, `getInitialState`, `subscribe` only, and the only actions are `connect` and `disconnect`.
- One workspace at a time; rows of another workspace are counted in `office.anomalies.foreign` and never applied.
