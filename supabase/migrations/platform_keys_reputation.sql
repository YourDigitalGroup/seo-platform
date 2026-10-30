-- Platform API keys (Team & access → API keys) + reputation monitoring.
-- Idempotent; safe to re-run.

-- ── 1. API keys in Supabase Vault ───────────────────────────────────────────
-- A key entered in the console is stored encrypted in Vault as
-- "seop_key_<NAME>" and wins over the Edge Function secret of the same name;
-- clearing it falls back to that secret. Only the service role (Edge
-- Functions) can read or write values; the console only ever sees names,
-- dates and who changed them.
create or replace function public.platform_key(p_name text) returns text
language sql stable security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'seop_key_' || p_name limit 1
$$;

create or replace function public.platform_key_set(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  if p_name !~ '^[A-Z][A-Z0-9_]{2,63}$' then raise exception 'invalid key name'; end if;
  select id into sid from vault.secrets where name = 'seop_key_' || p_name;
  if coalesce(p_value, '') = '' then
    if sid is not null then delete from vault.secrets where id = sid; end if;
  elsif sid is null then
    perform vault.create_secret(p_value, 'seop_key_' || p_name, 'SEO platform API key (Team & access)');
  else
    perform vault.update_secret(sid, p_value);
  end if;
end $$;

create or replace function public.platform_key_meta()
returns table (name text, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = public, vault as $$
  select substr(s.name, 10), s.created_at, s.updated_at from vault.secrets s where s.name like 'seop_key_%'
$$;

revoke execute on function public.platform_key(text) from public, anon, authenticated;
revoke execute on function public.platform_key_set(text, text) from public, anon, authenticated;
revoke execute on function public.platform_key_meta() from public, anon, authenticated;
grant execute on function public.platform_key(text) to service_role;
grant execute on function public.platform_key_set(text, text) to service_role;
grant execute on function public.platform_key_meta() to service_role;

-- Who changed which key, when (never the value).
create table if not exists public.platform_key_events (
  id          bigserial primary key,
  key_name    text not null,
  action      text not null check (action in ('set', 'cleared', 'tested')),
  ok          boolean,
  detail      text,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_email text,
  at          timestamptz not null default now()
);
create index if not exists platform_key_events_name_at on public.platform_key_events (key_name, at desc);
alter table public.platform_key_events enable row level security;
revoke all on public.platform_key_events from anon, authenticated;

-- ── 2. Reputation monitoring ────────────────────────────────────────────────
-- The client's Google Business Profile listing (Places API place id). Pinned
-- automatically when the listing's website is the client's domain, or set by
-- hand on the client's Reputation panel.
alter table public.clients add column if not exists gbp_place_id text;

-- One row per check per source ('google' now; Local Insight next).
create table if not exists public.reputation_snapshots (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  source       text not null default 'google',
  captured_at  timestamptz not null default now(),
  place_id     text,
  listing_name text,
  listing_url  text,
  rating       numeric,
  review_count integer,
  reviews      jsonb not null default '[]'::jsonb,
  error        text
);
create index if not exists reputation_snapshots_client on public.reputation_snapshots (client_id, source, captured_at desc);
alter table public.reputation_snapshots enable row level security;
revoke all on public.reputation_snapshots from anon, authenticated;
grant select on public.reputation_snapshots to authenticated;
drop policy if exists reputation_snapshots_staff_read on public.reputation_snapshots;
create policy reputation_snapshots_staff_read on public.reputation_snapshots for select to authenticated using (public.is_staff());

-- Every individual review ever seen, so new ones can be flagged.
create table if not exists public.reputation_reviews (
  client_id     uuid not null references public.clients(id) on delete cascade,
  source        text not null default 'google',
  review_id     text not null,
  rating        integer,
  author        text,
  text          text,
  published_at  timestamptz,
  review_url    text,
  first_seen_at timestamptz not null default now(),
  primary key (client_id, source, review_id)
);
create index if not exists reputation_reviews_recent on public.reputation_reviews (client_id, published_at desc);
alter table public.reputation_reviews enable row level security;
revoke all on public.reputation_reviews from anon, authenticated;
grant select on public.reputation_reviews to authenticated;
drop policy if exists reputation_reviews_staff_read on public.reputation_reviews;
create policy reputation_reviews_staff_read on public.reputation_reviews for select to authenticated using (public.is_staff());

-- Daily check, 12:50 UTC (after the daily audits, before Monday's report rebuild).
select cron.schedule('seop-daily-reputation', '50 12 * * *',
  $$select public.seop_invoke_function('reputation', '{"action":"collect_all"}'::jsonb)$$);
