import { prerequisiteResultSchema, type PrerequisiteResult } from "@ago/shared";

import type { Logger } from "../logger.js";
import type pg from "pg";

/**
 * Attestation (AGO-85): the worker runs the real probes and records the outcome in `capability_prerequisite_status`
 * for every workspace. The database function `enable_capability()` reads those rows, so a capability cannot be
 * turned on from the database side unless every required check passed within the last 60 seconds. The worker
 * records on start and then on a timer well inside that window; a worker that stops, or a probe that fails, lets the
 * rows go stale or non-pass, and the database then refuses (fail closed).
 *
 * Only a fixed check name, a fixed status and a fixed reason code are written, never error text.
 */
export const ATTESTATION_INTERVAL_MS = 30_000;

export interface AttestationStore {
  /** Upserts one row per (workspace, check) with `checked_at = now()`. */
  record(results: readonly PrerequisiteResult[]): Promise<void>;
}

const RECORD_SQL = `
  insert into public.capability_prerequisite_status (workspace_id, check_name, status, reason, checked_at)
  select w.id, r.name, r.status, r.reason, now()
    from public.workspaces w
   cross join jsonb_to_recordset($1::jsonb) as r(name text, status text, reason text)
  on conflict (workspace_id, check_name)
  do update set status = excluded.status, reason = excluded.reason, checked_at = excluded.checked_at
`;

export function createPgAttestationStore(pool: pg.Pool): AttestationStore {
  return {
    async record(results) {
      // Validate again at the boundary: an unknown name, status or free-text reason is never written.
      const rows = results.map((result) => {
        const parsed = prerequisiteResultSchema.parse(result);
        return { name: parsed.name, status: parsed.status, reason: parsed.reason ?? null };
      });
      if (rows.length === 0) return;
      await pool.query(RECORD_SQL, [JSON.stringify(rows)]);
    },
  };
}

export interface PrerequisiteAttestationOptions {
  readonly store: AttestationStore;
  readonly runChecks: () => Promise<readonly PrerequisiteResult[]>;
  readonly logger: Pick<Logger, "warn">;
  readonly intervalMs?: number;
}

export interface PrerequisiteAttestation {
  /** Runs one round now (also used by the timer). Never throws. */
  tick(): Promise<void>;
  stop(): void;
}

/** Records once now, then every `intervalMs`. Rounds never overlap; a failure is logged once until it recovers. */
export function startPrerequisiteAttestation(
  options: PrerequisiteAttestationOptions,
): PrerequisiteAttestation {
  const { store, runChecks, logger } = options;
  let isRunning = false;
  let isFailing = false;

  const tick = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      await store.record(await runChecks());
      isFailing = false;
    } catch {
      if (!isFailing) logger.warn({}, "could not record the prerequisite check results");
      isFailing = true;
    } finally {
      isRunning = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs ?? ATTESTATION_INTERVAL_MS);
  timer.unref();

  return {
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
}
