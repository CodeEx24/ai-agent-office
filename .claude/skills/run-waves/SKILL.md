---
name: run-waves
description: >-
  Orchestrate Agent Office delivery wave by wave. Find the current wave's ready AGO tickets,
  spawn one Orca worktree per ticket running /implement-ticket, then dispatch an independent
  /pr-gate reviewer for each PR. Route fixes back to the implementer, let the gate squash-merge
  clean PRs and close the Jira ticket, and move to the next wave when the current one is done.
  Escalates to the human only for payment/billing/spend decisions, secrets the human must
  supply, and repeated failures. Use when the user says "run the waves", "start wave 2",
  "orchestrate the backlog", "work through the tickets", "/run-waves", or "continue the waves"
  after a break. Run /plan-waves first if tickets have no wave-N labels.
argument-hint: "[wave-N | current] [--max-parallel N] [--one-wave] [--dry-run]"
---

# Run the waves (coordinator)

You are the **coordinator**. You never write product code, never review code yourself and never merge. You pick work, dispatch workers, answer their questions, route results and keep Jira truthful. Workers do the work:

| Role | Where | Skill it runs |
|---|---|---|
| Implementer | its own new Orca worktree, one per ticket | `/implement-ticket AGO-###` (user skill) |
| Tester | a fresh agent in the same worktree, right after the PR exists | `references/tester-brief.md`: `/verify-ticket` in a real browser, then E2E/integration tests for every AC |
| Gatekeeper | a fresh agent in the same worktree, after the tester passes | `/pr-gate <PR#>` (project skill) |

Flow per ticket: **implement → test → gate → merge**. The tester never fixes product code, and the implementer never grades its own work.

Read `docs/ai-workflow.md` once for the overall flow, the escalation rules and the DB/port conventions.

## Fixed facts

- Jira cloud: `stratyge.atlassian.net`, cloudId `db54a41b-b837-432b-b361-a2f0b8cfbe7a`, project `AGO`.
- Transitions: `11` To Do · `21` In Progress · `31` In Review · `41` Done. Re-check with `getTransitionsForJiraIssue` if a call fails, because workflows change.
- Waves are `wave-N` labels, written by `/plan-waves`. Dependencies are Jira **Blocks** links: a link whose `inwardIssue` is X means X blocks this ticket.
- Epics (`issuetype = Epic`) are never dispatched. Close an epic only when all its children are Done.
- GitHub: `CodeEx24/ai-agent-office`, base `main`, squash-only, `main` protected.
- Orca repo id: `08119f17-3c78-4df7-9886-658b38b2b7df`. Base ref for new worktrees: `origin/main`.

## 0. Preflight

1. `orca status --json` must show the runtime ready. Load the version-matched guides first: `orca skills get orchestration`, then `orca skills get orchestration --reference references/placement-and-remote.md`. Follow them where this file is silent. They win on Orca CLI syntax.
2. `gh auth status`, `git fetch origin`, and `orca repo set-base-ref --repo id:08119f17-3c78-4df7-9886-658b38b2b7df --ref origin/main --json` (idempotent).
3. Docker running (`docker ps`). Only needed once tickets touch the DB, so a failure here is a warning, not a stop.
4. Resume check. Before starting anything new, find work already in flight:
   - Jira tickets in `In Progress` / `In Review`,
   - open PRs (`gh pr list --state open --json number,headRefName,title`),
   - Orca workers from an earlier Run (`orca orchestration worker-list --include-remote --json`).
   Adopt them: a ticket with an open PR goes straight to the gate (step 4), and one In Progress without a PR gets a fresh implementer in its existing worktree. Never start a second implementer on a ticket that already has a live one.

## 1. Pick the wave and the ready set

```
JQL: project = AGO AND issuetype != Epic AND labels = wave-<N> AND statusCategory != Done
```
Use the wave from the argument, or else the lowest `wave-N` that still has open tickets. If no ticket has a `wave-*` label, stop and tell the user to run `/plan-waves`.

