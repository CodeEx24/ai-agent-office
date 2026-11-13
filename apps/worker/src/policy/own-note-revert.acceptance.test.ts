import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryOwnNoteRevertStore,
  hashNoteContent,
  recordOwnNoteEdit,
  revertOwnNoteEdit,
  type OwnNoteRevertStore,
} from "./own-note-revert.js";

// Independent acceptance tests for AGO-43 revert. Note content is built at runtime, never real data.
const WS = "ws-a";
const AGENT = "agent-a";
const NOTE = "note-1";

async function setup(previous: string | null, next: string) {
  const store = createInMemoryOwnNoteRevertStore();
  const record = await recordOwnNoteEdit(store, {
    workspaceId: WS,
    agentId: AGENT,
    noteId: NOTE,
    previousContent: previous,
    newContent: next,
  });
  return { store, record };
}

const ask = (
  recordId: string,
  currentContent: string | null,
  over: { workspaceId?: string; agentId?: string } = {},
) => ({
  workspaceId: over.workspaceId ?? WS,
  agentId: over.agentId ?? AGENT,
  recordId,
  currentContent,
});

describe("AC1: a revert record is created before the edit", () => {
  it("stores the previous content, scope and a hash of the new content, not reverted yet", async () => {
    const before = ["line one", "line two"].join("\n");
    const after = ["line one", "changed"].join("\n");
    const { store, record } = await setup(before, after);
    const stored = await store.get(WS, record.id);
    expect(stored).toMatchObject({
      workspaceId: WS,
      agentId: AGENT,
      noteId: NOTE,
      previousContent: before,
      isReverted: false,
    });
    expect(stored?.appliedHash).toBe(hashNoteContent(after));
    expect(stored?.appliedHash).not.toBe(hashNoteContent(before));
  });

  it("uses the injected clock for createdAt", async () => {
    const store = createInMemoryOwnNoteRevertStore();
    const record = await recordOwnNoteEdit(
      store,
      { workspaceId: WS, agentId: AGENT, noteId: NOTE, previousContent: "a", newContent: "b" },
      () => new Date("2030-01-02T03:04:05.000Z"),
    );
    expect(record.createdAt).toBe("2030-01-02T03:04:05.000Z");
  });

  it("gives each edit its own record id, so two edits of one note are both revertable", async () => {
    const store = createInMemoryOwnNoteRevertStore();
    const mk = (p: string, n: string) =>
      recordOwnNoteEdit(store, {
        workspaceId: WS,
        agentId: AGENT,
        noteId: NOTE,
        previousContent: p,
        newContent: n,
      });
    const first = await mk("v0", "v1");
    const second = await mk("v1", "v2");
    expect(first.id).not.toBe(second.id);
    expect(await revertOwnNoteEdit(store, ask(second.id, "v2"))).toEqual({
      outcome: "reverted",
      previousContent: "v1",
    });
    expect(await revertOwnNoteEdit(store, ask(first.id, "v1"))).toEqual({
      outcome: "reverted",
      previousContent: "v0",
    });
  });

  it("does not swallow a failing save, so the caller knows not to write", async () => {
    const failing: OwnNoteRevertStore = {
      save: () => Promise.reject(new Error("store down")),
      get: () => Promise.resolve(null),
      markReverted: () => Promise.resolve(),
    };
    await expect(
      recordOwnNoteEdit(failing, {
        workspaceId: WS,
        agentId: AGENT,
        noteId: NOTE,
        previousContent: "a",
        newContent: "b",
      }),
    ).rejects.toThrow("store down");
  });
});

describe("AC1: revert restores the previous content", () => {
  it.each([
    ["plain text", "before"],
    ["empty string", ""],
    ["unicode and emoji", "café 🚀 שלום"],
    ["multiline with CRLF and trailing newline", "a\r\nb\n"],
  ])("returns the exact previous content for %s", async (_label, previous) => {
    const { store, record } = await setup(previous, "after");
    expect(await revertOwnNoteEdit(store, ask(record.id, "after"))).toEqual({
      outcome: "reverted",
      previousContent: previous,
    });
  });

  it("returns null (delete the note) when the edit created the note", async () => {
    const { store, record } = await setup(null, "fresh");
    expect(await revertOwnNoteEdit(store, ask(record.id, "fresh"))).toEqual({
      outcome: "reverted",
      previousContent: null,
    });
  });

  it("marks the record reverted so a second revert is refused", async () => {
    const { store, record } = await setup("old", "new");
    await revertOwnNoteEdit(store, ask(record.id, "new"));
    expect((await store.get(WS, record.id))?.isReverted).toBe(true);
    expect(await revertOwnNoteEdit(store, ask(record.id, "new"))).toEqual({
      outcome: "refused",
      reasonCode: "already_reverted",
    });
  });
});

