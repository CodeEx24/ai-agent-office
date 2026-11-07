#!/usr/bin/env node
// Prints the first free TCP port at or above the given start (default 3100).
// Parallel ticket worktrees each run their own dev server, so none of them can assume port 3000.
//   PORT=$(node scripts/free-port.mjs) pnpm dev
//
// A port counts as free only if it can be bound on 127.0.0.1, 0.0.0.0 and ::1. On Windows a listener
// on 127.0.0.1 does not make a 0.0.0.0 bind fail, so probing one address is not enough (AGO-203).
// ::1 is skipped when the machine has no IPv6 loopback.

import net from 'node:net';

const start = Number(process.argv[2] ?? 3100);
const MAX_TRIES = 200;
const HOSTS = ['127.0.0.1', '0.0.0.0', '::1'];
// Errors that mean "this address family does not exist here", not "the port is taken".
const UNSUPPORTED_HOST_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT']);

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(host === '::1' && UNSUPPORTED_HOST_CODES.has(err.code)));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function isFree(port) {
  for (const host of HOSTS) {
    if (!(await canBind(port, host))) return false;
  }
  return true;
}

for (let port = start; port < start + MAX_TRIES; port++) {
  if (await isFree(port)) {
    console.log(port);
    process.exit(0);
  }
}
console.error(`no free port in ${start}-${start + MAX_TRIES - 1}`);
process.exit(1);
