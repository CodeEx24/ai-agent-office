-- AGO-107 AC3: a table without RLS or without a policy fails the test run.
-- Catalog-driven: it enumerates every table in the API-exposed schemas (supabase/config.toml
-- [api] schemas = public, graphql_public), so a table added by a later ticket is checked without
-- editing this file. The second half creates deliberately bad probe tables to prove each rule bites.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

create schema ago107_t;

-- Every rule is a row in this set: (table or function, problem). An empty set means the schema is clean.
create function ago107_t.violations() returns table (tbl text, problem text)
language sql stable as $f$
  with t as (
    select c.oid, n.nspname || '.' || c.relname as name, c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'graphql_public') and c.relkind in ('r', 'p')
  ), auth as (
    select oid from pg_roles where rolname = 'authenticated'
  )
  select t.name, 'rls disabled' from t where not t.relrowsecurity
  union all
  select t.name, 'no policies' from t
    where not exists (select 1 from pg_policy p where p.polrelid = t.oid)
  union all
  select t.name, 'anon holds a table privilege' from t
    where has_table_privilege('anon', t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege('anon', t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
  union all
  select t.name, 'authenticated holds TRUNCATE, REFERENCES or TRIGGER' from t
    where has_table_privilege('authenticated', t.oid, 'TRUNCATE,REFERENCES,TRIGGER')
  union all
  select t.name, 'privilege without policy: ' || x.cmd
    from t, (values ('select', 'r'), ('insert', 'a'), ('update', 'w'), ('delete', 'd')) as x(cmd, ch)
    where case x.cmd
            when 'delete' then has_table_privilege('authenticated', t.oid, 'DELETE')
            else has_any_column_privilege('authenticated', t.oid, upper(x.cmd))
          end
      and not exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polcmd in (x.ch::"char", '*'))
  union all
  select t.name, 'policy ' || p.polname || ' is not restricted to authenticated'
    from t join pg_policy p on p.polrelid = t.oid
    where p.polroles <> array[(select oid from auth)]
  union all
  select t.name, 'policy ' || p.polname || ' is an ALL policy (write one policy per command)'
    from t join pg_policy p on p.polrelid = t.oid
    where p.polcmd = '*'
  union all
  select t.name, 'policy ' || p.polname || ' does not use private.is_member'
    from t join pg_policy p on p.polrelid = t.oid
    where coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
          !~ 'is_member\('
  union all
  select t.name, 'update policy ' || p.polname || ' has no WITH CHECK'
    from t join pg_policy p on p.polrelid = t.oid
    where p.polcmd = 'w' and p.polwithcheck is null
  union all
  select t.name, 'no index led by workspace_id'
    from t
    where t.relname <> 'workspaces'
      and not exists (
        select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
        where i.indrelid = t.oid and a.attname = 'workspace_id')
  union all
  select n.nspname || '.' || p.proname, 'SECURITY DEFINER without a pinned search_path'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and coalesce(p.proconfig::text, '') !~ 'search_path='
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  union all
  select n.nspname || '.' || p.proname, 'executable by anon'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
$f$;

-- 1-3. the real schema
select cmp_ok((select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')),
  '>=', 13, 'the catalog check sees at least the 13 core tables');
select is_empty($$select * from ago107_t.violations()$$,
  'AC3: every table has RLS, a policy for each privilege authenticated holds, and nothing is open to anon');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace),
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace and p.polname ~ ('^' || c.relname || '_(select|insert|update|delete)_(viewer|member|owner)$')),
  'every policy is named <table>_<command>_<minimum role>');

