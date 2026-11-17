-- Rollback for AGO-126: stop publishing run_events to Realtime. The table, its rows and its RLS are untouched.
-- The supabase_realtime publication itself stays (Supabase owns it).
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'run_events'
  ) then
    alter publication supabase_realtime drop table public.run_events;
  end if;
end
$$;
