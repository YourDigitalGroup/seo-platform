-- AI citation tracking (Ahrefs Brand Radar). Each client gets a Brand Radar
-- report with custom prompts ("best tree service in Cedar Rapids, IA"), and
-- the brand-radar Edge Function snapshots the answers weekly: which questions
-- were asked on which AI engine, whether the brand was mentioned, which pages
-- were cited. Idempotent; safe to re-run.

create table if not exists public.ai_visibility (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients(id) on delete cascade,
  report_id            text,
  captured_at          timestamptz not null default now(),
  engines              text[] not null default '{}',
  prompts_tracked      integer,
  responses_checked    integer,
  responses_mentioning integer,
  responses_citing     integer,
  share_of_voice       numeric,
  top_competitor       text,
  top_competitor_sov   numeric,
  per_engine           jsonb not null default '[]'::jsonb,
  per_prompt           jsonb not null default '[]'::jsonb,
  cited_urls           jsonb not null default '[]'::jsonb,
  competitor_citations jsonb not null default '[]'::jsonb,
  error                text
);
create index if not exists ai_visibility_client_captured on public.ai_visibility (client_id, captured_at desc);
alter table public.ai_visibility enable row level security;
revoke all on public.ai_visibility from anon, authenticated;
grant select on public.ai_visibility to authenticated;
drop policy if exists ai_visibility_staff_read on public.ai_visibility;
create policy ai_visibility_staff_read on public.ai_visibility for select to authenticated using (public.is_staff());

-- Program-wide settings. Tracking starts OFF: reports and prompts are created
-- (free), but no AI engine runs them (Ahrefs bills checks) until a Super Admin
-- turns tracking on in Team & access.
insert into public.app_settings (key, value)
values ('ai_tracking', '{"enabled": false, "engines": ["chatgpt", "google_ai_overviews", "perplexity"], "frequency": "weekly", "prompts_per_client": 5, "country": "us"}'::jsonb)
on conflict (key) do nothing;

-- Generic service-role invoker for scheduled Edge Function calls.
create or replace function public.seop_invoke_function(fn text, payload jsonb) returns bigint
language plpgsql security definer set search_path = public as $fn$
declare p_url text; p_key text; rid bigint;
begin
  select decrypted_secret into p_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into p_key from vault.decrypted_secrets where name = 'service_role_key';
  if p_url is null or p_key is null then raise exception 'Vault secrets project_url / service_role_key missing'; end if;
  select net.http_post(
    url := p_url || '/functions/v1/' || fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || p_key),
    body := payload, timeout_milliseconds := 15000) into rid;
  return rid;
end $fn$;
revoke execute on function public.seop_invoke_function(text, jsonb) from public, anon, authenticated;

-- Weekly snapshot, Mondays 12:40 UTC: after the daily audit (11:00) and
-- before the weekly report rebuild (13:00), so reports carry fresh numbers.
select cron.schedule('seop-weekly-ai-citations', '40 12 * * 1',
  $$select public.seop_invoke_function('brand-radar', '{"action":"collect_all"}'::jsonb)$$);
