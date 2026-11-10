// AGO-166: the run-limits migration is reversible. Static checks always run; against the shared LOCAL stack
// (RUN_DB_TESTS=1, inside the db lock) it rolls the migration back, re-applies it and compares the schema dumps:
//   node scripts/db-lock.mjs acquire AGO-166
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-166-rollback.test.mjs
//   node scripts/db-lock.mjs release AGO-166
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
  .find((file) => file.endsWith('_ago_166_agent_run_limits.sql'))
  ?.replace(/\.sql$/, '');
if (!STAMP) throw new Error('AGO-166 migration not found');
const UP = readFileSync(path.join(ROOT, 'supabase', 'migrations', `${STAMP}.sql`), 'utf8');
const DOWN = readFileSync(path.join(ROOT, 'supabase', 'rollbacks', `${STAMP}.down.sql`), 'utf8');
const SHARED = readFileSync(path.join(ROOT, 'packages', 'shared', 'src', 'agents', 'run-limits.ts'), 'utf8');
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
const hasColumn = () =>
  psql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'run_limits'`) === '1';

describe('AGO-166 migration files', () => {
  it('rolls back everything the migration creates, without cascade', () => {
    expect(DOWN).toContain('drop function if exists public.set_agent_run_limits');
    expect(DOWN).toContain('drop column if exists run_limits');
    expect(DOWN).toContain('drop function if exists private.run_limits_valid');
    expect(DOWN.toLowerCase()).not.toContain('cascade');
  });

  it('grants the column to no API role and checks the owner role in the function', () => {
    expect(UP).not.toMatch(/grant (insert|update)[^;]*run_limits/i);
    expect(UP).toContain("private.is_member(p_workspace_id, 'owner')");
    expect(UP).toMatch(/revoke all on function public\.set_agent_run_limits[^;]*from public, anon/);
  });

  it('mirrors the bounds in packages/shared', () => {
    const bounds = {
      maxSteps: /maxSteps: \{ min: (\d+), max: (\d+) \}/.exec(SHARED),
      maxTokens: /maxTokens: \{ min: ([\d_]+), max: ([\d_]+) \}/.exec(SHARED),
      maxWallMs: /maxWallMs: \{ min: ([\d_]+), max: ([\d_]+) \}/.exec(SHARED),
    };
    for (const [name, match] of Object.entries(bounds)) {
      expect(match, name).not.toBeNull();
      const [min, max] = [match[1], match[2]].map((n) => n.replaceAll('_', ''));
      // each bound appears in the CHECK as `between <min> and <max>`
      expect(UP, name).toContain(`between ${min} and ${max}`);
    }
  });
});

describe.skipIf(!enabled)('AGO-166 rollback against the local stack', () => {
  it('apply, roll back, re-apply: the schema returns to the same dump', () => {
    assertLocalOnly({});
    expect(hasColumn()).toBe(true);
    const applied = dumpSchema();
    try {
      psql(`begin;\n${DOWN}\ncommit;`);
      expect(hasColumn()).toBe(false);
      expect(dumpSchema()).not.toBe(applied);
    } finally {
      // The stack is shared by every worktree: whatever failed above, leave the migration applied.
      if (!hasColumn()) psql(`begin;\n${UP}\ncommit;`);
    }
    expect(hasColumn()).toBe(true);
    expect(dumpSchema()).toBe(applied);
  });
});