Fetch `issuelinks` for each ticket. A ticket is **ready** when every ticket that blocks it is Done. That includes blockers in earlier waves; a blocker in a later wave is a plan error, so report it and skip the ticket. Order the ready set by priority (`p0` > `p1` > `p2`), then by how many tickets each one unblocks.

**Schema tickets.** Mark a ticket `schema` when its summary, description or AC mentions tables, columns, migrations, RLS, policies on data, triggers, functions, Realtime publications or seed data, or when it belongs to EP-01 (Data and auth). Only **one** schema ticket may be in flight at a time, from dispatch until its PR is merged. Other ready schema tickets wait for that slot, while non-schema tickets keep flowing. This stops migrations being written in parallel against different bases.

**Assign the names now** (CLAUDE.md §5). Workers and the gate never invent them:
- `type`: Story → `feat`, Bug → `fix`, EP-00 setup work → `build` (repo/tooling), `ci` (pipelines) or `chore`, docs only → `docs`.
- `scope`: one of web, worker, shared, ui, assets, db, auth, agents, work, vault, control, office, policy, ci, tooling, deps, repo. Pick the one that matches where most of the change will land.
- `slug`: from the summary, minus the `US-###` prefix and filler words. Lowercase ASCII kebab-case, 2–5 words, 40 chars max (`US-004 Scaffold the monorepo` → `scaffold-monorepo`).
- `branch` = `<type>/ago-<n>/<slug>`, `worktree` = `ago-<n>-<slug>`, display name = `AGO-<n> <summary without US-###>`. Use the Jira key unpadded.

`--dry-run`: print the table (Ticket · Summary · Ready? · Blocked by · Schema? · Branch) and stop.

## 2. Dispatch implementers (max parallel: 3 unless `--max-parallel`)

Bind one Run per invocation: `orca orchestration run-create --objective "AGO wave <N>" --json`.

For each ready ticket, up to the parallel limit:
1. Transition Jira to **In Progress** (`21`). Comment: `Picked up by /run-waves (wave N). Worktree ago-<n>-<slug>.`
2. Fill `references/worker-brief.md` (key, number, summary, wave, branch, type, scope, schema yes/no) and start the worker in a **new top-level worktree**:
   ```
   orca orchestration worker-start --spec "<filled brief>" --worktree new-top-level --name ago-<n>-<slug> --display-name "AGO-<n> <summary>" --agent claude --setup run --json
   ```
   Record ticket → branch, task id, dispatch id, worktree id and terminal handle. If `worker-start` fails, read `failedStage` and load `references/recovery-and-cleanup.md`. Do not blindly relaunch.
3. Start every independent ticket before the first wait. Dispatch the remaining ready tickets as slots free up.

## 3. Wait and route

```
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```
Process every message in the delivery, then `--ack` it. Follow the orchestration guide's loop rules: timeouts are checkpoints, and after three empty waits run `worker-list`.

**Questions from workers.** Classify each one first:
- **Schema slot request.** A worker that finds it needs a migration without being marked `schema` asks for the slot. If the slot is free, grant it and mark the ticket `schema`. If not, reply "wait": the worker finishes its non-schema parts and asks again. Re-check the slot whenever a schema PR merges.
- **Human-only.** First call `PushNotification` (load it with ToolSearch `select:PushNotification` if it is deferred). Keep it under 200 characters and lead with the action, for example `AGO-57 needs you: approve paid Higgsfield credits?`. Then ask the user with AskUserQuestion, recommended option first, and relay the answer with `orchestration reply`. Keep processing other workers while you wait. Human-only means any of:
  - spend: paid plans, upgrades, purchases, subscriptions, paid APIs or credits (Higgsfield, model providers, Telegram paid features), anything that bills;
  - a secret or credential only the human has;
  - creating or changing hosted Supabase/Vercel/cloud resources;
  - changing branch protection or repo settings;
  - an acceptance criterion that contradicts CLAUDE.md/AGENTS.md;
  - a locked-stack change, which needs an ADR.
- **Everything else.** Answer it yourself with the recommended option: the one the worker marked recommended, or else the one that best fits the AC, CLAUDE.md and the reuse-first rule. Say why in one line. Never leave a worker blocked on a question you can answer.

