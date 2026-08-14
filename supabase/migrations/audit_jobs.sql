-- audit_jobs — progress + result tracking for background audits.
-- run-audit (engine 5.5.0+) answers the console immediately and finishes the
-- audit in the background, so the API gateway can never 504 a long crawl.
-- This table is where the console watches for the outcome. If it is missing
-- the audit still completes — the console falls back to polling the audits
-- table — but failures then carry no error message, so run this migration.
-- Idempotent; safe to run more than once.

create table if not exists audit_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  status text not null default 'running',      -- running | done | error
  audit_only boolean not null default false,
  engine_version text,
  audit_id uuid,                                -- set on success
  result jsonb,                                 -- the full run-audit response payload
  error text,                                   -- set on failure
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists audit_jobs_client_idx on audit_jobs (client_id, started_at desc);

-- Writes come from the Edge Function (service role, bypasses RLS);
-- signed-in console users only ever read.
alter table audit_jobs enable row level security;
drop policy if exists audit_jobs_read on audit_jobs;
create policy audit_jobs_read on audit_jobs for select to authenticated using (true);
