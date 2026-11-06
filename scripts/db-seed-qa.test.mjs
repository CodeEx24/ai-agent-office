// AGO-122 QA: acceptance tests for `pnpm db:seed`, on top of db-seed.test.mjs. The DB tests need the shared
// local stack, so they only run with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-122-qa
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/db-seed-qa.test.mjs
//   node scripts/db-lock.mjs release AGO-122-qa

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { localDbContainer, runSeed } from './db-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_SCRIPT = path.join(ROOT, 'scripts', 'db-seed.mjs');
const SEED_SQL = readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8');
/** The statements only: the header comments say things like "no password" and must not trip the checks. */
const SEED_CODE = SEED_SQL.replace(/^\s*--.*$/gm, '');
const enabled = process.env.RUN_DB_TESTS === '1';

const WS = "'12200001-0000-4000-8000-000000000001'";
const SCOUT = "'12200020-0000-4000-8000-000000000001'";
const TASK_1 = "'12200060-0000-4000-8000-000000000001'";
const TASK_5 = "'12200060-0000-4000-8000-000000000005'";
const SEED_USER = "'12200010-0000-4000-8000-000000000001'";
const TABLES = ['members', 'agents', 'skills', 'agent_skills', 'agent_capabilities', 'tasks'];

function psql(sql) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), 'psql', '-U', 'postgres', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

/** One md5 over every seeded row of every seeded table: any added, removed or changed row changes it. */
function snapshot() {
  const parts = [
    `(select coalesce(md5(string_agg(row_to_json(w)::text, '' order by id)), '') from public.workspaces w where id = ${WS})`,
    ...TABLES.map((t) => `(select coalesce(md5(string_agg(row_to_json(x)::text, '' order by id)), '') from public.${t} x where workspace_id = ${WS})`),
    `(select coalesce(md5(string_agg(email || id::text, '' order by id)), '') from auth.users where id = ${SEED_USER})`,
  ];
  return psql(`select ${parts.join(" || '|' || ")}`);
}

/**
 * History rows in the SEED workspace only (AGO-201). The table-wide count failed after a live E2E run and
 * raced the run_events suites, which write their own rows (in their own workspaces) while this runs. The seed
 * must create none in its own workspace, which is what this proves.
 */
function historyRows() {
  const own = (table) => `(select count(*) from public.${table} where workspace_id = ${WS})`;
  return Number(psql(`select ${own('run_events')} + ${own('runs')} + ${own('approvals')}`));
}

describe.skipIf(!enabled)('AC1: db:seed gives the documented data', () => {
  it('AC1: one workspace, three strict idle agents, three skills, five tasks and the owner membership', () => {
    runSeed({});
    expect(psql(`select count(*) from public.workspaces where id = ${WS} and name = 'Seed Workspace'`)).toBe('1');
    expect(psql(`select string_agg(name || ':' || mode || ':' || status, ',' order by name) from public.agents where workspace_id = ${WS}`)).toBe(
      'Reviewer:strict:idle,Scout:strict:idle,Scribe:strict:idle',
    );
    expect(psql(`select count(*) from public.skills where workspace_id = ${WS}`)).toBe('3');
    expect(psql(`select count(*) from public.tasks where workspace_id = ${WS}`)).toBe('5');
    expect(psql(`select role from public.members where workspace_id = ${WS} and removed_at is null`)).toBe('owner');
  });

  it('AC1 security: the seed creates no run_events, runs or approvals', () => {
    runSeed({});
    expect(historyRows()).toBe(0);
  });
});

