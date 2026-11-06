-- Rollback for 20261106140001_ago_125_capability_catalog.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Removing the table deletes the catalog rows (the migration recreates them): local data only.
drop trigger if exists seed_capabilities on public.workspaces;
drop function if exists private.seed_capabilities_for_new_workspace();
drop function if exists private.seed_workspace_capabilities(uuid);
drop policy if exists capabilities_update_owner on public.capabilities;
drop policy if exists capabilities_select_viewer on public.capabilities;
drop table if exists public.capabilities;
