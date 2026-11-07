// AGO-128: the skill-versions migration is reversible. Against the shared LOCAL stack this applies the rollback
// file, checks the schema is back to the AGO-107 shape (member-level writes on skills and agent_skills), re-applies
// the migration and checks the schema dump is byte-for-byte what it was before (an empty diff). Same proof as
// scripts/ago-125-rollback.test.mjs. It needs the local stack, so it only runs with RUN_DB_TESTS=1 and inside the lock:
//   node scripts/db-lock.mjs acquire AGO-128
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-128-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-128
// It ends with the migration applied again (a `finally` restores it even if an assertion fails). For a moment the
// migration is NOT applied, so never run it in parallel with another DB suite. Local container only (docker exec);
// no URL is ever used, so a hosted project cannot be reached. Rolling back drops the version history (local data).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';
import { normalizeSchemaDump } from './schema-dump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = '20261106150001_ago_128_skill_versions';
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
const hasTable = () => psql(`select to_regclass('public.skill_versions') is not null`) === 't';
const functionCount = () =>
  Number(psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname in ('bump_skill_version', 'append_skill_version', 'skill_versions_block_change')`));
const skillTriggerCount = () =>
  Number(psql(`select count(*) from pg_trigger where tgrelid = 'public.skills'::regclass and tgname in ('bump_skill_version', 'append_skill_version') and not tgisinternal`));
const policyNames = (table) =>
  psql(`select coalesce(string_agg(polname, ',' order by polname), '') from pg_policy where polrelid = 'public.${table}'::regclass`);

describe('AGO-128 migration files', () => {
  it('rolls back everything the migration creates', () => {
    expect(DOWN).toContain('drop table if exists public.skill_versions');
    for (const trigger of ['append_skill_version', 'bump_skill_version']) {
      expect(DOWN).toContain(`drop trigger if exists ${trigger} on public.skills`);
    }
    for (const fn of ['skill_versions_block_change()', 'append_skill_version()', 'bump_skill_version()']) {
      expect(DOWN).toContain(`drop function if exists private.${fn}`);
    }
    expect(DOWN).toContain('drop constraint if exists skills_body_length_check');
    for (const name of ['skill_versions_select_viewer', 'skills_insert_owner', 'skills_update_owner', 'agent_skills_insert_owner', 'agent_skills_delete_owner']) {
      expect(DOWN).toContain(`drop policy if exists ${name}`);
    }
  });

  it('restores the AGO-107 member-level policies and the skills delete grant', () => {
    for (const name of ['skills_insert_member', 'skills_update_member', 'skills_delete_member', 'agent_skills_insert_member', 'agent_skills_delete_member']) {
      expect(DOWN).toContain(`create policy ${name}`);
    }
    expect(DOWN).toContain('grant delete on public.skills to authenticated');
  });

  it('never cascades, so a rollback cannot silently drop something it does not name', () => {
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('pins the search_path of every function', () => {
    const definers = UP.match(/security definer\s+set search_path = ''/g) ?? [];
    expect(definers).toHaveLength(2);
    expect((UP.match(/set search_path = ''/g) ?? []).length).toBe(3);
  });

  it('gives API roles read-only access to the version history', () => {
    expect(UP).toContain('grant select on public.skill_versions to authenticated');
    expect(UP).not.toMatch(/grant (insert|update|delete|all)[^;]*public\.skill_versions/i);
    expect(UP).toContain('revoke delete on public.skills from authenticated');
  });

  it('makes every write policy on skills and agent_skills owner-only', () => {
    expect(UP).not.toMatch(/is_member\(workspace_id, 'member'\)/);
    expect(UP).not.toMatch(/create policy \w+_member/);
  });

  it('blocks updates and non-cascade deletes of a version for every role', () => {
    expect(UP).toContain('before update on public.skill_versions');
    expect(UP).toContain('before delete on public.skill_versions');
    expect(UP).toContain("errcode = '42501'");
  });
});

describe.skipIf(!enabled)('AGO-128 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    // 1. starting point: migration applied (db:reset)
    expect(hasTable()).toBe(true);
    expect(functionCount()).toBe(3);
    expect(skillTriggerCount()).toBe(2);
    const applied = dumpSchema();
    const skillPolicies = policyNames('skills');
    const linkPolicies = policyNames('agent_skills');
    expect(skillPolicies).toBe('skills_insert_owner,skills_select_viewer,skills_update_owner');
    expect(linkPolicies).toBe('agent_skills_delete_owner,agent_skills_insert_owner,agent_skills_select_viewer');

    try {
      // 2. roll back: the table, triggers and functions are gone and the member policies are back
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasTable()).toBe(false);
      expect(functionCount()).toBe(0);
      expect(skillTriggerCount()).toBe(0);
      expect(policyNames('skills')).toBe('skills_delete_member,skills_insert_member,skills_select_viewer,skills_update_member');
      expect(policyNames('agent_skills')).toBe('agent_skills_delete_member,agent_skills_insert_member,agent_skills_select_viewer');
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasTable()) psql(`begin;\n${UP}\ncommit;`);
    }

    // 3. after rollback and re-apply: an empty diff against the first dump, and the backfill ran again
    expect(hasTable()).toBe(true);
    expect(policyNames('skills')).toBe(skillPolicies);
    expect(policyNames('agent_skills')).toBe(linkPolicies);
    expect(dumpSchema()).toBe(applied);
    const gaps = psql(
      `select count(*) from public.skills s where not exists (select 1 from public.skill_versions v where v.skill_id = s.id and v.version = s.version)`,
    );
    expect(gaps).toBe('0');
  });
});
