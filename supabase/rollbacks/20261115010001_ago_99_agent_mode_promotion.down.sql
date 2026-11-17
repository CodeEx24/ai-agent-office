-- Rollback for the AGO-99 migration (local DB only). Run it inside one transaction, then re-apply the migration.
-- Dropping agent_mode_changes loses the mode change log. Agents keep their current mode.
drop function if exists public.set_agent_mode(uuid, uuid, text);

drop trigger if exists agents_log_mode_change on public.agents;
drop function if exists private.agents_log_mode_change();
drop trigger if exists agents_guard_mode_insert on public.agents;
drop function if exists private.agents_guard_mode();

drop table if exists public.agent_mode_changes;
drop function if exists private.agent_mode_changes_block_change();

alter table public.agents drop constraint if exists agents_mode_check;
