# Environments and env config

Source of truth: `packages/shared/src/env/schema.ts` (Zod). Template: `.env.example`.
This ticket (AGO-70) models the environments in code and documents them. It creates no hosted
resources: Vercel and hosted Supabase are set up by a human.

## Environments

| | local | preview | production |
|---|---|---|---|
| `APP_ENV` | `local` (default when unset) | `preview` | `production` |
| Where it runs | developer machine, local Supabase in Docker (ports 55420-55429) | per-PR hosted preview | hosted |
| Supabase | local stack | hosted preview project (human-created) | hosted production project (human-created) |
| Required variables | none (safe dev defaults) | `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | same as preview |
| URL scheme | http allowed | https required | https required |

## Client vs server

- Only `NEXT_PUBLIC_*` variables may reach the browser (`clientEnvSchema`). Read them with
  `getClientEnv()` from `apps/web/src/lib/env/client.ts`, which imports `@ago/shared/client-env`
  (a subpath that excludes the server schema; never import the `@ago/shared` barrel from client code).
- Everything else is server-only. `apps/web/src/lib/env/server.ts` imports `server-only`, so
  importing `getServerEnv()` from a client component fails the build.
- The worker validates with `loadWorkerEnv()` in `apps/worker/src/env.ts`.

## Fail fast

- Web: `apps/web/src/instrumentation.ts` validates the server env when the server starts.
- Worker: call `loadWorkerEnv()` at process start.
- Errors name each missing or invalid variable and never print values.

## Build check

`pnpm build` runs `scripts/check-client-bundle.mjs` against `apps/web/.next/static` after
`next build`. It fails when the bundle contains a server-only variable name, a secret-named
`process.env.*` reference, or the value of a secret set in the build environment.

## Adding a variable

1. Add it to the schema (`clientEnvSchema` only if it must be public, and prefix `NEXT_PUBLIC_`).
2. If public, add the literal `process.env.NEXT_PUBLIC_X` line in `getClientEnv()`.
3. Add it, with a comment and a safe placeholder, to `.env.example`.
4. Add a schema test in `packages/shared/test/env.test.mjs`.
