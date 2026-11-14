-- Rollback for 20261114020001_ago_192_pack_events.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping pack_events loses the pack export audit trail.
drop function if exists public.record_pack_export(uuid, uuid[], integer, text);

drop table if exists public.pack_events;
drop function if exists private.pack_events_block_change();
