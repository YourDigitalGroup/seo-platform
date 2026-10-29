-- Advice Local: persist the latest successfully fetched directory status per client.
-- Current-state only; monthly history is not backfilled.
create table if not exists public.advice_local_directory_status (
  client_id uuid not null references public.clients(id) on delete cascade,
  directory text not null,
  status text not null,
  status_group text not null check(status_group in ('live','retry','queued','verify','attn','other')),
  initial_status text,
  listing_url text,
  updated_at_source text,
  fetched_at timestamptz not null,
  primary key (client_id,directory)
);
create index if not exists advice_local_directory_status_client_fetched on public.advice_local_directory_status(client_id,fetched_at desc);
alter table public.advice_local_directory_status enable row level security;
revoke all on public.advice_local_directory_status from anon,authenticated;
-- Called by the server-side advice-local function with service-role credentials.
create or replace function public.replace_advice_local_directories(p_client_id uuid,p_records jsonb)
returns void language plpgsql security invoker set search_path=public as $$
begin
 if current_user <> 'service_role' then raise exception 'service role required'; end if;
 if jsonb_typeof(p_records) <> 'array' then raise exception 'directory records must be an array'; end if;
 delete from public.advice_local_directory_status where client_id=p_client_id;
 insert into public.advice_local_directory_status(client_id,directory,status,status_group,initial_status,listing_url,updated_at_source,fetched_at)
 select p_client_id,x.directory,x.status,x.status_group,x.initial_status,x.listing_url,x.updated_at_source,x.fetched_at
 from jsonb_to_recordset(p_records) as x(
   client_id uuid,directory text,status text,status_group text,
   initial_status text,listing_url text,updated_at_source text,fetched_at timestamptz
 );
end $$;
revoke all on function public.replace_advice_local_directories(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.replace_advice_local_directories(uuid,jsonb) to service_role;
-- Attach live fulfillment counts to the monthly report row, without inflating
-- metrics from the other report dimensions.
create or replace view public.looker_reports_monthly as
select r.*,
  al.directory_count as al_directories_total,
  al.live_count as al_directories_live,
  al.retry_count as al_directories_retrying,
  al.queued_count as al_directories_queued,
  al.verify_count as al_directories_verification,
  al.attn_count as al_directories_needs_attention,
  al.other_count as al_directories_other,
  al.last_checked_at as al_status_checked_at
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
-- Append per-directory rows as a new section in the established items view.
-- Existing columns remain unchanged and a new listing URL field is appended.
create or replace view public.looker_report_items_monthly as
select i.*,null::text as al_listing_url
from public.looker_report_items i where i.is_month_final
union all
select
 r.report_id,r.client_id,r.client_name,r.client_url,r.plan,r.partner_group,r.report_date,
 10::integer as section_number,'advice_local_directory'::text as section,
 row_number() over(partition by r.report_id order by d.directory)::integer as item_order,
 d.directory as title,d.initial_status as detail,d.status_group as category,
 d.fetched_at as item_date,
 null::numeric as count_value,null::numeric as volume,null::numeric as position_before,null::numeric as position_after,
 null::numeric as gsc_queries,null::numeric as gsc_impressions,null::numeric as gsc_clicks,
 null::numeric as ai_mentions,null::numeric as ai_sov_pct,
 r.is_latest,r.report_month,r.is_month_final,
 null::text as position_before_label,null::text as position_after_label,
 d.listing_url as al_listing_url
from public.looker_reports_monthly r
join public.advice_local_directory_status d on d.client_id=r.client_id
 and date_trunc('month',d.fetched_at)::date=r.report_month;
revoke all on public.looker_reports_monthly,public.looker_report_items_monthly from anon,authenticated;
grant select on public.looker_reports_monthly,public.looker_report_items_monthly to looker_reader;
