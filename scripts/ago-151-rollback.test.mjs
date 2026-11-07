// AGO-151 (QA): the pgboss schema migration is reversible. Against the shared LOCAL stack this rolls the
// migration back, checks the schema (and every queued job in it) is gone while public data is untouched,
// re-applies the migration, checks the API roles still have no access, and proves a worker can install
// pg-boss again afterwards (rollback + re-apply is a clean round trip). Same shape as ago-128-rollback.test.mjs.
// It needs the local stack, so it only runs with RUN_DB_TESTS=1 and inside the lock:
//   node scripts/db-lock.mjs acquire AGO-151-qa
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-151-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-151-qa
// For a moment the schema does NOT exist, so never run it in parallel with another DB suite that uses the queue.
// Local container only (docker exec); a hosted project cannot be reached. A `finally` re-applies the migration.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = '20261107010001_ago_151_pgboss_schema';
const UP = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${STAMP}.sql`), 'utf8');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'ago-151-proc.mjs');
const enabled = process.env.RUN_DB_TESTS === '1';
const LOCKED = 'anon:false/false,authenticated:false/false,service_role:false/false';

function docker(args, input) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}
const psql = (sql) => docker(['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At'], sql).trim();
const schemaExists = () => psql(`select exists (select 1 from pg_namespace where nspname = 'pgboss')`) === 't';
const jobTableExists = () => psql(`select to_regclass('pgboss.job') is not null`) === 't';
const apiAccess = () =>
  psql(`select string_agg(r || ':' || has_schema_privilege(r, 'pgboss', 'USAGE')::text || '/' || has_schema_privilege(r, 'pgboss', 'CREATE')::text, ',' order by r)
          from unnest(array['anon','authenticated','service_role']) as r`);
const publicCounts = () => psql(`select (select count(*) from public.runs) || '/' || (select count(*) from public.run_events) || '/' || (select count(*) from public.workspaces)`);
const startPgBoss = () =>
  spawnSync(process.execPath, [FIXTURE], {
    env: { ...process.env, ROLE: 'enqueuer', DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:44322/postgres' },
    encoding: 'utf8',
    timeout: 60_000,
  });

describe('AGO-151 migration files', () => {
  it('creates only the pgboss schema and locks it away from every API role', () => {
    const up = UP.toLowerCase();
    expect(up).toContain('create schema if not exists pgboss');
    expect(up).toMatch(/revoke all on schema pgboss from[^;]*anon[^;]*authenticated[^;]*service_role/s);
    expect(up).not.toMatch(/grant [^;]*pgboss/);
    expect(up).not.toMatch(/\bpublic\.\w+/); // touches nothing in public
  });

  it('rolls back by dropping the schema and nothing else', () => {
    const statements = DOWN.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('--'));
    expect(statements).toEqual(['drop schema if exists pgboss cascade;']);
  });
});

describe.skipIf(!enabled)('AGO-151 rollback against the local stack', () => {
  it('apply, roll back, re-apply: pgboss disappears, public data stays, the roles stay locked out, pg-boss installs again', () => {
    assertLocalOnly({});
    // 1. starting point: migration applied (db:reset) and pg-boss's own tables installed by a worker
    startPgBoss();
    expect(schemaExists()).toBe(true);
    expect(jobTableExists()).toBe(true);
    expect(apiAccess()).toBe(LOCKED);
    const before = publicCounts();

    try {
      // 2. roll back: the schema, its tables and every queued job are gone; public data is untouched
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(schemaExists()).toBe(false);
      expect(jobTableExists()).toBe(false);
      expect(publicCounts()).toBe(before);
    } finally {
      // 3. re-apply: the schema is back, empty and locked
      psql(`begin;\n${UP}\ncommit;`);
    }
    expect(schemaExists()).toBe(true);
    expect(apiAccess()).toBe(LOCKED);
    expect(psql(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pgboss'`)).toBe('0');

    // 4. a worker brings pg-boss back on the re-applied schema
    const start = startPgBoss();
    expect(start.stdout).toContain('QA_RESULT []');
    expect(jobTableExists()).toBe(true);
    expect(apiAccess()).toBe(LOCKED);
    expect(publicCounts()).toBe(before);
  }, 180_000);
});
