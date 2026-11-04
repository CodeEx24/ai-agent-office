-- Rollback for 20261105020003_ago_74_work_runs_approvals.sql (local DB only).
drop table if exists public.notes_index;
drop table if exists public.budgets_usage;
drop table if exists public.claims;
drop table if exists public.approvals;
drop table if exists public.run_events;
drop table if exists public.runs;
drop table if exists public.tasks;
