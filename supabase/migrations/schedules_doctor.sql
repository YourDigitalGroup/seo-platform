-- ════════════════════════════════════════════════════════════════════════════
--  schedules_doctor.sql — REPAIR + DIAGNOSE the daily-audit / weekly-report
--  scheduler in one paste. Safe to run any number of times.
--
--  What it does, in order:
--   1 · Ensures pg_cron + pg_net are on.
--   2 · Replaces seop_invoke_scheduler with a hardened version: it now FAILS
--       LOUDLY when the Vault secrets are missing (the old one silently
--       posted to 'null/functions/…' and the failure vanished), and uses an
--       explicit 15s HTTP timeout.
--   3 · (Re)schedules both jobs — cron.schedule upserts by name.
--   4 · Fires the daily job RIGHT NOW so you don't wait until 11:00 UTC.
--   5 · Creates a permanent health view and prints the report.
--
--  READING THE REPORT (last result grid):
--   · "vault secrets: MISSING"      → run the two vault.create_secret lines
--                                     from schedules.sql, then re-run this file.
--   · "cron run: failed"            → the return_message column says why.
--   · "edge response: FAILED — 401" → the service_role_key in Vault is wrong
--                                     or was rotated. Re-create that secret.
--   · "edge response: FAILED — 404" → the run-scheduled Edge Function is not
--                                     deployed. Deploy it, then re-run.
--   · "edge response: OK"           → scheduler works; the response content
--                                     shows how many audits were dispatched.
--  The edge response to step 4's live fire arrives asynchronously — run
--    select * from seop_scheduler_health;
--  again ~30 seconds after this file finishes to see it.
-- ════════════════════════════════════════════════════════════════════════════
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2 · hardened invoker ────────────────────────────────────────────────────────
create or replace function seop_invoke_scheduler(mode text) returns bigint
language plpgsql security definer as $fn$
declare
  p_url text; p_key text; rid bigint;
begin
  select decrypted_secret into p_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into p_key from vault.decrypted_secrets where name = 'service_role_key';
  if p_url is null or p_key is null then
    raise exception 'Vault secrets missing — run: select vault.create_secret(''https://YOURPROJECT.supabase.co'',''project_url''); and select vault.create_secret(''YOUR_SERVICE_ROLE_KEY'',''service_role_key'');';
  end if;
  select net.http_post(
    url := p_url || '/functions/v1/run-scheduled',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || p_key),
    body := jsonb_build_object('mode', mode),
    timeout_milliseconds := 15000
  ) into rid;
  return rid;
end $fn$;

-- 3 · (re)schedule — upsert by job name ──────────────────────────────────────
select cron.schedule('seop-daily-audits',   '0 11 * * *', $$select seop_invoke_scheduler('daily-audits')$$);
select cron.schedule('seop-weekly-reports', '0 13 * * 1', $$select seop_invoke_scheduler('weekly-reports')$$);

-- 4 · fire the daily job right now (audits fresher than 20h are skipped, so
--     this is safe — it only reaches clients the schedule has been missing)
select seop_invoke_scheduler('daily-audits') as fired_request_id;

-- 5 · permanent health view + report ─────────────────────────────────────────
create or replace view seop_scheduler_health as
select item, status, detail, ran_at from (
  select 0 as ord, 'vault secrets' as item,
         case when (select count(*) from vault.decrypted_secrets
                    where name in ('project_url','service_role_key')) = 2
              then 'present'
              else 'MISSING — create project_url / service_role_key (see schedules.sql header)' end as status,
         '' as detail, null::timestamptz as ran_at
  union all
  select 1, 'cron job: '||jobname,
         case when active then 'scheduled' else 'PAUSED — re-run schedules_doctor.sql' end,
         schedule, null
  from cron.job where jobname in ('seop-daily-audits','seop-weekly-reports')
  union all
  select * from (
    select 2, 'cron run: '||j.jobname, d.status,
           coalesce(nullif(d.return_message,''),'—'), d.start_time
    from cron.job_run_details d join cron.job j using (jobid)
    where j.jobname in ('seop-daily-audits','seop-weekly-reports')
    order by d.start_time desc limit 10) runs
  union all
  select * from (
    select 3, 'edge response #'||r.id,
           case when r.status_code = 200 then 'OK'
                when r.status_code = 401 then 'FAILED — bad/rotated service_role_key in Vault'
                when r.status_code = 404 then 'FAILED — run-scheduled function not deployed'
                when r.status_code is null then 'FAILED — '||coalesce(r.error_msg,'no response (timeout?)')
                else 'HTTP '||r.status_code end,
           left(coalesce(r.content, r.error_msg, ''), 200), r.created
    from net._http_response r
    order by r.id desc limit 10) resp
) x
order by ord, ran_at desc nulls first;

select * from seop_scheduler_health;
