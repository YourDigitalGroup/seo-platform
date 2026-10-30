-- AI citation tracking for Looker Studio / TapClicks (report section 6).
-- Two views over the weekly report snapshots, joined to the other report
-- views by report_id. Filter is_latest for "now", or is_month_final for one
-- report per client per month (same convention as the *_monthly views).
-- Run after looker_views.sql and ai_citations.sql. Idempotent.

-- One row per report: the section 6 headline numbers.
create or replace view looker_ai_visibility as
select
  rs.id as report_id, rs.client_id, c.name as client_name, c.url as client_url,
  c.tier as plan, g.name as partner_group, rs.report_date,
  rk.is_latest, rk.report_month, rk.is_month_final,
  coalesce(d->>'ai_tracking_state',
           case when (d->>'ai_citations_live')::boolean then 'live' else 'not_configured' end) as ai_tracking_state,
  case coalesce(d->>'ai_tracking_state',
                case when (d->>'ai_citations_live')::boolean then 'live' else 'not_configured' end)
    when 'live' then 'Live'
    when 'collecting' then 'Tracking started'
    else 'Being configured' end                                   as ai_tracking_status,
  (select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(d->'ai_engines', '[]'::jsonb)) x) as ai_engines,
  (d->>'ai_prompts_tracked')::int                                  as ai_questions_tracked,
  (d->>'ai_queries_checked')::int                                  as ai_answers_checked,
  (d->>'ai_responses_mentioning')::int                             as ai_answers_mentioning,
  (d->>'ai_responses_citing')::int                                 as ai_answers_citing,
  (d->>'ai_mention_rate_pct')::numeric                             as ai_mention_rate_pct,
  (d->>'ai_citation_rate_pct')::numeric                            as ai_citation_rate_pct,
  jsonb_array_length(coalesce(d->'ai_cited_urls', '[]'::jsonb))    as ai_pages_cited,
  (d->>'ai_share_of_voice_pct')::numeric                           as ai_share_of_voice_pct,
  d->>'ai_top_competitor'                                          as ai_top_competitor,
  (d->>'ai_top_competitor_sov_pct')::numeric                       as ai_top_competitor_sov_pct,
  (d->>'ai_captured_at')::timestamptz                              as ai_checked_at,
  (d->>'aeo_readiness_pct')::numeric                               as aeo_readiness_pct,
  -- display-ready text, worded as the PDF words it
  case when (d->>'ai_queries_checked')::int > 0
       then (d->>'ai_responses_mentioning') || ' of ' || (d->>'ai_queries_checked') || ' answers mention the business' end as ai_mentions_label,
  case when (d->>'ai_queries_checked')::int > 0
       then (d->>'ai_responses_citing') || ' answers link to the website' end as ai_citations_label,
  case when (d->>'ai_prompts_tracked')::int > 0
       then (d->>'ai_prompts_tracked') || ' customer questions asked on '
            || coalesce((select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(d->'ai_engines', '[]'::jsonb)) x), 'AI engines') end as ai_scope_label
from report_snapshots rs
cross join lateral (select rs.data as d) j
join report_snapshot_rank rk on rk.id = rs.id
join clients c on c.id = rs.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- One row per list line in section 6. `section` says which table it feeds:
--   engine        title=engine, answers_checked / answers_mentioning / answers_citing
--   question      title=question, mentioned_on / cited_on (engine names), url=cited page
--   cited_page    title=page title, url, engines, answers=answers citing it
--   competitor    title=competitor domain, answers=answers citing it
--   trend         item_date, answers_checked / answers_mentioning / answers_citing, sov_pct
create or replace view looker_ai_visibility_items as
with s as (
  select rs.id as report_id, rs.client_id, c.name as client_name, c.url as client_url,
         c.tier as plan, g.name as partner_group, rs.report_date, rs.data as d,
         rk.is_latest, rk.report_month, rk.is_month_final
  from report_snapshots rs
  join report_snapshot_rank rk on rk.id = rs.id
  join clients c on c.id = rs.client_id
  left join partner_groups g on g.id = c.partner_group_id
), items as (
  select report_id, 'engine' as section, n as item_order, e->>'engine' as title, null::text as url,
         null::text as engines, null::text as mentioned_on, null::text as cited_on, null::timestamptz as item_date,
         (e->>'checked')::int as answers_checked, (e->>'mentioned')::int as answers_mentioning,
         (e->>'cited')::int as answers_citing, null::int as answers, null::numeric as sov_pct
    from s, jsonb_array_elements(coalesce(d->'ai_engine_breakdown', '[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 'question', n, e->>'question', e->>'cited_url', null,
         (select string_agg(v, ', ') from jsonb_array_elements_text(coalesce(e->'mentioned_on', '[]'::jsonb)) v),
         (select string_agg(v, ', ') from jsonb_array_elements_text(coalesce(e->'cited_on', '[]'::jsonb)) v),
         null, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'ai_prompts', '[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 'cited_page', n, coalesce(e->>'title', e->>'url'), e->>'url',
         (select string_agg(v, ', ') from jsonb_array_elements_text(coalesce(e->'engines', '[]'::jsonb)) v),
         null, null, null, null, null, null, (e->>'responses')::int, null
    from s, jsonb_array_elements(coalesce(d->'ai_cited_urls', '[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 'competitor', n, e->>'domain', null, null, null, null, null, null, null, null, (e->>'responses')::int, null
    from s, jsonb_array_elements(coalesce(d->'ai_competitor_citations', '[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 'trend', n, null, null, null, null, null, (e->>'date')::timestamptz,
         (e->>'checked')::int, (e->>'mentions')::int, (e->>'cited')::int, null, (e->>'sov_pct')::numeric
    from s, jsonb_array_elements(coalesce(d->'citation_trend', '[]'::jsonb)) with ordinality x(e, n)
)
select s.report_id, s.client_id, s.client_name, s.client_url, s.plan, s.partner_group, s.report_date,
       s.is_latest, s.report_month, s.is_month_final,
       i.section, i.item_order::int as item_order, i.title, i.url, i.engines, i.mentioned_on, i.cited_on,
       i.item_date, i.answers_checked, i.answers_mentioning, i.answers_citing, i.answers, i.sov_pct
from items i join s on s.report_id = i.report_id;

-- Same exposure rules as the other Looker views: only looker_reader reads them.
revoke all on looker_ai_visibility, looker_ai_visibility_items from anon, authenticated;
do $$ begin
  if exists (select from pg_roles where rolname = 'looker_reader') then
    grant select on looker_ai_visibility, looker_ai_visibility_items to looker_reader;
  end if;
end $$;