**Implementer `worker_done`.**
- `--outcome succeeded` with a PR URL: transition Jira to **In Review** (`31`), then `worker-retain` the implementer (it may get fixes). Dispatch the **tester** into the same worktree with a fresh agent:
  ```
  orca orchestration worker-start --spec "<filled references/tester-brief.md>" --worktree id:<that worktree id> --agent claude --json
  ```

**Tester `worker_done`.** The first line is the result:
- `QA: PASS`: release the tester, then dispatch the gate into the same worktree with a fresh agent:
  ```
  orca orchestration worker-start --spec "<filled references/review-brief.md, including the assigned branch>" --worktree id:<that worktree id> --agent claude --json
  ```
- `QA: FAIL`: send the failures to the retained implementer as a fix task, the same way as gate findings. Each failure counts as a fix round. After the fix, run the tester again, not the gate.
- `QA: BLOCKED`: a missing env value or secret is human-only (`PushNotification` + ask). A broken harness goes back to the implementer if this ticket broke it; otherwise escalate.
- `failed`, or no PR: read its summary. A missing env var or secret is human-only (escalate). Otherwise retry once with a fresh implementer in the same worktree, adding the failure summary to the brief. A second failure escalates to the user. Leave the ticket In Progress with a Jira comment that names the blocker.

**Gate `worker_done`.** The first line of the summary is the verdict:
- `VERDICT: MERGED`: the gate has already merged and closed Jira. Verify it: `gh pr view <n> --json state,mergeCommit` shows MERGED and the Jira status is Done. Then `worker-release` both workers and remove the worktree via the orca-cli guide (`orca worktree` remove/archive). Dispatch the next ready ticket.
- `VERDICT: CHANGES_REQUESTED`: send the findings back to the retained implementer by reusing its terminal with a new task:
  ```
  orca orchestration task-create --spec "Fix round <k> for AGO-<n>, PR #<pr>: <findings verbatim>. Push to the same branch, re-run the gates, reply with worker_done." --json
  orca orchestration worker-start --task <task_id> --terminal <implementer handle> --json
  ```
  Release the gate worker. When the fix is done, dispatch a fresh tester (behaviour may have changed), then the gate. After **3** fix rounds without a clean gate, escalate to the user.
- `VERDICT: WAITING`: CI is still running or GitHub is slow. Re-dispatch the gate after 10 minutes.
- `VERDICT: ESCALATE`: `PushNotification` (`PR #<n> AGO-<n> needs your merge: <reason>`), relay the reason to the user verbatim, and pause that ticket.

Also send a `PushNotification` when a ticket fails twice, when a PR hits 3 fix rounds, and when a wave finishes. Don't send one for routine progress.

**Branch check.** On every `worker_done` that carries a PR, confirm the PR's `headRefName` equals the assigned branch. If it doesn't, the worker renamed after pushing: send it a fix task to close that PR and reopen from the assigned branch. Never accept a second branch for one ticket.

## 4. Finish the wave

The wave is done when every non-epic `wave-<N>` ticket is Done. Then:
1. Close any epic whose children are all Done: transition `41` and comment with the list of merged PRs.
2. Run `/wave-status` for a cross-check, which catches merged-but-open tickets and stray PRs, and fix what it flags.
3. `worker-list --run <run_id> --terminal-state reclaimable --json` must return none.
4. Report to the user: per ticket, the outcome, PR link and fix rounds, plus anything escalated or skipped.
5. Unless `--one-wave` was given, continue with the next wave from step 1.

## Hard rules

- Never merge, approve or push code yourself. The gate merges, and only through `/pr-gate`.
- Never decide a human-only question. When unsure whether something costs money, ask.
- Never start two implementers on one ticket, and never put two tickets in one worktree.
- Never have two schema tickets in flight at once.
- Never let a worker pick or change its own branch name.
- Keep Jira in sync at every step. The board is what the human reads.
- If a guard hook denies an action, treat that as a human-only boundary. Don't work around it.
