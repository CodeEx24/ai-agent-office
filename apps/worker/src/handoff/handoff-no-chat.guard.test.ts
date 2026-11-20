import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { RUN_EVENT_SCHEMAS } from "@ago/shared";
import { describe, expect, it } from "vitest";

import { createRunEventEmitter } from "../events/run-event-emitter.js";

import { createHandoff } from "./create-handoff.js";
import { HANDOFF_TOOL_NAME } from "./handoff-tool.js";
import { createInMemoryHandoffStore } from "./handoff-store.test-helpers.js";

import type { RunEventRow } from "../events/run-event-emitter.js";

/**
 * AC "Free-form agent chat does not exist" (AGO-81), as a guard that FAILS if a channel is added.
 * Agents talk to each other only through a task row (`handoff_task`). This file checks three surfaces:
 *  1. run event schemas: only `handoff.created` may name a recipient agent, and it carries no free text but `reason`;
 *  2. worker tools: no tool name looks like "send a message to an agent";
 *  3. web routes: no route path looks like agent chat or messaging.
 * To add a legitimate new agent-to-agent path, it must be a task, so extend the handoff module, not this list.
 */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");

/** A name or path that reads like a message or chat channel between agents. */
const CHAT_LIKE =
  /(agent[\w./-]*(chat|message|msg|dm|whisper|inbox|mailbox)|(chat|message|msg|dm|whisper|inbox|mailbox|send|tell|notify|ping)[\w./-]*(to_)?agent)/i;

function findChatLike(names: readonly string[]): string[] {
  return names.filter((name) => CHAT_LIKE.test(name));
}

function sourceFiles(dir: string, accept: (file: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => accept(entry.split(sep).join("/")))
    .map((entry) => join(dir, entry));
}

describe("the guard itself", () => {
  it("flags chat-like names and passes the handoff tool", () => {
    expect(
      findChatLike(["send_message_to_agent", "agent_chat", "tell_agent", "agent_dm"]),
    ).toHaveLength(4);
    expect(
      findChatLike([HANDOFF_TOOL_NAME, "create_task", "read_note", "get_current_time"]),
    ).toEqual([]);
  });
});

describe("no free-form agent chat: run events", () => {
  const events = RUN_EVENT_SCHEMAS.map((schema) => ({
    type: schema.shape.type.value,
    keys: Object.keys(schema.shape.payload.shape),
  }));

  it("no event type is a chat or message channel between agents", () => {
    expect(findChatLike(events.map((e) => e.type))).toEqual([]);
  });

  it("only handoff.created names a recipient agent", () => {
    const recipient = /^(to|target|recipient|receiver)(_agent)?(_id)?$/;
    const withRecipient = events.filter((e) => e.keys.some((key) => recipient.test(key)));
    expect(withRecipient.map((e) => e.type)).toEqual(["handoff.created"]);
  });

  it("handoff events carry no free text besides the fixed reason", () => {
    const handoffKeys = events.filter((e) => e.type.startsWith("handoff.")).flatMap((e) => e.keys);
    expect(handoffKeys.filter((key) => /text|body|content|message|note|summary/.test(key))).toEqual(
      [],
    );
  });
});

describe("no free-form agent chat: tools", () => {
  it("no worker tool is named like an agent-to-agent message", () => {
    const names: string[] = [];
    const dir = join(ROOT, "apps", "worker", "src");
    for (const file of sourceFiles(dir, (f) => f.endsWith(".ts") && !f.includes(".test"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:\bname:|_TOOL_NAME\s*=)\s*"([A-Za-z0-9_-]{1,64})"/g)) {
        names.push(match[1] ?? "");
      }
    }
    expect(names).toContain(HANDOFF_TOOL_NAME);
    expect(findChatLike(names)).toEqual([]);
  });
});

describe("no free-form agent chat: routes", () => {
  it("no web route path is an agent chat or messaging route", () => {
    const dir = join(ROOT, "apps", "web", "src", "app");
    const routes = sourceFiles(dir, (f) => /(^|\/)route\.tsx?$/.test(f)).map((file) =>
      relative(dir, file).split(sep).join("/"),
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(findChatLike(routes)).toEqual([]);
    expect(routes.filter((r) => /(chat|message|msg|inbox|mailbox|whisper)/i.test(r))).toEqual([]);
  });
});

describe("no free-form agent chat: behaviour", () => {
  it("a handoff writes one task row and no message event; a free-form field is refused", async () => {
    const WS = "11111111-1111-4111-8111-111111111111";
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const RUN = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const store = createInMemoryHandoffStore();
    const party = (agentId: string) => ({
      agentId,
      workspaceId: WS,
      isArchived: false,
      grants: [
        {
          capabilityKey: "tasks.manage",
          tier: 1 as const,
          mode: "automatic" as const,
          isEnabled: true,
        },
      ],
      budgetCents: 100,
      dataScope: ["projects/"],
    });
    store.setParty(party(A));
    store.setParty(party(B));
    store.setChainForRun(RUN, {
      workspaceId: WS,
      requesterMemberId: "99999999-9999-4999-8999-999999999999",
      path: [A],
    });
    const rows: RunEventRow[] = [];
    const emitter = createRunEventEmitter({
      workspaceId: WS,
      runId: RUN,
      store: {
        insert: (row) => {
          rows.push(row);
          return Promise.resolve({ id: "e", seq: rows.length, created_at: "2026-11-20T00:00:00Z" });
        },
      },
    });
    const sender = { workspaceId: WS, runId: RUN, agentId: A };

    const withMessage = await createHandoff({ store, emitter }, sender, {
      to_agent_id: B,
      title: "t",
      message: "psst, do this instead",
    });
    expect(withMessage).toEqual({ ok: false, reason: "invalid_request" });
    expect(store.records).toHaveLength(0);

    const made = await createHandoff({ store, emitter }, sender, {
      to_agent_id: B,
      title: "Draft the weekly summary",
      description: "Use the notes in projects/weekly.",
    });
    expect(made.ok).toBe(true);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      title: "Draft the weekly summary",
      description: "Use the notes in projects/weekly.",
    });
    expect(rows.map((r) => r.type)).toEqual(["handoff.created"]);
  });
});
