import { createHash } from "node:crypto";

import type { ToolDescriptor, ToolServerSnapshot } from "@ago/shared";

/**
 * Canonical JSON and the hashes built on it (AGO-68). The same snapshot always gives the same bytes: object
 * keys are sorted at every depth, strings are NFC-normalised (so a different Unicode form of the same text
 * hashes the same, but a real change always shows), there is no whitespace, and values JSON cannot carry
 * stably (undefined, functions, NaN, Infinity) throw rather than being dropped silently: a hash that ignored
 * a field would let that field change unseen.
 */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const MAX_DEPTH = 64;

function canonicalize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalizationError("value is nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError("non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts = keys.map((key) => {
        const item = record[key];
        if (item === undefined) throw new CanonicalizationError("undefined value");
        return `${JSON.stringify(key.normalize("NFC"))}:${canonicalize(item, depth + 1)}`;
      });
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalizationError("value is not JSON");
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, 0);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of one tool: every field the server sent (name, description, input schema, annotations, ...). */
export function hashTool(tool: ToolDescriptor): string {
  return sha256Hex(canonicalJson(tool));
}

/** Tools in a fixed order (by name). Throws on a duplicate name: two tools with one name are ambiguous. */
export function sortedTools(tools: readonly ToolDescriptor[]): ToolDescriptor[] {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]?.name === sorted[i - 1]?.name) {
      throw new CanonicalizationError("duplicate tool name");
    }
  }
  return sorted;
}

/** The pin: server identity, version and the canonical form of its whole tool list. */
export function hashSnapshot(snapshot: ToolServerSnapshot): string {
  return sha256Hex(
    canonicalJson({
      serverId: snapshot.serverId,
      version: snapshot.version,
      tools: sortedTools(snapshot.tools),
    }),
  );
}
