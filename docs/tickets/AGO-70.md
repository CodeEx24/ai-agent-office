# AGO-70 - Define environments and validated env config

## Overview
Story US-008, Epic EP-00, Wave 1, Jira: https://stratyge.atlassian.net/browse/AGO-70. Blocked by AGO-61 (Done).
Define local, preview and production environments with a Zod-validated env schema and no secrets in client bundles.

Acceptance criteria (verbatim):
- Given a missing required env var, when the app starts, then it fails with a clear message
- A build check fails if a secret-named var reaches the client bundle
- .env.example lists every variable
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

Risk tier: medium (touches the secrets surface; no auth, data model or agent runtime).

## Implementation details
- `packages/shared/src/env/schema.ts`: Zod schemas. `clientEnvSchema` (`NEXT_PUBLIC_*` only), `serverOnlyEnvSchema`, `serverEnvSchema` (server plus public, with per-environment rules in `superRefine`), `workerEnvSchema`. Exports `SERVER_ONLY_ENV_NAMES` and `CLIENT_ENV_NAMES`.
- `packages/shared/src/env/parse.ts`: `parseEnv(schema, source)` throws `EnvValidationError`. The message names each missing or invalid variable and never prints values.
- `apps/web/src/lib/env/server.ts` (`import "server-only"`, `getServerEnv()`), `client.ts` (`getClientEnv()`, literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them).
- `apps/web/src/instrumentation.ts`: validates the server env at server start (fail fast).
- `apps/worker/src/env.ts`: `loadWorkerEnv()`. It is not called yet; the worker entrypoint arrives with AGO-143.
- `scripts/check-client-bundle.mjs`: build check, run by `apps/web` `build` after `next build`. Flags server-only variable names, secret-named `process.env.*` references, and secret values present in `.next/static`. Reports names only.
- `docs/environments.md`: environment table and how to add a variable. `.env.example`: every variable, commented, placeholders only.
- Environments are modelled and documented only. No hosted resource is created (Vercel and hosted Supabase are human-only).

## API changes
None.

## Database changes
None. No migration; the schema slot was not needed.

## Dependencies on other tickets
- AGO-61 (Done): Next.js app.
- AGO-78 (merged): local Supabase ports 55420-55429. Confirmed API port 55421 and DB port 55422 in `supabase/config.toml`; the defaults and `.env.example` use them.
- AGO-111 (Vitest) and AGO-115: also touch root `package.json`/lockfile. The tests here use Node's built-in `node --test`; port to Vitest when AGO-111 lands.
- AGO-143 (worker skeleton): should call `loadWorkerEnv()` at startup.

## Decisions taken
| Decision | Chosen (recommended) | Reason |
|---|---|---|
| Where the schema lives | `packages/shared`, parsing wrappers per app | Brief and CLAUDE.md: schemas in `packages/shared`; `server-only` only in web |
| Local strictness | Local has safe defaults and no required vars; preview/production require Supabase keys and `DATABASE_URL` and https | App must run locally with no `.env.local`; deployed environments must fail fast |
| Test runner | `node --test` against built `dist` | Vitest (AGO-111) not merged yet |
| Build check wiring | `&&` after `next build` in the web `build` script | pnpm 10 does not run `postbuild` hooks automatically |
| Bundle check detection | Server variable names, secret-named `process.env` references, and secret values | Names catch accidental references; values catch inlined secrets |
| Client import path | `@ago/shared/client-env` subpath, not the barrel | The barrel carries server variable names; a real client build tripped the bundle check |
| Secret classification | One shared `isSecretLikeEnvName` that strips `NEXT_PUBLIC_` first; SECRET, PRIVATE, TOKEN, PASSWORD, SERVICE_ROLE and API_KEY are never public; other `*_KEY` is secret unless prefixed (so `NEXT_PUBLIC_SUPABASE_ANON_KEY` stays allowed) | Fix round 1 (QA): the prefix could launder a secret past the check |
| Secret value matching | Values of every server-only schema var, plus any secret-like name even under `NEXT_PUBLIC_`; explicit non-secret allowlist: `APP_ENV`, `SUPABASE_URL`, `LANGFUSE_HOST`, `SENTRY_DSN` | Those four legitimately appear in bundles (e.g. `production`) and would fail every real build |
| Server-name twins (fix round 2) | A `NEXT_PUBLIC_` var is forbidden when its prefix-stripped name is in `SERVER_ONLY_ENV_NAMES` minus the non-secret allowlist, in addition to the secret-keyword rule; names are compared case-insensitively; the allowlist lives in `@ago/shared` (`NON_SECRET_SERVER_ENV_NAMES`) and the bundle check reuses it | `NEXT_PUBLIC_DATABASE_URL` carries credentials but has no secret keyword |
| Credential URLs (defence in depth) | The bundle check flags any `scheme://user:password@host` string whatever the variable name | Catches secrets exposed under names no rule anticipated |
| Startup rejection | `parseServerEnv` also rejects any secret-like `NEXT_PUBLIC_*` var, naming it only | Fail fast at startup as well as at build |
| Local Supabase URL | `http://127.0.0.1:55421` | Matches the API port in AGO-78's `supabase/config.toml` (verified after merging main) |
| `.env.example` | Write it, blocked by a deny rule on `.env*`; coordinator asked, human lifting the deny | AC3 requires it; no workaround used |

## Known limitations
- The value check only sees secrets present in the build environment, so CI without secrets relies on the name checks.
- Name heuristics could flag a harmless `process.env.*_KEY` reference in client code; fix by renaming or making it `NEXT_PUBLIC_`.
- `loadWorkerEnv()` is not wired into a worker entrypoint yet.
- No lint script exists yet (skipped gate).

## Testing notes
- `pnpm test` runs the schema tests (`packages/shared/test/env.test.mjs`) and the bundle check fixtures (`scripts/check-client-bundle.test.mjs`) with `node --test`.
- `pnpm build` runs the real bundle check.
- Fail-fast: start the web app with `APP_ENV=production` and no keys; startup logs the missing variable names.

## Follow-up tasks
- Bundle check does not detect encoded secrets (string concatenation, base64, hex). Judged low risk (the secret would have to be deliberately obfuscated in client code); add detection if a real need appears.
- Port tests to Vitest after AGO-111.
- Wire `loadWorkerEnv()` into the worker entrypoint: **known gap, owned by AGO-143** (the worker skeleton). Not fixed in AGO-70; `loadWorkerEnv()` exists and is tested but nothing calls it at process start yet.
- Human: create hosted preview and production environments and set `APP_ENV` and keys.
- QA (AGO-118 not landed, so no Playwright harness yet). Node-level acceptance tests are in `scripts/ago-70-acceptance.test.mjs`. When AGO-118 lands, add these Playwright specs in the harness:
  - `AC1: app starts with the local defaults and renders the home page with no env set`
  - `AC1: production start with keys missing never serves a page` (negative: process exits, port refuses connections)
  - `AC2: a built client bundle contains no server-only variable name or secret value` (scan `.next/static` after build)
  - `AC2: a page importing a server env module from a client component fails the build` (negative)
- QA: add an AC3 content check (every schema variable appears in `.env.example`, values are placeholders) once the owner lifts the deny rule on `.env*`.
- QA finding (open): the bundle check can be bypassed with a `NEXT_PUBLIC_` prefix on a secret name or value; see the three `AC2 (bypass)` tests, which fail until the check is fixed.
