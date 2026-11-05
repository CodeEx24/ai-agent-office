-- AGO-102 fix round 1: nothing deletes run_events, not even the workspace cascade.
-- Supersedes the "workspace gone" exception of 20261105090001 (that file stays as merged/reviewed).
-- Erasing a tenant's events is a deliberate, human-only path deferred to AGO-147.
-- Rollback: supabase/rollbacks/20261105100001_ago_102_run_events_restrict_delete.down.sql
--
--   1. run_events.workspace_id -> workspaces: ON DELETE CASCADE becomes RESTRICT;
--   2. run_events (workspace_id, run_id) -> runs: NO ACTION becomes RESTRICT (immediate, explicit);
--   3. private.run_events_block_change() rejects every row delete, update and truncate.
-- Deleting a workspace or run that has no events still works (tasks, runs, etc. still cascade).

alter table public.run_events
  drop constraint run_events_workspace_id_fkey,
  drop constraint run_events_workspace_id_run_id_fkey,
  add constraint run_events_workspace_id_fkey
    foreign key (workspace_id) references public.workspaces (id) on delete restrict,
  add constraint run_events_workspace_id_run_id_fkey
    foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete restrict;

create or replace function private.run_events_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'run_events is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Insert a new event instead.';
end;
$$;

comment on table public.run_events is 'Append-only (AGO-102): UPDATE/DELETE/TRUNCATE are blocked by privileges and triggers for every role, and parent deletes are RESTRICTed while events exist. seq increases per run. Erasure is a human-only path (AGO-147).';
