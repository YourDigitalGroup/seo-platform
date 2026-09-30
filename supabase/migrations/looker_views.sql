-- Looker Studio integration — flattened, read-only reporting views.
-- Claire connects Looker Studio's PostgreSQL connector to Supabase using a
-- dedicated read-only role that can ONLY see these views (never raw tables,
-- never API keys). See docs/LOOKER_INTEGRATION.md for the connector setup.
-- Idempotent; safe to re-run.

-- One row per audit, per client — scores, grades, and headline metrics.
create or replace view looker_audits as
select
  a.id                as audit_id,
  a.client_id,
  c.name              as client_name,
  c.url               as client_url,
  c.tier              as plan,
  g.name              as partner_group,
  a.run_at,
  a.score,
  a.grade_technical, a.grade_performance, a.grade_onpage, a.grade_schema,
  a.grade_aeo, a.grade_eeat, a.grade_local,
  a.domain_rating, a.org_keywords, a.org_traffic,
  a.org_keywords_top3, a.referring_domains
from audits a
join clients c on c.id = a.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- One row per client — current state for roster-level dashboards.
create or replace view looker_clients as
select
  c.id as client_id, c.name, c.url, c.market, c.tier as plan, c.status,
  g.name as partner_group,
  c.engagement_start_date, c.contract_length_months, c.contract_is_evergreen,
  c.suspended_at, c.suspend_reason,
  (select max(a.run_at) from audits a where a.client_id = c.id)  as last_audit_at,
  (select a.score from audits a where a.client_id = c.id order by a.run_at desc limit 1) as latest_score
from clients c
left join partner_groups g on g.id = c.partner_group_id;

-- One row per content piece — production/approval pipeline reporting.
create or replace view looker_content as
select
  t.id as topic_id, p.client_id, c.name as client_name, g.name as partner_group,
  t.title, t.kind, t.status, t.source, t.location, t.created_at
from content_topics t
join packages p on p.id = t.package_id
join clients c on c.id = p.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- One row per campaign deliverable — delivery/fulfillment reporting
-- (months completed, tactics delivered vs planned, per partner/plan).
create or replace view looker_deliverables as
select
  d.id as deliverable_id, d.client_id, c.name as client_name, c.url as client_url,
  c.tier as plan, g.name as partner_group,
  d.name, d.engine, d.kind, d.cadence, d.month_offset, d.cycle_month,
  d.state, d.auto
from deliverables d
join clients c on c.id = d.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- ════════════════════════════════════════════════════════════════════════════
--  THE CLIENT PROGRESS REPORT, IN FULL
--  generate-report (2.2.0+) writes one snapshot per report build: every number,
--  list, grade and plan item the PDF renders, as structured data. The three
--  looker_report* views flatten it, so a dashboard shows exactly what the PDF
--  shows — same computation, no re-derivation.
--    looker_reports        one row per report (all headline numbers, §1–§8)
--    looker_report_grades  one row per pillar per report (§7)
--    looker_report_items   one row per list line per report (§2, §3, §4, §5,
--                          §6, §8 tables and lists), keyed by `section`
--  Snapshots start with the first report built after redeploying
--  generate-report; fire `select seop_invoke_scheduler('weekly-reports');`
--  to build one for every active client right away.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists report_snapshots (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null,
  package_id     uuid not null,
  audit_id       uuid not null,
  report_date    timestamptz,
  report_version text,
  built_at       timestamptz not null default now(),
  data           jsonb not null
);
-- one snapshot per package + audit: a rebuild of the same report replaces it
create unique index if not exists report_snapshots_pkg_audit on report_snapshots (package_id, audit_id);
create index if not exists report_snapshots_client_date on report_snapshots (client_id, report_date desc);
-- service role (the report builder) bypasses RLS; nobody else reads the table directly
alter table report_snapshots enable row level security;

