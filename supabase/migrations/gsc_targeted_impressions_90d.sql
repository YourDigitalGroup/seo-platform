-- Rolling 90-day GSC page snapshots, separate from calendar-month page data.
create table if not exists public.gsc_pages_90d (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id) on delete cascade,
 page_url text not null,
 impressions integer not null default 0,
 clicks integer not null default 0,
 period_start date not null,
 period_end date not null,
 pulled_at timestamptz not null default now()
);
create index if not exists gsc_pages_90d_client_pull_idx on public.gsc_pages_90d(client_id,pulled_at desc);
alter table public.gsc_pages_90d enable row level security;
revoke all on public.gsc_pages_90d from anon, authenticated;

-- Keep existing columns/ordering and append one numeric metric.
do $$
declare v text;
begin
 select pg_get_viewdef('public.looker_targeted_landing_pages_monthly'::regclass,true) into v;
 v := replace(v, 'FROM targets t', 
   ', (select sum(g.impressions)::bigint from public.gsc_pages_90d g ' ||
   'where g.client_id=t.client_id and date_trunc(''month'',g.pulled_at)::date=t.report_month ' ||
   'and g.pulled_at=(select max(z.pulled_at) from public.gsc_pages_90d z ' ||
   'where z.client_id=t.client_id and date_trunc(''month'',z.pulled_at)::date=t.report_month) ' ||
   'and lower(trim(trailing ''/'' from split_part(split_part(g.page_url,''?'',1),''#'',1))) ' ||
   'like ''%/'' || t.target_slug) AS impressions_90d FROM targets t');
 execute 'create or replace view public.looker_targeted_landing_pages_monthly as ' || v;
end $$;
revoke all on public.looker_targeted_landing_pages_monthly from anon, authenticated;
grant select on public.looker_targeted_landing_pages_monthly to looker_reader;
