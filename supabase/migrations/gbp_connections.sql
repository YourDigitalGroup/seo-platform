-- Google Business Profile performance (report page 1, "Local Listing
-- Optimization"): the Google sign-ins that read it, and which listing each
-- client is. Feeds gbp_performance_monthly → looker_llo_google_business_profile.
-- Idempotent; safe to re-run.

-- The table and view the report reads (created earlier straight in the
-- database; recorded here so the repo can rebuild them).
create table if not exists public.gbp_performance_monthly (
  client_id                  uuid not null references public.clients(id) on delete cascade,
  report_month               date not null,
  location_id                text,
  directions_requests        integer,
  website_clicks             integer,
  call_clicks                integer,
  desktop_maps_impressions   integer,
  desktop_search_impressions integer,
  mobile_maps_impressions    integer,
  mobile_search_impressions  integer,
  search_views               integer,
  maps_views                 integer,
  search_terms               jsonb not null default '[]'::jsonb,
  fetched_at                 timestamptz not null default now(),
  source                     text not null default 'google_business_profile_performance_api',
  primary key (client_id, report_month),
  constraint gbp_perf_month_first check (report_month = date_trunc('month', report_month)::date)
);
alter table public.gbp_performance_monthly enable row level security;

-- One row per connected Google account. The refresh token itself lives in
-- Vault (platform key GBP_REFRESH_<KEY>), never in this table.
create table if not exists public.gbp_connections (
  key               text primary key,              -- '44i' | 'ydg'
  label             text not null,
  expected_email    text,
  scope_note        text,
  account_email     text,                          -- who actually signed in
  connected_at      timestamptz,
  connected_by      text,
  last_discovery_at timestamptz,
  locations_found   integer,
  last_sync_at      timestamptz,
  last_error        text
);
alter table public.gbp_connections enable row level security;
revoke all on public.gbp_connections from anon, authenticated;
insert into public.gbp_connections (key, label, expected_email, scope_note) values
  ('44i', '44i Digital', 'media@44interactive.com', '44i partner group'),
  ('ydg', 'Your Digital Group', 'yourdigitalgroup@gmail.com', 'All other partner groups')
on conflict (key) do nothing;

-- Short-lived OAuth "state" values tying a Google sign-in back to the Super
-- Admin who started it and the console page to return to.
create table if not exists public.gbp_oauth_states (
  state         text primary key,
  connection    text not null references public.gbp_connections(key) on delete cascade,
  return_to     text,
  created_by    text,
  created_at    timestamptz not null default now()
);
alter table public.gbp_oauth_states enable row level security;
revoke all on public.gbp_oauth_states from anon, authenticated;

-- Which Business Profile listing a client is ("locations/123…") and which
-- connected account can read it. Matched by website, else by name, or set by hand.
alter table public.clients add column if not exists gbp_location text;
alter table public.clients add column if not exists gbp_location_title text;
alter table public.clients add column if not exists gbp_connection text;

-- Daily pull, 13:10 UTC (after reputation, before Monday's report rebuild).
-- Google finalizes performance data a few days late, so each run refreshes
-- the current and previous month.
select cron.schedule('seop-daily-gbp-performance', '10 13 * * *',
  $$select public.seop_invoke_function('gbp', '{"action":"collect_all"}'::jsonb)$$);
