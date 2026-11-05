-- AGO-102: run_events is append-only for every role, with a per-run increasing sequence.
-- Builds on AGO-74 (table). AGO-107 will add policies/grants (it must never grant UPDATE/DELETE/TRUNCATE).
-- Rollback: supabase/rollbacks/20261105090001_ago_102_run_events_append_only.down.sql
--
-- Defence in depth (RLS alone is not enough: service_role bypasses it and RLS does not cover TRUNCATE):
--   1. privileges: UPDATE/DELETE/TRUNCATE revoked from every API role (and PUBLIC);
--   2. BEFORE UPDATE/DELETE row trigger and BEFORE TRUNCATE statement trigger that raise for everyone,
--      including service_role and the table owner. ENABLE ALWAYS so they also fire under
--      session_replication_role = replica;
--   3. the only delete allowed is the cascade of deleting the whole workspace (tenant erasure).
-- Not covered: a superuser can drop/disable the triggers. Schema changes go through migrations only.

-- 1. Per-run sequence: replace the global identity with a per-run value.
alter table public.run_events alter column seq drop identity if exists;
update public.run_events e set seq = r.n
  from (select id, row_number() over (partition by run_id order by seq, created_at, id) as n
          from public.run_events) r
  where e.id = r.id;
alter table public.run_events alter column seq set default 0; -- 0 = "assign the next number" (see trigger)
drop index public.run_events_workspace_run_seq_idx;
alter table public.run_events
  add constraint run_events_seq_positive check (seq > 0),
  add constraint run_events_run_seq_key unique (workspace_id, run_id, seq);

-- Assigns or validates seq under a per-run advisory lock, so concurrent inserts for one run are
-- serialized and cannot both take the same number or go backwards. SECURITY DEFINER so the max()
-- sees every row of the run regardless of the caller's RLS/privileges. The unique constraint is the
-- backstop. Numbers are exactly max + 1 (gap-free).
create function private.run_events_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max bigint;
begin
  -- max() below must see rows committed by the lock holder we waited for: only READ COMMITTED
  -- takes a fresh snapshot per statement after the lock is granted.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'run_events inserts require READ COMMITTED isolation'
      using errcode = '25000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('run_events:' || new.run_id::text, 0));
  select coalesce(max(e.seq), 0) into v_max
    from public.run_events e
    where e.workspace_id = new.workspace_id and e.run_id = new.run_id;
  if new.seq is null or new.seq = 0 then
    new.seq := v_max + 1;
  elsif new.seq <> v_max + 1 then
    -- Strictly the next number: a duplicate or lower value is out of order, a higher one would
    -- leave a gap (and a huge value could overflow bigint and brick the run).
    raise exception 'run_events.seq must be the next number for the run: got %, expected %', new.seq, v_max + 1
      using errcode = '23514', constraint = 'run_events_seq_increasing';
  end if;
  return new;
end;
$$;
revoke all on function private.run_events_before_insert() from public;
create trigger run_events_before_insert before insert on public.run_events
  for each row execute function private.run_events_before_insert();

-- 2. Append-only guards.
-- Row delete is allowed only while the workspace itself is being deleted (FK cascade): by then the
-- workspace row is already gone. A direct delete finds the workspace and is rejected.
create function private.run_events_block_change()
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
revoke all on function private.run_events_block_change() from public;

create trigger run_events_block_update_delete before update or delete on public.run_events
  for each row execute function private.run_events_block_change();
create trigger run_events_block_truncate before truncate on public.run_events
  for each statement execute function private.run_events_block_change();
alter table public.run_events enable always trigger run_events_before_insert;
alter table public.run_events enable always trigger run_events_block_update_delete;
alter table public.run_events enable always trigger run_events_block_truncate;

-- 3. Privileges: no role that goes through the API can modify or empty the table.
revoke update, delete, truncate, trigger, references on table public.run_events from public, anon, authenticated, service_role;
revoke update (id, workspace_id, run_id, seq, type, payload, created_at) on public.run_events from public, anon, authenticated, service_role;
comment on table public.run_events is 'Append-only (AGO-102): UPDATE/DELETE/TRUNCATE are blocked by privileges and triggers for every role. seq increases per run.';