-- 4-12. probes: each bad shape must be reported (the catalog test fails closed)
create table public.ago107_p_norls (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
create index on public.ago107_p_norls (workspace_id);

create table public.ago107_p_nopol (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
create index on public.ago107_p_nopol (workspace_id);
alter table public.ago107_p_nopol enable row level security;

create table public.ago107_p_grant (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
create index on public.ago107_p_grant (workspace_id);
alter table public.ago107_p_grant enable row level security;
revoke all on public.ago107_p_grant from anon, authenticated;
grant select, insert on public.ago107_p_grant to authenticated;
create policy ago107_p_grant_select on public.ago107_p_grant for select to authenticated using (private.is_member(workspace_id));

create table public.ago107_p_open (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
create index on public.ago107_p_open (workspace_id);
alter table public.ago107_p_open enable row level security;
revoke all on public.ago107_p_open from anon, authenticated;
create policy ago107_p_open_select on public.ago107_p_open for select to authenticated using (true);

create table public.ago107_p_public (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
create index on public.ago107_p_public (workspace_id);
alter table public.ago107_p_public enable row level security;
revoke all on public.ago107_p_public from anon, authenticated;
create policy ago107_p_public_select on public.ago107_p_public for select using (private.is_member(workspace_id));

create table public.ago107_p_all (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
create index on public.ago107_p_all (workspace_id);
alter table public.ago107_p_all enable row level security;
revoke all on public.ago107_p_all from anon, authenticated;
create policy ago107_p_all_all on public.ago107_p_all for all to authenticated using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));

create table public.ago107_p_noidx (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
alter table public.ago107_p_noidx enable row level security;
revoke all on public.ago107_p_noidx from anon, authenticated;
create policy ago107_p_noidx_select on public.ago107_p_noidx for select to authenticated using (private.is_member(workspace_id));

create table public.ago107_p_nocheck (id uuid primary key default gen_random_uuid(), workspace_id uuid not null);
create index on public.ago107_p_nocheck (workspace_id);
alter table public.ago107_p_nocheck enable row level security;
revoke all on public.ago107_p_nocheck from anon, authenticated;
create policy ago107_p_nocheck_update on public.ago107_p_nocheck for update to authenticated using (private.is_member(workspace_id, 'member'));

create function public.ago107_p_definer() returns int language sql security definer as $$ select 1 $$;

select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_norls' and problem = 'rls disabled'), 1,
  'a table with RLS disabled is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_nopol' and problem = 'no policies'), 1,
  'a table with RLS on but no policy is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_grant' and problem = 'privilege without policy: insert'), 1,
  'a privilege granted to authenticated without a policy for that command is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_norls' and problem = 'anon holds a table privilege'), 1,
  'a table that leaves default privileges open to anon is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_open' and problem like '%does not use private.is_member'), 1,
  'a policy that does not check membership (using true) is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_public' and problem like '%not restricted to authenticated'), 1,
  'a policy that applies to PUBLIC instead of authenticated is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_all' and problem like '%is an ALL policy%'), 1,
  'a FOR ALL policy is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_noidx' and problem = 'no index led by workspace_id'), 1,
  'a table without a workspace_id index is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_nocheck' and problem like 'update policy%has no WITH CHECK'), 1,
  'an UPDATE policy without WITH CHECK is reported');
select is((select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_definer' and problem = 'SECURITY DEFINER without a pinned search_path')
  + (select count(*)::int from ago107_t.violations() where tbl = 'public.ago107_p_definer' and problem = 'executable by anon'), 2,
  'a SECURITY DEFINER function with no search_path that anon can execute is reported twice');

-- 13. clean tables are not flagged (the probes above are the only violations)
select is((select count(distinct tbl)::int from ago107_t.violations() where tbl not like '%ago107_p_%'), 0,
  'only the probes are reported; the real tables stay clean');

-- 14-19. the privilege floor that the policies sit on
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    and c.relname not like 'ago107_p_%' and not c.relrowsecurity), 0, 'RLS is on for every real table');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace and c.relname not like 'ago107_p_%'), 37,
  '37 policies exist on the 14 real tables (3 AGO-82 + 31 AGO-107 + 3 AGO-96); a new policy needs this number and the role matrix updated');
select is(has_table_privilege('authenticated', 'public.run_events', 'INSERT,UPDATE,DELETE,TRUNCATE'), false,
  'authenticated cannot write run_events (append-only, runtime-only)');
select is(has_table_privilege('authenticated', 'public.claims', 'INSERT,UPDATE,DELETE'), false,
  'authenticated cannot write claims (runtime-only)');
select is(has_table_privilege('authenticated', 'public.approvals', 'INSERT,DELETE'), false,
  'authenticated cannot create or delete approvals');
select is(has_column_privilege('authenticated', 'public.approvals', 'payload_hash', 'UPDATE'), false,
  'authenticated cannot update the approval payload hash');

select * from finish();
rollback;
