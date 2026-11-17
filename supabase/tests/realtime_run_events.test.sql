-- AGO-126: run_events is published to Supabase Realtime, and only that table of the app schema's event log is
-- exposed to the stream with row security still on (Realtime evaluates RLS per subscriber).
-- Run: pnpm exec supabase test db (inside the db lock as AGO-126).
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select ok(
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'run_events'),
  'run_events is in the supabase_realtime publication');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.run_events'::regclass),
  'run_events still has row level security on');
select ok(
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'run_events'
          and policyname = 'run_events_select_viewer' and cmd = 'SELECT'),
  'the member-scoped select policy is the one Realtime evaluates');
select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('approvals', 'members', 'workspaces')),
  0,
  'this migration publishes nothing else sensitive (approvals, members, workspaces stay off the stream)');

select * from finish();
rollback;