describe.skipIf(!enabled)('AC2: db:seed is idempotent', () => {
  it('AC2: running it three more times leaves every seeded row byte-identical', () => {
    runSeed({});
    const before = snapshot();
    expect(before).not.toBe('');
    for (let run = 0; run < 3; run += 1) runSeed({});
    expect(snapshot()).toBe(before);
    expect(historyRows()).toBe(0);
  });

  describe('after a developer edits the seeded data', () => {
    afterAll(() => {
      // put the shared stack back exactly as the seed defines it
      if (!enabled) return;
      psql(`update public.agents set description = 'Researches topics and files findings as vault notes.' where id = ${SCOUT}`);
      psql(`update public.tasks set status = 'todo' where id in (${TASK_1}, ${TASK_5})`);
      runSeed({});
    });

    it('AC2: an edited row is kept and not duplicated (no overwrite)', () => {
      runSeed({});
      psql(`update public.agents set description = 'EDITED BY A DEVELOPER' where id = ${SCOUT}`);
      psql(`update public.tasks set status = 'in_progress' where id = ${TASK_1}`);
      const edited = snapshot();
      runSeed({});
      runSeed({});
      expect(snapshot()).toBe(edited);
      expect(psql(`select description from public.agents where id = ${SCOUT}`)).toBe('EDITED BY A DEVELOPER');
      expect(psql(`select status from public.tasks where id = ${TASK_1}`)).toBe('in_progress');
      expect(psql(`select count(*) from public.agents where workspace_id = ${WS}`)).toBe('3');
      expect(psql(`select count(*) from public.tasks where workspace_id = ${WS}`)).toBe('5');
    });

    it('AC2: a deleted seed row comes back once, with its fixed id, and is not duplicated', () => {
      runSeed({});
      psql(`delete from public.tasks where id = ${TASK_5}`);
      expect(psql(`select count(*) from public.tasks where workspace_id = ${WS}`)).toBe('4');
      runSeed({});
      runSeed({});
      expect(psql(`select count(*) from public.tasks where workspace_id = ${WS}`)).toBe('5');
      expect(psql(`select count(*) from public.tasks where id = ${TASK_5}`)).toBe('1');
    });
  });
});

describe('security: db:seed refuses a non-local database before touching anything', () => {
  // SUPABASE_DB_CONTAINER points at a container that does not exist: if the guard let the run through,
  // docker would fail with "No such container". The guard message must come first and docker must never run.
  const REMOTE = {
    DATABASE_URL: 'postgresql://postgres:hunter2@db.abcdefghijkl.supabase.co:5432/postgres',
    SUPABASE_DB_URL: 'postgresql://postgres:hunter2@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
    NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
    SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
    STAGING_DB_URL: 'postgresql://postgres:x@10.0.0.5:5432/postgres',
  };

  for (const [key, value] of Object.entries(REMOTE)) {
    it(`security: ${key} pointing at a remote host exits non-zero without connecting`, () => {
      const result = spawnSync(process.execPath, [SEED_SCRIPT], {
        env: { ...process.env, SUPABASE_DB_CONTAINER: 'ago122-qa-no-such-container', [key]: value },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Refusing to seed/);
      expect(result.stderr).toContain(key);
      expect(result.stderr).not.toMatch(/No such container/i);
      expect(result.stdout).not.toMatch(/Seeded/);
      expect(result.stderr).not.toContain('hunter2'); // the credential in the URL is never echoed
    });
  }

  it('security: one remote value among local ones is still refused', () => {
    const result = spawnSync(process.execPath, [SEED_SCRIPT], {
      env: {
        ...process.env,
        SUPABASE_DB_CONTAINER: 'ago122-qa-no-such-container',
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:44321',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:44322/postgres',
        SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to seed: SUPABASE_URL/);
  });
});

describe('security: the seed holds no secrets', () => {
  const SECRET_PATTERNS = {
    JWT: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    'Supabase secret key': /sb_secret_[A-Za-z0-9_-]+/,
    'OpenAI/Anthropic-style key': /\bsk-[A-Za-z0-9_-]{16,}/,
    'AWS access key': /\bAKIA[0-9A-Z]{16}\b/,
    'GitHub token': /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    'private key block': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    'bcrypt hash': /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{50,}/,
    'connection string with password': /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/,
  };

  for (const [label, pattern] of Object.entries(SECRET_PATTERNS)) {
    it(`security: seed.sql contains no ${label}`, () => {
      expect(SEED_SQL).not.toMatch(pattern);
    });
  }

  it('security: seed.sql never sets a password and every email is a clearly local address', () => {
    expect(SEED_CODE).not.toMatch(/encrypted_password|crypt\(|password/i);
    const emails = SEED_CODE.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) expect(email).toMatch(/@agent-office\.local$/);
  });

  it('security: seed.sql never writes run_events, runs, approvals or claims', () => {
    expect(SEED_CODE).not.toMatch(/insert\s+into\s+public\.(run_events|runs|approvals|claims)\b/i);
  });
});
