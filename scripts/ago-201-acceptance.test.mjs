// AGO-201 QA, AC4: "db-seed-qa no longer fails after live E2E without a reset and no longer races the
// run_events suites when run in parallel". The DB tests need the shared local stack, so they only run
// with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-201-qa
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-201-acceptance.test.mjs
//   node scripts/db-lock.mjs release AGO-201-qa

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDbContainer } from './db-seed.mjs';
import { teardownRunEventsSql } from './run-events-teardown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'vitest.scripts.config.mjs';
const enabled = process.env.RUN_DB_TESTS === '1';

function psql(sql) {
  return execFileSync('docker', ['exec', '-i', localDbContainer(), 'psql', '-U', 'postgres', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

/** Runs vitest on the scripts config in a child process, with RUN_DB_TESTS as given. */
function runVitest(files, runDbTests) {
  const env = { ...process.env, CI: '' };
  if (runDbTests) env.RUN_DB_TESTS = '1';
  else delete env.RUN_DB_TESTS;
  return spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', CONFIG, ...files], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

/** The `test.fileParallelism` the scripts config resolves to for a given RUN_DB_TESTS. */
function fileParallelismFor(runDbTests) {
  const env = { ...process.env };
  if (runDbTests === undefined) delete env.RUN_DB_TESTS;
  else env.RUN_DB_TESTS = runDbTests;
  const configUrl = JSON.stringify(pathToFileURL(path.join(ROOT, CONFIG)).href);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import c from ${configUrl}; console.log(String(c.test.fileParallelism));`], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  return out.trim();
}

describe('AC4: the DB suites never run in parallel files', () => {
  it('AC4: with RUN_DB_TESTS=1 test files run one at a time', () => {
    expect(fileParallelismFor('1')).toBe('false');
  });

  // AGO-212: parallel files exhausted the shared Postgres connection slots, so serial is now unconditional.
  it('AC4 (AGO-212): without RUN_DB_TESTS files also run one at a time', () => {
    expect(fileParallelismFor(undefined)).toBe('false');
    expect(fileParallelismFor('0')).toBe('false');
  });
});

describe.skipIf(!enabled)('AC4: db-seed-qa survives the history a live E2E run leaves behind', () => {
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();

  beforeAll(() => {
    // Run history in ANOTHER workspace, as any E2E or run_events suite leaves it. run_events is
    // append-only, so it is removed with the same transaction the run_events suites use.
    psql(`
      insert into public.workspaces (id, name) values ('${workspaceId}', 'AGO-201 QA decoy');
      insert into public.agents (id, workspace_id, name) values ('${agentId}', '${workspaceId}', 'decoy agent');
      insert into public.runs (id, workspace_id, agent_id) values ('${runId}', '${workspaceId}', '${agentId}');
      insert into public.run_events (workspace_id, run_id, type) values ('${workspaceId}', '${runId}', 'decoy')`);
  });

  afterAll(() => {
    psql(teardownRunEventsSql([workspaceId]));
  });

  it('AC4: with history rows present in another workspace (no reset), db-seed-qa passes', () => {
    const before = Number(psql(`select (select count(*) from public.run_events) + (select count(*) from public.runs)`));
    expect(before, 'the decoy history must exist before db-seed-qa runs').toBeGreaterThanOrEqual(2);

    const result = runVitest(['scripts/db-seed-qa.test.mjs'], true);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Test Files\s+1 passed/);
    // The seed must not have touched the other workspace's history.
    expect(Number(psql(`select count(*) from public.run_events where workspace_id = '${workspaceId}'`))).toBe(1);
  });

  it('AC4: db-seed-qa and the run_events suites pass together in one run (no race on the shared database)', () => {
    const result = runVitest(
      ['scripts/db-seed-qa.test.mjs', 'scripts/run-events-qa.test.mjs', 'scripts/run-events-concurrency.test.mjs'],
      true,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Test Files\s+3 passed/);
  });
});
