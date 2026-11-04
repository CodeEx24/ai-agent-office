# AGO-67 - Implement sign-in with email, Google and GitHub

## Overview
User story US-007 (Epic EP-01 Data and auth, Wave 1). As a user I can sign in with email, Google or GitHub and reach my workspace securely. Jira: https://stratyge.atlassian.net/browse/AGO-67. Blocked by AGO-78 (Supabase local dev) and AGO-61 (Next.js 16), both done. Risk tier: high (authentication).

Acceptance criteria (verbatim):
- Given valid credentials, when I sign in with any provider, then I land in my workspace
- Signed-out users are redirected from protected routes
- Sessions refresh and sign-out clears them
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Implementation details
Supabase Auth with `@supabase/ssr` in the App Router. How it fits together is in `docs/auth.md`.

- `apps/web/src/proxy.ts` (Next 16 replacement for middleware) refreshes the session with `getClaims()` and redirects signed-out visitors from `/app/**`.
- `apps/web/src/app/app/layout.tsx` re-checks with `getUser()`, so the proxy is not the only gate.
- `/sign-in` offers the email code form plus Google and GitHub buttons (server actions, Zod-validated). `/auth/callback` exchanges the PKCE `code` and redirects to a validated `next`.
- Sign-out is a POST server action.
- `packages/ui` gained shadcn `Input` and `Label` (none existed).
- Origin for redirects comes from the request's Host header (`lib/request-origin.ts`): Next rewrites `127.0.0.1` to `localhost` in `nextUrl`, which drops host-scoped cookies. Found by the E2E run.

### Decisions taken (no human at the keyboard; recommended option chosen each time)
| Decision | Chosen | Why |
|---|---|---|
| Email method | 6-digit OTP code, with the magic link in the same email | The code works on any dev port and in any browser; the link still works for users. |
| Landing page | Protected `/app` showing who is signed in | Workspaces and memberships are AGO-82; `/app` is where it will resolve the workspace. |
| Schema | **No migration, no new table** | Auth needs none. A `profiles` table would also fail the catalog test requiring `workspace_id` on every public table and would pre-empt AGO-82. |
| Google/GitHub in `config.toml` | Wired with `env(...)` references but `enabled = false` | The CLI refuses to start an enabled provider with empty credentials, and agents must not hold OAuth secrets. The owner flips it (docs/auth.md). |
| OAuth button tests | Stub the Auth server's `authorize` endpoint and assert provider and `redirect_to` | Real provider sign-in needs owner credentials. Marked "verified once the owner adds credentials". |
| CI | Stack-free specs run in CI; live specs are gated by `E2E_SUPABASE=1` | CI has no Supabase stack and `.github/workflows/` changes need a human merge. Live specs ran locally (see below). |
| Forms | `useActionState` + Zod in server actions, not React Hook Form | Two single-field forms; RHF adds nothing here. RHF stays available for larger forms. |
| Env | Small typed helper `lib/env.ts` | AGO-70's env schema (PR #10) is not merged. One file to switch over later. |
| Shared signed-in state | Playwright `setup` project signs in through the real email flow and saves `e2e/.auth/user.json` | No service-role key needed. |
| Config reload | Restarted the shared local stack once (`supabase stop` / `start`) inside the DB lock to load the auth config | Auth config changes only apply on restart. Data was preserved. |

## API changes
No JSON API. Routes added: `GET /sign-in`, `GET /auth/callback`, `GET /app` (protected), plus server actions `sendCodeAction`, `verifyCodeAction`, `signInWithOAuthAction`, `signOutAction`. No agent-token route is affected; none of these accept agent tokens.

## Database changes
None. No migration. `supabase/config.toml` changed: redirect allow-list (`http://127.0.0.1:*/**`, `http://localhost:*/**`), email templates (`supabase/templates/`), and the `[auth.external.google|github]` blocks. Rollback: revert those files and restart the stack (`pnpm db:stop && pnpm db:start`).

## Dependencies on other tickets
- AGO-78 (local Supabase) and AGO-61 (Next 16): done.
- AGO-82 (workspaces and memberships) lands next; it resolves the workspace on `/app`.
- AGO-70 (validated env config, PR #10): replace `apps/web/src/lib/env.ts` when it merges.

## Known limitations
- Real Google and GitHub sign-in is **verified once the owner adds credentials** (docs/auth.md). The buttons' redirect URLs are proven by tests.
- Live E2E specs do not run in CI (no Supabase stack there). Adding `supabase start` to the workflow is a follow-up for a human-merged PR.
- `/app` does not resolve a workspace yet (AGO-82).
- No rate limiting beyond Supabase's own limits; no CAPTCHA.

## Testing notes
- `pnpm lint && pnpm typecheck && pnpm test` for unit tests: `safe-next-path` (open-redirect cases: `//evil.com`, `/\evil.com`, `https://evil.com`, `%2F%2Fevil.com`, `javascript:`), `routes`, `request-origin`, UI `Input`/`Label`.
- E2E: see `docs/auth.md` > Tests for the live command. Specs: `e2e/auth.spec.ts` (stack-free) and `e2e/auth-live.spec.ts` (local stack). Security negatives: open redirect via `next=` on the callback, garbage session cookie, revoked cookies after sign-out.

## Follow-up tasks
- Run the live specs in CI once a Supabase stack job exists (human-merged workflow change).
- Swap `lib/env.ts` for the AGO-70 schema.
- AGO-82: resolve the workspace after sign-in.
- Owner: create the Google and GitHub OAuth apps and verify real sign-in.
