-- Rollback for 20261105090001_ago_102_run_events_append_only.sql (local DB only).
-- Restores the AGO-74 shape: global identity seq, plain index, service_role may modify rows.
drop trigger if exists run_events_block_truncate on public.run_events;
drop trigger if exists run_events_block_update_delete on public.run_events;
drop trigger if exists run_events_before_insert on public.run_events;
drop function if exists private.run_events_block_change();
drop function if exists private.run_events_before_insert();
alter table public.run_events
  drop constraint if exists run_events_run_seq_key,
  drop constraint if exists run_events_seq_positive;
alter table public.run_events alter column seq drop default;
alter table public.run_events alter column seq add generated always as identity;
do $$
begin
  execute format('alter table public.run_events alter column seq restart with %s',
    (select coalesce(max(seq), 0) + 1 from public.run_events));
end $$;
create index run_events_workspace_run_seq_idx on public.run_events (workspace_id, run_id, seq);
grant update, delete, truncate, trigger, references on table public.run_events to service_role;
comment on table public.run_events is null;
