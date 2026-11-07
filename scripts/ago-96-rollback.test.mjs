// AGO-96 AC3: the department-hooks migration is reversible. Against the shared LOCAL stack this applies the
// rollback file, checks the schema is back to the pre-AGO-96 shape, re-applies the migration and checks
// the schema dump is byte-for-byte what it was before (an empty diff), the same proof AGO-74 did by hand.
// It needs the local stack, so it only runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-96
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-96-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-96
// It ends with the migration applied again (a `finally` restores it even if an assertion fails), so the
// database is left exactly as `db:reset` made it. For a moment the migration is NOT applied, so this test
// must never run in parallel with another DB suite: use the db lock and `--no-file-parallelism`.
// Local container only (docker exec); no URL is ever used, so a hosted project cannot be reached.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';
import { normalizeSchemaDump } from './schema-dump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = '20261106130001_ago_96_department_hooks_policies';
const UP = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${STAMP}.sql`), 'utf8');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const enabled = process.env.RUN_DB_TESTS === '1';
const HOOK_TABLES = ['agents', 'tasks', 'approvals', 'notes_index'];

function docker(args, input) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}
const psql = (sql) => docker(['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At'], sql).trim();
/** Schema-only dump of everything the app owns; `public` and `private` hold all of it. */
// pg_dump prints a random \restrict / \unrestrict token per run; drop those two lines before comparing.
// Compared in an order-insensitive form: see scripts/schema-dump.mjs (AGO-202).
const dumpSchema = () =>
  normalizeSchemaDump(
    docker(['pg_dump', '-U', 'postgres', '-s', '--no-owner', '-n', 'public', '-n', 'private', 'postgres'])
      .split('\n')
      .filter((line) => !/^\\(un)?restrict /.test(line))
      .join('\n'),
  );
const hasHooks = () =>
  Number(psql(`select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'department_id'`));
const hasPoliciesTable = () => psql(`select to_regclass('public.policies') is not null`) === 't';
const policyCount = () =>
  Number(psql(`select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace`));

describe('AGO-96 migration files', () => {
  it('rolls back everything the migration creates', () => {
    for (const table of HOOK_TABLES) expect(DOWN).toContain(`alter table public.${table} drop column if exists department_id`);
    expect(DOWN).toContain('drop table if exists public.policies');
    expect(DOWN).toContain('drop function if exists private.bump_policy_version()');
    for (const name of ['policies_select_viewer', 'policies_insert_owner', 'policies_update_owner']) {
      expect(DOWN).toContain(`drop policy if exists ${name}`);
    }
  });

  it('never cascades, so a rollback cannot silently drop something it does not name', () => {
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('keeps department_id free of a foreign key until the departments table exists', () => {
    expect(UP).not.toMatch(/department_id[^,\n]*references/i);
  });
});

describe.skipIf(!enabled)('AGO-96 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    // 1. starting point: migration applied (db:reset)
    expect(hasHooks()).toBe(4);
    expect(hasPoliciesTable()).toBe(true);
    const applied = dumpSchema();
    const policiesBefore = policyCount();

    try {
      // 2. roll back: hooks, table, helper and policies are gone, the AGO-107 policies remain
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasHooks()).toBe(0);
      expect(hasPoliciesTable()).toBe(false);
      expect(psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'bump_policy_version'`)).toBe('0');
      expect(policyCount()).toBe(policiesBefore - 3);
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasPoliciesTable()) psql(`begin;\n${UP}\ncommit;`);
    }

    // 3. the schema after rollback and re-apply: an empty diff against the first dump
    expect(hasHooks()).toBe(4);
    expect(hasPoliciesTable()).toBe(true);
    expect(policyCount()).toBe(policiesBefore);
    expect(dumpSchema()).toBe(applied);
  });
});
