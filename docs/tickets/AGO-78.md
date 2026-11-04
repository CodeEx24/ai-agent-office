# AGO-78 - US-010 Set up Supabase, local dev and migrations

## Overview
Local Supabase project, migration workflow and generated TypeScript types. Jira: AGO-78, epic EP-01 (Data and auth), wave 1. Local only: creating, linking or pushing a hosted Supabase project is human-only and not done here (see Follow-up tasks). The real core schema is AGO-74, so no domain tables are created.

## Implementation details
- `supabase/config.toml` from `supabase init`, with `project_id = "agent-office"` and its own port block 55420-55429 (API 55421, DB 55422, Studio 55423, Inbucket 55424, analytics 55427, edge inspector 55428, pooler 55429, shadow DB 55420), because other projects' stacks already hold the default 54321-54329 on this machine.
- Supabase CLI pinned at `supabase@3.0.0` as a root devDependency (the only root dependency change; AGO-61 also edits the root `package.json` and lockfile).
- Root scripts: `db:start`, `db:stop`, `db:reset`, `db:migration:new`, `db:types`.
- `scripts/db-types.mjs` runs `supabase gen types typescript --local` and writes `packages/shared/src/db/database.types.ts` only on success; `@ago/shared` re-exports `Database` and `Json`.
- Baseline migration `supabase/migrations/20261104160007_ago_78_baseline_private_schema.sql` creates the `private` schema (no API access). Matching rollback in `supabase/rollbacks/`.
- `supabase/seed.sql` is an empty placeholder (fixtures arrive with AGO-74).
- `.claude/skills/local-db/SKILL.md`: MCP URL and port troubleshooting updated to 55421 / 55420-55429.
- `.mcp.json`: `supabase-local` URL moved to `http://127.0.0.1:55421/mcp`. This file is human-merged.
- Docs: `docs/database.md` (ports, commands, locking, migration workflow, rollback), README commands.

### Decisions taken (recommended option chosen, no human available)
- Own port block 554xx and `project_id = "agent-office"` instead of the 543xx defaults: the coordinator-recommended option; avoids clashing with the running harbour-strata, bidatap and task-buddy stacks. Note: this differs from the `local-db` skill text ("every worktree has the same project_id"), which holds because every Agent Office worktree uses `agent-office`.
- Supabase CLI pinned exactly to 3.0.0 (the version the `local-db` skill names and the latest at the time), rather than a range.
- Baseline migration is just a `private` schema (pgcrypto was rejected: Supabase already ships it, which made the migration a no-op and its rollback harmful): smallest thing that proves the workflow; no domain tables (AGO-74).
- Rollbacks are plain `.down.sql` files in `supabase/rollbacks/` (Supabase has no down migrations), kept outside `migrations/` so the CLI never applies them.
- `db:reset` is a plain `supabase db reset`; the lock is a documented convention (`scripts/db-lock.mjs`), not baked into the script, so a ticket ID stays explicit.
- `auth.site_url` left at the default `http://127.0.0.1:3000`: dev servers use free ports, so auth redirect config belongs to the sign-in ticket (AGO-67).
- Types limited to the `public` schema.

## API changes
None.

## Database changes
Migration `20261104160007_ago_78_baseline_private_schema.sql`: `create schema if not exists private;` plus `revoke all ... from public, anon, authenticated`. No tables, so no `workspace_id`/RLS yet (AGO-74).
Rollback: `supabase/rollbacks/20261104160007_ago_78_baseline_private_schema.down.sql` (`drop schema if exists private;`), or `pnpm db:reset` on the previous commit. Both are documented in `docs/database.md`.

## Dependencies on other tickets
Blocked by AGO-57 (monorepo, done). Blocks AGO-74 (core schema) and AGO-67 (sign-in).

## Known limitations
- Hosted Supabase project not created (human-only).
- `pnpm lint` and `pnpm test` do not exist yet (AGO-111); no CI job yet (AGO-92), so migrations are not checked in CI.
- Generated types are empty (`public` has no tables) until AGO-74.
- The generated file is not formatted (the CLI suggests oxfmt); it is never hand-edited.

## Testing notes
Run with Docker up. Everything below was run locally:
- `pnpm db:start`; `node scripts/db-lock.mjs acquire AGO-78`; `pnpm db:reset`; release. Baseline migration applied and the `private` schema exists.
- AC1: `supabase migration list --local` shows `20261104160007` on both sides; `supabase db diff --local` reports "No schema changes found".
- AC2: `pnpm db:types` regenerates `packages/shared/src/db/database.types.ts`; re-running it leaves `git diff` empty; `pnpm typecheck` and `pnpm build` pass with the re-export.
- AC3 (rollback): applying the `.down.sql` drops the schema (count 0), `pnpm db:reset` restores it (count 1). The first draft used `pgcrypto`, but a reset without the migration still had it, so the test could not prove anything; it was replaced by `private`, which only the migration creates (verified).
- Clean install: `supabase@3.0.0` has no install script and `pnpm ignored-builds` is empty, so no `onlyBuiltDependencies` entry is needed. A delete-and-reinstall run was not done (the permission prompt denied the `rm`).

## Follow-up tasks
- Human: create the hosted Supabase project and link it (never by agents).
- AGO-111: add lint/test scripts; consider a CI check that `pnpm db:reset` + `pnpm db:types` leaves no diff (AGO-92).
- AGO-67: set `auth.site_url` and redirect URLs for sign-in.
