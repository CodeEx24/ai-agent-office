#!/usr/bin/env node
// Runs a git/gh command as the Agent Office bot account, so agent work is authored by the bot
// and the human's account can give the gate's real GitHub approval.
//
//   node scripts/as-bot.mjs git commit -m "feat(web): ... (AGO-57)"
//   node scripts/as-bot.mjs git push -u origin feat/ago-57/agent-wizard
//   node scripts/as-bot.mjs gh pr create --title "..." --body-file ...
//
// The token comes from the user-level env var AGO_BOT_TOKEN: a fine-grained PAT of the bot account,
// limited to this repo. It is passed only to the child process and never printed.
// Without the token the command runs unchanged as the logged-in user.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
if (cmd !== 'git' && cmd !== 'gh') {
  console.error('usage: as-bot.mjs <git|gh> <args...>');
  process.exit(1);
}

const token = process.env.AGO_BOT_TOKEN;
const env = { ...process.env };
delete env.AGO_BOT_TOKEN; // children get only what they need
let finalArgs = args;

function botIdentity() {
  const commonDir = path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim());
  const cachePath = path.join(commonDir, 'agent-office-bot.json');
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    const out = execFileSync('gh', ['api', 'user', '--jq', '{login: .login, id: .id}'], {
      encoding: 'utf8',
      env: { ...env, GH_TOKEN: token },
    });
    const identity = JSON.parse(out);
    writeFileSync(cachePath, JSON.stringify(identity));
    return identity;
  }
}

if (!token) {
  console.error('as-bot: AGO_BOT_TOKEN not set, running as your own account');
} else if (cmd === 'gh') {
  env.GH_TOKEN = token;
} else if (args[0] === 'commit') {
  const { login, id } = botIdentity();
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = login;
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${id}+${login}@users.noreply.github.com`;
} else if (['push', 'fetch', 'pull'].includes(args[0])) {
  // Credential helper that answers from the child's env; the token never lands on disk or in argv.
  env.AGO_BOT_GIT_TOKEN = token;
  const helper = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$AGO_BOT_GIT_TOKEN"; }; f';
  finalArgs = ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, ...args];
}

const result = spawnSync(cmd, finalArgs, { stdio: 'inherit', env });
process.exit(result.status ?? 1);
