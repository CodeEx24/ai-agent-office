---
status: open
tickets: [AGO-192]
order: 1
estimate: 5 min
---

# Give your account a password for `pnpm pack:export`

**Why.** The app signs people in with an emailed code, so accounts have no password. `pnpm pack:export` signs in as you with an email and password (owner decision on AGO-192), so the account you export with needs one. The export itself is not affected: the web API uses your normal browser session.

**What you need.** The email of the account that is a member or owner of the workspace you export from, and access to the Supabase project (local Studio or the hosted dashboard).

## Local stack

1. Start the stack (`pnpm db:start`) and open Supabase Studio (the URL is printed by `supabase status`).
2. Go to **Authentication → Users**, open your user and set a password.
3. Put the values in your own shell, or in `apps/web/.env.local` (not committed). Use the names, never commit the values:

   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   AGO_CLI_EMAIL=...
   AGO_CLI_PASSWORD=...
   ```

4. Run `pnpm pack:export --workspace <workspace id>`. A wrong password prints `Sign-in failed. Check AGO_CLI_EMAIL and AGO_CLI_PASSWORD.`

## Hosted project

Same steps in the hosted Supabase dashboard (**Authentication → Users**). Use a password you do not use anywhere else, keep it out of the repo and out of shared chat, and prefer a dedicated account that is a member (not owner) of the workspace, since a member can export.

## Check it worked

The command prints `Exported <n> agent(s) and <n> skill(s) to <file>` and a `sha256:` checksum. A row appears in `pack_events` for the export (the exporter and the agent names, never the pack content).

## Open question for the owner

The app has no screen to set a password, so the steps above rely on the Supabase dashboard. If you would rather have a "CLI password" screen or a personal access token, that is a separate ticket (see Follow-ups in `docs/tickets/AGO-192.md`).
