# Local database: Supabase, migrations and types

Agent Office uses a local Supabase stack in Docker (Postgres 17, Auth, Realtime, Storage, Studio). Hosted Supabase projects are created and linked by a human only; nothing here touches one.

## Ports

This project has its own block so it can run beside other Supabase stacks (which default to 54321-54329). Its `project_id` is `agent-office`.

| Service | Port | URL |
|---|---|---|
| API (Kong) and local MCP | 44321 | `http://127.0.0.1:44321` (`/mcp`) |
| Postgres | 44322 | `postgresql://postgres:postgres@127.0.0.1:44322/postgres` |
| Studio | 44323 | `http://127.0.0.1:44323` |
| Inbucket (test email) | 44324 | `http://127.0.0.1:44324` |
| Analytics | 44327 | |
| Edge runtime inspector | 44328 | |
| Pooler (disabled by default) | 44329 | |
| Shadow DB (`db diff`) | 44320 | |

Ports live in `supabase/config.toml`. Local keys and URLs: `pnpm exec supabase status` (demo keys only). They go in untracked `.env.local` files, never in git.

## Commands

Docker Desktop must be running (about 4 GB of memory).

| Task | Command |
|---|---|
| Start the stack | `pnpm db:start` |
| Stop (keeps data) | `pnpm db:stop` |
| Rebuild the DB from the repo's migrations and seed | `pnpm db:reset` |
| New migration | `pnpm db:migration:new ago_<n>_<what>` |
| Regenerate TypeScript types | `pnpm db:types` |

The stack is shared by every worktree. `db:reset` rebuilds it from the current worktree, so wrap resets and DB test runs in the file lock:

```
node scripts/db-lock.mjs acquire AGO-<n>
pnpm db:reset
node scripts/db-lock.mjs release AGO-<n>
```

## Migration workflow

1. `pnpm db:migration:new ago_<n>_<what>` creates `supabase/migrations/<timestamp>_ago_<n>_<what>.sql`.
2. Write the SQL. Every table has `workspace_id` and RLS policies (CLAUDE.md invariants).
3. Write the rollback in `supabase/rollbacks/<same timestamp>_ago_<n>_<what>.down.sql`. Supabase does not run it; it is the reviewed, reversible counterpart.
4. Apply from scratch: lock, `pnpm db:reset`, unlock. The local database now matches the repo.
5. `pnpm db:types` and commit the regenerated `packages/shared/src/db/database.types.ts`.
6. Describe the change and rollback in `docs/tickets/AGO-<n>.md`.

Only one schema-changing ticket is in flight at a time.

## Database tests (pgTAP)

SQL tests live in `supabase/tests/*.sql` and run with `pnpm exec supabase test db` (inside the db lock, like a reset). `core_schema.test.sql` is catalog-driven: every table in `public` must have RLS enabled, a uuid primary key and (except `workspaces`) a `workspace_id uuid not null`, so a new table that breaks the invariants fails the suite.

`run_events_append_only.test.sql` proves `run_events` rejects UPDATE, DELETE and TRUNCATE for `anon`, `authenticated`, `service_role` and the owner, and that `seq` must increase per run. The concurrent-insert check is `scripts/run-events-concurrency.test.mjs` (`RUN_DB_TESTS=1`, inside the db lock). `run_events` is append-only by privileges and triggers (AGO-102): never grant UPDATE/DELETE/TRUNCATE on it, and change its schema through migrations only (a superuser migration is the one way to alter it).

## Rollback

Local database: run `pnpm db:reset` on the previous commit, which rebuilds it from that commit's migrations. This is the normal path.

Undoing one migration on a running local database: apply its `rollbacks/*.down.sql` (for example `docker exec -i supabase_db_agent-office psql -U postgres < supabase/rollbacks/<file>.down.sql`), then delete the row from `supabase_migrations.schema_migrations`, or simply reset. To drop a migration from a branch, revert the commit that added both the migration and its rollback file.

Hosted environments are migrated by a human through the release process, not by agents.

## Generated types

`pnpm db:types` writes `packages/shared/src/db/database.types.ts` from the local database (`public` schema) and `@ago/shared` re-exports `Database` and `Json`. The script writes only when generation succeeds. Never edit the file by hand.
