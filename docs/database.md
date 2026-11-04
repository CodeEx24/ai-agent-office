# Local database: Supabase, migrations and types

Agent Office uses a local Supabase stack in Docker (Postgres 17, Auth, Realtime, Storage, Studio). Hosted Supabase projects are created and linked by a human only; nothing here touches one.

## Ports

This project has its own block so it can run beside other Supabase stacks (which default to 54321-54329). Its `project_id` is `agent-office`.

| Service | Port | URL |
|---|---|---|
| API (Kong) and local MCP | 55421 | `http://127.0.0.1:55421` (`/mcp`) |
| Postgres | 55422 | `postgresql://postgres:postgres@127.0.0.1:55422/postgres` |
| Studio | 55423 | `http://127.0.0.1:55423` |
| Inbucket (test email) | 55424 | `http://127.0.0.1:55424` |
| Analytics | 55427 | |
| Edge runtime inspector | 55428 | |
| Pooler (disabled by default) | 55429 | |
| Shadow DB (`db diff`) | 55420 | |

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

## Rollback

Local database: run `pnpm db:reset` on the previous commit, which rebuilds it from that commit's migrations. This is the normal path.

Undoing one migration on a running local database: apply its `rollbacks/*.down.sql` (for example `docker exec -i supabase_db_agent-office psql -U postgres < supabase/rollbacks/<file>.down.sql`), then delete the row from `supabase_migrations.schema_migrations`, or simply reset. To drop a migration from a branch, revert the commit that added both the migration and its rollback file.

Hosted environments are migrated by a human through the release process, not by agents.

## Generated types

`pnpm db:types` writes `packages/shared/src/db/database.types.ts` from the local database (`public` schema) and `@ago/shared` re-exports `Database` and `Json`. The script writes only when generation succeeds. Never edit the file by hand.
