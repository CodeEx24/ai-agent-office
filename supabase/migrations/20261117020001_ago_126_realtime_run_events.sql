-- AGO-126: publish public.run_events to Supabase Realtime (Postgres Changes) so the office can stream new events.
-- No table, column or policy changes: Realtime evaluates the existing RLS policy run_events_select_viewer (AGO-107)
-- per subscriber, so a member only receives rows of their own workspaces. run_events stays append-only (AGO-102);
-- only INSERT is ever published in practice. Rollback: supabase/rollbacks/20261117020001_ago_126_realtime_run_events.down.sql
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'run_events'
  ) then
    alter publication supabase_realtime add table public.run_events;
  end if;
end
$$;
