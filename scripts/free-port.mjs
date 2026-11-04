#!/usr/bin/env node
// Prints the first free TCP port at or above the given start (default 3100).
// Parallel ticket worktrees each run their own dev server, so none of them can assume port 3000.
//   PORT=$(node scripts/free-port.mjs) pnpm dev

import net from 'node:net';

const start = Number(process.argv[2] ?? 3100);
const MAX_TRIES = 200;

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

for (let port = start; port < start + MAX_TRIES; port++) {
  if (await isFree(port)) {
    console.log(port);
    process.exit(0);
  }
}
console.error(`no free port in ${start}-${start + MAX_TRIES - 1}`);
process.exit(1);
