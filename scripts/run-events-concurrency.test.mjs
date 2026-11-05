// AGO-102: concurrent inserts into run_events must get distinct, gap-free, increasing per-run seq numbers.
// Needs the shared local Supabase stack, so it only runs with RUN_DB_TESTS=1, and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-102
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/run-events-concurrency.test.mjs
//   node scripts/db-lock.mjs release AGO-102
// Each insert is its own `psql` process inside the DB container = its own connection, so the inserts
// really race. Rows are removed at the end by the test-only teardown (scripts/run-events-teardown.mjs); the app has no delete path.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { teardownRunEventsSql } from './run-events-teardown.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_agent-office';
const enabled = process.env.RUN_DB_TESTS === '1';

async function psql(sql) {
  const { stdout } = await run('docker', [
    'exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql,
  ]);
  return stdout.trim();
}

const settle = (sql) => psql(sql).then(() => 'ok', () => 'error');

describe.skipIf(!enabled)('run_events per-run sequence under concurrency', () => {
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const insertAs = (runId, seq) =>
    `set role service_role; insert into public.run_events (workspace_id, run_id, type${seq ? ', seq' : ''})
     values ('${workspaceId}', '${runId}', 'test'${seq ? `, ${seq}` : ''})`;

  beforeAll(async () => {
    await psql(`
      insert into public.workspaces (id, name) values ('${workspaceId}', 'AGO-102 concurrency');
      insert into public.agents (id, workspace_id, name) values ('${agentId}', '${workspaceId}', 'agent');
      insert into public.runs (id, workspace_id, agent_id) values
        ('${runA}', '${workspaceId}', '${agentId}'), ('${runB}', '${workspaceId}', '${agentId}')`);
  });

  afterAll(async () => {
    if (enabled) await psql(teardownRunEventsSql([workspaceId]));
  });

  it('assigns distinct, gap-free seq 1..N to parallel inserts on one run, and numbers runs independently', async () => {
    const inserts = 40;
    const results = await Promise.all(
      Array.from({ length: inserts }, (_, i) => settle(insertAs(i % 4 === 0 ? runB : runA))),
    );
    expect(results.every((r) => r === 'ok')).toBe(true);

    const seqs = async (r) =>
      (await psql(`select string_agg(seq::text, ',' order by seq) from public.run_events where run_id = '${r}'`)).split(',').map(Number);
    const countB = results.filter((_, i) => i % 4 === 0).length;
    expect(await seqs(runB)).toEqual(Array.from({ length: countB }, (_, i) => i + 1));
    expect(await seqs(runA)).toEqual(Array.from({ length: inserts - countB }, (_, i) => i + 1));
  });

  it('lets exactly one of several parallel inserts claim the same explicit seq', async () => {
    const start = Number(await psql(`select max(seq) from public.run_events where run_id = '${runA}'`));
    const target = start + 1;
    const results = await Promise.all(Array.from({ length: 10 }, () => settle(insertAs(runA, target))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(await psql(`select count(*) from public.run_events where run_id = '${runA}' and seq = ${target}`)).toBe('1');
  });
});
