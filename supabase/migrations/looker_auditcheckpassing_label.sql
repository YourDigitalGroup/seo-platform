-- Append a display-ready Audit Checks Passing label to the existing monthly view.
-- Keep every pre-existing column in its current position.
create or replace view public.looker_reports_monthly as
select r.*,
  al.directory_count as al_directories_total,
  al.live_count as al_directories_live,
  al.retry_count as al_directories_retrying,
  al.queued_count as al_directories_queued,
  al.verify_count as al_directories_verification,
  al.attn_count as al_directories_needs_attention,
  al.other_count as al_directories_other,
  al.last_checked_at as al_status_checked_at,
  CASE WHEN r.checks_passing IS NOT NULL AND r.checks_total IS NOT NULL
       THEN r.checks_passing::text || '/' || r.checks_total::text
       ELSE NULL END AS label_auditcheckpassing
from public.looker_reports r
left join lateral (
 select count(*)::integer directory_count,
  count(*) filter(where status_group='live')::integer live_count,
  count(*) filter(where status_group='retry')::integer retry_count,
  count(*) filter(where status_group='queued')::integer queued_count,
  count(*) filter(where status_group='verify')::integer verify_count,
  count(*) filter(where status_group='attn')::integer attn_count,
  count(*) filter(where status_group='other')::integer other_count,
  max(fetched_at) last_checked_at
 from public.advice_local_directory_status al
 where al.client_id=r.client_id and date_trunc('month',al.fetched_at)::date=r.report_month
) al on true
where r.is_month_final;

revoke all on public.looker_reports_monthly from anon,authenticated;
grant select on public.looker_reports_monthly to looker_reader;
