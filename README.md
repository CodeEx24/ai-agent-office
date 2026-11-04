# Agent Office

A web app where AI agents with skills and capabilities work in a shared workspace, shown as a 3D animated virtual office, using shared Markdown (Obsidian-style) memory. A human is always in the loop. See `CLAUDE.md` for the engineering guide and `docs/ai-workflow.md` for the AI delivery workflow.

## Layout

| Path | Package | Role |
|---|---|---|
| `apps/web` | `@ago/web` | Next.js app (placeholder until AGO-61) |
| `apps/worker` | `@ago/worker` | Agent runtime and queue worker |
| `packages/shared` | `@ago/shared` | Zod schemas, event types, policy types, DB types |
| `packages/ui` | `@ago/ui` | shadcn/ui components and tokens |
| `packages/assets` | `@ago/assets` | GLB manifest and optimization scripts |
| `vault-template/` | n/a | Starter Markdown vault |
| `docs/tickets/` | n/a | Per-ticket notes (`AGO-###.md`) |

## Requirements

- Node.js 24 or newer
- pnpm 10.17.1 (`corepack enable` picks it up from `packageManager`)
- Docker Desktop, for the local Supabase stack (database commands only)

## Commands

```
pnpm install     install all workspace dependencies
pnpm build       build every package in dependency order (Turborepo)
pnpm typecheck   type-check every package
pnpm dev         run every package's dev task
pnpm clean       remove build output
pnpm db:start    start the local Supabase stack (Docker)
pnpm db:stop     stop it (keeps data)
pnpm db:reset    rebuild the local DB from supabase/migrations
pnpm db:migration:new <name>   create a migration
pnpm db:types    regenerate types into packages/shared
```

Lint, test and E2E scripts arrive with AGO-111. Database ports, the migration workflow, locking and rollback are in [docs/database.md](docs/database.md).

## Importing between packages

Packages are scoped `@ago/*` and depend on each other with `workspace:*`. `tsconfig.base.json` maps each alias (`@ago/shared`, `@ago/ui`, `@ago/assets`) to its `src/index.ts`, so type-checking and editors see source directly. Builds emit to `dist/` and resolve through the workspace links, with Turborepo building dependencies first.
