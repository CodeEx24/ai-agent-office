// AGO-86: the run-control migration is reversible. Static checks always run; against the shared LOCAL stack
// (RUN_DB_TESTS=1, inside the db lock) it rolls the migration back, re-applies it and compares the schema dumps:
//   node scripts/db-lock.mjs acquire AGO-86
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-86-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-86
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
  .find((file) => file.endsWith('_ago_86_run_control.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-86 migration not found');
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
const hasFunction = () => psql(`select count(*) from pg_proc where proname = 'request_run_control'`) === '1';

describe('AGO-86 migration files', () => {
  it('rolls back everything the migration creates, without cascade', () => {
    expect(DOWN).toContain('drop function if exists public.request_run_control');
    for (const column of ['stop_requested_at', 'resume_requested_at', 'control_requested_by']) {
      expect(DOWN).toContain(`drop column if exists ${column}`);
    }
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('puts the control function behind a human session and a member check, for authenticated only', () => {
    expect(UP).toContain("private.is_member(p_workspace_id, 'member')");
    expect(UP).toContain('v_user is null');
    expect(UP).toContain("'agent_id', 'run_id', 'agent_credential'");
    expect(UP).toMatch(/revoke all on function public\.request_run_control[^;]*from public, anon, authenticated, service_role/);
    expect(UP).toMatch(/grant execute on function public\.request_run_control[^;]*to authenticated;/);
  });

  it('does not write run_events or change runs from the control function', () => {
    const body = /create function public\.request_run_control[\s\S]*?\n\$\$;/.exec(UP)?.[0] ?? '';
    expect(body).not.toBe('');
    expect(body).not.toMatch(/insert into public\.run_events/i);
    expect(body).not.toMatch(/update public\.runs/i);
  });
});

describe.skipIf(!enabled)('AGO-86 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    expect(hasFunction()).toBe(true);
    const applied = dumpSchema();
    try {
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasFunction()).toBe(false);
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasFunction()) psql(`begin;\n${UP}\ncommit;`);
    }
    expect(hasFunction()).toBe(true);
    expect(dumpSchema()).toBe(applied);
  });
});
