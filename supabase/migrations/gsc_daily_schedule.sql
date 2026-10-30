-- Daily GSC refresh at 13:10 UTC (8:10 AM Central Standard Time, 9:10 AM CDT).
-- Reuses the Vault-backed, service-role-only scheduler invocation.
select cron.schedule('seop-daily-gsc','10 13 * * *','select public.seop_invoke_scheduler(''daily-gsc'')');
