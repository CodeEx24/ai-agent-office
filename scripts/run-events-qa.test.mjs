// AGO-102 QA: independent integration tests for run_events (append-only + per-run seq), written from the
// acceptance criteria, not from the implementer's suite. Needs the shared local Supabase stack, so it only
// runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-102-qa
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/run-events-qa.test.mjs
//   node scripts/db-lock.mjs release AGO-102-qa
// AC1: any role (anon, authenticated, service_role over PostgREST, owner over SQL) cannot update/delete/empty.
// AC2: inserts carry a per-run seq that must increase (max + 1), also under concurrent connections.
// The local service_role key is read from `supabase status` at run time and never printed.

import { execFile, execSync } from 'node:child_process';
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

// Resolves to { ok, message } so tests can assert the error text instead of just "something failed".
const attempt = (sql) =>
  run('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql]).then(
    () => ({ ok: true, message: '' }),
    (error) => ({ ok: false, message: String(error.stderr ?? error.message) }),
  );

function localStackEnv() {
  const out = execSync('pnpm exec supabase status -o env', { encoding: 'utf8' });
  const read = (name) => out.match(new RegExp(`^${name}="?([^"\\r\\n]+)"?`, 'm'))?.[1];
  return { url: read('API_URL'), serviceKey: read('SERVICE_ROLE_KEY'), anonKey: read('ANON_KEY') };
}

