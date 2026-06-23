-- ════════════════════════════════════════════════════════════════════════════
--  campaign_engine.sql
--  Backbone for the auto-generated 6-month campaign. Additive + idempotent +
--  view-safe (no enum or column-type changes — only adds columns, relaxes one
--  NOT NULL, and ensures a staff RLS policy).
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Campaign lifecycle lives in a free-text `state`
--    (planned → generating → ready → delivered → skipped), independent of the
--    legacy enum `status` column so we never have to guess enum values.
alter table deliverables alter column status drop not null;
alter table deliverables add column if not exists state    text    not null default 'planned';
alter table deliverables add column if not exists auto     boolean not null default true;
alter table deliverables add column if not exists topic_id uuid;  -- content_topics row, once queued
alter table deliverables add column if not exists draft_id uuid;  -- content_drafts row, once written

create index if not exists deliverables_client_cycle_idx
  on deliverables (client_id, cycle_month, state);
create index if not exists deliverables_client_month_idx
  on deliverables (client_id, month_offset);

-- 2) Internal-only access: any authenticated staffer manages the campaign.
alter table deliverables enable row level security;
drop policy if exists deliverables_staff_all on deliverables;
create policy deliverables_staff_all on deliverables
  for all to authenticated using (true) with check (true);
