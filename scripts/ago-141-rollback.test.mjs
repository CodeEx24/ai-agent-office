// AGO-141: the agent-wizard migration is reversible. Static checks always run; against the shared LOCAL stack
// (RUN_DB_TESTS=1, inside the db lock, only after the schema slot is granted and the migration is applied) it rolls
// the migration back, checks the AGO-107 shape returned, re-applies it and compares the schema dumps (empty diff):
//   node scripts/db-lock.mjs acquire AGO-141
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-141-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-141
// Local container only (docker exec); no URL is used, so a hosted project cannot be reached.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';
import { normalizeSchemaDump } from './schema-dump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The timestamp changes when the migration is renamed to the next free one: find it by its suffix.
const STAMP = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_ago_141_agent_wizard.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-141 migration not found');
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
const hasFunction = () => psql(`select to_regprocedure('public.create_agent(uuid,text,text,text,text,integer,uuid[],jsonb)') is not null`) === 't';
const policyNames = (table) =>
  psql(`select coalesce(string_agg(polname, ',' order by polname), '') from pg_policy where polrelid = 'public.${table}'::regclass`);

describe('AGO-141 migration files', () => {
  it('rolls back everything the migration creates', () => {
    expect(DOWN).toContain('drop function if exists public.create_agent');
    expect(DOWN).toContain('drop policy if exists agents_insert_owner');
    expect(DOWN).toContain('drop constraint if exists agent_capabilities_high_tier_never_automatic');
    for (const column of ['mode', 'role', 'model', 'prompt', 'daily_budget_cents']) {
      expect(DOWN).toContain(`drop column if exists ${column}`);
    }
  });

  it('restores the member-level insert policy and the AGO-107 grants', () => {
    expect(DOWN).toContain('create policy agents_insert_member');
    expect(DOWN).toContain('grant insert (workspace_id, name, description) on public.agents to authenticated');
    expect(DOWN).toContain('grant insert (workspace_id, agent_id, capability, tier, granted_by) on public.agent_capabilities to authenticated');
  });

  it('never cascades', () => {
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('pins the search_path and is invoker-rights, so RLS stays the enforcement point', () => {
    expect(UP).toMatch(/security invoker\s+set search_path = ''/);
    expect(UP).not.toMatch(/security definer/i);
  });

  it('keeps mode, status and department_id out of every agents grant', () => {
    const grant = /grant insert \(([^)]*)\)\s+on public\.agents/.exec(UP)?.[1] ?? '';
    expect(grant).not.toMatch(/\b(mode|status|department_id|archived_at)\b/);
  });

  it('only owners can insert agents and the function is not callable by anon', () => {
    expect(UP).toContain("private.is_member(workspace_id, 'owner')");
    expect(UP).toMatch(/revoke all on function public\.create_agent[^;]*from public, anon/);
    expect(UP).toMatch(/grant execute on function public\.create_agent[^;]*to authenticated/);
  });

  it('refuses an automatic tier 3 or 4 grant in the function and with a CHECK', () => {
    expect(UP).toContain("check (tier < 3 or mode = 'approval')");
    expect(UP).toMatch(/v_tier >= 3 and v_mode <> 'approval'/);
  });
});

describe.skipIf(!enabled)('AGO-141 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    expect(hasFunction()).toBe(true);
    const applied = dumpSchema();
    const policies = policyNames('agents');
    expect(policies).toContain('agents_insert_owner');

    try {
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasFunction()).toBe(false);
      expect(policyNames('agents')).toContain('agents_insert_member');
      expect(policyNames('agents')).not.toContain('agents_insert_owner');
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasFunction()) psql(`begin;\n${UP}\ncommit;`);
    }

    expect(hasFunction()).toBe(true);
    expect(policyNames('agents')).toBe(policies);
    expect(dumpSchema()).toBe(applied);
  });
});
