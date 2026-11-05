// AGO-122: db:seed is idempotent and local-only. The idempotency test needs the shared local stack, so it
// only runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-122
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/db-seed.test.mjs
//   node scripts/db-lock.mjs release AGO-122

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertLocalOnly, localDbContainer, runSeed } from './db-seed.mjs';

const WS = "'12200001-0000-4000-8000-000000000001'";
const enabled = process.env.RUN_DB_TESTS === '1';

const COUNT_SQL = [
  `(select count(*) from public.workspaces where id = ${WS})`,
  ...['members', 'agents', 'skills', 'agent_skills', 'agent_capabilities', 'tasks'].map(
    (t) => `(select count(*) from public.${t} where workspace_id = ${WS})`,
  ),
  `(select count(*) from auth.users where email like '%@agent-office.local')`,
].join(', ');

/** workspaces|members|agents|skills|agent_skills|agent_capabilities|tasks|local users */
function counts() {
  const out = execFileSync(
    'docker',
    ['exec', '-i', localDbContainer(), 'psql', '-U', 'postgres', '-q', '-At', '-c', `select ${COUNT_SQL}`],
    { encoding: 'utf8' },
  );
  return out.trim().split('|').map(Number);
}

describe('db:seed safety', () => {
  it('derives the local container from config.toml', () => {
    expect(localDbContainer({})).toBe('supabase_db_agent-office');
  });

  it('refuses a non-local database URL', () => {
    expect(() => assertLocalOnly({ DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/postgres' })).toThrow(/local-only/);
    expect(() => assertLocalOnly({ NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/local-only/);
  });

  it('accepts localhost URLs and an empty environment', () => {
    expect(() => assertLocalOnly({})).not.toThrow();
    expect(() => assertLocalOnly({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:44321' })).not.toThrow();
    expect(() => assertLocalOnly({ DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:44322/postgres' })).not.toThrow();
  });

  it('rejects a lookalike host that only starts with 127.0.0.1', () => {
    expect(() => assertLocalOnly({ DATABASE_URL: 'postgresql://x@127.0.0.1.evil.example/postgres' })).toThrow(/local-only/);
  });
});

describe.skipIf(!enabled)('db:seed against the local stack', () => {
  it('produces 1 workspace, 3 agents, 5 tasks and starter skills, and re-running changes nothing', () => {
    runSeed({});
    const first = counts();
    // workspaces, members, agents, skills, agent_skills, agent_capabilities, tasks, local users
    expect(first).toEqual([1, 1, 3, 3, 3, 3, 5, 1]);
    runSeed({});
    runSeed({});
    expect(counts()).toEqual(first);
  });
});
