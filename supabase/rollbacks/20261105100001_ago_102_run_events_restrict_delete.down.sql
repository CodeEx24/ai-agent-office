-- Rollback for 20261105100001_ago_102_run_events_restrict_delete.sql (local DB only).
-- Restores the state after 20261105090001: workspace cascade allowed, workspace-gone delete exception.
alter table public.run_events
  drop constraint run_events_workspace_id_fkey,
  drop constraint run_events_workspace_id_run_id_fkey,
  add constraint run_events_workspace_id_fkey
    foreign key (workspace_id) references public.workspaces (id) on delete cascade,
  add constraint run_events_workspace_id_run_id_fkey
    foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete no action;

create or replace function private.run_events_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and tg_level = 'ROW'
     and not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  raise exception 'run_events is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Insert a new event instead.';
end;
$$;

comment on table public.run_events is 'Append-only (AGO-102): UPDATE/DELETE/TRUNCATE are blocked by privileges and triggers for every role. seq increases per run.';
