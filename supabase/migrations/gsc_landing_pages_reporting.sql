-- Store GSC page-level analytics and expose monthly page tables plus summaries.
-- Page metrics cover the trailing 90 days at pull time, not a calendar-month-only window.
create table if not exists public.gsc_pages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  page_url text not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr numeric,
  position numeric,
  period_start date not null,
  period_end date not null,
  pulled_at timestamptz not null default now()
);
create index if not exists gsc_pages_client_pull on public.gsc_pages(client_id,pulled_at desc);
alter table public.gsc_pages enable row level security;
revoke all on public.gsc_pages from anon,authenticated;

-- Append page summary metrics while retaining the established one-row-per-report grain.
-- Preserve previous column order and all established access rules.
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
       ELSE NULL END AS label_auditcheckpassing,
  CASE
    WHEN rs.data->>'ai_tracking_state' = 'collecting' THEN 'Tracking started'
    WHEN rs.data->>'ai_tracking_state' = 'live' THEN 'Tracking live'
    WHEN rs.data->>'ai_tracking_state' = 'not_configured' THEN 'Being configured'
    ELSE r.ai_citation_status
  END::text AS label_ai_tracking_status,
  CASE
    WHEN rs.data->>'ai_tracking_state' = 'collecting'
      THEN 'The customer questions we track are being asked on the AI engines now; the first results appear in the next report.'
    WHEN rs.data->>'ai_tracking_state' = 'live'
      THEN 'AI citation results are available. See the report for tracked questions, mentions, and citations.'
    ELSE 'Once live, this section reports the queries checked per AI engine, citations earned with the cited URL, and the trend across cycles.'
  END::text AS label_ai_tracking_description,
  CASE WHEN r.aeo_checks_passing IS NOT NULL AND r.aeo_checks_total IS NOT NULL
    THEN 'structured-data & answer-content checks passing (' || r.aeo_checks_passing::text || '/' || r.aeo_checks_total::text || ')'
    ELSE 'structured-data & answer-content checks passing'
  END::text AS label_aeo_readiness_description,
  CASE WHEN COALESCE((rs.data->>'ai_queries_checked')::numeric,0) > 0
         AND rs.data->>'ai_responses_mentioning' IS NOT NULL
    THEN (rs.data->>'ai_responses_mentioning')
    ELSE 'Data not yet available.'
  END::text AS label_ai_mentions,
  CASE WHEN COALESCE((rs.data->>'ai_queries_checked')::numeric,0) > 0
         AND rs.data->>'ai_responses_citing' IS NOT NULL
    THEN (rs.data->>'ai_responses_citing')
    ELSE 'Data not yet available.'
  END::text AS label_ai_citations_earned,
  CASE WHEN COALESCE((rs.data->>'ai_queries_checked')::numeric,0) > 0
         AND r.ai_share_of_voice_pct IS NOT NULL
    THEN r.ai_share_of_voice_pct::text || '%'
    ELSE 'Data not yet available.'
  END::text AS label_ai_share_of_voice,
  gsc_pages.pages_count AS gsc_landing_pages_count,
  gsc_pages.impressions AS gsc_landing_page_impressions,
  gsc_pages.top_page AS gsc_top_landing_page,
  gsc_pages.top_page_impressions AS gsc_top_landing_page_impressions
from public.looker_reports r
left join public.report_snapshots rs ON rs.id=r.report_id
left join lateral (
  select count(*)::integer as pages_count,
         coalesce(sum(pg.impressions),0)::bigint as impressions,
         (array_agg(pg.page_url order by pg.impressions desc, pg.page_url))[1] as top_page,
         max(pg.impressions)::integer as top_page_impressions
  from public.gsc_pages pg
  where pg.client_id=r.client_id
    and pg.pulled_at=(select max(x.pulled_at) from public.gsc_pages x
       where x.client_id=r.client_id and date_trunc('month',x.pulled_at)::date=r.report_month)
) gsc_pages on true
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

-- Page detail view for native Page / Impressions Looker Studio tables.
create or replace view public.looker_gsc_landing_pages_monthly as
select r.report_id, r.client_id, r.client_name, r.client_url, r.partner_group,
       r.report_date, r.report_month, r.is_latest, r.is_month_final,
       p.page_url as targeted_landing_page,
       p.impressions, p.clicks, p.ctr, p.position,
       p.period_start, p.period_end, p.pulled_at
from public.looker_reports_monthly r
join public.gsc_pages p on p.client_id=r.client_id
  and date_trunc('month',p.pulled_at)::date=r.report_month
  and p.pulled_at=(select max(z.pulled_at) from public.gsc_pages z
       where z.client_id=r.client_id and date_trunc('month',z.pulled_at)::date=r.report_month)
where r.is_month_final;
revoke all on public.looker_gsc_landing_pages_monthly from anon,authenticated;
grant select on public.looker_gsc_landing_pages_monthly to looker_reader;
