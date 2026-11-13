-- Rollback for 20261113040001_ago_30_run_checkpoints.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping the table loses stored checkpoints: a run that was waiting on a resume restarts from step 1.
drop table if exists private.run_checkpoints;
