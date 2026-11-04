#!/usr/bin/env node
// Serializes use of the one shared local Supabase stack across parallel ticket worktrees.
// The lock file lives in the git common dir, so every worktree of this repo sees the same lock.
//
//   node scripts/db-lock.mjs acquire AGO-57 [--wait-min 30]   exit 0 = held, 2 = timed out
//   node scripts/db-lock.mjs release AGO-57                    only the owner can release
//   node scripts/db-lock.mjs status
//
// Locks older than STALE_MINUTES are treated as abandoned and broken automatically.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MINUTES = 60;
const POLL_MS = 15_000;

const [command, owner, ...rest] = process.argv.slice(2);
const waitIdx = rest.indexOf('--wait-min');
const waitMinutes = waitIdx === -1 ? 30 : Number(rest[waitIdx + 1]);

const commonDir = path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim());
const lockPath = path.join(commonDir, 'agent-office-db.lock');

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function ageMinutes(lock) {
  return (Date.now() - Date.parse(lock.acquiredAt)) / 60_000;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquire() {
  const lock = { owner, pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() };
  try {
    writeFileSync(lockPath, JSON.stringify(lock), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function acquire() {
  if (!owner) fail('usage: db-lock.mjs acquire <AGO-###>');
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const current = readLock();
    if (current?.owner === owner) return done(`db lock already held by ${owner}`);
    if (current && ageMinutes(current) > STALE_MINUTES) {
      console.log(`db lock held by ${current.owner} for ${ageMinutes(current).toFixed(0)} min; breaking stale lock`);
      rmSync(lockPath, { force: true });
    }
    if (tryAcquire()) return done(`db lock acquired by ${owner}`);
    if (Date.now() > deadline) {
      console.error(`db lock still held by ${readLock()?.owner ?? 'unknown'} after ${waitMinutes} min`);
      process.exit(2);
    }
    console.log(`db lock held by ${readLock()?.owner ?? 'unknown'}; waiting...`);
    sleep(POLL_MS);
  }
}

function release() {
  const current = readLock();
  if (!current) return done('db lock is free');
  if (current.owner !== owner) fail(`db lock is held by ${current.owner}, not ${owner}; not releasing`);
  rmSync(lockPath, { force: true });
  done(`db lock released by ${owner}`);
}

function status() {
  const current = readLock();
  done(current ? `db lock held by ${current.owner} since ${current.acquiredAt}` : 'db lock is free');
}

function done(message) {
  console.log(message);
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (command === 'acquire') acquire();
else if (command === 'release') release();
else if (command === 'status') status();
else fail('usage: db-lock.mjs <acquire|release|status> [AGO-###] [--wait-min N]');
