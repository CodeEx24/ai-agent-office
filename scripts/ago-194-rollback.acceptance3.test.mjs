// AGO-194 round 3 acceptance (tester-functional): the AGO-192 check on pack_events, cardinality(agent_names) =
// cardinality(agent_ids) (pack_events_check), exists after the migration and after its rollback, and refuses a
// mismatched row in both states. Independent of ago-194-rollback.test.mjs: it never commits the rollback. The rollback
// runs inside a transaction that is always rolled back, so the shared local stack keeps the migration applied.
//   node scripts/db-lock.mjs acquire AGO-194
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-194-rollback.acceptance3.test.mjs
//   node scripts/db-lock.mjs release AGO-194

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_ago_194_pack_import.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-194 migration not found');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const enabled = process.env.RUN_DB_TESTS === '1';

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', localDbContainer(), 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-q', '-At'],
    { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
const psqlFailure = (sql) => {
  try {
    psql(sql);
    return '';
  } catch (error) {
    return String(error.stderr ?? error);
  }
};

const CHECK_COUNT = `select count(*) from pg_constraint where conrelid = 'public.pack_events'::regclass and contype = 'c' and conname = 'pack_events_check' and pg_get_constraintdef(oid) like '%cardinality(agent_names)%' and pg_get_constraintdef(oid) like '%cardinality(agent_ids)%';`;

const FIXTURE = `
  insert into auth.users (id, instance_id, aud, role, email)
    values ('19400000-0000-4000-8000-0000000009c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago194-rb3@example.test');
  insert into public.workspaces (id, name) values ('194cccc0-0000-4000-8000-000000000003', 'AGO-194 rollback acc3');
  insert into public.members (id, workspace_id, user_id, role)
    values ('19400000-0000-4000-8000-0000000009d1', '194cccc0-0000-4000-8000-000000000003', '19400000-0000-4000-8000-0000000009c1', 'owner');`;
const MISMATCHED_EXPORT = `
  insert into public.pack_events (workspace_id, kind, exported_by, agent_ids, agent_names, skill_count, checksum)
    values ('194cccc0-0000-4000-8000-000000000003', 'export', '19400000-0000-4000-8000-0000000009d1',
            array['19400000-0000-4000-8000-0000000009e1'::uuid, '19400000-0000-4000-8000-0000000009e2'::uuid], array['only one'], 0, repeat('a', 64));`;
const MATCHED_EXPORT = `
  insert into public.pack_events (workspace_id, kind, exported_by, agent_ids, agent_names, skill_count, checksum)
    values ('194cccc0-0000-4000-8000-000000000003', 'export', '19400000-0000-4000-8000-0000000009d1',
            array['19400000-0000-4000-8000-0000000009e1'::uuid], array['one'], 0, repeat('a', 64));`;

describe.skipIf(!enabled)('AGO-194 round 3: the AGO-192 pack_events check survives the migration and its rollback', () => {
  it('exists after the migration is applied', () => {
    assertLocalOnly({});
    expect(psql(CHECK_COUNT)).toBe('1');
  });

  it('refuses a mismatched row after the migration (SQLSTATE 23514 naming pack_events_check), and accepts a matched one', () => {
    assertLocalOnly({});
    const refused = psqlFailure(`begin;${FIXTURE}${MISMATCHED_EXPORT}rollback;`);
    expect(refused).toContain('23514');
    expect(refused).toContain('pack_events_check');
    expect(psqlFailure(`begin;${FIXTURE}${MATCHED_EXPORT}rollback;`)).toBe('');
  });

  it('still exists inside the rolled-back state, and still refuses a mismatched row there', () => {
    assertLocalOnly({});
    // The transaction always ends in rollback: the stack keeps the migration applied.
    const out = psql(`begin;\n${DOWN}\n${CHECK_COUNT}\nrollback;`);
    expect(out).toBe('1');
    const refused = psqlFailure(`begin;\n${DOWN}\n${FIXTURE}${MISMATCHED_EXPORT}rollback;`);
    expect(refused).toContain('23514');
    expect(refused).toContain('pack_events_check');
    expect(psqlFailure(`begin;\n${DOWN}\n${FIXTURE}${MATCHED_EXPORT}rollback;`)).toBe('');
  });

  it('leaves the migration applied afterwards (the import function is still there)', () => {
    assertLocalOnly({});
    expect(psql(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_agent_pack';`)).toBe('1');
    expect(psql(CHECK_COUNT)).toBe('1');
  });
});
