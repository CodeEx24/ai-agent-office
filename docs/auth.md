# Authentication

Agent Office signs users in with Supabase Auth: **email** (a one-time code or magic link), **Google** and **GitHub**. After sign-in the user lands on the protected `/app` page. Workspaces and memberships arrive with AGO-82; `/app` shows who is signed in and is where that will plug in.

## How it works

| Piece | File | Role |
|---|---|---|
| Proxy | `apps/web/src/proxy.ts` | Next 16's `proxy.ts` (formerly middleware). Refreshes the session cookie on every request and redirects signed-out visitors from `/app/**` to `/sign-in?next=<path>`. |
| Session refresh | `apps/web/src/lib/supabase/session.ts` | `getClaims()` in the proxy. Any failure (no cookie, bad token, Supabase down) counts as signed out. |
| Server client | `apps/web/src/lib/supabase/server.ts` | Cookie-backed client for server components, actions and route handlers. One per request. |
| Server gate | `apps/web/src/app/app/layout.tsx` | Re-checks the user with `getUser()` (asks the Auth server). The proxy is never the only gate. |
| Sign-in page | `apps/web/src/app/sign-in/page.tsx` | Email form plus Google and GitHub buttons. |
| Actions | `apps/web/src/features/auth/actions.ts` | Send code, verify code, start OAuth, sign out. Zod-validated. |
| Callback | `apps/web/src/app/auth/callback/route.ts` | Exchanges the one-time `code` for a session, then redirects to a validated `next`. |
| Redirect safety | `apps/web/src/features/auth/safe-next-path.ts` | `next` must be a same-origin path; anything else becomes `/app`. |
| Origin | `apps/web/src/lib/request-origin.ts` | Redirects go back to the host the user is on (cookies are host-scoped; Next rewrites `127.0.0.1` to `localhost` in `nextUrl`). |

Rules to keep:

- On the server use `getUser()` or `getClaims()`. Never trust `getSession()` or a bare cookie.
- Sign-out is a POST form (server action), never a link: link prefetching would sign users out.
- Only the Supabase URL and anon key are public. No service-role key or provider secret ever reaches the client.

## Environment

Read through `apps/web/src/lib/env.ts` (to be replaced by the validated env config from AGO-70).

| Variable | Where | Value locally |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `apps/web/.env.local` | `http://127.0.0.1:55421` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `apps/web/.env.local` | the `ANON_KEY` from `pnpm exec supabase status -o env` (a local demo key) |
| `NEXT_PUBLIC_APP_URL` | `apps/web/.env.local` | the origin you run on, e.g. `http://127.0.0.1:3000`. Used for the email link and OAuth `redirectTo` sent to Supabase, so it must match your `PORT`. |

`.env.local` files are written by the owner, never by agents or commits. Run the app on a free port: `PORT=$(node scripts/free-port.mjs) pnpm dev`.

## Local email sign-in

1. Start the stack: `pnpm db:start`.
2. Open `/sign-in`, enter any address, press **Email me a sign-in code**.
3. Open the local mail catcher at <http://127.0.0.1:55424> (Mailpit). The email has a 6-digit code and a magic link.
4. Enter the code (or open the link in the same browser). You land on `/app`.

The email templates are `supabase/templates/magic_link.html` and `confirmation.html` (new users get the second). Restart the stack after editing them or `supabase/config.toml`: `pnpm db:stop && pnpm db:start`.

## Google and GitHub: owner setup (human only)

Agents cannot create these apps or hold their secrets. Until the owner does this, the two buttons build the correct provider redirect but the provider answers with an error. Real Google/GitHub sign-in is **verified once the owner adds credentials**. Both OAuth apps are free.

The callback URL for both is Supabase's own endpoint:

```
http://127.0.0.1:55421/auth/v1/callback
```

### GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Application name: `Agent Office (local)`. Homepage URL: `http://127.0.0.1:3000`.
3. Authorization callback URL: `http://127.0.0.1:55421/auth/v1/callback`.
4. Register, then **Generate a new client secret**. Copy the Client ID and the secret.

### Google

1. Google Cloud Console → create or pick a project → APIs & Services → **OAuth consent screen** (External, add yourself as a test user).
2. Credentials → **Create credentials → OAuth client ID** → type **Web application**.
3. Authorized redirect URI: `http://127.0.0.1:55421/auth/v1/callback`.
4. Create, then copy the Client ID and Client secret.

### Wire them in

Create `supabase/.env.local` (git-ignored; only you write it):

```
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=...
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=...
SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=...
SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=...
```

Then in `supabase/config.toml` set `enabled = true` under `[auth.external.google]` and `[auth.external.github]` (they ship `false` because the CLI refuses to start an enabled provider with empty credentials), and restart: `pnpm db:stop && pnpm db:start`. Check by pressing a provider button on `/sign-in`.

The `127.0.0.1:*` and `localhost:*` entries in `additional_redirect_urls` are for local development only. Never push them to a hosted project; list its exact production URLs instead.

For a hosted project the same two redirect URLs become `https://<project-ref>.supabase.co/auth/v1/callback`, and the provider IDs go in the Supabase dashboard. That is a human step, outside this ticket.

## Tests

- Unit (Vitest): `safe-next-path`, `routes`, `request-origin`, UI `Input`/`Label`.
- E2E stack-free (run in CI): signed-out redirects, garbage cookie, provider button redirect URLs, open-redirect negatives.
- E2E live (local stack): email code and magic-link sign-in, wrong code, reload persistence, sign-out and revoked cookies, shared signed-in fixture. Run:

```sh
ANON=$(pnpm exec supabase status -o env | grep '^ANON_KEY=' | cut -d= -f2 | tr -d '"')
node scripts/db-lock.mjs acquire AGO-<n>
PORT=$(node scripts/free-port.mjs) E2E_SUPABASE=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55421 NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON" pnpm test:e2e
node scripts/db-lock.mjs release AGO-<n>
```

See `docs/testing.md` for the signed-in fixture (`AUTH_STATE_PATH`).
