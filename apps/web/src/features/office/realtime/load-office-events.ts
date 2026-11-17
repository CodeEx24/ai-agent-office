import {
  compareFeedOrder,
  officeEventRecordSchema,
  type OfficeCursor,
  type OfficeEventRecord,
} from "@ago/shared";

import type { OfficeEventSource } from "./office-event-source";

/** created_at is the transaction start, so commit order can differ: re-read a small window before the cursor. */
export const DEFAULT_OVERLAP_MS = 5 * 60 * 1000;
export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_MAX_PAGES = 40;

export interface LoadOfficeEventsOptions {
  readonly source: OfficeEventSource;
  readonly workspaceId: string;
  /** Last applied row of the current state; null loads the whole feed (bounded by `maxPages`). */
  readonly cursor: OfficeCursor | null;
  readonly overlapMs?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface LoadedOfficeEvents {
  /** Valid rows of this workspace in feed order, one per `id`. Safe to feed to `applyOfficeEvents`. */
  readonly rows: OfficeEventRecord[];
  /** Rows of another workspace (never returned when RLS works; counted as defence in depth). */
  readonly foreign: number;
  /** Rows that did not validate. */
  readonly invalid: number;
  /** True when `maxPages` stopped the load before the feed ended; the caller must load again. */
  readonly truncated: boolean;
}

export function overlapStart(cursor: OfficeCursor | null, overlapMs: number): string | null {
  if (!cursor) return null;
  return new Date(Date.parse(cursor.created_at) - overlapMs).toISOString();
}

/**
 * Catch-up: every row of one workspace from `cursor - overlap`, paged by keyset in feed order.
 * Rows of another workspace and invalid rows are dropped and counted, never returned.
 */
export async function loadOfficeEvents(
  options: LoadOfficeEventsOptions,
): Promise<LoadedOfficeEvents> {
  const { source, workspaceId, cursor } = options;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const since = overlapStart(cursor, options.overlapMs ?? DEFAULT_OVERLAP_MS);

  const byId = new Map<string, OfficeEventRecord>();
  let foreign = 0;
  let invalid = 0;
  let after: OfficeCursor | null = null;
  let truncated = false;

  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    const batch = await source.fetchEvents({ workspaceId, since, after, limit: pageSize });
    let last: OfficeCursor | null = null;
    for (const raw of batch) {
      const parsed = officeEventRecordSchema.safeParse(raw);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      const row = parsed.data;
      last = { created_at: row.created_at, id: row.id };
      if (row.workspace_id !== workspaceId) {
        foreign += 1;
        continue;
      }
      byId.set(row.id, row);
    }
    // A short page ends the feed. A page with no valid position cannot advance the keyset: stop.
    if (batch.length < pageSize || !last) break;
    after = last;
  }

  const rows = [...byId.values()].sort(compareFeedOrder);
  return { rows, foreign, invalid, truncated };
}

/** One run's rows after `afterSeq`, validated, this workspace only, ascending by `seq`. */
export async function loadRunEventsAfter(
  source: OfficeEventSource,
  workspaceId: string,
  runId: string,
  afterSeq: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<OfficeEventRecord[]> {
  const out: OfficeEventRecord[] = [];
  let cursorSeq = afterSeq;
  for (let page = 0; page < DEFAULT_MAX_PAGES; page += 1) {
    const batch = await source.fetchRunEvents({
      workspaceId,
      runId,
      afterSeq: cursorSeq,
      limit: pageSize,
    });
    let advanced = false;
    for (const raw of batch) {
      const parsed = officeEventRecordSchema.safeParse(raw);
      if (!parsed.success) continue;
      const row = parsed.data;
      if (row.workspace_id !== workspaceId || row.run_id !== runId) continue;
      out.push(row);
      if (row.seq > cursorSeq) {
        cursorSeq = row.seq;
        advanced = true;
      }
    }
    if (batch.length < pageSize || !advanced) break;
  }
  return out.sort((a, b) => a.seq - b.seq);
}
