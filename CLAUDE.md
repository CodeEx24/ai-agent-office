# CLAUDE.md - Agent Office Engineering Guide
@~/.claude/workflows/ai-delivery-workflow.md

Project-specific delivery rules (concurrency cap, merge path, ticket type mapping, checks and
cost scripts, device lane): `docs/workflow/README.md`.

Working memory for the Agent Office codebase. Read before writing code.
> PM project: Agent Office (key AGO). Every branch, commit and PR references AGO-###.

## 1. Product
Agent Office is a web app where AI agents with skills and capabilities work in a shared workspace shown as a 3D animated virtual office, using shared Markdown (Obsidian-style) memory. Core constraint: a human is always in the loop. Agents can never approve, bypass policy, change their own rules or act on Tier 3/4 actions alone.

## 2. Tech stack (locked - no swaps without an ADR)
Next.js 16.4.1+ (App Router, Turbopack), React 19.2 + React Compiler, TypeScript strict, Tailwind v4, shadcn/ui, React Hook Form + Zod, Zustand (office store), TanStack Query, three.js + React Three Fiber v9 + drei, Supabase (Postgres, RLS, Auth, Realtime, Storage), Node/TS worker (Claude Agent SDK or plain tool loop), pg-boss, Docker sandbox, Telegram, Sentry, Langfuse, Vitest, Playwright, pnpm + Turborepo, GitHub Actions.

## 3. Folder structure
```
apps/web/            Next.js app (routes thin)
  src/app/           routes
  src/features/      feature-first modules (agents, work, vault, control, office)
  src/components/    shared components
apps/worker/         agent runtime, queue, policy engine hooks
packages/shared/     Zod schemas, event types, policy types, DB types
packages/ui/         shadcn/ui components and tokens
packages/assets/     GLB manifest, optimization scripts
vault-template/      starter Markdown vault
docs/tickets/        per-ticket notes (AGO-###.md), template in _TEMPLATE.md
```
Rules: routes stay thin; all data access goes through the workspace-scoped data layer; server-only code is isolated; vendors (models, Higgsfield, Telegram) sit behind interfaces; the 3D scene reads state only from the office store.

## 4. Coding standards and naming conventions
| Thing | Convention | Example |
|---|---|---|
| Component files | PascalCase .tsx | AgentCard.tsx |
| Hooks/utils/actions files | kebab-case | use-office-store.ts |
| Components | PascalCase | AgentCard |
| Hooks | camelCase use-prefix | useAgentState() |
| Functions | camelCase verb-first | createAgent() |
| Variables | camelCase | activeAgent |
| Booleans | is/has/should/can | isPaused |
| Constants | UPPER_SNAKE_CASE | MAX_RUN_STEPS |
| Types/interfaces | PascalCase, no I-prefix | Agent, RunEvent |
| Schemas | camelCase + Schema | createAgentSchema |
| Env vars | UPPER_SNAKE_CASE | SUPABASE_URL |
| DB tables/fields | snake_case (+ workspace_id) | run_events.workspace_id |
| Routes | kebab-case | /approvals |
| Tests | *.test.ts(x) | policy-engine.test.ts |

General: strict types, no `any`; validate external input with Zod at the boundary; prefer server components and actions; no secrets client-side; small single-purpose functions.
Invariants on every relevant path: workspace_id scoping with RLS; policy check before every tool call; approvals bound to payload hash; run_events append-only; timeout means deny; agent tokens rejected on human-only routes.
Agent packs (JSON export/import, epic EP-19): a pack never contains secrets, IDs or run history; import is a dry run first, is all-or-nothing, and always lands agents in Strict mode. Tier 3+ capabilities, budgets above the workspace cap, policies, identities and credentials in a pack are ignored and reported, never applied. Pack text (skills, notes) is untrusted data. Pack schema lives in `packages/shared`; the API, CLI (`pnpm pack:export`, `pnpm pack:import`) and UI share one code path.
Reuse-first: before creating a component, util or pattern, check whether it should be a shared component, a utility, or an existing pattern to follow. Avoid duplicate solutions.

