#!/usr/bin/env node
// PreToolUse guard for Agent Office.
// Denies shell commands and file writes that bypass the human-in-the-loop delivery flow:
// force pushes, pushes to main, non-squash or admin merges, skipped git hooks,
// remote Supabase changes, repo deletion/visibility changes, .env writes,
// and commits whose staged diff contains a secret.
// Wired in .claude/settings.json for Bash|PowerShell and Write|Edit|MultiEdit|NotebookEdit.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PROTECTED_BRANCHES = new Set(['main', 'master']);

const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/sk-proj-[A-Za-z0-9_-]{20,}/, 'OpenAI project key'],
  [/\bsk-[A-Za-z0-9]{48,}\b/, 'OpenAI API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained token'],
  [/\bsbp_[0-9a-f]{40}\b/, 'Supabase access token'],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}/, 'Supabase secret key'],
  [/\b(sk|rk)_live_[0-9a-zA-Z]{24,}/, 'Stripe live key'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/, 'Telegram bot token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key'],
  [/postgres(ql)?:\/\/[^:\s'"]+:[^@\s'"]{6,}@(?!127\.0\.0\.1|localhost|db[:/])[^\s'"]+/, 'remote Postgres URL with password'],
];

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[agent-office guard] ${reason}`,
      },
    }),
  );
  process.exit(0);
}

// Split a shell line into simple command segments, then into tokens (quotes stripped).
function segmentsOf(command) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((seg) =>
      (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, '')),
    )
    .filter((tokens) => tokens.length > 0);
}

function toolName(token) {
  return path.basename(token).replace(/\.(exe|cmd)$/i, '');
}

// Return the args after `<tool> <sub>` (e.g. git push), or null when the segment is not that command.
function argsAfter(tokens, tool, sub) {
  const i = tokens.findIndex((t, idx) => toolName(t) === tool && tokens[idx + 1] === sub);
  return i === -1 ? null : tokens.slice(i + 2);
}

function isForceFlag(arg) {
  if (arg === '--force' || arg.startsWith('--force-with-lease') || arg === '--force-if-includes') return true;
  return /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg);
}

function refTarget(arg) {
  const ref = arg.replace(/^\+/, '');
  const dest = ref.includes(':') ? ref.split(':').pop() : ref;
  return dest.replace(/^refs\/heads\//, '');
}

function checkGitPush(args) {
  if (args.some(isForceFlag)) deny('Force push is blocked. Push a new commit instead.');
  if (args.includes('--mirror') || args.includes('--all')) deny('Mirror/all-branch pushes are blocked.');
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.some((a) => a.startsWith('+'))) deny('Force refspecs (+ref) are blocked.');
  // positional[0] is the remote; the rest are refspecs.
  if (positional.slice(1).some((a) => PROTECTED_BRANCHES.has(refTarget(a)))) {
    deny('Direct pushes to main are blocked. Push the ticket branch and open a PR.');
  }
}

function checkGitCommit(args, cwd) {
  if (args.includes('--no-verify') || args.includes('-n')) deny('Skipping git hooks (--no-verify) is blocked.');
  // During a merge, compare the index with MERGE_HEAD (the branch being merged in) so only
  // this branch's own changes are scanned, not content that already passed review on that branch.
  let base = [];
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd, stdio: 'ignore' });
    base = ['MERGE_HEAD'];
  } catch {
    /* not merging */
  }
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color', ...base], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return; // not a repo or nothing staged; let git report it
  }
  const findings = new Set();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(6);
      continue;
    }
    if (!line.startsWith('+') || file.endsWith('.env.example')) continue;
    for (const [re, label] of SECRET_PATTERNS) if (re.test(line)) findings.add(`${label} in ${file}`);
    for (const jwt of line.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g) ?? []) {
      try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
        if (payload.role === 'service_role' && payload.iss !== 'supabase-demo') {
          findings.add(`Supabase service_role JWT in ${file}`);
        }
      } catch {
        /* not a JWT */
      }
    }
  }
  if (findings.size > 0) {
    deny(`Possible secret in staged changes: ${[...findings].join('; ')}. Move it to an env var or the credential broker and unstage it.`);
  }
}

function checkGh(tokens) {
  const pr = argsAfter(tokens, 'gh', 'pr');
  if (pr && pr[0] === 'merge') {
    const merge = pr.slice(1);
    if (merge.includes('--admin')) deny('Admin merges bypass branch protection and are blocked.');
    if (merge.includes('--merge') || merge.includes('--rebase') || !merge.includes('--squash')) {
      deny('Only squash merges are allowed: gh pr merge <n> --squash --delete-branch.');
    }
  }
  const repo = argsAfter(tokens, 'gh', 'repo');
  if (repo && repo[0] === 'delete') deny('Deleting the repository is human-only.');
  if (repo && repo[0] === 'edit' && repo.some((a) => a.startsWith('--visibility'))) deny('Changing repo visibility is human-only.');
  const api = argsAfter(tokens, 'gh', 'api');
  if (api) {
    const i = api.findIndex((a) => a === '-X' || a === '--method');
    const method = i === -1 ? 'GET' : (api[i + 1] ?? 'GET').toUpperCase();
    if (method !== 'GET' && api.some((a) => /\/(branches\/[^/]+\/protection|rulesets)/.test(a))) {
      deny('Branch protection and rulesets are human-only.');
    }
  }
}

function checkSupabase(tokens) {
  const i = tokens.findIndex((t) => toolName(t) === 'supabase');
  if (i === -1) return;
  const args = tokens.slice(i + 1);
  const sub = args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');
  const isRemote =
    args.includes('--linked') ||
    args.some((a) => a.startsWith('--db-url') && !/127\.0\.0\.1|localhost/.test(a)) ||
    ['link', 'db push', 'projects', 'secrets set', 'functions deploy', 'branches'].some((s) => sub.startsWith(s));
  if (isRemote) deny(`Remote Supabase changes ("supabase ${sub}") are human-only. Agents use the local Docker stack only.`);
}

function checkShell(command, cwd) {
  if (/AGO_BOT(_GIT)?_TOKEN/.test(command)) {
    deny('The bot token is only used through scripts/as-bot.mjs; never read, print or pass it directly.');
  }
  for (const tokens of segmentsOf(command)) {
    const push = argsAfter(tokens, 'git', 'push');
    if (push) checkGitPush(push);
    const commit = argsAfter(tokens, 'git', 'commit');
    if (commit) checkGitCommit(commit, cwd);
    checkGh(tokens);
    checkSupabase(tokens);
  }
}

function checkFileWrite(filePath) {
  const base = path.basename(filePath ?? '');
  if (/^\.env(\..+)?$/.test(base) && base !== '.env.example') {
    deny(`Writing ${base} is blocked. Secrets are set by the human; update .env.example instead.`);
  }
}

const input = JSON.parse((await readStdin()) || '{}');
const tool = input.tool_name ?? '';
const toolInput = input.tool_input ?? {};
const cwd = input.cwd || process.cwd();

if (tool === 'Bash' || tool === 'PowerShell') checkShell(String(toolInput.command ?? ''), cwd);
if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) checkFileWrite(toolInput.file_path ?? toolInput.notebook_path);
process.exit(0);
