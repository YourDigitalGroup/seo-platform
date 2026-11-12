-- WordPress "went live" events from the connector (1.12+) → wp-events.
-- One row per published piece per client; drives the Trello notification to
-- the account manager and records whether it was delivered.
-- Idempotent; safe to re-run.
create table if not exists public.wp_publish_events (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  external_id    text not null,               -- content topic id from the deploy file
  topic_id       uuid references public.content_topics(id) on delete set null,
  title          text,
  url            text,
  post_type      text,
  plugin_version text,
  published_at   timestamptz not null default now(),
  trello_status  text,                        -- posted | posted_untagged | no_card | not_configured | failed
  trello_detail  text,
  created_at     timestamptz not null default now(),
  unique (client_id, external_id)
);
alter table public.wp_publish_events enable row level security;
revoke all on public.wp_publish_events from anon;
drop policy if exists wp_publish_events_staff_read on public.wp_publish_events;
create policy wp_publish_events_staff_read on public.wp_publish_events
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid()));
