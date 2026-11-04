-- Rollback for 20261105020001_ago_74_tenancy_foundation.sql (local DB only; roll back newer AGO-74 files first).
drop table if exists public.members;
drop table if exists public.workspaces;
drop function if exists private.set_updated_at();
