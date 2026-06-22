-- ════════════════════════════════════════════════════════════════════════════
--  reconcile_schema.sql
--  Brings the live database up to the schema the deployed Edge Functions expect.
--
--  WHY: the final run-audit / generate-fixes / generate-report functions write
--  and read columns that the live database never received (the remediation +
--  report-storage migrations were never applied). With those columns missing,
--  the inserts/queries fail silently — so fixes never stage, content never
--  queues, and the report comes back empty.
--
--  SAFE: this only ADDS columns/indexes and relaxes one NOT NULL. It drops
--  nothing and is idempotent — running it more than once is harmless.
--  Supersedes report_storage_migration.sql (includes its columns).
-- ════════════════════════════════════════════════════════════════════════════

-- 1) fixes — evolve to the typed-artifact shape the remediation engine uses.
--    run-audit stages a fix with (audit_id, status, context); generate-fixes
--    fills after_text/schema_jsonld and flips status to 'ready'; the console
--    marks it 'pushed'; generate-report reads pushed fixes by audit_id.
alter table fixes
  add column if not exists audit_id   uuid references audits(id) on delete cascade,
  add column if not exists status     text        not null default 'suggested',
  add column if not exists context    jsonb,
  add column if not exists revision   integer     not null default 1,
  add column if not exists updated_at timestamptz not null default now();

-- run-audit stages fixes against an audit before any package row exists,
-- so package_id must be optional.
alter table fixes alter column package_id drop not null;

-- lookups made by generate-fixes, generate-report, and the console.
create index if not exists fixes_audit_id_idx     on fixes (audit_id);
create index if not exists fixes_audit_status_idx on fixes (audit_id, status);

-- 2) content_topics — geo column so the audit can bind trade-area landing pages
--    (e.g. a "garage organization" topic targeted to Brandon vs. Sioux Falls).
alter table content_topics
  add column if not exists location text;

-- 3) packages — storage for the generated client-facing progress report.
alter table packages
  add column if not exists report_html     text,
  add column if not exists report_built_at timestamptz,
  add column if not exists report_meta     jsonb;
