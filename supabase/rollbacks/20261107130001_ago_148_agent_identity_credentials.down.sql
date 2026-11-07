-- Rollback for 20261107130001_ago_148_agent_identity_credentials.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping the tables deletes the identities and the credential issuance log: local data only.
drop trigger if exists revoke_credentials_on_run_end on public.runs;
drop trigger if exists create_agent_identity on public.agents;
drop policy if exists agent_credentials_select_viewer on public.agent_credentials;
drop policy if exists agent_identities_select_viewer on public.agent_identities;
drop trigger if exists agent_credentials_block_truncate on public.agent_credentials;
drop trigger if exists agent_credentials_block_delete on public.agent_credentials;
drop trigger if exists agent_credentials_block_update on public.agent_credentials;
drop trigger if exists check_agent_credential_issue on public.agent_credentials;
drop table if exists public.agent_credentials;
drop table if exists public.agent_identities;
drop function if exists private.revoke_credentials_on_run_end();
drop function if exists private.agent_credentials_block_change();
drop function if exists private.check_agent_credential_issue();
drop function if exists private.create_agent_identity();
