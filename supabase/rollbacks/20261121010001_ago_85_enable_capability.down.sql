-- Rollback for the AGO-85 migration (local DB only). Run it inside one transaction, then re-apply the migration.
-- Dropping the table loses the worker's recorded check results (the worker rewrites them within 30 seconds).
-- Capabilities keep their current enabled value. Owners get their direct update grant back (AGO-125 state).
drop function if exists public.disable_capability(uuid, uuid);
drop function if exists public.enable_capability(uuid, uuid);
drop function if exists private.capability_prerequisite_checks(text);
drop table if exists public.capability_prerequisite_status;

revoke update (description) on public.capabilities from authenticated;
grant update (enabled, description) on public.capabilities to authenticated;
grant update on public.capabilities to service_role;
