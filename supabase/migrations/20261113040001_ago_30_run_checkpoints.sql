-- AGO-30: durable checkpoint for agent runs (resume after a crash or a pause without repeating tool calls).
--
-- Rollback: supabase/rollbacks/20261113040001_ago_30_run_checkpoints.down.sql
--
-- Decisions:
-- * The table lives in the `private` schema, not `public`. It holds tool inputs and results (scrubbed), which a
--   workspace member must not read through the Data API, and `private` is not exposed there: anon, authenticated
--   and service_role get no access. Only the worker's database role (the table owner) reads and writes it.
--   RLS is still switched on, with no policy, as a second wall: a role that is not the owner sees nothing.
-- * One row per run, keyed by (workspace_id, run_id) with a composite foreign key to public.runs, so a checkpoint
--   can never point at another workspace's run. Deleting the run deletes its checkpoint.
-- * `state` is the loop's state (validated in the worker with the Zod schema in packages/shared; the database only
--   checks it is an object under 1 MB). Null means "no state yet": a pause can be requested before the first write.
-- * `pause_requested_at` is the human's pause request. The loop reads it at safe points; it never aborts a model call.

create table private.run_checkpoints (
  workspace_id uuid not null,
  run_id uuid not null,
  state jsonb,
  pause_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, run_id),
  foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete cascade,
  constraint run_checkpoints_state_check
    check (state is null or (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 1000000))
);
comment on table private.run_checkpoints is 'Durable state of an agent run between tool calls, plus the pause request (AGO-30). Worker-only: no access for anon, authenticated or service_role. Holds scrubbed tool inputs and results.';

create trigger set_updated_at before update on private.run_checkpoints
  for each row execute function private.set_updated_at();

alter table private.run_checkpoints enable row level security;
revoke all on private.run_checkpoints from public, anon, authenticated, service_role;
