#!/usr/bin/env node
// Re-applies supabase/seed.sql to the running LOCAL Supabase database without a reset (AGO-122).
//   pnpm db:seed            (local stack must be running: pnpm db:start)
// The seed is idempotent, so running it again changes nothing. Safe by construction: it only talks to
// the local Supabase db container through `docker exec`, never to a URL, so a hosted project cannot be
// reached. Wrap it in the db lock like any other write to the shared stack when other tickets run.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const SEED_PATH = path.join(ROOT, 'supabase', 'seed.sql');
const LOCAL_URL = /^(https?|postgres(ql)?):\/\/([^@/]*@)?(127\.0\.0\.1|localhost|\[::1\])([:/?]|$)/;

/** `supabase_db_<project_id>`, the container name the Supabase CLI gives the local database. */
export function localDbContainer(env = process.env) {
  if (env.SUPABASE_DB_CONTAINER) return env.SUPABASE_DB_CONTAINER;
  const config = readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!projectId) throw new Error('project_id not found in supabase/config.toml');
  return `supabase_db_${projectId}`;
}

/** Refuses an environment that points at a non-local database. The script never connects by URL anyway. */
export function assertLocalOnly(env = process.env) {
  const hosted = Object.entries(env)
    .filter(([key, value]) => /(DATABASE_URL|DB_URL|SUPABASE_URL)$/.test(key) && value && !LOCAL_URL.test(value))
    .map(([key]) => key);
  if (hosted.length > 0) {
    throw new Error(`Refusing to seed: ${hosted.join(', ')} does not point at localhost. db:seed is local-only.`);
  }
}

export function runSeed(env = process.env) {
  assertLocalOnly(env);
  const container = localDbContainer(env);
  execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'], {
    input: readFileSync(SEED_PATH, 'utf8'),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return container;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const container = runSeed();
    console.log(`Seeded ${path.relative(ROOT, SEED_PATH)} into ${container} (idempotent).`);
  } catch (error) {
    console.error(`db:seed failed: ${error instanceof Error ? error.message : error}`);
    console.error('Is the local stack running? Try: pnpm db:start');
    process.exit(1);
  }
}
