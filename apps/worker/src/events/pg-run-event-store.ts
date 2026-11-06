import type { RunEventRow, RunEventStore, StoredRunEvent } from "./run-event-emitter.js";
import type pg from "pg";

interface InsertedRow {
  id: string;
  seq: string | number;
  created_at: Date | string;
}

/**
 * Postgres store. `seq` is deliberately not in the column list: the BEFORE INSERT trigger from
 * AGO-102 takes a per-run advisory lock and assigns max+1, so concurrent emits on one run get
 * 1..N without gaps and different runs never block each other. Needs READ COMMITTED (the default).
 * The caller owns the pool and closes it.
 */
export function createPgRunEventStore(pool: pg.Pool): RunEventStore {
  return {
    async insert(row: RunEventRow): Promise<StoredRunEvent> {
      const result = await pool.query<InsertedRow>(
        `insert into public.run_events (workspace_id, run_id, type, payload)
         values ($1, $2, $3, $4::jsonb)
         returning id, seq, created_at`,
        [row.workspace_id, row.run_id, row.type, JSON.stringify(row.payload)],
      );
      const inserted = result.rows[0];
      if (inserted === undefined) throw new Error("insert returned no row");
      return {
        id: inserted.id,
        seq: Number(inserted.seq),
        created_at:
          inserted.created_at instanceof Date
            ? inserted.created_at.toISOString()
            : inserted.created_at,
      };
    },
  };
}