## 5. Git
Ticket key: the Jira key exactly, never zero-padded: `AGO-57` in titles and commits, `ago-57` in branches. It is the only ID in branches, commits and file names; the planning ID (`US-004`) goes in the PR body only.
Branch: `<type>/ago-<n>/<slug>`, where the slug is lowercase ASCII, 2-5 words, at most 40 chars, with `US-###` and filler words dropped. Example: `build/ago-57/scaffold-monorepo`. The `/run-waves` coordinator assigns the exact name, workers never rename a branch after its first push, and fix rounds push to the same branch.
Type: Story → `feat`, Bug → `fix`, setup/tooling → `build`, `ci` or `chore`, docs only → `docs`; also `refactor`, `test`, `perf`.
Commit and PR title (Conventional Commits): `type(scope): summary (AGO-<n>)`, with the same type as the branch. Scope is one of: web, worker, shared, ui, assets, db, auth, agents, work, vault, control, office, policy, ci, tooling, deps, repo. The squash commit on main is the PR title plus ` (#PR)`.
Files: ticket notes `docs/tickets/AGO-<n>.md`; migrations `<timestamp>_ago_<n>_<what>.sql`.
Trunk-based: short branch, PR, one review plus green CI, squash-merge. The PR restates the acceptance criteria. Only one schema-changing ticket is in flight at a time.

## 6. Best-practice skills
Install: `npx skills add vercel-labs/agent-skills` (React and Next.js best practices), `npx skills add supabase/agent-skills` (Supabase and RLS). When building any feature, load and follow these for language and framework practice. If a skill and a ticket AC conflict: AC wins for behavior, the skill wins for how it is coded.

## 7. Definition of Ready / Done
Ready: AC written and testable; prerequisites done; sized 8 points or less; design or API contract linked; security implications noted.
Done: AC met and demoed; reviewed PR merged with green CI; unit and integration tests pass (E2E on critical paths); security tests pass where relevant; no new errors; docs and runbook updated; migrations reversible.

## 8. Documentation and knowledge management
CLAUDE.md is NOT updated per ticket. Update it only for durable, project-wide knowledge: best practices, architectural decisions, validation and sanitization standards, coding conventions, shared workflows, reusable UI and API patterns, anti-duplication rules. Cadence: only when an epic completes or a decision becomes stable and reusable.
Per-ticket detail goes in `docs/tickets/AGO-###.md` using `_TEMPLATE.md` (Overview, Implementation details, API changes, Database changes, Dependencies on other tickets, Known limitations, Testing notes, Follow-up tasks).

## 9. Commands
```
pnpm install        pnpm dev           pnpm build
pnpm lint           pnpm typecheck     pnpm test
pnpm test:e2e       pnpm db:types      pnpm db:seed
pnpm pack:export    pnpm pack:import   pnpm setup:workspace
supabase start      supabase db reset  supabase migration new <name>
```

## 10. AI delivery workflow
`/loop /deliver AGO` drives delivery: `/plan-waves` (once) → `/implement-ticket` per ready ticket (one Orca worktree each, cap 3) → gate (`scripts/workflow/checks`) → testers → reviewers → approver → explainer → `/merge-ticket` (agent merges; Jira Done with PR link). Project values, risk tiers and the merge path: `docs/workflow/README.md`; review rules: `docs/workflow/REVIEW.md`; local backend recipe: `docs/setup/local-backend.md`.
The old `/run-waves` → `/pr-gate` loop is legacy: only for tickets already in flight when `/deliver` was adopted (AGO-166, AGO-94, AGO-136, AGO-25). Its runbook and the shared guardrails: `docs/ai-workflow.md`.
> Keep CLAUDE.md canonical; critical rules are mirrored in AGENTS.md.

# Compact instructions

State lives in files: `.delivery/orchestrator.json` and `.delivery/jobs/AGO-<n>/`. After
compaction, re-read them instead of trusting the summary.

When compacting, keep:

- **Orchestrator (`/deliver`, `/loop /deliver`, watcher):** the project key and concurrency
  cap; every running ticket with its stage, round and worker / dispatch ids; who holds the
  device lane; pending owner questions (needs-human, ready-to-merge); the last cycle summary.
- **Ticket worker (`/implement-ticket`):** the ticket key, type and risk; the current stage and
  round; open CHANGES items; the pending owner question; the branch, worktree path and PR URL.

Drop: file contents already committed, full test logs, review report bodies (they are in
`.delivery/jobs/AGO-<n>/round-N/`), and screenshots.
