// AGO-194: the pack import migration is reversible. Static checks always run; against the shared LOCAL stack
// (RUN_DB_TESTS=1, inside the db lock) it rolls the migration back, re-applies it and compares the schema dumps:
//   node scripts/db-lock.mjs acquire AGO-194
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-194-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-194
// Local container only (docker exec); no URL is used, so a hosted project cannot be reached.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { assertLocalOnly, localDbContainer } from './db-seed.mjs';
import { normalizeSchemaDump } from './schema-dump.mjs';

// The live part shells out to docker (pg_dump twice, psql): give the whole file room.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .find((file) => file.endsWith('_ago_194_pack_import.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-194 migration not found');
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
const hasFunction = () => psql(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_agent_pack'`) === '1';

const auditCheckCount = () =>
  psql(
    `select count(*) from pg_constraint where conrelid = 'public.pack_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%cardinality(agent_names)%'`,
  );

describe('AGO-194 migration files', () => {
  it('rolls back everything the migration creates, without cascade, and refuses to lose import events', () => {
    expect(DOWN).toContain('drop function if exists public.import_agent_pack');
    expect(DOWN).toContain('drop column if exists detail');
    expect(DOWN).toMatch(/kind = 'import'/);
    expect(DOWN).toMatch(/raise exception 'rollback refused/);
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('makes the function a SECURITY DEFINER with an empty search_path, behind a human session and the owner check', () => {
    expect(UP).toMatch(/security definer\s+set search_path = ''/);
    expect(UP).toContain('v_user is null');
    expect(UP).toMatch(/'agent_id', 'run_id', 'agent_credential'/);
    expect(UP).toContain("private.is_member(p_workspace_id, 'owner')");
    expect(UP).toMatch(/revoke all on function public\.import_agent_pack[^;]*from public, anon, authenticated, service_role/);
    expect(UP).toMatch(/grant execute on function public\.import_agent_pack[^;]*to authenticated;/);
  });

  it('drops exactly the two intended checks by name and leaves the AGO-192 names/ids check alone', () => {
    const code = (text) =>
      text
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
    const drops = [...code(UP).matchAll(/drop constraint\s+(\w+)/gi)].map((match) => match[1]);
    expect(drops).toEqual(['pack_events_kind_check', 'pack_events_agent_ids_check']);
    expect(code(UP)).not.toMatch(/drop constraint[^;]*pack_events_check/i);
    expect(code(DOWN)).not.toMatch(/pack_events_check/);
    const restored = [...code(DOWN).matchAll(/drop constraint if exists\s+(\w+)/gi)].map((match) => match[1]);
    expect(restored.sort()).toEqual(
      ['pack_events_agent_ids_check', 'pack_events_detail_object', 'pack_events_kind_check'].sort(),
    );
  });

  it('writes a mode only as strict, never a secret, and never reads a tier from the plan', () => {
    const body = /create function public\.import_agent_pack[\s\S]*?\n\$\$;/.exec(UP)?.[0] ?? '';
    expect(body).not.toBe('');
    expect(body).not.toMatch(/insert into public\.agents \([^)]*\bmode\b/i);
    // The one mode write is the reset of an updated agent to strict.
    const assignments = [...body.matchAll(/\bmode\s*=\s*([^\s,;]+)/gi)].map((match) => match[1]);
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((value) => value === "'strict'")).toBe(true);
    expect(body).not.toMatch(/->>\s*'tier'/);
    expect(body).not.toMatch(/agent_credentials|agent_identities|secret/i);
    expect(body).toMatch(/'approval'/);
  });
});

describe.skipIf(!enabled)('AGO-194 rollback against the local stack', () => {
  it('refuses to roll back while an import event exists, and changes nothing', () => {
    assertLocalOnly({});
    const refused = () =>
      psql(`
        begin;
        insert into auth.users (id, instance_id, aud, role, email)
          values ('19400000-0000-4000-8000-0000000009a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago194-rb@example.test');
        insert into public.workspaces (id, name) values ('194cccc0-0000-4000-8000-000000000001', 'AGO-194 rollback');
        insert into public.members (id, workspace_id, user_id, role)
          values ('19400000-0000-4000-8000-0000000009b1', '194cccc0-0000-4000-8000-000000000001', '19400000-0000-4000-8000-0000000009a1', 'owner');
        insert into public.pack_events (workspace_id, kind, exported_by, agent_ids, agent_names, skill_count, checksum)
          values ('194cccc0-0000-4000-8000-000000000001', 'import', '19400000-0000-4000-8000-0000000009b1', '{}', '{}', 0, repeat('a', 64));
        ${DOWN}
        commit;`);
    // The failed statement aborts the transaction, so the fixture rows are gone and the migration is still applied.
    expect(refused).toThrow();
    expect(hasFunction()).toBe(true);
    expect(psql(`select count(*) from public.pack_events where kind = 'import'`)).toBe('0');
  });

  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    expect(hasFunction()).toBe(true);
    // The AGO-192 check (cardinality(agent_names) = cardinality(agent_ids)) exists after up, after rollback, after re-apply.
    expect(auditCheckCount()).toBe('1');
    const applied = dumpSchema();
    try {
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasFunction()).toBe(false);
      expect(auditCheckCount()).toBe('1');
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasFunction()) psql(`begin;\n${UP}\ncommit;`);
    }
    expect(hasFunction()).toBe(true);
    expect(auditCheckCount()).toBe('1');
    expect(dumpSchema()).toBe(applied);
  });
});
