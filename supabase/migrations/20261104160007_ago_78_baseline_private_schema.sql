-- AGO-78: baseline migration. Proves the local migration workflow end to end.
-- No domain tables here: the core schema (workspaces, RLS, ...) is AGO-74.
-- Rollback: supabase/rollbacks/20261104160007_ago_78_baseline_private_schema.down.sql

-- Home for internal helper functions (policy helpers, security definer functions).
-- It is not in the API's exposed schemas, and the API roles get no access to it.
create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

comment on schema private is 'Internal helpers. Not exposed through the Data API; no access for anon or authenticated.';
