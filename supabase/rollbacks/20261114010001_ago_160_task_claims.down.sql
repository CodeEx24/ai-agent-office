-- Rollback for 20261114010001_ago_160_task_claims.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping claim_events loses the claim audit trail; dropping claim_token means live claims lose their fence.
drop function if exists public.sweep_expired_claims(uuid);
drop function if exists public.release_claim(uuid, uuid, uuid, text);
drop function if exists public.renew_claim(uuid, uuid, uuid, integer);
drop function if exists public.claim_task(uuid, uuid, uuid, uuid, integer);
drop function if exists private.log_claim_event(uuid, uuid, uuid, uuid, text, jsonb);

drop table if exists public.claim_events;
drop function if exists private.claim_events_block_change();

alter table public.claims
  drop constraint if exists claims_release_reason_matches_release,
  drop constraint if exists claims_release_reason_values,
  drop constraint if exists claims_expires_after_claimed,
  alter column expires_at drop not null,
  alter column expires_at drop default,
  drop column if exists release_reason,
  drop column if exists renewed_at,
  drop column if exists claim_token;

-- Back to the AGO-107 grant: table-level select for members.
revoke select on public.claims from authenticated;
grant select on public.claims to authenticated;
