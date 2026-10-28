-- WordPress connector AI proxy (wp-ai Edge Function): per-site daily usage,
-- so the Anthropic key can live in Supabase instead of in every plugin zip.
-- Service-role only (RLS on, no policies; the function is not callable from
-- the public API). Idempotent; safe to re-run.
create table if not exists public.wp_ai_usage (
  client_id     uuid not null references public.clients(id) on delete cascade,
  day           date not null default current_date,
  calls         integer not null default 0,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  primary key (client_id, day)
);
alter table public.wp_ai_usage enable row level security;
revoke all on public.wp_ai_usage from anon, authenticated;

-- Atomic "count this call" — returns today's call count after the increment.
create or replace function public.wp_ai_record(p_client uuid, p_in integer, p_out integer)
returns integer language sql security definer set search_path = public as $$
  insert into wp_ai_usage (client_id, day, calls, input_tokens, output_tokens)
  values (p_client, current_date, 1, greatest(p_in, 0), greatest(p_out, 0))
  on conflict (client_id, day) do update
    set calls = wp_ai_usage.calls + 1,
        input_tokens = wp_ai_usage.input_tokens + greatest(p_in, 0),
        output_tokens = wp_ai_usage.output_tokens + greatest(p_out, 0)
  returning calls;
$$;
revoke execute on function public.wp_ai_record(uuid, integer, integer) from public, anon, authenticated;