-- One row per report: every headline number in sections 1–8.
create or replace view looker_reports as
select
  rs.id as report_id, rs.client_id, c.name as client_name, c.url as client_url,
  c.tier as plan, g.name as partner_group,
  rs.report_date, rs.built_at, rs.report_version,
  (row_number() over (partition by rs.client_id order by rs.report_date desc, rs.built_at desc) = 1) as is_latest,
  -- cover + §1 where the program stands
  (d->>'baseline_date')::timestamptz          as baseline_date,
  (d->>'last_cycle_date')::timestamptz        as last_cycle_date,
  d->>'market'                                as market,
  d->>'business_type'                         as business_type,
  (d->>'program_month')::int                  as program_month,
  d->>'phase'                                 as phase,
  d->>'state'                                 as state,
  d->>'state_summary'                         as state_summary,
  (d->>'is_first_cycle')::boolean             as is_first_cycle,
  (d->>'program_days')::int                   as program_days,
  (d->>'audit_score')::numeric                as audit_score,
  -- §2 what you own so far (program-to-date)
  (d->>'content_published_total')::int        as content_published_total,
  (d->>'fixes_deployed_total')::int           as fixes_deployed_total,
  (d->>'schema_types_count')::int             as schema_types_count,
  (select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(d->'schema_types','[]'::jsonb)) x) as schema_types,
  (d->>'checks_passing')::int                 as checks_passing,
  (d->>'checks_total')::int                   as checks_total,
  (d->>'checks_passing_baseline')::int        as checks_passing_baseline,
  -- §3 this cycle's work
  (d->>'cycle_fixes_deployed')::int           as cycle_fixes_deployed,
  (d->>'cycle_content_count')::int            as cycle_content_published,
  (d->>'near_duplicates_consolidated')::int   as near_duplicates_consolidated,
  -- §4 leading indicators (Google Search Console, measured)
  (d->>'gsc_connected')::boolean              as gsc_connected,
  (d->>'gsc_queries')::numeric                as gsc_query_surface,
  (d->>'gsc_queries_delta')::numeric          as gsc_query_surface_delta,
  (d->>'gsc_queries_last_cycle')::numeric     as gsc_query_surface_last_cycle,
  (d->>'gsc_queries_baseline')::numeric       as gsc_query_surface_baseline,
  (d->>'gsc_impressions')::numeric            as gsc_impressions_90d,
  (d->>'gsc_impressions_last_cycle')::numeric as gsc_impressions_last_cycle,
  (d->>'gsc_impressions_baseline')::numeric   as gsc_impressions_baseline,
  (d->>'gsc_clicks')::numeric                 as gsc_clicks_90d,
  (d->>'gsc_clicks_last_cycle')::numeric      as gsc_clicks_last_cycle,
  (d->>'gsc_clicks_baseline')::numeric        as gsc_clicks_baseline,
  (d->>'gsc_striking')::numeric               as gsc_striking_distance,
  -- §5 rankings & traffic (modeled estimates)
  (d->>'ranking_keywords')::numeric           as ranking_keywords,
  (d->>'ranking_keywords_baseline')::numeric  as ranking_keywords_baseline,
  (d->>'ranking_keywords_delta')::numeric     as ranking_keywords_delta,
  d->>'ranking_keywords_delta_note'           as ranking_keywords_delta_note,
  (d->>'est_visits')::numeric                 as est_monthly_visits,
  (d->>'est_visits_baseline')::numeric        as est_monthly_visits_baseline,
  (d->>'est_visits_delta')::numeric           as est_monthly_visits_delta,
  d->>'est_visits_delta_note'                 as est_monthly_visits_delta_note,
  (d->>'domain_authority')::numeric           as domain_authority,
  (d->>'domain_authority_baseline')::numeric  as domain_authority_baseline,
  (d->>'yoy_available')::boolean              as yoy_available,
  (d->>'yoy_keywords_then')::numeric          as yoy_ranking_keywords_then,
  (d->>'yoy_visits_then')::numeric            as yoy_est_visits_then,
  -- §6 AI visibility (AEO)
  (d->>'aeo_readiness_pct')::numeric          as aeo_readiness_pct,
  (d->>'aeo_ready_pass')::int                 as aeo_checks_passing,
  (d->>'aeo_ready_total')::int                as aeo_checks_total,
  (d->>'ai_citations_live')::boolean          as ai_citation_tracking_live,
  (d->>'ai_mentions')::numeric                as ai_mentions,
  (d->>'ai_share_of_voice_pct')::numeric      as ai_share_of_voice_pct,
  d->>'ai_top_competitor'                     as ai_top_competitor,
  (d->>'ai_top_competitor_sov_pct')::numeric  as ai_top_competitor_sov_pct,
  -- §8 next cycle
  (d->>'verified_fixed_count')::int           as verified_fixed_count,
  jsonb_array_length(coalesce(d->'next_actions','[]'::jsonb)) as next_actions_count,
  (d->>'review_recommended')::boolean         as review_recommended,
  -- Display-ready text, worded as the PDF words it. Looker scorecards can't
  -- render text or true/false fields, so drop these into a table or text
  -- chart instead of re-building the wording in Looker.
  -- (Kept at the end: CREATE OR REPLACE VIEW can only append columns.)
  to_char((d->>'report_date')::timestamptz, 'FMMonth FMDD, YYYY')   as report_date_label,
  to_char((d->>'baseline_date')::timestamptz, 'FMMonth FMDD, YYYY') as baseline_date_label,
  initcap(d->>'phase')                                             as phase_label,
  'Program month ' || (d->>'program_month') || ' · ' || initcap(d->>'phase') || ' phase' as program_label,
  (d->>'checks_passing') || '/' || (d->>'checks_total')             as checks_passing_label,
  case when (d->>'checks_passing_baseline')::int > 0
       then 'was ' || (d->>'checks_passing_baseline') || ' at baseline'
       else 'baseline for future cycles' end                        as checks_baseline_label,
  case when (d->>'gsc_queries_delta') is not null
       then (case when (d->>'gsc_queries_delta')::numeric >= 0 then '+' else '' end)
            || (d->>'gsc_queries_delta') || ' vs last cycle' end    as gsc_query_surface_delta_label,
  case when coalesce((d->>'gsc_striking')::numeric, 0) > 0
       then (d->>'gsc_striking') || ' queries sit in striking distance (positions 4–20) — the next-cycle work targets these first.'
  end                                                               as gsc_striking_label,
  case when (d->>'domain_authority_baseline') is not null
       then 'was ' || (d->>'domain_authority_baseline') || ' at baseline · builds over months'
  end                                                               as domain_authority_baseline_label,
  case when (d->>'aeo_readiness_pct') is not null
       then (d->>'aeo_readiness_pct') || '% (' || (d->>'aeo_ready_pass') || '/' || (d->>'aeo_ready_total') || ' checks)'
  end                                                               as aeo_readiness_label,
  case when (d->>'ai_citations_live')::boolean then 'Live' else 'Being configured' end as ai_citation_status,
  case when (d->>'yoy_available')::boolean
       then 'Keywords ' || coalesce(d->>'yoy_keywords_then','—') || ' → ' || coalesce(d->>'ranking_keywords','—')
            || '; est. visits ' || coalesce(d->>'yoy_visits_then','—') || ' → ' || coalesce(d->>'est_visits','—')
       else 'Year-over-year comparison unlocks at month 13 of the program.' end as yoy_note,
  case when (d->>'cycle_fixes_deployed')::int > 0
       then (d->>'cycle_fixes_deployed') || ' fixes deployed this cycle.'
       else 'No fixes were marked deployed in this window — items staged in the platform are not claimed here until they ship.'
  end                                                               as cycle_fixes_note
