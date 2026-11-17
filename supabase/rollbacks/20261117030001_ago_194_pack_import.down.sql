-- Rollback for 20261117030001_ago_194_pack_import.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- pack_events is append-only, so import events cannot be removed: the rollback refuses while any exist.
do $$
begin
  if exists (select 1 from public.pack_events where kind = 'import') then
    raise exception 'rollback refused: import events exist and pack_events is append-only';
  end if;
end;
$$;

drop function if exists public.import_agent_pack(uuid, text, jsonb);

-- Restores exactly what the up migration changed, by name: the detail column and its check, and the two checks it
-- widened (kind, agent_ids), back to the AGO-192 definitions. The AGO-192 check pack_events_check
-- (cardinality(agent_names) = cardinality(agent_ids)) is neither dropped here nor re-added: up never removes it
-- (it only restores it where an earlier draft of this migration had dropped it), so the rollback leaves it in place.
alter table public.pack_events drop constraint if exists pack_events_agent_ids_check;
alter table public.pack_events drop constraint if exists pack_events_kind_check;
alter table public.pack_events drop constraint if exists pack_events_detail_object;
alter table public.pack_events drop column if exists detail;

alter table public.pack_events add constraint pack_events_kind_check check (kind in ('export'));
alter table public.pack_events add constraint pack_events_agent_ids_check
  check (cardinality(agent_ids) between 1 and 100);
