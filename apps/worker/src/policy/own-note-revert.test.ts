import { describe, expect, it } from "vitest";

import {
  createInMemoryOwnNoteRevertStore,
  recordOwnNoteEdit,
  revertOwnNoteEdit,
} from "./own-note-revert.js";

const WS = "ws-1";
const AGENT = "agent-1";

async function edited(previous: string | null = "old") {
  const store = createInMemoryOwnNoteRevertStore();
  const record = await recordOwnNoteEdit(store, {
    workspaceId: WS,
    agentId: AGENT,
    noteId: "note-1",
    previousContent: previous,
    newContent: "new",
  });
  return { store, record };
}

describe("own-note revert", () => {
  it("restores the previous content", async () => {
    const { store, record } = await edited();
    const result = await revertOwnNoteEdit(store, {
      workspaceId: WS,
      agentId: AGENT,
      recordId: record.id,
      currentContent: "new",
    });
    expect(result).toEqual({ outcome: "reverted", previousContent: "old" });
  });

  it("returns null previous content when the edit created the note", async () => {
    const { store, record } = await edited(null);
    const result = await revertOwnNoteEdit(store, {
      workspaceId: WS,
      agentId: AGENT,
      recordId: record.id,
      currentContent: "new",
    });
    expect(result).toEqual({ outcome: "reverted", previousContent: null });
  });

  it("refuses a second revert", async () => {
    const { store, record } = await edited();
    const request = { workspaceId: WS, agentId: AGENT, recordId: record.id, currentContent: "new" };
    await revertOwnNoteEdit(store, request);
    expect(await revertOwnNoteEdit(store, request)).toEqual({
      outcome: "refused",
      reasonCode: "already_reverted",
    });
  });

  it("refuses another agent, another workspace and an unknown record", async () => {
    const { store, record } = await edited();
    const base = { workspaceId: WS, agentId: AGENT, recordId: record.id, currentContent: "new" };
    expect(await revertOwnNoteEdit(store, { ...base, agentId: "agent-2" })).toEqual({
      outcome: "refused",
      reasonCode: "wrong_agent",
    });
    expect(await revertOwnNoteEdit(store, { ...base, workspaceId: "ws-2" })).toEqual({
      outcome: "refused",
      reasonCode: "not_found",
    });
    expect(await revertOwnNoteEdit(store, { ...base, recordId: "missing" })).toEqual({
      outcome: "refused",
      reasonCode: "not_found",
    });
  });

  it("refuses when the note changed after the edit or was deleted", async () => {
    const { store, record } = await edited();
    const base = { workspaceId: WS, agentId: AGENT, recordId: record.id };
    expect(await revertOwnNoteEdit(store, { ...base, currentContent: "someone else" })).toEqual({
      outcome: "refused",
      reasonCode: "note_changed",
    });
    expect(await revertOwnNoteEdit(store, { ...base, currentContent: null })).toEqual({
      outcome: "refused",
      reasonCode: "note_changed",
    });
  });

  it("never keeps the new content in the record", async () => {
    const { record } = await edited();
    expect(JSON.stringify(record)).not.toContain('"new"');
  });
});
