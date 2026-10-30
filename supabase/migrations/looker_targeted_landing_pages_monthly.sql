-- One reporting row per configured target, per finalized client report month.
-- Slugs are derived from client intake labels. They are candidates, NOT verified
-- published URLs. GSC impressions are attributed only for exact matching paths.
create or replace view public.looker_targeted_landing_pages_monthly as
with targets as (
  select r.report_id, r.client_id, r.client_name, r.client_url,
    r.partner_group, r.report_date, r.report_month,
    r.is_latest, r.is_month_final,
    btrim(x.label) as target_name, x.ordinality::integer as target_order,
    regexp_replace(
      regexp_replace(lower(btrim(x.label)), '[^a-z0-9]+', '-', 'g'),
      '(^-+|-+$)', '', 'g'
    ) as target_slug
  from public.looker_reports_monthly r
  join public.clients c on c.id = r.client_id
  cross join lateral regexp_split_to_table(
    replace(coalesce(c.intake->>'landing_targets', ''),chr(13),''), chr(10)
  ) with ordinality as x(label, ordinality)
  where btrim(x.label) <> ''
)
select t.report_id, t.client_id, t.client_name, t.client_url, t.partner_group,
  t.report_date, t.report_month, t.is_latest, t.is_month_final,
  t.target_order, t.target_name,
  ('/' || t.target_slug || '/')::text as targeted_landing_pages,
  matched.page_url as verified_page_url,
  (matched.page_url is not null) as url_verified,
  matched.impressions::bigint as impressions,
  matched.clicks::bigint as clicks,
  matched.pulled_at as gsc_pulled_at
from targets t
left join lateral (
  select min(g.page_url) as page_url,
    sum(g.impressions)::bigint as impressions,
    sum(g.clicks)::bigint as clicks,
    max(g.pulled_at) as pulled_at
  from public.gsc_pages g
  where g.client_id = t.client_id
    and date_trunc('month', g.pulled_at)::date = t.report_month
    and g.pulled_at = (
      select max(z.pulled_at) from public.gsc_pages z
      where z.client_id = t.client_id
        and date_trunc('month', z.pulled_at)::date = t.report_month
    )
    and lower(trim(trailing '/' from split_part(split_part(g.page_url,'?',1),'#',1)))
       like '%/' || t.target_slug
) matched on true;
revoke all on public.looker_targeted_landing_pages_monthly from anon, authenticated;
grant select on public.looker_targeted_landing_pages_monthly to looker_reader;
