// AGO-84: the kill switch migration is reversible. Static checks always run; against the shared LOCAL stack
// (RUN_DB_TESTS=1, inside the db lock) it rolls the migration back, re-applies it and compares the schema dumps:
//   node scripts/db-lock.mjs acquire AGO-84
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-84-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-84
// Local container only (docker exec); no URL is used, so a hosted project cannot be reached.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';
import { normalizeSchemaDump } from './schema-dump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_ago_84_kill_switch.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-84 migration not found');
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
const hasTable = () => psql(`select count(*) from pg_class where relnamespace = 'private'::regnamespace and relname = 'kill_switches'`) === '1';

describe('AGO-84 migration files', () => {
  it('rolls back everything the migration creates, without cascade', () => {
    expect(DOWN).toContain('drop table if exists private.kill_switches');
    expect(DOWN).toContain('drop function if exists public.activate_kill_switch');
    expect(DOWN).toContain('drop function if exists public.release_kill_switch');
    expect(DOWN).toContain('drop trigger if exists check_kill_switch_on_credential_issue');
    expect(DOWN).toContain('drop function if exists private.check_kill_switch_on_credential_issue');
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('keeps the latch table closed to every API role, with RLS on', () => {
    expect(UP).toContain('alter table private.kill_switches enable row level security');
    expect(UP).toMatch(/revoke all on private\.kill_switches from public, anon, authenticated, service_role/);
    expect(UP).not.toMatch(/grant [^;]*on private\.kill_switches/i);
  });

  it('puts both functions behind a human session and an owner check, for authenticated only', () => {
    expect(UP.match(/private\.is_member\(p_workspace_id, 'owner'\)/g)).toHaveLength(2);
    expect(UP.match(/v_user is null/g)).toHaveLength(2);
    expect(UP.match(/'agent_id', 'run_id', 'agent_credential'/g)).toHaveLength(2);
    for (const fn of ['activate_kill_switch', 'release_kill_switch']) {
      expect(UP).toMatch(new RegExp(`revoke all on function public\\.${fn}[^;]*from public, anon, authenticated, service_role`));
      expect(UP).toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]*to authenticated;`));
    }
  });

  it('does not write run_events, change runs or delete anything from the kill switch functions', () => {
    for (const fn of ['activate_kill_switch', 'release_kill_switch']) {
      const body = new RegExp(`create function public\\.${fn}[\\s\\S]*?\\n\\$\\$;`).exec(UP)?.[0] ?? '';
      expect(body).not.toBe('');
      expect(body).not.toMatch(/insert into public\.run_events/i);
      expect(body).not.toMatch(/update public\.runs/i);
      expect(body).not.toMatch(/\bdelete\b/i);
    }
  });

  it('leaves the AGO-148 issuance check function untouched', () => {
    expect(UP).not.toMatch(/(create or replace|drop) function private\.check_agent_credential_issue/);
  });
});

describe.skipIf(!enabled)('AGO-84 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    expect(hasTable()).toBe(true);
    const applied = dumpSchema();
    try {
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasTable()).toBe(false);
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasTable()) psql(`begin;\n${UP}\ncommit;`);
    }
    expect(hasTable()).toBe(true);
    expect(dumpSchema()).toBe(applied);
  });
});
