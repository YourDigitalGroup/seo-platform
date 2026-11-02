-- Reputation Monitoring pages of the client report (Looker Studio / TapClicks).
-- One row per client per month from Local Incite, written by the reputation
-- function's daily run (the current month month-to-date; the previous month
-- is re-finalized during the first five days of a month), plus three views:
--   looker_reputation_monthly  Overview: lifetime total + rating, the month's
--                              reviews + rating, 12-month star breakdown
--   looker_reputation_sites    per review site (Google, Yelp, ...) per month
--   looker_reputation_reviews  every review with its site, reviewer, rating,
--                              text and location (the "Public Reviews" list)
-- Filter on `month` (first day of the month) or the report's date range.
-- Run after looker_views.sql and local_incite.sql. Idempotent.

create table if not exists public.reputation_monthly (
  client_id        uuid not null references public.clients(id) on delete cascade,
  month            date not null,                    -- first day of the month
  source           text not null default 'local_incite',
  location_name    text,
  location_address text,
  total_reviews    integer,                          -- lifetime, as of captured_at
  overall_rating   numeric,                          -- lifetime average
  period_reviews   integer,                          -- reviews published in the month
  period_rating    numeric,                          -- their average
  sites            jsonb not null default '[]'::jsonb, -- [{site, total_reviews, rating, period_reviews, period_rating}]
  stars_12m        jsonb,                            -- {"1": n, ... "5": n}, last 12 months
  captured_at      timestamptz not null default now(),
  primary key (client_id, month, source)
);
alter table public.reputation_monthly enable row level security;
revoke all on public.reputation_monthly from anon, authenticated;
grant select on public.reputation_monthly to authenticated;
drop policy if exists reputation_monthly_staff_read on public.reputation_monthly;
create policy reputation_monthly_staff_read on public.reputation_monthly for select to authenticated using (public.is_staff());

-- Where the review sits on the listing, for the review list ("Resistance
-- Exteriors - Dousman, 123 Elm St., Dousman").
alter table public.reputation_reviews add column if not exists location_name text;
alter table public.reputation_reviews add column if not exists location_address text;

create or replace view looker_reputation_monthly as
select
  m.client_id, c.name as client_name, c.url as client_url, c.tier as plan, g.name as partner_group,
  m.month, to_char(m.month, 'Mon YYYY') as month_label,
  (m.month = date_trunc('month', now())::date) as is_current_month,
  m.location_name, regexp_replace(m.location_address, '\s*,(\s*,)+', ',', 'g') as location_address,
  m.total_reviews, m.overall_rating, m.period_reviews, m.period_rating,
  4.4::numeric as industry_average_rating,   -- the benchmark the report quotes
  s.star_total as reviews_12m,
  (m.stars_12m->>'1')::int as stars_1_12m, (m.stars_12m->>'2')::int as stars_2_12m,
  (m.stars_12m->>'3')::int as stars_3_12m, (m.stars_12m->>'4')::int as stars_4_12m,
  (m.stars_12m->>'5')::int as stars_5_12m,
  round(100.0 * (m.stars_12m->>'1')::int / nullif(s.star_total, 0), 1) as stars_1_pct_12m,
  round(100.0 * (m.stars_12m->>'2')::int / nullif(s.star_total, 0), 1) as stars_2_pct_12m,
  round(100.0 * (m.stars_12m->>'3')::int / nullif(s.star_total, 0), 1) as stars_3_pct_12m,
  round(100.0 * (m.stars_12m->>'4')::int / nullif(s.star_total, 0), 1) as stars_4_pct_12m,
  round(100.0 * (m.stars_12m->>'5')::int / nullif(s.star_total, 0), 1) as stars_5_pct_12m,
  m.captured_at
from reputation_monthly m
cross join lateral (select coalesce((m.stars_12m->>'1')::int, 0) + coalesce((m.stars_12m->>'2')::int, 0) + coalesce((m.stars_12m->>'3')::int, 0)
                         + coalesce((m.stars_12m->>'4')::int, 0) + coalesce((m.stars_12m->>'5')::int, 0) as star_total) s
join clients c on c.id = m.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- One row per review site per month (Google 222 reviews 4.95, Yelp 8 4.13...).
create or replace view looker_reputation_sites as
select
  m.client_id, c.name as client_name, c.url as client_url, c.tier as plan, g.name as partner_group,
  m.month, to_char(m.month, 'Mon YYYY') as month_label,
  x->>'site' as review_site, n::int as site_order,
  (x->>'total_reviews')::int as total_reviews, (x->>'rating')::numeric as rating,
  (x->>'period_reviews')::int as period_reviews, (x->>'period_rating')::numeric as period_rating,
  m.captured_at
from reputation_monthly m
cross join lateral jsonb_array_elements(m.sites) with ordinality t(x, n)
join clients c on c.id = m.client_id
left join partner_groups g on g.id = c.partner_group_id;

-- Every review. Local Incite (all sites) for linked clients, Google for the rest.
create or replace view looker_reputation_reviews as
select
  r.client_id, c.name as client_name, c.url as client_url, c.tier as plan, g.name as partner_group,
  date_trunc('month', r.published_at)::date as month, r.published_at, r.published_at::date as review_date,
  coalesce(r.site, 'Google') as review_site, r.author as reviewer, r.rating, r.text as review_text,
  r.review_url, r.location_name, regexp_replace(r.location_address, '\s*,(\s*,)+', ',', 'g') as location_address,
  coalesce(r.site, 'Google') || ' Review By ' || coalesce(r.author, 'a customer') as review_heading,
  case when r.rating is not null then repeat('★', greatest(0, least(5, r.rating))) end as stars_label
from reputation_reviews r
join clients c on c.id = r.client_id
left join partner_groups g on g.id = c.partner_group_id
where r.published_at is not null
  and r.source = case when c.local_incite_location_id is not null then 'local_incite' else 'google' end;

-- Same exposure rules as the other Looker views: only looker_reader reads them.
revoke all on looker_reputation_monthly, looker_reputation_sites, looker_reputation_reviews from anon, authenticated;
do $$ begin
  if exists (select from pg_roles where rolname = 'looker_reader') then
    grant select on looker_reputation_monthly, looker_reputation_sites, looker_reputation_reviews to looker_reader;
  end if;
end $$;
