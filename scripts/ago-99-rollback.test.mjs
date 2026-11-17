// AGO-99: the agent mode migration is reversible. Static checks always run; against the shared LOCAL stack
// (RUN_DB_TESTS=1, inside the db lock) it rolls the migration back, re-applies it and compares the schema dumps:
//   node scripts/db-lock.mjs acquire AGO-99
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-99-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-99
// Local container only (docker exec); no URL is used, so a hosted project cannot be reached.
// The rollback drops agent_mode_changes, so the mode log of the local database is lost (agents keep their modes).

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';
import { normalizeSchemaDump } from './schema-dump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_ago_99_agent_mode_promotion.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-99 migration not found');
const UP = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${STAMP}.sql`), 'utf8');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const enabled = process.env.RUN_DB_TESTS === '1';

function docker(args, input) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}
const psql = (sql) => docker(['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At'], sql).trim();
const dumpSchema = () =>
  normalizeSchemaDump(
    docker(['pg_dump', '-U', 'postgres', '-s', '--no-owner', '-n', 'public', '-n', 'private', 'postgres'])
      .split('\n')
      .filter((line) => !/^\\(un)?restrict /.test(line))
      .join('\n'),
  );
// What the migration creates, as one number: the table, the CHECK, the two triggers on agents and the three functions.
const objectCount = () =>
  Number(
    psql(`select
      (select count(*) from pg_class where oid = to_regclass('public.agent_mode_changes'))
      + (select count(*) from pg_constraint where conrelid = 'public.agents'::regclass and conname = 'agents_mode_check')
      + (select count(*) from pg_trigger where tgrelid = 'public.agents'::regclass and tgname in ('agents_guard_mode_insert', 'agents_log_mode_change'))
      + (select count(*) from pg_proc where proname in ('set_agent_mode', 'agents_guard_mode', 'agents_log_mode_change', 'agent_mode_changes_block_change'))`),
  );
const OBJECTS = 1 + 1 + 2 + 4;

describe('AGO-99 migration files', () => {
  it('rolls back everything the migration creates, without cascade', () => {
    expect(DOWN).toContain('drop function if exists public.set_agent_mode');
    expect(DOWN).toContain('drop trigger if exists agents_log_mode_change on public.agents');
    expect(DOWN).toContain('drop function if exists private.agents_log_mode_change');
    expect(DOWN).toContain('drop trigger if exists agents_guard_mode_insert on public.agents');
    expect(DOWN).toContain('drop function if exists private.agents_guard_mode');
    expect(DOWN).toContain('drop table if exists public.agent_mode_changes');
    expect(DOWN).toContain('drop function if exists private.agent_mode_changes_block_change');
    expect(DOWN).toContain('drop constraint if exists agents_mode_check');
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('has no session flag and keeps both guards firing for every session', () => {
    expect(UP).not.toContain('ago.mode_change');
    expect(UP).toContain('enable always trigger agents_guard_mode_insert');
    expect(UP).toContain('enable always trigger agents_log_mode_change');
    expect(UP).not.toMatch(/\bDRAFT\b/);
    expect(DOWN).not.toMatch(/\bDRAFT\b/);
  });

  it('puts the log trigger behind an owner check and a log row, and the RPC behind authenticated only', () => {
    const body = /create function private\.agents_log_mode_change[\s\S]*?\n\$\$;/.exec(UP)?.[0] ?? '';
    expect(body).not.toBe('');
    expect(body).toContain("private.is_member(new.workspace_id, 'owner')");
    expect(body).toContain('auth.uid() is null');
    expect(body).toContain('insert into public.agent_mode_changes');
    expect(UP).toMatch(/revoke all on function public\.set_agent_mode[^;]*from public, anon, authenticated, service_role/);
    expect(UP).toMatch(/grant execute on function public\.set_agent_mode[^;]*to authenticated;/);
  });
});

describe.skipIf(!enabled)('AGO-99 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    expect(objectCount()).toBe(OBJECTS);
    const applied = dumpSchema();
    try {
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(objectCount()).toBe(0);
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (objectCount() === 0) psql(`begin;\n${UP}\ncommit;`);
    }
    expect(objectCount()).toBe(OBJECTS);
    expect(dumpSchema()).toBe(applied);
  });
});
