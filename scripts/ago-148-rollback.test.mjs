// AGO-148: the agent identity and credentials migration is reversible. Against the shared LOCAL stack this applies
// the rollback file, checks both tables, the four functions and the two triggers are gone, re-applies the migration
// and checks the schema dump is byte-for-byte what it was before (an empty diff). Same proof as
// scripts/ago-128-rollback.test.mjs. It needs the local stack, so it only runs with RUN_DB_TESTS=1 and inside the lock:
//   node scripts/db-lock.mjs acquire AGO-148
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-148-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-148
// It ends with the migration applied again (a `finally` restores it even if an assertion fails). For a moment the
// migration is NOT applied, so never run it in parallel with another DB suite. Local container only (docker exec);
// no URL is ever used, so a hosted project cannot be reached. Rolling back drops the issuance log (local data).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = '20261107130001_ago_148_agent_identity_credentials';
const UP = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${STAMP}.sql`), 'utf8');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const enabled = process.env.RUN_DB_TESTS === '1';
const FUNCTIONS = ['create_agent_identity', 'check_agent_credential_issue', 'agent_credentials_block_change', 'revoke_credentials_on_run_end', 'revoke_credentials_on_agent_archive', 'revoke_credentials_on_grant_removed'];

function docker(args, input) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}
const psql = (sql) => docker(['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At'], sql).trim();
// pg_dump prints a random \restrict / \unrestrict token per run; drop those two lines before comparing.
const dumpSchema = () =>
  docker(['pg_dump', '-U', 'postgres', '-s', '--no-owner', '-n', 'public', '-n', 'private', 'postgres'])
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .join('\n');
const tableCount = () =>
  Number(psql(`select count(*) from unnest(array['public.agent_identities', 'public.agent_credentials']) t where to_regclass(t) is not null`));
const functionCount = () =>
  Number(psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname in (${FUNCTIONS.map((f) => `'${f}'`).join(', ')})`));
const outsideTriggerCount = () =>
  Number(psql(`select count(*) from pg_trigger where not tgisinternal and tgname in ('create_agent_identity', 'revoke_credentials_on_run_end')`));

describe('AGO-148 migration files', () => {
  it('rolls back everything the migration creates', () => {
    for (const table of ['agent_credentials', 'agent_identities']) {
      expect(DOWN).toContain(`drop table if exists public.${table}`);
    }
    for (const fn of FUNCTIONS) {
      expect(DOWN).toContain(`drop function if exists private.${fn}()`);
    }
    expect(DOWN).toContain('drop trigger if exists revoke_credentials_on_run_end on public.runs');
    expect(DOWN).toContain('drop trigger if exists create_agent_identity on public.agents');
    for (const policy of ['agent_credentials_select_viewer', 'agent_identities_select_viewer']) {
      expect(DOWN).toContain(`drop policy if exists ${policy}`);
    }
  });

  it('never cascades, so a rollback cannot silently drop something it does not name', () => {
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('pins the search_path of every function and makes the definers unreachable for API roles', () => {
    expect((UP.match(/security definer\s+set search_path = ''/g) ?? []).length).toBe(6);
    for (const fn of FUNCTIONS) {
      expect(UP).toContain(`revoke all on function private.${fn}() from public, anon, authenticated`);
    }
  });

  it('gives API roles read-only access and service_role only the revoked_at update', () => {
    expect(UP).toContain('grant select on public.agent_identities, public.agent_credentials to authenticated');
    expect(UP).not.toMatch(/grant (insert|update|delete|all)[^;]*to authenticated/i);
    expect(UP).toContain('grant update (revoked_at) on public.agent_credentials to service_role');
  });

  it('caps the lifetime at 15 minutes with a constraint, and blocks update, delete and truncate', () => {
    expect(UP).toContain("expires_at <= issued_at + interval '15 minutes'");
    expect(UP).toContain('before update on public.agent_credentials');
    expect(UP).toContain('before delete on public.agent_credentials');
    expect(UP).toContain('before truncate on public.agent_credentials');
  });
});

describe.skipIf(!enabled)('AGO-148 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    // 1. starting point: migration applied (db:reset)
    expect(tableCount()).toBe(2);
    expect(functionCount()).toBe(FUNCTIONS.length);
    expect(outsideTriggerCount()).toBe(2);
    const applied = dumpSchema();

    try {
      // 2. roll back: the tables, triggers and functions are gone
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(tableCount()).toBe(0);
      expect(functionCount()).toBe(0);
      expect(outsideTriggerCount()).toBe(0);
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (tableCount() === 0) psql(`begin;\n${UP}\ncommit;`);
    }

    // 3. after rollback and re-apply: an empty diff against the first dump, and every agent has its identity again
    expect(tableCount()).toBe(2);
    expect(dumpSchema()).toBe(applied);
    expect(psql(`select count(*) from public.agents a where not exists (select 1 from public.agent_identities i where i.agent_id = a.id)`)).toBe('0');
  });
});
