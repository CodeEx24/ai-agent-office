#!/usr/bin/env node
// Regenerates packages/shared/src/db/database.types.ts from the LOCAL Supabase database.
// Writes the file only when generation succeeds, so a stopped stack never leaves an empty types file.
//   pnpm db:types            (local stack must be running: pnpm db:start)

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('packages/shared/src/db/database.types.ts');
// Under `pnpm run`, npm_execpath is pnpm's JS entry, so no shell is needed (works on Windows too).
const pnpmEntry = process.env.npm_execpath;
const [command, entryArgs] = pnpmEntry ? [process.execPath, [pnpmEntry]] : ['pnpm', []];

let types;
try {
  types = execFileSync(command, [...entryArgs, 'exec', 'supabase', 'gen', 'types', 'typescript', '--local', '--schema', 'public'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch {
  console.error('db:types failed. Is the local stack running? Try: pnpm db:start');
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, types);
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
