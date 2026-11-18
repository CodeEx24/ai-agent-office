import { z } from "zod";

/**
 * Tool server allowlist and pins (AGO-68). Pure schemas and types, safe for the web app too.
 *
 * A tool server is an external process that offers tools (for example an MCP server). A workspace owner
 * allowlists it, a human reviews its tool list and pins the hash of that list. Anything the server later
 * changes (a description, a schema, an added or removed tool, its version) no longer matches the pin and the
 * server is blocked until a human reviews it again. Tool text is untrusted: it is hashed and diffed, never
 * copied into logs or run events.
 */

/** Stable codes for a refused server or call. They go into logs, run events and tests. */
export const TOOL_SERVER_DENIAL_REASONS = [
  "server_not_allowlisted",
  "pin_missing",
  "hash_mismatch",
  "snapshot_unavailable",
  "diff_error",
  "passthrough_token",
] as const;
export type ToolServerDenialReason = (typeof TOOL_SERVER_DENIAL_REASONS)[number];

const MAX_TOOLS = 500;

export const toolServerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, "server id: lowercase letters, digits, _ . - (max 63)");

/**
 * One tool as the server lists it. Loose on purpose: every field the server sends is part of the hash, so a
 * change to an annotation or any extra field is a change too.
 */
export const toolDescriptorSchema = z.looseObject({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

/** What a connect returns: who the server says it is, its version and its tool list. */
export const toolServerSnapshotSchema = z.strictObject({
  serverId: toolServerIdSchema,
  version: z.string().max(64),
  tools: z.array(toolDescriptorSchema).max(MAX_TOOLS),
});
export type ToolServerSnapshot = z.infer<typeof toolServerSnapshotSchema>;

export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** A bounded, text-free summary of what changed: tool names (clipped) and counts, never descriptions. */
export interface ToolServerDiffSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly descriptionChanged: readonly string[];
  readonly schemaChanged: readonly string[];
  readonly otherChanged: readonly string[];
  readonly versionChanged: boolean;
  readonly identityChanged: boolean;
  /** Total changed tools before the name lists were clipped. */
  readonly totalChanges: number;
}
