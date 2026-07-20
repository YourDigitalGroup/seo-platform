-- ════════════════════════════════════════════════════════════════════════════
--  directive_engine.sql
--  Backbone for the v4 "Directive Engine": the audit now evaluates an
--  exhaustive, weighted CHECKLIST (the union of what Lighthouse, Ahrefs,
--  SEMrush, Moz and the popular "SEO checker" tools grade), derives every
--  pillar score from it, and compiles a PLAN-SCOPED DIRECTIVE — the ordered
--  work plan for the client's chosen tier that, once fully executed and
--  verified, converges the site to an A on any third-party SEO audit.
--
--  Additive + idempotent, house style (text + CHECK, no enums).
--  Every new column is also mirrored into audits.raw / packages by the Edge
--  Functions defensively, so deploying code before running this migration
--  degrades gracefully instead of failing.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) audits — the 7th pillar (performance / Core Web Vitals) and the composite
--    0-100 audit score the directive drives toward.
alter table audits add column if not exists grade_performance text;
alter table audits add column if not exists score integer;

-- 2) packages — the compiled directive (work plan scoped to the client's plan).
--    Shape: { version, built_at, tier, score, target_score, pillars, progress,
--             items: [{check_id, pillar, title, action, engine, fix_kind,
--                      severity, points, in_plan, service, unlock_tier,
--                      status, target_page}], summary }
alter table packages add column if not exists directive jsonb;

-- 3) audit_checks — one row per evaluated check, queryable across cycles so
--    the console and reports can chart pass-rate history per pillar/check.
create table if not exists audit_checks (
  id         uuid primary key default gen_random_uuid(),
  audit_id   uuid not null references audits(id) on delete cascade,
  check_id   text not null,
  pillar     text not null check (pillar in
             ('technical','performance','onpage','schema','aeo','eeat','local')),
  label      text not null,
  status     text not null check (status in ('pass','warn','fail','na')),
  weight     integer not null default 1,
  evidence   text,
  fix_kind   text,
  created_at timestamptz not null default now(),
  unique (audit_id, check_id)
);

create index if not exists audit_checks_audit_idx  on audit_checks (audit_id);
create index if not exists audit_checks_status_idx on audit_checks (audit_id, status);

alter table audit_checks enable row level security;
drop policy if exists audit_checks_staff_all on audit_checks;
create policy audit_checks_staff_all on audit_checks
  for all to authenticated using (true) with check (true);
