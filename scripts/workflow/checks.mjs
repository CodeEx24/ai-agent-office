#!/usr/bin/env node
// The project's gate: install (frozen lockfile), lint, typecheck, test, build, pgTAP, ticket record.
// Entry points: scripts/workflow/checks.sh and checks.ps1 (thin wrappers around this file).
//
//   node scripts/workflow/checks.mjs                  local mode: print result, exit code only
//   node scripts/workflow/checks.mjs --report <path>  also write <path>; first line VERDICT: PASS|FAIL
//
// pgTAP runs only when the local Supabase stack is up, inside scripts/db-lock.mjs; otherwise it is
// skipped with a note. Exit code: 0 = PASS, 1 = FAIL.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_TAIL_LINES = 40;
const STACK_API_URL = "http://127.0.0.1:44321/auth/v1/health";

/** @typedef {{ name: string, command: string, status: "pass" | "fail" | "skip", output: string }} StepResult */

/** Ticket key from a branch like `chore/ago-205/adopt-delivery-workflow` -> `AGO-205`, else null. */
export function ticketKeyFromBranch(branch) {
  const match = /^[a-z]+\/(ago-\d+)\//.exec(branch.trim());
  return match ? match[1].toUpperCase() : null;
}

export function tail(text, lines = LOG_TAIL_LINES) {
  const all = text.replace(/\s+$/, "").split(/\r?\n/);
  return all.slice(-lines).join("\n");
}

/** `FAIL` if any step failed, else `PASS` (skips do not fail the gate). */
export function verdictOf(results) {
  return results.some((r) => r.status === "fail") ? "FAIL" : "PASS";
}

/** The report file: first line is the verdict, then each step with its command and log tail. */
export function buildReport(results, { key = null, branch = null, finishedAt = new Date() } = {}) {
  const lines = [`VERDICT: ${verdictOf(results)}`, ""];
  lines.push(`Ticket: ${key ?? "unknown"} · Branch: ${branch ?? "unknown"} · ${finishedAt.toISOString()}`, "");
  lines.push("| Step | Result |", "|---|---|");
  for (const r of results) lines.push(`| ${r.name} | ${r.status.toUpperCase()} |`);
  for (const r of results) {
    lines.push("", `## ${r.name}: ${r.status.toUpperCase()}`, "", "```", `$ ${r.command}`);
    if (r.output.trim()) lines.push(tail(r.output));
    lines.push("```");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Ticket record check. The record must exist; its links block (first lines) must name a ticket link,
 * and once a PR exists (`hasPr`) a PR link. Returns { ok, message }.
 */
export function checkTicketRecord(content, key, hasPr) {
  if (content === null) return { ok: false, message: `docs/tickets/${key}.md is missing` };
  const head = content.split(/\r?\n/).slice(0, 25).join("\n");
  if (!/Ticket:\s*\S+/i.test(head)) {
    return { ok: false, message: `${key}.md has no "Ticket:" link in its links block` };
  }
  if (hasPr && !/PRs?:[^\n]*(pull\/\d+|#\d+)/i.test(head)) {
    return { ok: false, message: `a PR exists but the ${key}.md links block has no PR link` };
  }
  return { ok: true, message: `${key}.md present with a links block` };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32", ...options });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function step(name, command, args) {
  const { code, output } = run(command, args);
  return { name, command: [command, ...args].join(" "), status: code === 0 ? "pass" : "fail", output };
}

async function stackIsUp() {
  try {
    const res = await fetch(STACK_API_URL, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function pgtapStep(key) {
  const command = "pnpm exec supabase test db (inside node scripts/db-lock.mjs)";
  if (!(await stackIsUp())) {
    return { name: "pgTAP", command, status: "skip", output: "Skipped: the local Supabase stack is not up (pnpm db:start)." };
  }
  const owner = key ?? "CHECKS";
  const acquire = run("node", ["scripts/db-lock.mjs", "acquire", owner]);
  if (acquire.code !== 0) return { name: "pgTAP", command, status: "fail", output: acquire.output };
  try {
    return step("pgTAP", "pnpm", ["exec", "supabase", "test", "db"]);
  } finally {
    run("node", ["scripts/db-lock.mjs", "release", owner]);
  }
}

function ticketRecordStep(key, branch) {
  const name = "Ticket record";
  const command = `check docs/tickets/${key ?? "<KEY>"}.md`;
  if (!key) {
    return { name, command, status: "skip", output: `Skipped: no ticket key in branch "${branch}".` };
  }
  const file = path.join("docs", "tickets", `${key}.md`);
  const content = existsSync(file) ? readFileSync(file, "utf8") : null;
  const pr = run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number", "--jq", "length"]);
  const hasPr = pr.code === 0 && Number(pr.output.trim()) > 0;
  const { ok, message } = checkTicketRecord(content, key, hasPr);
  return { name, command, status: ok ? "pass" : "fail", output: message };
}

async function main() {
  const argv = process.argv.slice(2);
  const reportIdx = argv.indexOf("--report");
  const reportPath = reportIdx === -1 ? null : argv[reportIdx + 1];
  if (reportIdx !== -1 && !reportPath) {
    console.error("--report needs a path");
    process.exit(2);
  }

  const branch = run("git", ["branch", "--show-current"]).output.trim();
  const key = ticketKeyFromBranch(branch);

  const results = [];
  const record = (r) => {
    results.push(r);
    console.log(`${r.status.toUpperCase().padEnd(5)} ${r.name}`);
    if (r.status !== "pass") console.log(tail(r.output, 15));
    return r.status !== "fail";
  };

  // Stop at the first hard failure: later steps depend on a clean install and compile.
  const pipeline = [
    () => step("Install", "pnpm", ["install", "--frozen-lockfile"]),
    () => step("Lint", "pnpm", ["lint"]),
    () => step("Typecheck", "pnpm", ["typecheck"]),
    () => step("Test", "pnpm", ["test"]),
    () => step("Build", "pnpm", ["build"]),
  ];
  let ok = true;
  for (const make of pipeline) {
    if (!(ok = record(make()))) break;
  }
  if (ok) record(await pgtapStep(key));
  record(ticketRecordStep(key, branch));

  const verdict = verdictOf(results);
  if (reportPath) {
    mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    writeFileSync(reportPath, buildReport(results, { key, branch }), "utf8");
  }
  console.log(`VERDICT: ${verdict}`);
  process.exit(verdict === "PASS" ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
