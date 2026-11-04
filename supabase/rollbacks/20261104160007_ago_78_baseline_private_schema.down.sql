-- Rollback for 20261104160007_ago_78_baseline_private_schema.sql (apply by hand on a local DB only).
-- Fails if later migrations put objects in the schema: roll those back first.
drop schema if exists private;