describe("AC1: revert fails closed", () => {
  it("refuses an unknown record id", async () => {
    const { store } = await setup("a", "b");
    expect(await revertOwnNoteEdit(store, ask("does-not-exist", "b"))).toEqual({
      outcome: "refused",
      reasonCode: "not_found",
    });
  });

  it("refuses another workspace as not_found and leaves the record untouched", async () => {
    const { store, record } = await setup("a", "b");
    expect(
      await revertOwnNoteEdit(store, ask(record.id, "b", { workspaceId: "ws-other" })),
    ).toEqual({ outcome: "refused", reasonCode: "not_found" });
    expect((await store.get(WS, record.id))?.isReverted).toBe(false);
  });

  it("refuses another agent in the same workspace and leaves the record untouched", async () => {
    const { store, record } = await setup("a", "b");
    expect(await revertOwnNoteEdit(store, ask(record.id, "b", { agentId: "agent-b" }))).toEqual({
      outcome: "refused",
      reasonCode: "wrong_agent",
    });
    expect((await store.get(WS, record.id))?.isReverted).toBe(false);
    expect((await revertOwnNoteEdit(store, ask(record.id, "b"))).outcome).toBe("reverted");
  });

  it("refuses when the note was changed after the edit, and a later correct revert still works", async () => {
    const { store, record } = await setup("a", "b");
    expect(await revertOwnNoteEdit(store, ask(record.id, "b edited by a person"))).toEqual({
      outcome: "refused",
      reasonCode: "note_changed",
    });
    expect((await revertOwnNoteEdit(store, ask(record.id, "b"))).outcome).toBe("reverted");
  });

  it("refuses when the note was deleted since the edit (current content is null)", async () => {
    const { store, record } = await setup("a", "b");
    expect(await revertOwnNoteEdit(store, ask(record.id, null))).toEqual({
      outcome: "refused",
      reasonCode: "note_changed",
    });
  });

  it("refuses when the note differs only by trailing whitespace", async () => {
    const { store, record } = await setup("a", "b");
    expect((await revertOwnNoteEdit(store, ask(record.id, "b\n"))).outcome).toBe("refused");
  });

  it("refuses when the current content is the previous content (already undone by hand)", async () => {
    const { store, record } = await setup("a", "b");
    expect((await revertOwnNoteEdit(store, ask(record.id, "a"))).outcome).toBe("refused");
  });

  it("does not mark the record reverted when the revert is refused", async () => {
    const markReverted = vi.fn(() => Promise.resolve());
    const spy: OwnNoteRevertStore = { ...createInMemoryOwnNoteRevertStore(), markReverted };
    const record = await recordOwnNoteEdit(spy, {
      workspaceId: WS,
      agentId: AGENT,
      noteId: NOTE,
      previousContent: "a",
      newContent: "b",
    });
    await revertOwnNoteEdit(spy, ask(record.id, "changed"));
    expect(markReverted).not.toHaveBeenCalled();
  });

  it("keeps records of two workspaces apart even when record ids collide", async () => {
    const store = createInMemoryOwnNoteRevertStore();
    const base = {
      agentId: AGENT,
      noteId: NOTE,
      appliedHash: hashNoteContent("n"),
      createdAt: "x",
      isReverted: false,
    };
    await store.save({ ...base, id: "same", workspaceId: "ws-1", previousContent: "one" });
    await store.save({ ...base, id: "same", workspaceId: "ws-2", previousContent: "two" });
    expect(await revertOwnNoteEdit(store, ask("same", "n", { workspaceId: "ws-2" }))).toEqual({
      outcome: "reverted",
      previousContent: "two",
    });
    expect((await store.get("ws-1", "same"))?.isReverted).toBe(false);
  });

  it("never puts note content into a refusal result", async () => {
    const secret = ["sk", "live", String(Date.now())].join("-");
    const { store, record } = await setup(secret, "b");
    const refused = await revertOwnNoteEdit(store, ask(record.id, secret + "x"));
    expect(JSON.stringify(refused)).not.toContain(secret);
  });
});
