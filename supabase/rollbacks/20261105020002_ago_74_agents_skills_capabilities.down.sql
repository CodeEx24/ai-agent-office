-- Rollback for 20261105020002_ago_74_agents_skills_capabilities.sql (local DB only; roll back newer AGO-74 files first).
drop table if exists public.agent_capabilities;
drop table if exists public.agent_skills;
drop table if exists public.skills;
drop table if exists public.agents;