describe.skipIf(!enabled)('AGO-102 run_events (QA)', () => {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const runCount = randomUUID();
  const stack = enabled ? localStackEnv() : {};
  const api = (key, method, path, body, extra = {}) =>
    fetch(`${stack.url}/rest/v1/${path}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const seqs = async (id) =>
    (await psql(`select coalesce(string_agg(seq::text, ',' order by seq), '') from public.run_events where run_id = '${id}'`))
      .split(',').filter(Boolean).map(Number);
  const insertSql = (id, seq, role = 'service_role') =>
    `set role ${role}; insert into public.run_events (workspace_id, run_id, type${seq ? ', seq' : ''})
     values ('${workspaceId}', '${id}', 'qa'${seq ? `, ${seq}` : ''})`;

  beforeAll(async () => {
    await psql(`
      insert into public.workspaces (id, name) values ('${workspaceId}', 'AGO-102 QA'), ('${otherWorkspaceId}', 'AGO-102 QA other');
      insert into public.agents (id, workspace_id, name) values ('${agentId}', '${workspaceId}', 'qa agent');
      insert into public.runs (id, workspace_id, agent_id) values
        ('${runId}', '${workspaceId}', '${agentId}'), ('${runCount}', '${workspaceId}', '${agentId}');
      insert into public.run_events (workspace_id, run_id, type) values
        ('${workspaceId}', '${runId}', 'first'), ('${workspaceId}', '${runId}', 'second')`);
  });

  afterAll(async () => {
    if (!enabled) return;
    // Workspace delete is refused while events exist (RESTRICT), so use the test-only teardown.
    await psql(teardownRunEventsSql([workspaceId, otherWorkspaceId]));
  });

  describe('AC1: update/delete/truncate on run_events is rejected for any role', () => {
    it('AC1: service_role over PostgREST cannot PATCH an event (42501)', async () => {
      const res = await api(stack.serviceKey, 'PATCH', `run_events?run_id=eq.${runId}&seq=eq.1`, { type: 'tampered' });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('42501');
      expect(await psql(`select type from public.run_events where run_id = '${runId}' and seq = 1`)).toBe('first');
    });

    it('AC1: service_role over PostgREST cannot DELETE an event (42501)', async () => {
      const res = await api(stack.serviceKey, 'DELETE', `run_events?run_id=eq.${runId}&seq=eq.1`);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('42501');
      expect(await seqs(runId)).toEqual([1, 2]);
    });

    it('AC1: service_role over PostgREST cannot upsert over an existing event (merge-duplicates)', async () => {
      const res = await api(
        stack.serviceKey, 'POST', 'run_events?on_conflict=workspace_id,run_id,seq',
        { workspace_id: workspaceId, run_id: runId, seq: 1, type: 'tampered' },
        { Prefer: 'resolution=merge-duplicates' },
      );
      expect(res.ok).toBe(false);
      expect((await res.json()).code).toBe('42501');
      expect(await psql(`select type from public.run_events where run_id = '${runId}' and seq = 1`)).toBe('first');
    });

    it('AC1: anon cannot PATCH or DELETE over PostgREST', async () => {
      for (const method of ['PATCH', 'DELETE']) {
        const res = await api(stack.anonKey, method, `run_events?run_id=eq.${runId}`, method === 'PATCH' ? { type: 'x' } : undefined);
        expect(res.ok, method).toBe(false);
        expect([401, 403], method).toContain(res.status);
      }
      expect(await seqs(runId)).toEqual([1, 2]);
    });

    it('AC1: the table owner (postgres) cannot update, delete or truncate, even via MERGE or replica mode', async () => {
      for (const sql of [
        `update public.run_events set type = 'x' where run_id = '${runId}'`,
        `delete from public.run_events where run_id = '${runId}'`,
        `truncate public.run_events`,
        `merge into public.run_events t using (select id from public.run_events limit 1) s on t.id = s.id when matched then delete`,
        `merge into public.run_events t using (select id from public.run_events limit 1) s on t.id = s.id when matched then update set type = 'x'`,
        `set session_replication_role = replica; delete from public.run_events where run_id = '${runId}'`,
      ]) {
        const result = await attempt(sql);
        expect(result.ok, sql).toBe(false);
        expect(result.message, sql).toContain('run_events is append-only');
      }
      expect(await seqs(runId)).toEqual([1, 2]);
    });

    it('AC1: application roles cannot disable or drop the guard triggers or switch to replica mode', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const sql of [
          'alter table public.run_events disable trigger run_events_block_update_delete',
          'alter table public.run_events disable trigger all',
          'drop trigger run_events_block_update_delete on public.run_events',
          'alter table public.run_events enable replica trigger run_events_block_update_delete',
        ]) {
          const result = await attempt(`set role ${role}; ${sql}`);
          expect(result.ok, `${role}: ${sql}`).toBe(false);
          expect(result.message).toMatch(/must be owner/);
        }
        const replica = await attempt(`set role ${role}; set session_replication_role = replica`);
        expect(replica.ok).toBe(false);
        expect(replica.message).toMatch(/permission denied/);
      }
    });

    it('AC1: deleting a run or an agent that has events is refused and keeps the events', async () => {
      for (const sql of [
        `delete from public.runs where id = '${runId}'`,
        `delete from public.agents where id = '${agentId}'`,
      ]) {
        for (const role of ['service_role', 'postgres']) {
          const result = await attempt(`set role ${role}; ${sql}`);
          expect(result.ok, `${role}: ${sql}`).toBe(false);
          expect(result.message).toContain('violates foreign key constraint');
        }
      }
      expect(await seqs(runId)).toEqual([1, 2]);
    });
  });

  describe('AC1 (fix round 1): deleting a workspace or run cannot erase events', () => {
    it('AC1: service_role over PostgREST cannot DELETE a workspace that has events (23503), events stay intact', async () => {
      const res = await api(stack.serviceKey, 'DELETE', `workspaces?id=eq.${workspaceId}`);
      expect(res.ok).toBe(false);
      expect((await res.json()).code).toBe('23503');
      expect(await seqs(runId)).toEqual([1, 2]);
    });

    it('AC1: service_role over PostgREST cannot DELETE a run that has events (23503)', async () => {
      const res = await api(stack.serviceKey, 'DELETE', `runs?id=eq.${runId}`);
      expect(res.ok).toBe(false);
      expect((await res.json()).code).toBe('23503');
      expect(await seqs(runId)).toEqual([1, 2]);
    });

    it('AC1: anon cannot DELETE a workspace over PostgREST, events stay intact', async () => {
      const res = await api(stack.anonKey, 'DELETE', `workspaces?id=eq.${workspaceId}`);
      expect(res.ok).toBe(false);
      expect([401, 403]).toContain(res.status);
      expect(await seqs(runId)).toEqual([1, 2]);
    });

    it('AC1: the owner (postgres) cannot delete a workspace with events, in one statement or a multi-row delete', async () => {
      for (const sql of [
        `delete from public.workspaces where id = '${workspaceId}'`,
        `delete from public.workspaces where id in ('${workspaceId}', '${otherWorkspaceId}')`,
      ]) {
        const result = await attempt(sql);
        expect(result.ok, sql).toBe(false);
        expect(result.message).toContain('violates foreign key constraint');
      }
      expect(await seqs(runId)).toEqual([1, 2]);
      expect(await psql(`select count(*) from public.workspaces where id = '${otherWorkspaceId}'`)).toBe('1');
    });

    it('AC1: a workspace and a run without events can still be deleted over PostgREST', async () => {
      const emptyWorkspace = randomUUID();
      const emptyAgent = randomUUID();
      const emptyRun = randomUUID();
      await psql(`
        insert into public.workspaces (id, name) values ('${emptyWorkspace}', 'AGO-102 QA empty');
        insert into public.agents (id, workspace_id, name) values ('${emptyAgent}', '${emptyWorkspace}', 'empty agent');
        insert into public.runs (id, workspace_id, agent_id) values ('${emptyRun}', '${emptyWorkspace}', '${emptyAgent}')`);
      expect((await api(stack.serviceKey, 'DELETE', `runs?id=eq.${emptyRun}`)).ok).toBe(true);
      expect((await api(stack.serviceKey, 'DELETE', `workspaces?id=eq.${emptyWorkspace}`)).ok).toBe(true);
      expect(await psql(`select count(*) from public.workspaces where id = '${emptyWorkspace}'`)).toBe('0');
    });

    it('AC1: no teardown or bypass is reachable through the API (no RPC), and the guard stays ENABLE ALWAYS', async () => {
      for (const name of ['teardown_run_events', 'run_events_teardown', 'run_events_block_change', 'disable_run_events_guard']) {
        for (const key of [stack.serviceKey, stack.anonKey]) {
          const res = await api(key, 'POST', `rpc/${name}`, {});
          expect(res.ok, name).toBe(false);
          expect([401, 403, 404], name).toContain(res.status);
        }
      }
      expect(
        await psql(`select string_agg(tgenabled::text, '') from pg_trigger where tgrelid = 'public.run_events'::regclass and not tgisinternal`),
      ).toMatch(/^A+$/);
    });

    it('AC1: the test-only teardown re-enables the guard, and rolls back whole (workspace and events kept) when it fails', async () => {
      const scratchWorkspace = randomUUID();
      const scratchAgent = randomUUID();
      const scratchRun = randomUUID();
      await psql(`
        insert into public.workspaces (id, name) values ('${scratchWorkspace}', 'AGO-102 QA scratch');
        insert into public.agents (id, workspace_id, name) values ('${scratchAgent}', '${scratchWorkspace}', 'scratch agent');
        insert into public.runs (id, workspace_id, agent_id) values ('${scratchRun}', '${scratchWorkspace}', '${scratchAgent}');
        insert into public.run_events (workspace_id, run_id, type) values ('${scratchWorkspace}', '${scratchRun}', 'keep')`);
      const guardStates = () =>
        psql(`select string_agg(tgenabled::text, '') from pg_trigger where tgrelid = 'public.run_events'::regclass and not tgisinternal`);

      // A failing teardown (invalid uuid as the second id) must not leave the guard off nor remove anything.
      const failed = await attempt(teardownRunEventsSql([scratchWorkspace, 'not-a-uuid']));
      expect(failed.ok).toBe(false);
      expect(await guardStates()).toMatch(/^A+$/);
      expect(await psql(`select count(*) from public.run_events where workspace_id = '${scratchWorkspace}'`)).toBe('1');

      await psql(teardownRunEventsSql([scratchWorkspace]));
      expect(await guardStates()).toMatch(/^A+$/);
      expect(await psql(`select count(*) from public.workspaces where id = '${scratchWorkspace}'`)).toBe('0');
      // Still append-only afterwards.
      const after = await attempt(`delete from public.run_events where workspace_id = '${workspaceId}'`);
      expect(after.ok).toBe(false);
      expect(after.message).toContain('run_events is append-only');
      expect(await seqs(runId)).toEqual([1, 2]);
    });
  });

  describe('AC2: inserts carry a per-run seq that must increase', () => {
    it('AC2: omitting seq over PostgREST (service_role) assigns the next number for the run', async () => {
      const res = await api(
        stack.serviceKey, 'POST', 'run_events',
        { workspace_id: workspaceId, run_id: runId, type: 'api' },
        { Prefer: 'return=representation' },
      );
      expect(res.status).toBe(201);
      expect((await res.json())[0].seq).toBe(3);
    });

    it('AC2: a duplicate, an out-of-order and a gapped explicit seq are rejected; max+1 is accepted', async () => {
      for (const seq of [1, 3, 2, -1, 5, 999999999999]) {
        const result = await attempt(insertSql(runId, seq));
        expect(result.ok, `seq ${seq}`).toBe(false);
        expect(result.message, `seq ${seq}`).toMatch(/seq must be the next number|check constraint/);
      }
      expect((await attempt(insertSql(runId, 4))).ok).toBe(true);
      expect(await seqs(runId)).toEqual([1, 2, 3, 4]);
    });

    it('AC2: authenticated cannot insert, so an end user cannot forge a seq', async () => {
      const result = await attempt(insertSql(runId, 5, 'authenticated'));
      expect(result.ok).toBe(false);
      expect(await seqs(runId)).toEqual([1, 2, 3, 4]);
    });

    it('AC2: an event for a run under another workspace is rejected, so a run cannot get a second seq 1', async () => {
      const result = await attempt(
        `insert into public.run_events (workspace_id, run_id, type) values ('${otherWorkspaceId}', '${runId}', 'x')`,
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain('violates foreign key constraint');
    });

    it('AC2: inserts under REPEATABLE READ or SERIALIZABLE are refused', async () => {
      for (const level of ['repeatable read', 'serializable']) {
        const result = await attempt(
          `begin isolation level ${level}; insert into public.run_events (workspace_id, run_id, type) values ('${workspaceId}', '${runId}', 'x'); commit`,
        );
        expect(result.ok, level).toBe(false);
        expect(result.message).toContain('READ COMMITTED');
      }
    });

    it('AC2: parallel connections inserting into one run get distinct gap-free seq, and runs stay independent', async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => attempt(insertSql(i % 3 === 0 ? runCount : runId))),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      const a = await seqs(runId);
      const b = await seqs(runCount);
      expect(a).toEqual(Array.from({ length: a.length }, (_, i) => i + 1));
      expect(b).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      expect(a).toHaveLength(4 + 20);
    });

    it('AC2: mixing omitted and explicit seq in parallel never duplicates and never leaves a gap', async () => {
      const next = (await seqs(runId)).length + 1;
      const results = await Promise.all([
        ...Array.from({ length: 8 }, () => attempt(insertSql(runId, next))),
        ...Array.from({ length: 8 }, () => attempt(insertSql(runId))),
      ]);
      const wins = results.filter((r) => r.ok).length;
      expect(wins).toBeGreaterThanOrEqual(8); // every omitted insert succeeds; the explicit ones race for one number
      const all = await seqs(runId);
      expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
      expect(all).toHaveLength(next - 1 + wins);
    });
  });
});
