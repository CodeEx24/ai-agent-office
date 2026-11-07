-- Rollback for 20261107120001_ago_141_agent_wizard.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping the columns loses role, model, prompt, budget and grant modes of wizard-created agents: local data only.
drop function if exists public.create_agent(uuid, text, text, text, text, integer, uuid[], jsonb);

revoke insert on public.agent_capabilities from authenticated;
grant insert (workspace_id, agent_id, capability, tier, granted_by) on public.agent_capabilities to authenticated;
alter table public.agent_capabilities drop constraint if exists agent_capabilities_high_tier_never_automatic;
alter table public.agent_capabilities drop column if exists mode;

drop policy if exists agents_insert_owner on public.agents;
create policy agents_insert_member on public.agents for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));
revoke insert on public.agents from authenticated;
grant insert (workspace_id, name, description) on public.agents to authenticated;

alter table public.agents
  drop column if exists daily_budget_cents,
  drop column if exists prompt,
  drop column if exists model,
  drop column if exists role;