from report_snapshots rs
cross join lateral (select rs.data as d) j
join clients c on c.id = rs.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- One row per pillar per report: §7 baseline / last cycle / now + notes.
create or replace view looker_report_grades as
select
  rs.id as report_id, rs.client_id, c.name as client_name, c.url as client_url,
  c.tier as plan, g.name as partner_group, rs.report_date,
  e->>'pillar'                   as pillar,
  (e->>'sort')::int              as pillar_order,
  e->>'baseline'                 as grade_baseline,
  e->>'last_cycle'               as grade_last_cycle,
  e->>'now'                      as grade_now,
  (e->>'not_assessed')::boolean  as not_assessed,
  (e->>'coverage_pct')::int      as coverage_pct,
  (e->>'regression')::boolean    as regression,
  e->>'notes'                    as notes_and_next_moves
from report_snapshots rs
cross join lateral jsonb_array_elements(coalesce(rs.data->'grades','[]'::jsonb)) e
join clients c on c.id = rs.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- One row per list line per report. `section` names the report table the
-- line comes from; the number columns that apply depend on the section:
--   content_by_type (§2)       title=type, count_value
--   schema_types (§2)          title=schema type
--   fixes_deployed (§3)        title=fix type, category=kind, count_value
--   content_published (§3)     title, category=type
--   gsc_trend (§4)             item_date, gsc_queries/impressions/clicks
--   position_improvements (§5) title=term, volume, position_before/after
--   newly_ranking (§5)         title=term, volume, position_after
--   early_movement (§4)        title=term, position_before/after (positions 20–100)
--   citation_trend (§6)        item_date, ai_mentions, ai_sov_pct
--   next_actions (§8)          title=action, detail=what it does, category=program area
--   verified_fixed (§8)        title
--   not_pursuing (§8)          title=term, detail=reason
--   roadmap (§8)               title
--   review_flags               title (internal — strategist review triggers)
create or replace view looker_report_items as
with s as (
  select rs.id as report_id, rs.client_id, c.name as client_name, c.url as client_url,
         c.tier as plan, g.name as partner_group, rs.report_date, rs.data as d
  from report_snapshots rs
  join clients c on c.id = rs.client_id
  left join partner_groups g on g.id = c.partner_group_id
), items as (
  select report_id, 2 as section_number, 'content_by_type' as section, n as item_order,
         e->>'type' as title, null::text as detail, e->>'kind' as category, null::timestamptz as item_date,
         (e->>'count')::numeric as count_value, null::numeric as volume,
         null::numeric as position_before, null::numeric as position_after,
         null::numeric as gsc_queries, null::numeric as gsc_impressions, null::numeric as gsc_clicks,
         null::numeric as ai_mentions, null::numeric as ai_sov_pct
    from s, jsonb_array_elements(coalesce(d->'content_by_type','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 2, 'schema_types', n, e, null, null, null, null, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements_text(coalesce(d->'schema_types','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 3, 'fixes_deployed', n, e->>'label', null, e->>'kind', null, (e->>'count')::numeric, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'cycle_fixes_by_kind','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 3, 'content_published', n, e->>'title', null, e->>'type', null, null, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'cycle_content','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 4, 'gsc_trend', n, null, null, null, (e->>'date')::timestamptz, null, null, null, null,
         (e->>'queries')::numeric, (e->>'impressions')::numeric, (e->>'clicks')::numeric, null, null
    from s, jsonb_array_elements(coalesce(d->'gsc_trend','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 4, 'early_movement', n, e->>'keyword', null, null, null, null, null,
         (e->>'before')::numeric, (e->>'after')::numeric, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'deep_moves','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 5, 'position_improvements', n, e->>'keyword', null, null, null, null, (e->>'volume')::numeric,
         (e->>'before')::numeric, (e->>'after')::numeric, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'position_improvements','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 5, 'newly_ranking', n, e->>'keyword', null, null, null, null, (e->>'volume')::numeric,
         null, (e->>'after')::numeric, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'newly_ranking','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 6, 'citation_trend', n, null, null, null, (e->>'date')::timestamptz, null, null, null, null,
         null, null, null, (e->>'mentions')::numeric, (e->>'sov_pct')::numeric
    from s, jsonb_array_elements(coalesce(d->'citation_trend','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 8, 'next_actions', n, e->>'title', e->>'action', e->>'program_area', null, null, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'next_actions','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 8, 'verified_fixed', n, e, null, null, null, null, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements_text(coalesce(d->'verified_fixed','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 8, 'not_pursuing', n, e->>'keyword', e->>'reason', null, null, null, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'not_pursuing','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 8, 'roadmap', n, e->>'title', null, null, null, null, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements(coalesce(d->'roadmap','[]'::jsonb)) with ordinality x(e, n)
  union all
  select report_id, 9, 'review_flags', n, e, null, null, null, null, null, null, null, null, null, null, null, null
    from s, jsonb_array_elements_text(coalesce(d->'review_flags','[]'::jsonb)) with ordinality x(e, n)
)
select s.report_id, s.client_id, s.client_name, s.client_url, s.plan, s.partner_group, s.report_date,
       i.section_number, i.section, i.item_order::int as item_order,
       i.title, i.detail, i.category, i.item_date, i.count_value, i.volume,
       i.position_before, i.position_after, i.gsc_queries, i.gsc_impressions, i.gsc_clicks,
       i.ai_mentions, i.ai_sov_pct
from items i join s on s.report_id = i.report_id;

-- Read-only role for the Looker Studio PostgreSQL connector.
-- After running this, set a password:  alter role looker_reader password '…';
do $$ begin
  if not exists (select from pg_roles where rolname = 'looker_reader') then
    create role looker_reader login password 'CHANGE-ME-IN-DASHBOARD';
  end if;
end $$;
grant usage on schema public to looker_reader;
grant select on looker_audits, looker_clients, looker_content, looker_deliverables,
  looker_reports, looker_report_grades, looker_report_items to looker_reader;
