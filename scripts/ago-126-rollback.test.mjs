// AGO-126: the Realtime publication migration is reversible. Static checks always run; against the shared LOCAL stack
// (RUN_DB_TESTS=1, inside the db lock) it rolls the migration back, re-applies it and checks run_events leaves and
// rejoins the publication with its rows and RLS untouched:
//   node scripts/db-lock.mjs acquire AGO-126
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-126-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-126
// Local container only (docker exec); no URL is used, so a hosted project cannot be reached.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_ago_126_realtime_run_events.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-126 migration not found');
const UP = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${STAMP}.sql`), 'utf8');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const enabled = process.env.RUN_DB_TESTS === '1';

function docker(args, input) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}
const psql = (sql) => docker(['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At'], sql).trim();
const published = () =>
  psql(`select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'run_events'`);

describe('AGO-126 migration files', () => {
  it('only touches the supabase_realtime publication for run_events', () => {
    expect(UP).toContain('alter publication supabase_realtime add table public.run_events');
    expect(DOWN).toContain('alter publication supabase_realtime drop table public.run_events');
    const rest = (UP + DOWN).replace('alter publication supabase_realtime drop table public.run_events', '');
    expect(rest).not.toMatch(/drop table|cascade|truncate|delete from/i);
  });
});

describe.skipIf(!enabled)('AGO-126 rollback round trip (local stack)', () => {
  it('drops run_events from the publication and re-adds it, idempotently, keeping rows and RLS', () => {
    assertLocalOnly();
    expect(published()).toBe('1');
    const rls = () => psql(`select relrowsecurity from pg_class where oid = 'public.run_events'::regclass`);
    const rowsBefore = psql('select count(*) from public.run_events');
    expect(rls()).toBe('t');

    psql(DOWN);
    expect(published()).toBe('0');
    psql(DOWN); // running the rollback twice is harmless
    expect(published()).toBe('0');

    psql(UP);
    expect(published()).toBe('1');
    psql(UP); // re-applying is harmless
    expect(published()).toBe('1');

    expect(rls()).toBe('t');
    expect(psql('select count(*) from public.run_events')).toBe(rowsBefore);
  });
});
