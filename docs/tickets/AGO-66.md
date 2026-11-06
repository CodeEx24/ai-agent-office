# AGO-66 - Add CSP, input validation and rate limits

## Overview
User story US-080 (Epic EP-17 Web security, Wave 2 in the AI delivery plan). Jira: https://stratyge.atlassian.net/browse/AGO-66. Blocked by AGO-61 (Next.js 16), done. Risk tier: high (web security surface, auth endpoints).

Acceptance criteria (verbatim):
- Every route validates input with Zod
- Rate limits return 429 with retry hints
- CSP blocks inline scripts
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Implementation details

### CSP (AC3)
- `apps/web/src/proxy.ts` (the AGO-67 session proxy, extended not replaced) makes a fresh nonce per request, builds the policy with `lib/security/csp.ts`, forwards it as `Content-Security-Policy` + `x-nonce` on the **request** headers (so Next puts the nonce on its own scripts), runs `updateSession`, then sets the same CSP on every exit path: pass-through, sign-in redirect and 429.
- Enforcing header, not report-only. `script-src 'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'`: no `unsafe-inline`, no `unsafe-eval` in production. `unsafe-eval` is added only when `NODE_ENV === "development"` (React Refresh).
- `'wasm-unsafe-eval'` is needed because the Pixel/Mannequin GLBs are meshopt-compressed and three.js decodes them in WebAssembly (found by the existing `/dev/3d` e2e specs). It does not allow `eval()`.
- `connect-src 'self' blob: data:` plus the Supabase origin and its `ws(s)` form, taken from the validated `NEXT_PUBLIC_SUPABASE_URL` (`lib/env.ts#getSupabaseUrl`), never hard-coded. `img-src 'self' blob: data:` and `worker-src 'self' blob:` for three.js. `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`.
- The root layout reads `x-nonce` from `headers()` and passes it to `ThemeProvider` (next-themes' pre-paint inline script). Reading request headers makes every route dynamic, which per-request nonces require: prerendered HTML cannot carry one. Before this ticket `/` and `/dev/ui` were static.
- Baseline headers for every route including static assets, via `next.config.ts` `headers()` (`lib/security/headers.ts`): `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation, payment, usb denied), `X-Frame-Options: DENY`. HSTS is left to the host.

### Zod on every route (AC1)
- `lib/validation/parse-input.ts`: `parseInput(schema, input)` is the one place untrusted input is parsed (plus `formDataToRecord`, `searchParamsToRecord`, `invalidInputResponse`).
- Applied to: `GET /auth/callback` (`authCallbackQuerySchema`), `GET /sign-in` (`signInQuerySchema`), and every server action (`sendCodeAction`, `verifyCodeAction`, `signInWithOAuthAction`, `createWorkspaceAction`). `signOutAction` takes no input and is annotated `@no-input`.
- `src/test/input-validation.test.ts` statically scans `app/**/route.ts`, every `"use server"` file and every page that reads `searchParams`/`params`, and fails when an exported handler neither calls `parseInput(` nor documents `@no-input`. It also proves the scan detects a violation. New routes and actions are covered automatically.

### Rate limits (AC2)
- `lib/rate-limit/`: a `RateLimiter` interface (async, so a shared store can replace the memory one) and `MemoryRateLimiter`, a sliding-window log with a hard cap on tracked keys (LRU eviction, never evicts the bucket in use). Held on `globalThis` because Next bundles the proxy and server code separately.
- Two layers. The proxy applies coarse budgets and returns a real **HTTP 429** with `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Policy` and `Cache-Control: no-store`:
  - `POST /sign-in`: 60/min per IP
  - `GET /auth/callback`: 30/min per IP
  - `POST /app/**`: 60/min per user (`sub` claim from `updateSession`), IP fallback
- Server actions cannot set a status, so finer per-identity budgets live in the actions and return a friendly message with the wait time: send-code 5 per 10 min per email, verify-code 8 per 10 min per email (caps guessing of the 6-digit code), onboarding 10 per 10 min per user.
- Budgets are in `lib/rate-limit/rules.ts`; `matchRouteRateLimit` maps method + path to a rule, so future agent/approval routes add one line.
- A limiter fault fails open (Supabase's own limits and the other layer still apply).

## API changes
No new endpoints. Behaviour added to existing ones: `POST /sign-in` (server actions), `GET /auth/callback` and `POST /app/**` can answer `429` with the headers above. `GET /auth/callback` and `GET /sign-in` now answer an invalid query (oversized or malformed values) as if the parameter were missing. Every response carries the CSP and baseline headers.

## Database changes
None. No migration, no table (the schema slot belongs to AGO-107). The limiter is in memory.

## Dependencies on other tickets
- AGO-61 (Next.js 16): done. AGO-67 (auth proxy and actions) and AGO-82 (workspace actions) are the code this extends.
- AGO-48 (public API and API keys) is blocked by this ticket: its routes should use `parseInput` and add a rule to `rules.ts`.

## Known limitations
- **Rate limiting is single instance only**: counters live in process memory, so N instances allow N times the budget and a restart clears them. A Postgres-backed `RateLimiter` is the follow-up (needs a table, so a schema ticket).
- **Client IP is only trustworthy behind a proxy that overwrites `x-forwarded-for`** (Vercel does). Without one a caller can rotate the header and dodge the per-IP bucket; the per-email and per-user budgets still hold. With no usable header every caller shares one "unknown" bucket.
- A server action that hits the proxy's 429 (an abusive client, 60+ submissions a minute from one IP) surfaces as a generic client error, not the friendly message. Normal users hit the per-email message first.
- `style-src` keeps `'unsafe-inline'`: React `style=""` attributes and sonner's runtime `<style>` cannot carry a nonce. AC3 is scoped to scripts. Tightening styles needs sonner/style attribute changes.
- No `form-action` directive: the no-JS OAuth form POST is redirected through Supabase to Google/GitHub, and Chrome applies `form-action` to every redirect hop.
- Dev mode (`next dev`) allows `unsafe-eval`; CSP behaviour is verified on the production build only.
- Every route is now server-rendered per request (no static `/`), a small cost accepted for strict nonces.

## Testing notes
- Unit (Vitest): `memory-rate-limiter.test.ts`, `rate-limit.test.ts` (IP parsing, route rules, headers, 429 response, action limits, fail-open), `csp.test.ts` (directives, nonce uniqueness, Supabase origin, dev-only eval, baseline headers), `parse-input.test.ts` (helper and route schemas), `input-validation.test.ts` (enumeration check).
- E2E (Playwright, production build, `pnpm test:e2e`): `csp.spec.ts` (enforcing nonce CSP on `/`, `/sign-in`, `/dev/ui`, `/dev/3d`; new nonce per request and on every inline script; baseline headers on pages and static assets; pages hydrate with no CSP console errors via the auto guard; a parser-inserted inline `<script>` and an `onerror=` attribute do not execute and a CSP violation is logged), `rate-limit.spec.ts` (61st sign-in POST gets 429 + `Retry-After` + `RateLimit-*`; per-IP isolation; page views unlimited). Each rate-limit test uses its own `x-forwarded-for` so parallel specs do not interfere.
- Live stack (`E2E_SUPABASE=1`, hold `node scripts/db-lock.mjs acquire AGO-66`): `csp-live.spec.ts` signs in, loads `/app`, completes the onboarding server action and checks the CSP including the Supabase origin.
- Full live run result: 154 e2e tests green except `auth-session.spec.ts` "errors do not reveal whether an email already has an account". It requests a code for the same address twice in a row, and the local Supabase Auth server itself answers the second with `429 over_email_send_rate_limit` (reproduced with a direct `POST /auth/v1/otp` twice, bypassing the app). The page shows Supabase's "We could not send the email", not this ticket's "Too many attempts" message, so it is the stack's own per-address throttle, not AGO-66's limiter (budget 5 sends per 10 min). It was not re-run against `main`; flagged for the reviewer.
- `playwright.config.ts` now sets `ENABLE_UI_GALLERY=1` so `/dev/ui` can be covered on the production build.

## Decisions taken (no human at the keyboard; recommended option chosen each time)
| Decision | Chosen | Why |
|---|---|---|
| CSP delivery | Nonce + `strict-dynamic` in `proxy.ts`, composed with `updateSession` | Brief: strict, enforcing, no `unsafe-inline` for scripts; AGO-67's proxy kept. |
| Static pages | Make all routes dynamic by reading `x-nonce` in the root layout | Prerendered HTML cannot carry a per-request nonce. |
| Styles | `style-src 'self' 'unsafe-inline'` | Style attributes and sonner's `<style>` cannot be nonced; AC3 is about scripts. |
| WASM | `'wasm-unsafe-eval'` in production | Meshopt GLBs need wasm; far narrower than `unsafe-eval`. |
| `form-action` | Not set | Would break the no-JS OAuth redirect chain in Chrome. |
| Rate limit store | In-memory sliding window behind `RateLimiter` | Money rule: no paid Redis/Upstash. Schema slot busy: no table. Postgres store is a follow-up. |
| Where 429 is produced | Proxy for HTTP 429; per-identity limits in actions with a message | Server actions cannot set a status; the proxy is the only place that can. |
| Client IP | First `x-forwarded-for` hop, then `x-real-ip`, else shared bucket | No `request.ip` in Next 16; documented trust requirement. |
| Zod helper | One `parseInput` in `lib/validation` + static enumeration test | Reuse-first: existing schemas are kept, the helper unifies the parse step. |
| New env vars | None | Limits are code constants in `rules.ts`; avoids touching the shared env schema and docs. |

## Follow-up tasks
- Postgres-backed `RateLimiter` for multi-instance deployments (needs a migration, so a schema ticket).
- Friendly UI for a proxy-level 429 on form submissions (catch the failed action on the client).
- Remove `style-src 'unsafe-inline'` (nonce sonner's style, drop inline `style=""` attributes).
- CSP violation reporting endpoint (`report-to`) once there is somewhere to send it.
- AGO-48 (public API): use `parseInput` and add a `rules.ts` entry for its routes.
