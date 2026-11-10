# Local backend recipe

How to run the app against the local Supabase stack, for developers, agents and the device tester (Playwright). Everything is local: no hosted project is ever linked, pushed to or changed. Related: [../database.md](../database.md), [../auth.md](../auth.md), [../testing.md](../testing.md), [../workflow/README.md](../workflow/README.md).

## Prerequisites

- Docker Desktop running.
- `pnpm install` (the Supabase CLI is a dev dependency; use `pnpm exec supabase ...`).

## Start the stack

```
pnpm exec supabase start      # same as pnpm db:start
pnpm exec supabase status -o env   # API_URL and ANON_KEY (a local demo key)
```

The stack uses ports 44320-44329 so it does not clash with other projects:

| Service | Port | URL |
|---|---|---|
| API (Kong, auth, REST) | 44321 | <http://127.0.0.1:44321> |
| Postgres | 44322 | `postgresql://postgres:postgres@127.0.0.1:44322/postgres` |
| Studio | 44323 | <http://127.0.0.1:44323> |
| Mailpit (mail catcher, login codes) | 44324 | <http://127.0.0.1:44324> |
| Shadow DB (migrations diff) | 44320 | internal |
| Pooler / analytics / edge inspector | 44327-44329 | internal |

Stop with `pnpm exec supabase stop` (`pnpm db:stop`). Config: `supabase/config.toml`.

## The stack is shared: use the db lock

All worktrees share one stack, so any schema reset or DB test run is wrapped in the lock:

```
node scripts/db-lock.mjs acquire AGO-<n>      # waits up to 30 min; exit 2 = timed out
pnpm exec supabase db reset                    # or pnpm db:reset, pgTAP, DB-backed Vitest, live e2e
node scripts/db-lock.mjs release AGO-<n>      # always release, also on failure
node scripts/db-lock.mjs status
```

Locks older than 60 minutes are treated as abandoned. The checks script (`scripts/workflow/checks.sh`) takes the lock itself for pgTAP and skips pgTAP when the stack is down.

## Seed data

```
pnpm db:seed        # scripts/db-seed.mjs: demo workspace data; safe to re-run
```

`supabase db reset` applies migrations and `supabase/seed.sql`. Regenerate DB types with `pnpm db:types`.

## Test account (no real inbox, ever)

Sign-in is passwordless email. There is no shared password account; each run uses a throw-away address.

- By hand: open `/sign-in`, enter any address (e.g. `me@example.test`), press **Email me a sign-in code**, read the 6-digit code in Mailpit (<http://127.0.0.1:44324>) and enter it.
- In Playwright (AGO-67 fixtures): with `E2E_SUPABASE=1`, the `setup` project (`apps/web/e2e/auth.setup.ts`) signs in once with `uniqueEmail("setup")`, reads the code from Mailpit through the `SignInPage` page object, and saves `storageState` to `apps/web/e2e/.auth/user.json` (git-ignored). Specs start signed in with `test.use({ storageState: AUTH_STATE_PATH })` and guard with `test.skip(!isLiveStack, ...)`. Never commit saved state or credentials.

## Dev server and e2e on a free port

Other tickets run in parallel, so never use a fixed port 3000:

```
PORT=$(node scripts/free-port.mjs) pnpm dev
```

Live e2e (inside the db lock), from [../auth.md](../auth.md):

```
ANON=$(pnpm exec supabase status -o env | sed -n 's/^ANON_KEY="\(.*\)"/\1/p')
PORT=$(node scripts/free-port.mjs) E2E_SUPABASE=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:44321 NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON" pnpm test:e2e
```

`.env.local` files are written by the owner, never by agents. Browser checks by agents use the headless `playwright` MCP, not the shared Chrome. One local web app plus one Playwright run at a time (the device lane, see [../workflow/README.md](../workflow/README.md)); stop the dev server and, if you started it, the stack when you release the lane.

## Troubleshooting

- Ports busy: `pnpm exec supabase stop`, then check `node scripts/free-port.mjs`; another worktree may hold the stack, check `node scripts/db-lock.mjs status`.
- Docker not running: `supabase start` fails fast; start Docker Desktop first.
- Mailpit empty: the stack was restarted without the templates; `pnpm db:stop && pnpm db:start`.
