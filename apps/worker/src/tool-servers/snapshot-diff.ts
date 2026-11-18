import { canonicalJson, hashTool, sortedTools } from "./canonical-hash.js";

import type { ToolDescriptor, ToolServerDiffSummary, ToolServerSnapshot } from "@ago/shared";

/** Most names listed per category, and the longest name kept. Descriptions are never copied. */
export const MAX_DIFF_NAMES = 20;
const MAX_NAME_CHARS = 64;

const clip = (names: readonly string[]): string[] =>
  names.slice(0, MAX_DIFF_NAMES).map((name) => name.slice(0, MAX_NAME_CHARS));

interface ChangedBuckets {
  descriptionChanged: string[];
  schemaChanged: string[];
  otherChanged: string[];
}

/** A tool can fall in more than one bucket (description and schema both changed). */
function classify(old: ToolDescriptor, next: ToolDescriptor, out: ChangedBuckets): void {
  if (old.description !== next.description) out.descriptionChanged.push(next.name);
  if (canonicalJson(old.inputSchema ?? null) !== canonicalJson(next.inputSchema ?? null)) {
    out.schemaChanged.push(next.name);
  }
  // Annotations or any other field: still a change, still blocks.
  const { description: _d1, inputSchema: _s1, ...restOld } = old;
  const { description: _d2, inputSchema: _s2, ...restNext } = next;
  if (canonicalJson(restOld) !== canonicalJson(restNext)) out.otherChanged.push(next.name);
}

/**
 * What changed between the pinned snapshot and the live one, as a bounded summary of tool names and counts.
 * Throws on a duplicate tool name or a value that cannot be canonicalised; callers treat a throw as
 * `diff_error` and block.
 */
export function diffSnapshots(
  pinned: ToolServerSnapshot,
  live: ToolServerSnapshot,
): ToolServerDiffSummary {
  const before = new Map(sortedTools(pinned.tools).map((tool) => [tool.name, tool]));
  const after = new Map(sortedTools(live.tools).map((tool) => [tool.name, tool]));

  const added: string[] = [];
  const removed: string[] = [];
  const buckets: ChangedBuckets = { descriptionChanged: [], schemaChanged: [], otherChanged: [] };

  for (const [name, tool] of after) {
    const old = before.get(name);
    if (old === undefined) added.push(name);
    else if (hashTool(old) !== hashTool(tool)) classify(old, tool, buckets);
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name);

  const changedTools = new Set([
    ...added,
    ...removed,
    ...buckets.descriptionChanged,
    ...buckets.schemaChanged,
    ...buckets.otherChanged,
  ]);
  return {
    added: clip(added),
    removed: clip(removed),
    descriptionChanged: clip(buckets.descriptionChanged),
    schemaChanged: clip(buckets.schemaChanged),
    otherChanged: clip(buckets.otherChanged),
    versionChanged: pinned.version !== live.version,
    identityChanged: pinned.serverId !== live.serverId,
    totalChanges: changedTools.size,
  };
}

export function hasChanges(diff: ToolServerDiffSummary): boolean {
  return diff.totalChanges > 0 || diff.versionChanged || diff.identityChanged;
}
