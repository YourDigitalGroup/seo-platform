-- Trello integration settings — configured in the console (Team & access).
-- Idempotent; safe to run more than once.

-- Per-user Trello @username (strategists get tagged on their cards).
alter table profiles add column if not exists trello_username text;

-- Small key/value store for console-managed settings. Row 'trello' holds:
--   { board_id, title_template, lists: { <profile_id>: <trello_list_id> } }
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
drop policy if exists app_settings_rw on app_settings;
create policy app_settings_rw on app_settings
  for all to authenticated using (true) with check (true);
