-- AGO-151: the pg-boss schema is worker-only. Run: pnpm exec supabase test db (inside the db lock).
-- Holds whether or not the worker has installed pg-boss yet: privileges are checked on whatever exists.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select has_schema('pgboss', 'the pgboss schema exists');
select ok(not exists (select 1 from unnest(string_to_array('public,graphql_public', ',')) s where s = 'pgboss'),
  'sanity: pgboss is not one of the API schemas');

select is((select has_schema_privilege('anon', 'pgboss', 'USAGE')), false, 'anon has no USAGE on pgboss');
select is((select has_schema_privilege('authenticated', 'pgboss', 'USAGE')), false, 'authenticated has no USAGE on pgboss');
select is((select has_schema_privilege('service_role', 'pgboss', 'USAGE')), false, 'service_role has no USAGE on pgboss');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pgboss' and c.relkind in ('r', 'p', 'v', 'S')
      and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))),
  0, 'no pgboss relation is readable or writable by anon or authenticated');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pgboss' and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  0, 'no pgboss function is executable by anon or authenticated');

select * from finish();
rollback;
