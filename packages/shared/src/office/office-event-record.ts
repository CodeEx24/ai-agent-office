import { z } from "zod";

/**
 * The input of the office reducer (AGO-124): one `run_events` row plus the run's `agent_id`.
 *
 * The loader that reads rows (AGO-126 / AGO-142) joins `runs` (workspace-scoped) to add `agent_id`, so
 * every event attributes itself and a window of events never needs the run's `run.created`.
 * `payload` is the stored column: `{ version, ...fields }`. It is validated separately by the reducer,
 * because an unknown type or version must be counted, not rejected at the envelope.
 *
 * Ordering: `seq` is per run (AGO-102). The workspace "feed order" is `(created_at, id)`; correctness
 * never depends on it, it only defines N ("the last N events") and the cursor.
 */
export const officeEventRecordSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  run_id: z.uuid(),
  agent_id: z.uuid(),
  seq: z.number().int().positive(),
  type: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime({ offset: true }),
});
export type OfficeEventRecord = z.infer<typeof officeEventRecordSchema>;

/** Position in the workspace feed: the last row applied. AGO-126 fetches rows after it. */
export const officeCursorSchema = z.object({
  created_at: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});
export type OfficeCursor = z.infer<typeof officeCursorSchema>;

/** Total order of the workspace feed: `created_at` (compared as an instant), then `id`. */
export function compareFeedOrder(a: OfficeCursor, b: OfficeCursor): number {
  const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byTime !== 0) return byTime < 0 ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Rows sorted into feed order (a copy; the input is not touched). */
export function sortFeed<T extends OfficeCursor>(rows: readonly T[]): T[] {
  return [...rows].sort(compareFeedOrder);
}

/**
 * "The last N events" of one workspace: the final `n` rows in feed order, duplicates (same `id`) removed.
 * Feed this to `rebuildOfficeState`. `n <= 0` gives an empty window.
 */
export function selectTail<T extends OfficeCursor>(rows: readonly T[], n: number): T[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const sorted = sortFeed(unique);
  return sorted.slice(Math.max(0, sorted.length - Math.floor(n)));
}
