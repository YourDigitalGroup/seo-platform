-- Weekly Ahrefs pulls. run-audit runs every day for every active client, but
-- backlink / keyword / competitor data barely moves day to day and each full
-- pull costs ~14k API units. run-audit now keeps every successful Ahrefs
-- response here and reuses it for 7 days (key = endpoint + params without the
-- `date` param), so each client's Ahrefs data refreshes weekly while the
-- on-page checks keep running daily. Failed calls are never cached.
-- Service role only (no policies). Idempotent; safe to re-run.
create table if not exists public.ahrefs_cache (
  key        text primary key,          -- sha-256 of endpoint + sorted params (no date)
  path       text not null,
  target     text,
  response   jsonb not null,
  fetched_at timestamptz not null default now()
);
create index if not exists ahrefs_cache_fetched_idx on public.ahrefs_cache (fetched_at);
alter table public.ahrefs_cache enable row level security;
revoke all on public.ahrefs_cache from anon, authenticated;

-- Keep the table small: anything older than two weeks is never served again.
select cron.schedule('seop-ahrefs-cache-prune', '45 9 * * 0',
  $$delete from public.ahrefs_cache where fetched_at < now() - interval '14 days'$$);
