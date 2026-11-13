-- Background drafting: every 5 minutes run-scheduled writes drafts for a few
-- topics that have none yet (oldest campaign month first). Idle when the
-- backlog is empty. Idempotent: re-scheduling the same job name replaces it.
select cron.schedule('seop-draft-backlog', '*/5 * * * *',
  $$select public.seop_invoke_scheduler('draft-backlog')$$);
