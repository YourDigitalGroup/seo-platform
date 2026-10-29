-- Daily automated Advice Local directory status refresh
-- Calls only the read-only fulfillment-status workflow.
select cron.schedule('seop-daily-advice-local', '30 12 * * *', 'select public.seop_invoke_scheduler(''daily-advice-local'')');
