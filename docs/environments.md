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

## Rate limiter and proxy headers (AGO-201)

| Variable | Default | Purpose |
|---|---|---|
| `TRUST_PROXY_HEADERS` | `false` | `true` or `false`. Set `true` only when the app runs behind a reverse proxy that **overwrites** `X-Forwarded-For` / `X-Real-IP` (Vercel does). The rate limiter then uses the first hop as the client address. |

By default the forwarding headers are ignored, because without a trusted proxy a caller can set them to
anything and get a fresh per-IP bucket on every request. With the switch off, every caller shares one
`unknown` per-IP bucket (fails closed). Per-user and per-email limits never read these headers and are
unchanged. Set it to `true` in preview and production on Vercel; Playwright sets it for the rate-limit
specs. Not secret (the value may appear in a bundle); `.env.example` is protected by a deny rule, so the
variable is documented here only (see `docs/tickets/AGO-201.md`).

## Worker variables (AGO-143)

Beyond the shared server variables, the worker reads (all optional, validated in `apps/worker/src/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_PORT` | `8787` | Health server port (`0` = pick a free port). Separate from the web `PORT`. |
| `WORKER_HOST` | `127.0.0.1` | Bind address; the container image sets `0.0.0.0`. |
| `LOG_LEVEL` | `info` | pino level: fatal, error, warn, info, debug, trace, silent. |
| `HEALTH_DB_TIMEOUT_MS` | `2000` | Timeout of the `/health` database probe (100-30000). |

`DATABASE_URL` defaults to the local Supabase Postgres (`127.0.0.1:44322`) when `APP_ENV` is `local`. `.env.example` is protected by a deny rule, so these four are not listed there yet (follow-up in `docs/tickets/AGO-143.md`).

## Error tracking and log shipping (AGO-104)

Sentry is **optional**. With no DSN the web app and the worker run normally, the SDK is never
initialised and nothing is sent. Only the **free Sentry Developer plan** is in scope: no Replay,
no Profiling, no tracing (`tracesSampleRate: 0`), no Seer/AI, no source-map upload.

| Variable | Where | Purpose |
|---|---|---|
| `SENTRY_DSN` | web server, worker (server-only) | Ingest address for server and worker errors. Validated as a URL by `serverOnlyEnvSchema`. |
| `NEXT_PUBLIC_SENTRY_DSN` | browser (declared in `clientEnvSchema`) | Ingest address for browser errors. A DSN is write-only and public by design. It is inlined at **build** time, so set it when running `next build`. |

Both are listed, empty, in `.env.example`.

**How to enable** (a human does this; no account is created by code):
1. Create a free Sentry Developer account and a project (Next.js for the web, Node for the worker, or one project for both).
2. Copy the project DSN into `.env.local` (or the host's secret store) as `SENTRY_DSN=<dsn>` and `NEXT_PUBLIC_SENTRY_DSN=<dsn>`.
3. Set `NEXT_PUBLIC_SENTRY_DSN` **before `next build`** (it is inlined into the browser bundle), then restart the web app and the worker.
4. Leave both empty to turn error tracking off. Nothing is initialised or sent.

- **Web:** `apps/web/src/instrumentation.ts` (`register`, `onRequestError`) and
  `apps/web/src/instrumentation-client.ts`, using `@sentry/nextjs`. `next.config.ts` is not wrapped
  with `withSentryConfig` (that is only needed for source maps and tunnelling).
- **Worker:** `apps/worker/src/sentry.ts`, using `@sentry/node`. `run_id`, `agent_id` and
  `workspace_id` become Sentry tags through `tracker.captureException(error, context)`; uncaught
  exceptions and unhandled rejections are reported, flushed, then the process exits 1; `stop()`
  flushes on SIGTERM/SIGINT.
- **CSP:** the Sentry ingest origin (taken from the DSN, never its key) is added to `connect-src`
  only when `NEXT_PUBLIC_SENTRY_DSN` is set (`apps/web/src/lib/security/csp.ts`). The value is the
  one inlined at **build** time, the same one the browser SDK uses, so the CSP and the browser
  always agree; changing the DSN needs a rebuild. An invalid value is logged once (variable name
  only) and treated as "off": the app keeps serving and nothing is allowed or sent.
- **Scrubbing:** every event and breadcrumb passes `scrubTelemetryEvent` (`packages/shared/src/redaction`,
  the same rules as the worker log scrubber) in `beforeSend` / `beforeBreadcrumb`: secret-named keys
  (including `cookie`), `Authorization`/`Bearer`/`Basic` values, `apikey=`/`token=` pairs, credentialed
  URLs, JWTs, `Cookie:` / `Set-Cookie:` header lines, and `sk-` (any `sk-` key of 16+ characters,
  including `sk-proj-`, `sk-svcacct-`, `sk-admin-`, `sk-ant-`), `sb_secret_`, `ghp_` style keys,
  also inside free-text messages. Sentry v11
  has no `sendDefaultPii`; `TELEMETRY_DATA_COLLECTION` turns every `dataCollection` category off.
- **Log shipping:** the worker already writes one scrubbed JSON object per line to stdout. The host
  (container runtime, Vercel, or whatever the human picks) collects stdout; no paid log service is
  used. Log lines at info and above also become Sentry breadcrumbs on later errors, with the run id.

## Build check

`pnpm build` runs `scripts/check-client-bundle.mjs` against `apps/web/.next/static` after
`next build`. It fails when the bundle contains a server-only variable name, a secret-named
`process.env.*` reference, or the value of a secret set in the build environment.

## Adding a variable

1. Add it to the schema (`clientEnvSchema` only if it must be public, and prefix `NEXT_PUBLIC_`).
2. If public, add the literal `process.env.NEXT_PUBLIC_X` line in `getClientEnv()`.
3. Add it, with a comment and a safe placeholder, to `.env.example`.
4. Add a schema test in `packages/shared/test/env.test.mjs`.
