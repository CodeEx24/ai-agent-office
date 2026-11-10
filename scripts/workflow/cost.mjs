#!/usr/bin/env node
// Cost of a ticket's agents.   node scripts/workflow/cost.mjs AGO-205   (or: scripts/workflow/cost AGO-205)
//
// Looks in the Claude Code transcript store (~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects) for
// project folders whose name contains the lowercase ticket key as a whole token, e.g. a worktree
// "...-ago-205-adopt-delivery-workflow" -> "C--Users-...-ago-205-adopt-delivery-workflow". Every .jsonl
// below it counts, including subagents/. Usage is de-duplicated by message id. Prices are USD per
// million tokens in PRICES; a model not listed there is reported as unpriced.
// Prints "cost: not tracked" and exits 0 when no transcripts are found.

import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// USD per million tokens: input, output, cache write (5m), cache read. Update when prices change.
export const PRICES = {
  "claude-fable-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function priceFor(model) {
  const key = Object.keys(PRICES).find((prefix) => model.startsWith(prefix));
  return key ? PRICES[key] : null;
}

/** Sum usage from transcript JSONL texts. Returns { [model]: { input, output, cacheWrite, cacheRead } }. */
export function sumUsage(jsonlTexts) {
  const seen = new Set();
  const totals = {};
  for (const text of jsonlTexts) {
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry?.message;
      const usage = message?.usage;
      if (!usage || !message.model) continue;
      const id = message.id ?? entry.uuid;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const t = (totals[message.model] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
      t.input += usage.input_tokens ?? 0;
      t.output += usage.output_tokens ?? 0;
      t.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      t.cacheRead += usage.cache_read_input_tokens ?? 0;
    }
  }
  return totals;
}

export function priceUsage(totals) {
  let usd = 0;
  const unpriced = [];
  for (const [model, t] of Object.entries(totals)) {
    const p = priceFor(model);
    if (!p) {
      unpriced.push(model);
      continue;
    }
    usd += (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1e6;
  }
  return { usd, unpriced };
}

function listJsonl(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...listJsonl(full));
    else if (name.endsWith(".jsonl")) files.push(full);
  }
  return files;
}

export function findTranscriptDirs(projectsDir, key) {
  const token = new RegExp(`(^|-)${key.toLowerCase()}(-|$)`);
  try {
    return readdirSync(projectsDir)
      .filter((name) => token.test(name.toLowerCase()))
      .map((name) => path.join(projectsDir, name));
  } catch {
    return [];
  }
}

export function formatCost({ usd, unpriced }, totals, fileCount) {
  const tokens = Object.values(totals).reduce((n, t) => n + t.input + t.output + t.cacheWrite + t.cacheRead, 0);
  const note = unpriced.length ? ` (unpriced models: ${unpriced.join(", ")})` : "";
  return `cost: $${usd.toFixed(2)} (${tokens} tokens, ${fileCount} transcripts)${note}`;
}

function main() {
  const key = process.argv[2];
  if (!key || !/^[A-Za-z]+-\d+$/.test(key)) {
    console.error("usage: cost <KEY>-<n>   e.g. cost AGO-205");
    process.exit(2);
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const files = findTranscriptDirs(path.join(configDir, "projects"), key).flatMap(listJsonl);
  if (files.length === 0) {
    console.log("cost: not tracked");
    return;
  }
  const totals = sumUsage(files.map((f) => readFileSync(f, "utf8")));
  console.log(formatCost(priceUsage(totals), totals, files.length));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
