-- ════════════════════════════════════════════════════════════════════════════
--  schedules.sql — daily audits + weekly reports, on the database's clock.
--
--  Uses pg_cron (scheduler) + pg_net (HTTP) + Vault (secrets) — all built into
--  Supabase. The jobs POST to the run-scheduled Edge Function, which fans out
--  to run-audit (audit_only) / generate-report per active client.
--
--  ONE-TIME SETUP before running this file — store the two secrets in Vault
--  (SQL editor; replace the placeholders with your real values):
--
--    select vault.create_secret('https://YOURPROJECT.supabase.co', 'project_url');
--    select vault.create_secret('YOUR_SERVICE_ROLE_KEY', 'service_role_key');
--
--  Then run this file. Re-running is safe: cron.schedule() upserts by name.
--  Verify with:  select jobname, schedule, active from cron.job;
--  Recent runs:  select * from cron.job_run_details order by start_time desc limit 10;
-- ════════════════════════════════════════════════════════════════════════════
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function seop_invoke_scheduler(mode text) returns bigint
language sql security definer as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/run-scheduled',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('mode', mode)
  );
$$;

-- Daily audit-only re-runs: 11:00 UTC = 6:00 AM Central (winter) / 5:00 AM (summer).
-- Fresh scores + history + fix verification every morning; no packages rebuilt.
select cron.schedule('seop-daily-audits', '0 11 * * *', $$select seop_invoke_scheduler('daily-audits')$$);

-- Weekly report rebuilds: Mondays 13:00 UTC, AFTER that morning's audits —
-- the white-label client report is never more than a week stale.
select cron.schedule('seop-weekly-reports', '0 13 * * 1', $$select seop_invoke_scheduler('weekly-reports')$$);
