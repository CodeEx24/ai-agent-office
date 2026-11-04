#!/usr/bin/env node
// Prepares a fresh Orca worktree for an AGO ticket.
// 1. Copies untracked env files (.env, .env.local, ...) from the main checkout, if missing here.
//    Values are never printed. .env.example is tracked, so it is never copied.
// 2. Installs dependencies with pnpm once the monorepo exists.
// Runs from orca.yaml (scripts.setup). Safe to re-run.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ENV_DIRS = ['.', 'apps/web', 'apps/worker', 'supabase'];
const ENV_FILE = /^\.env(\..+)?$/;

function mainCheckout() {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const first = out.split('\n').find((line) => line.startsWith('worktree '));
  return first ? path.resolve(first.slice('worktree '.length).trim()) : null;
}

function copyEnvFiles(from, to) {
  const copied = [];
  for (const dir of ENV_DIRS) {
    const src = path.join(from, dir);
    if (!existsSync(src)) continue;
    for (const name of readdirSync(src)) {
      if (!ENV_FILE.test(name) || name === '.env.example') continue;
      const dest = path.join(to, dir, name);
      if (existsSync(dest) || !existsSync(path.dirname(dest))) continue;
      copyFileSync(path.join(src, name), dest);
      copied.push(path.join(dir, name));
    }
  }
  return copied;
}

const here = path.resolve(process.cwd());
const main = mainCheckout();

if (main && main !== here) {
  const copied = copyEnvFiles(main, here);
  console.log(copied.length ? `env: copied ${copied.join(', ')} from main checkout` : 'env: nothing to copy');
} else {
  console.log('env: running in the main checkout, skipping copy');
}

if (existsSync(path.join(here, 'package.json'))) {
  const args = existsSync(path.join(here, 'pnpm-lock.yaml')) ? ['install', '--frozen-lockfile'] : ['install'];
  console.log(`deps: pnpm ${args.join(' ')}`);
  const result = spawnSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(result.status ?? 1);
} else {
  console.log('deps: no package.json yet (monorepo not scaffolded), skipping install');
}
