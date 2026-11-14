-- Rollback for AGO-58: remove the function. Events already appended stay (run_events is append-only by design).
drop function if exists public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text);
