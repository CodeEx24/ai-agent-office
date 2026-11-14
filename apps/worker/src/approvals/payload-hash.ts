import { createHash } from "node:crypto";

/**
 * The canonical serialization the whole worker hashes (AGO-47): object keys sorted, `undefined` members left
 * out, anything that is not JSON data written as `null`. The same value always gives the same text, whatever
 * order its keys were built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const isPlain = ["string", "number", "boolean"].includes(typeof value);
    return isPlain ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * The hash an approval is bound to: SHA-256 hex of the canonical form of the exact tool name and arguments.
 * The request side (`approval.requested`, the `approvals` row) and the grant side (the check right before the
 * tool runs) both call this one function, so they cannot drift. The grant side always computes it from the
 * call about to run and never takes a hash from the model, the checkpoint or the approval row.
 */
export function approvalPayloadHash(toolName: string, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ tool_name: toolName, input }))
    .digest("hex");
}
