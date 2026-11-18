import type { RunEventEmitter } from "../events/run-event-emitter.js";
import type { ToolServerDiffSummary } from "@ago/shared";

export interface ToolServerScope {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
}

export interface ToolServerChange {
  readonly serverId: string;
  readonly pinnedHash: string;
  readonly liveHash: string;
  /** Null when the diff itself failed. */
  readonly diff: ToolServerDiffSummary | null;
}

/** Where a changed server is reported. Best effort: the block stands even if this throws. */
export interface ToolServerAlertSink {
  changed(scope: ToolServerScope, change: ToolServerChange): Promise<void>;
}

export const TOOL_SERVER_CHANGED_CODE = "tool_server_changed";
const MAX_MESSAGE = 500;
const MAX_LISTED = 8;

/** Tool names come from the server, so they are untrusted text: keep a safe alphabet and a short length. */
const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 48);

function list(label: string, names: readonly string[]): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, MAX_LISTED).map(safeName).join(",");
  return ` ${label}=[${shown}${names.length > MAX_LISTED ? ",..." : ""}]`;
}

/**
 * The text of the alert: server id, the two hashes and a bounded summary (names and counts). No tool
 * descriptions, no schemas, no tokens: descriptions are untrusted and a changed one may be an attack.
 */
export function formatChangeMessage(change: ToolServerChange): string {
  const head = `server ${safeName(change.serverId)} changed: pinned=${change.pinnedHash} live=${change.liveHash}`;
  const { diff } = change;
  const tail =
    diff === null
      ? " diff unavailable"
      : ` changes=${String(diff.totalChanges)}${diff.versionChanged ? " version" : ""}${
          diff.identityChanged ? " identity" : ""
        }${list("added", diff.added)}${list("removed", diff.removed)}${list(
          "description",
          diff.descriptionChanged,
        )}${list("schema", diff.schemaChanged)}${list("other", diff.otherChanged)}`;
  return `${head}${tail}`.slice(0, MAX_MESSAGE);
}

/**
 * Alert through the append-only run event log (no parallel channel): an `error.raised` event on the run that
 * noticed the change. A notification (Telegram, UI badge) can read these events later.
 */
export function createRunEventAlertSink(
  emitterFor: (scope: ToolServerScope) => Pick<RunEventEmitter, "emit">,
): ToolServerAlertSink {
  return {
    async changed(scope, change) {
      await emitterFor(scope).emit({
        type: "error.raised",
        payload: {
          code: TOOL_SERVER_CHANGED_CODE,
          message: formatChangeMessage(change),
          retryable: false,
        },
      });
    },
  };
}
