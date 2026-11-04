---
name: local-db
description: >-
  Run Agent Office's database locally: one shared Supabase stack in Docker (Postgres, Auth,
  Realtime, Storage, Studio), safe to use from many parallel ticket worktrees through a file
  lock. Covers start/stop, applying a branch's migrations with db reset, generating types,
  RLS tests, the local Supabase MCP, and the rule that agents never touch a hosted project.
  Use whenever a ticket needs the database: "start the db", "run migrations", "db reset",
  "test RLS", "generate db types", "is supabase running", or when a test fails because
  Postgres or Auth is unreachable.
---

# Local database (Supabase in Docker)

## Rules
- Agents use **only** the local stack. Hosted Supabase (link, `db push`, `--linked`, secrets, deploys) is human-only, and the guard hook enforces it.
- One stack per machine, shared by all worktrees: every worktree's `supabase/config.toml` has the same `project_id`, so the containers and ports are shared. Serialize anything that changes or depends on the schema with the lock:
  ```
  node scripts/db-lock.mjs acquire AGO-###     # waits up to 30 min; exit 2 = timed out
  ... supabase db reset / DB tests ...
  node scripts/db-lock.mjs release AGO-###
  ```
  Always release, even when a step fails. Locks older than 60 min are broken automatically.
- Only one schema-changing ticket is in flight at a time (the `/run-waves` schema slot). Ask the coordinator before writing a migration if your brief says `schema: no`.
- Migrations: `supabase migration new ago_<n>_<what>`, which gives `<timestamp>_ago_<n>_<what>.sql`. Every table gets `workspace_id` + RLS policies. Keep migrations reversible: add a down/rollback note in `docs/tickets/AGO-###.md`. Load the `supabase-postgres-best-practices` and `supabase` skills before writing SQL.

## CLI
Once the monorepo exists (AGO-57), the Supabase CLI is a root dev dependency, so use `pnpm exec supabase …`. Before that, use `pnpm dlx supabase@3.0.0 …`. Docker Desktop must be running (`docker ps`).

| Task | Command |
|---|---|
| Start the stack (first run pulls images) | `pnpm exec supabase start` |
| Status, URLs and local keys | `pnpm exec supabase status` (local demo keys only, never real ones) |
| Apply this branch's migrations and seed from scratch | lock → `pnpm exec supabase db reset` → unlock |
| Generate DB types | `pnpm db:types` (→ `packages/shared`) |
| RLS / DB tests | lock → `pnpm exec supabase test db` or the Vitest integration suite → unlock |
| Stop (keeps data) | `pnpm exec supabase stop` |

`db reset` rebuilds the shared DB from the current worktree's migrations. That is why it needs the lock: another ticket's tests could be running against the old schema.

## Env
Local URLs and keys come from `supabase status`. They go in the untracked `.env.local` / `apps/web/.env.local`, which the human creates once in the main checkout and `scripts/worktree-setup.mjs` copies into every new worktree. Agents never write `.env*` files (hook-enforced). If a value is missing, say which one and use the `setup-env` skill.

## Local MCP
`.mcp.json` registers `supabase-local` at `http://127.0.0.1:55421/mcp`. It only connects while the stack is running. Use it to inspect tables, policies and logs, and run `get_advisors` after a migration. It is local only and never points at a hosted project.

## Troubleshooting
- Port already in use (55420–55429, this project's block; see docs/database.md): another stack with a different `project_id` is running. Check with `docker ps` and stop it.
- `supabase start` hangs: Docker Desktop isn't running, or it is out of memory (the stack needs ~4 GB).
- Lock stuck: `node scripts/db-lock.mjs status`. Only the owner can release it, and it is auto-broken after 60 min.
