// AGO-125: the capability-catalog migration is reversible. Against the shared LOCAL stack this applies the
// rollback file, checks the schema is back to the pre-AGO-125 shape, re-applies the migration and checks the
// schema dump is byte-for-byte what it was before (an empty diff). Same proof as scripts/ago-96-rollback.test.mjs.
// It needs the local stack, so it only runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-125
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-125-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-125
// It ends with the migration applied again (a `finally` restores it even if an assertion fails). For a moment
// the migration is NOT applied, so never run it in parallel with another DB suite. Local container only
// (docker exec); no URL is ever used, so a hosted project cannot be reached.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';
import { normalizeSchemaDump } from './schema-dump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = '20261106140001_ago_125_capability_catalog';
const UP = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${STAMP}.sql`), 'utf8');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const enabled = process.env.RUN_DB_TESTS === '1';

function docker(args, input) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}
const psql = (sql) => docker(['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At'], sql).trim();
// pg_dump prints a random \restrict / \unrestrict token per run; drop those two lines before comparing.
const dumpSchema = () =>
  normalizeSchemaDump(
    docker(['pg_dump', '-U', 'postgres', '-s', '--no-owner', '-n', 'public', '-n', 'private', 'postgres'])
      .split('\n')
      .filter((line) => !/^\\(un)?restrict /.test(line))
      .join('\n'),
  );
const hasTable = () => psql(`select to_regclass('public.capabilities') is not null`) === 't';
const functionCount = () =>
  Number(psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname in ('seed_workspace_capabilities', 'seed_capabilities_for_new_workspace')`));
const triggerCount = () =>
  Number(psql(`select count(*) from pg_trigger where tgrelid = 'public.workspaces'::regclass and tgname = 'seed_capabilities' and not tgisinternal`));
const policyCount = () =>
  Number(psql(`select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace`));

describe('AGO-125 migration files', () => {
  it('rolls back everything the migration creates', () => {
    expect(DOWN).toContain('drop table if exists public.capabilities');
    expect(DOWN).toContain('drop trigger if exists seed_capabilities on public.workspaces');
    expect(DOWN).toContain('drop function if exists private.seed_capabilities_for_new_workspace()');
    expect(DOWN).toContain('drop function if exists private.seed_workspace_capabilities(uuid)');
    for (const name of ['capabilities_select_viewer', 'capabilities_update_owner']) {
      expect(DOWN).toContain(`drop policy if exists ${name}`);
    }
  });

  it('never cascades, so a rollback cannot silently drop something it does not name', () => {
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('keeps tier 3 and 4 from ever being automatic in the table definition', () => {
    expect(UP).toContain("constraint capabilities_high_tier_never_automatic check (tier < 3 or default_mode = 'approval')");
  });

  it('pins the search_path of both security definer functions', () => {
    const definers = UP.match(/security definer\s+set search_path = ''/g) ?? [];
    expect(definers).toHaveLength(2);
  });

  it('never grants insert or delete on the catalog to API roles', () => {
    expect(UP).not.toMatch(/grant (insert|delete|all)[^;]*public\.capabilities/i);
    expect(UP).toContain('grant update (enabled, description) on public.capabilities to authenticated');
  });
});

describe.skipIf(!enabled)('AGO-125 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    // 1. starting point: migration applied (db:reset)
    expect(hasTable()).toBe(true);
    expect(functionCount()).toBe(2);
    expect(triggerCount()).toBe(1);
    const applied = dumpSchema();
    const policiesBefore = policyCount();

    try {
      // 2. roll back: table, trigger, functions and the two policies are gone
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasTable()).toBe(false);
      expect(functionCount()).toBe(0);
      expect(triggerCount()).toBe(0);
      expect(policyCount()).toBe(policiesBefore - 2);
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasTable()) psql(`begin;\n${UP}\ncommit;`);
    }

    // 3. after rollback and re-apply: an empty diff against the first dump, and the backfill ran again
    expect(hasTable()).toBe(true);
    expect(policyCount()).toBe(policiesBefore);
    expect(dumpSchema()).toBe(applied);
    const gaps = psql(
      `select count(*) from public.workspaces w where (select count(*) from public.capabilities c where c.workspace_id = w.id) <> 12`,
    );
    expect(gaps).toBe('0');
  });
});
