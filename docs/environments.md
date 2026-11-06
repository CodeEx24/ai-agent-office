# Environments and env config

Source of truth: `packages/shared/src/env/schema.ts` (Zod). Template: `.env.example`.
This ticket (AGO-70) models the environments in code and documents them. It creates no hosted
resources: Vercel and hosted Supabase are set up by a human.

## Environments

| | local | preview | production |
|---|---|---|---|
| `APP_ENV` | `local` (default only when `NODE_ENV` is not `production`, see below) | `preview` (required) | `production` (required) |
| Where it runs | developer machine, local Supabase in Docker (ports 44320-44329) | per-PR hosted preview | hosted |
| Supabase | local stack | hosted preview project (human-created) | hosted production project (human-created) |
| Required variables | none (safe dev defaults) | `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | same as preview |
| URL scheme | http allowed | https required | https required |

## Client vs server

- Only `NEXT_PUBLIC_*` variables may reach the browser (`clientEnvSchema`). Read them with
  `getClientEnv()` from `apps/web/src/lib/env/client.ts`, which imports `@ago/shared/client-env`
  (a subpath that excludes the server schema; never import the `@ago/shared` barrel from client code).
- Public variables are deny-by-default: any `NEXT_PUBLIC_` variable not declared in `clientEnvSchema` is rejected at startup and flagged by the bundle check. To expose one, add it to the schema.
- Everything else is server-only. `apps/web/src/lib/env/server.ts` imports `server-only`, so
  importing `getServerEnv()` from a client component fails the build.
- The worker validates with `loadWorkerEnv()` in `apps/worker/src/env.ts`.

## Fail fast

- Web: `apps/web/src/instrumentation.ts` validates the server env when the server starts.
- Worker: `apps/worker/src/index.ts` calls `loadWorkerConfig()` (which wraps `loadWorkerEnv()`) at process start and exits 1 with one JSON error line naming the variable when the check fails (AGO-143).
- Errors name each missing or invalid variable and never print values.
- `APP_ENV` is required whenever `NODE_ENV=production`, on any host (Vercel, Docker, plain Node) and in the
  worker. If it is unset, startup fails with an error naming `APP_ENV` and how to set it (never a value). It
  defaults to `local` only when `NODE_ENV` is not `production`. Set `APP_ENV=preview` or `production` on a
  deployment. A production build that runs locally (`next start`, CI, Playwright) must set `APP_ENV=local`:
  `.env.example` does, `ci.yml` does, and `apps/web/playwright.config.ts` sets it in `webServer.env`. `turbo.json`
  passes `APP_ENV` through to the `build`, `dev` and `test:e2e` tasks.
  Both the web app and the worker use one helper, `isAppEnvMissingInProduction`, via `parseServerEnv`.

## Worker variables (AGO-143)

Beyond the shared server variables, the worker reads (all optional, validated in `apps/worker/src/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_PORT` | `8787` | Health server port (`0` = pick a free port). Separate from the web `PORT`. |
| `WORKER_HOST` | `127.0.0.1` | Bind address; the container image sets `0.0.0.0`. |
| `LOG_LEVEL` | `info` | pino level: fatal, error, warn, info, debug, trace, silent. |
| `HEALTH_DB_TIMEOUT_MS` | `2000` | Timeout of the `/health` database probe (100-30000). |

`DATABASE_URL` defaults to the local Supabase Postgres (`127.0.0.1:44322`) when `APP_ENV` is `local`. `.env.example` is protected by a deny rule, so these four are not listed there yet (follow-up in `docs/tickets/AGO-143.md`).

## Build check

`pnpm build` runs `scripts/check-client-bundle.mjs` against `apps/web/.next/static` after
`next build`. It fails when the bundle contains a server-only variable name, a secret-named
`process.env.*` reference, or the value of a secret set in the build environment.

## Adding a variable

1. Add it to the schema (`clientEnvSchema` only if it must be public, and prefix `NEXT_PUBLIC_`).
2. If public, add the literal `process.env.NEXT_PUBLIC_X` line in `getClientEnv()`.
3. Add it, with a comment and a safe placeholder, to `.env.example`.
4. Add a schema test in `packages/shared/test/env.test.mjs`.
